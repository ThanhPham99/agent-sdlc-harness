import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {safeRelative,truncateUtf8,readJson} from './util.mjs';
import {checkTool} from './policy.mjs';
import {putArtifact,emit,saveRun} from './store.mjs';
import {normalizeInput} from './normalize.mjs';

function exec(argv,cwd,timeout,maxBytes){const r=spawnSync(argv[0],argv.slice(1),{cwd,encoding:'utf8',timeout,maxBuffer:20*1024*1024});const raw=(r.stdout||'')+(r.stderr||'');const t=truncateUtf8(raw,maxBytes);return {status:(r.status===0?'PASS':'FAIL'),exit_code:r.status??1,summary:t.text,truncated:t.truncated,raw};}
function projectCommand(cfg,key,args){const tmpl=cfg.commands?.[key];if(!Array.isArray(tmpl)||!tmpl.length)throw new Error(`project command ${key} not configured`);return tmpl.map(x=>String(x).replaceAll('{selector}',args.selector||''));}
function sensitivePath(root,rel){const sec=readJson(path.join(root,'policies','security-policy.json'));const p=String(rel||'').replaceAll('\\','/');return (sec.sensitive_read_patterns||[]).some(g=>{const re='^'+g.replace(/[.+^${}()|[\]\\]/g,'\\$&').replaceAll('**','.*').replaceAll('*','[^/]*')+'$';return new RegExp(re).test(p);});}
function secretScan(projectRoot){
  const pattern='(AKIA[0-9A-Z]{16}|BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY|api[_-]?key\\s*[:=]|secret\\s*[:=]|token\\s*[:=])';
  const r=spawnSync('git',['grep','-l','-E',pattern],{cwd:projectRoot,encoding:'utf8',timeout:120000,maxBuffer:4*1024*1024});
  if(r.status===1)return {status:'PASS',exit_code:0,summary:'No tracked files matched the built-in secret patterns.',truncated:false,raw:''};
  if(r.status===0){const files=(r.stdout||'').split('\n').filter(Boolean).slice(0,200);return {status:'FAIL',exit_code:1,summary:`Potential secret patterns detected in tracked files (values redacted):\n${files.join('\n')}`,truncated:false,raw:''};}
  return {status:'FAIL',exit_code:r.status??1,summary:(r.stderr||'secret scan failed').slice(0,24000),truncated:false,raw:''};
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
  else if(tool==='test.run_targeted')result=exec(projectCommand(cfg,'test_targeted',args),projectRoot,Math.max(timeout,args.timeout_ms||0),maxBytes);
  else if(tool==='test.run_full')result=exec(projectCommand(cfg,'test_full',args),projectRoot,Math.max(timeout,args.timeout_ms||0),maxBytes);
  else if(tool==='build.run')result=exec(projectCommand(cfg,'build',args),projectRoot,Math.max(timeout,args.timeout_ms||0),maxBytes);
  else throw new Error(`tool ${tool} requires host/MCP/external implementation`);
  let full=null;if((result.truncated||result.status==='FAIL')&&result.raw){const a=putArtifact(projectRoot,{kind:'tool-log',content:result.raw,runId:run.run_id,stage:run.state,filename:`${tool}.log`});full=a.artifact_id;}
  const out={tool,status:result.status,exit_code:result.exit_code,summary:result.summary,failures:[],full_log_artifact:full,truncated:result.truncated};emit(projectRoot,run,{type:'tool.completed',payload:{tool,status:out.status,exit_code:out.exit_code,truncated:out.truncated},artifact_refs:full?[full]:[]});return out;
}
