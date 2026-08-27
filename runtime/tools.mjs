import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {safeRelative,truncateUtf8,readJson} from './util.mjs';
import {checkTool} from './policy.mjs';
import {putArtifact,emit,saveRun} from './store.mjs';
import {normalizeInput} from './normalize.mjs';
import {recordEvidence} from './evidence.mjs';
import {resolveLaunch,describeSpawn} from './launcher.mjs';

// A command the harness was told to run, resolved the same way host binaries
// are, and a result that distinguishes "it ran and failed" from "it never ran".
function exec(argv,cwd,timeout,maxBytes){
  const launch=resolveLaunch(argv);
  if(launch.status!=='OK'){
    const detail=launch.detail?` (${launch.detail})`:'';
    return {status:'ERROR',reason:launch.reason,exit_code:null,
      summary:`${launch.reason}${detail}: cannot launch ${argv.join(' ')}`,
      truncated:false,raw:''};
  }
  const r=spawnSync(launch.bin,launch.args,{cwd,encoding:'utf8',timeout,maxBuffer:20*1024*1024,...launch.spawnOptions});
  const d=describeSpawn(r);
  const raw=(r.stdout||'')+(r.stderr||'');
  const t=truncateUtf8(raw,maxBytes);
  // On ERROR the child's own output is usually empty and the errno is the only
  // fact there is, so it leads the summary instead of being dropped.
  const summary=d.status==='ERROR'
    ? [`${d.reason}: ${argv.join(' ')}`,d.signal?`killed by ${d.signal}`:null,t.text||null].filter(Boolean).join('\n')
    : t.text;
  return {status:d.status,reason:d.reason,exit_code:d.exit_code,summary,truncated:t.truncated,raw};
}
function projectCommand(cfg,key,args){
  const tmpl=cfg.commands?.[key];
  if(!Array.isArray(tmpl)||!tmpl.length)throw new Error(`project command ${key} not configured`);
  const selector=args.selector===undefined||args.selector===null?'':String(args.selector);
  // An unsubstituted placeholder used to become the empty string, which turned
  // `node {selector}` into `node ''`: exit 0, no output, recorded as
  // targeted_verification_pass. A command that asks for a selector gets one or
  // does not run.
  if(tmpl.some(x=>String(x).includes('{selector}'))&&!selector.trim()){
    throw new Error(`project command ${key} requires a selector; none was provided`);
  }
  return tmpl.map(x=>String(x).replaceAll('{selector}',selector));
}
function sensitivePath(root,rel){const sec=readJson(path.join(root,'policies','security-policy.json'));const p=String(rel||'').replaceAll('\\','/');return (sec.sensitive_read_patterns||[]).some(g=>{const re='^'+g.replace(/[.+^${}()|[\]\\]/g,'\\$&').replaceAll('**','.*').replaceAll('*','[^/]*')+'$';return new RegExp(re).test(p);});}
function secretScan(projectRoot){
  const pattern='(AKIA[0-9A-Z]{16}|BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY|api[_-]?key\\s*[:=]|secret\\s*[:=]|token\\s*[:=])';
  const r=spawnSync('git',['grep','-l','-E',pattern],{cwd:projectRoot,encoding:'utf8',timeout:120000,maxBuffer:4*1024*1024});
  if(r.status===1)return {status:'PASS',exit_code:0,summary:'No tracked files matched the built-in secret patterns.',truncated:false,raw:''};
  if(r.status===0){const files=(r.stdout||'').split('\n').filter(Boolean).slice(0,200);return {status:'FAIL',exit_code:1,summary:`Potential secret patterns detected in tracked files (values redacted):\n${files.join('\n')}`,truncated:false,raw:''};}
  return {status:'FAIL',exit_code:r.status??1,summary:(r.stderr||'secret scan failed').slice(0,24000),truncated:false,raw:''};
}
function sanitizeWebQuery(root,query){
  const sec=readJson(path.join(root,'policies','security-policy.json'));
  const wsp=sec.web_search_policy||{};
  const blocked=wsp.blocked_query_patterns||[];
  for(const pat of blocked){
    const cleanPat=pat.startsWith('(?i)')?pat.slice(4):pat;
    const flags=pat.startsWith('(?i)')?'i':'';
    try{if(new RegExp(cleanPat,flags).test(query))return {ok:false,reason:`Query violates security policy pattern: ${pat}`,query};}catch{}
  }
  return {ok:true,query};
}
function checkWebUrl(root,urlStr){
  try{
    const u=new URL(urlStr);
    if(!['http:','https:'].includes(u.protocol))return {ok:false,reason:`Invalid protocol: ${u.protocol}. Only http/https supported.`};
    const host=u.hostname.toLowerCase();
    const sec=readJson(path.join(root,'policies','security-policy.json'));
    const wsp=sec.web_search_policy||{};
    const blockedHosts=wsp.blocked_host_patterns||[];
    for(const bh of blockedHosts){
      if(bh.startsWith('*.')){const domain=bh.slice(2);if(host===domain||host.endsWith('.'+domain))return {ok:false,reason:`Target host ${host} matches blocked domain pattern ${bh}`};}
      else if(bh.endsWith('*')){const prefix=bh.slice(0,-1);if(host.startsWith(prefix))return {ok:false,reason:`Target host ${host} matches blocked IP/host pattern ${bh}`};}
      else if(host===bh)return {ok:false,reason:`Target host ${host} is blocked by security policy`};
    }
    return {ok:true,url:urlStr};
  }catch{return {ok:false,reason:`Invalid URL format: ${urlStr}`};}
}
export function invokeTool(root,projectRoot,run,tool,args={}){
  const cfg=JSON.parse(fs.readFileSync(path.join(projectRoot,'.agent-sdlc','project.json'),'utf8'));const decision=checkTool(root,run,tool,cfg);if(decision.decision!=='ALLOW')return {tool,status:decision.decision==='DENY'?'DENY':'APPROVAL_REQUIRED',exit_code:null,summary:decision,failures:[],full_log_artifact:null,truncated:false};let result;const maxBytes=24000;const timeout=120000;
  if(tool==='input.normalize'){
    const rel=String(args.path||'');const p=safeRelative(projectRoot,rel);const n=normalizeInput(p,{maxBytes:Number(args.max_bytes||20*1024*1024)});
    let artifact=null;if(n.status==='NORMALIZED'){artifact=putArtifact(projectRoot,{kind:'normalized-requirement',content:n.markdown,runId:run.run_id,stage:run.state,filename:path.basename(rel)+'.md'});run.artifacts=[...new Set([...(run.artifacts||[]),artifact.artifact_id])];saveRun(projectRoot,run);}
    result={status:n.status==='NORMALIZED'?'PASS':'FAIL',exit_code:n.status==='NORMALIZED'?0:2,summary:JSON.stringify({normalization_status:n.status,reason:n.reason,source_type:n.source_type,source_sha256:n.source_sha256,artifact_ref:artifact?.artifact_id||null}),truncated:false,raw:''};
  }
  else if(tool==='repo.read'){
    const rel=String(args.path||'');if(sensitivePath(root,rel))throw new Error(`sensitive path blocked: ${rel}`);
    const p=safeRelative(projectRoot,rel);const data=fs.readFileSync(p,'utf8');const t=truncateUtf8(data,maxBytes);result={status:'PASS',exit_code:0,summary:t.text,truncated:t.truncated,raw:data};
  }
  else if(tool==='repo.search'){const argv=['git','grep','-n','--',''+(args.pattern||'')]; if(args.path)argv.push('--',args.path); result=exec(argv,projectRoot,timeout,maxBytes);if(result.exit_code===1){result={...result,status:'PASS',exit_code:0,summary:'No matches.',raw:''};}}
  else if(tool==='repo.diff')result=exec(['git','diff','--no-ext-diff',...(args.cached?['--cached']:[])],projectRoot,timeout,maxBytes);
  else if(tool==='git.status')result=exec(['git','status','--short'],projectRoot,timeout,maxBytes);
  else if(tool==='security.secret_scan')result=secretScan(projectRoot);
  else if(tool==='web.search'){
    const query=String(args.query||args.pattern||'');
    const sanitized=sanitizeWebQuery(root,query);
    if(!sanitized.ok){result={status:'FAIL',exit_code:1,summary:sanitized.reason,truncated:false,raw:''};}
    else{
      const results=Array.isArray(args.results)?args.results:[{title:`Web documentation search for: ${sanitized.query}`,query:sanitized.query,status:'SEARCH_READY_HOST_DELEGATED'}];
      const payload=JSON.stringify({query:sanitized.query,results_count:results.length,matches:results},null,2);
      const t=truncateUtf8(payload,maxBytes);
      result={status:'PASS',exit_code:0,summary:t.text,truncated:t.truncated,raw:payload};
    }
  }
  else if(tool==='web.fetch_url'){
    const url=String(args.url||'');
    const checked=checkWebUrl(root,url);
    if(!checked.ok){result={status:'FAIL',exit_code:1,summary:checked.reason,truncated:false,raw:''};}
    else{
      const rawContent=String(args.content||`[DOCUMENTATION_CONTENT from ${url}]\nFetched official source reference.`);
      const t=truncateUtf8(rawContent,maxBytes);
      result={status:'PASS',exit_code:0,summary:t.text,truncated:t.truncated,raw:rawContent};
    }
  }
  else if(tool==='test.run_targeted')result=exec(projectCommand(cfg,'test_targeted',args),projectRoot,Math.max(timeout,args.timeout_ms||0),maxBytes);
  else if(tool==='test.run_full')result=exec(projectCommand(cfg,'test_full',args),projectRoot,Math.max(timeout,args.timeout_ms||0),maxBytes);
  else if(tool==='build.run')result=exec(projectCommand(cfg,'build',args),projectRoot,Math.max(timeout,args.timeout_ms||0),maxBytes);
  else throw new Error(`tool ${tool} requires host/MCP/external implementation`);
  // Anything that is not a clean pass is worth keeping the raw log for, ERROR
  // included; the previous condition named FAIL only.
  let full=null;if((result.truncated||result.status!=='PASS')&&result.raw){const a=putArtifact(projectRoot,{kind:'tool-log',content:result.raw,runId:run.run_id,stage:run.state,filename:`${tool}.log`});full=a.artifact_id;}
  // A gate token is only as trustworthy as what wrote it. Binding it to the
  // deterministic tool run that produced it, instead of letting a caller
  // assert the same string, is what makes it evidence rather than a claim.
  if(tool==='test.run_targeted')recordEvidence(projectRoot,run,{stage:run.state,claim:'targeted_verification_pass',status:result.status,tool,exitCode:result.exit_code,artifactRef:full});
  const out={tool,status:result.status,reason:result.reason??null,exit_code:result.exit_code,summary:result.summary,failures:[],full_log_artifact:full,truncated:result.truncated};emit(projectRoot,run,{type:'tool.completed',payload:{tool,status:out.status,reason:out.reason,exit_code:out.exit_code,truncated:out.truncated},artifact_refs:full?[full]:[]});return out;
}
