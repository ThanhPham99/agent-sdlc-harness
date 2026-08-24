#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

export const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export const manifest=JSON.parse(fs.readFileSync(path.join(ROOT,'agent-sdlc.manifest.json'),'utf8'));
export const VERSION=manifest.version;
export const HOSTS=['claude','codex','antigravity'];
export const HOST_BIN={claude:'claude',codex:'codex',antigravity:'agy'};
export const HOST_BIN_ENV={claude:'AI_SDLC_CLAUDE_BIN',codex:'AI_SDLC_CODEX_BIN',antigravity:'AI_SDLC_ANTIGRAVITY_BIN'};
export const HOST_HELP_ARGS={claude:['--help'],codex:['exec','--help'],antigravity:['--help']};
export const HOST_REQUIRED_TOKENS={
  claude:['--bare','--plugin-dir','--print','--output-format','--json-schema','--no-session-persistence','--max-turns'],
  codex:['--ephemeral','--json','--output-schema','--output-last-message','--sandbox','--skip-git-repo-check'],
  antigravity:['--sandbox','--print','--print-timeout','--output-format','--json-schema']
};
export const exitCode=status=>({QUALIFIED:0,READY:0,FAIL:1,PENDING:2,BLOCKED:3}[status]??1);
export const utcNow=()=>new Date().toISOString();
export const sha256Bytes=b=>crypto.createHash('sha256').update(b).digest('hex');
export const sha256File=p=>sha256Bytes(fs.readFileSync(p));
export const canonicalDigest=v=>sha256Bytes(Buffer.from(JSON.stringify(v,Object.keys(v).sort())));
export function digestFiles(rels){const h=crypto.createHash('sha256');for(const rel of [...rels].sort()){const p=path.join(ROOT,rel);h.update(rel);h.update('\0');h.update(fs.readFileSync(p));h.update('\0');}return h.digest('hex');}
export function corpusFiles(){return ['evals/activation/deterministic-cases.json','evals/activation/multi-turn-cases.json','evals/activation/adversarial-cases.json','evals/activation/provider-expectations.json','evals/live/activation-cases.json','evals/live/semantic-cases.json','evals/live/security-cases.json','evals/live/repository-e2e-cases.json','evals/live/semantic-decision.schema.json','evals/live/repository-decision.schema.json','evals/live/qualification-lock.json'];}
export function corpusDigest(){return digestFiles(corpusFiles());}
export function qualificationSubjectDigest(){
  const prefixes=['skills','config','policies','runtime','prompts','workflows','overlays','roles','tools','templates','adapters','protocol','bin'];
  const rels=[];
  for(const prefix of prefixes){const base=path.join(ROOT,prefix);if(!fs.existsSync(base))continue;for(const full of walk(base))rels.push(path.relative(ROOT,full).split(path.sep).join('/'));}
  rels.push(...corpusFiles());
  rels.push('agent-sdlc.manifest.json','scripts/qualification-lib.mjs','scripts/qualify-host.mjs','scripts/qualify-release.mjs','scripts/qualification-bundle.mjs','scripts/host-preflight.mjs','scripts/verify-dist.mjs','scripts/build-dist.mjs');
  return digestFiles([...new Set(rels)]);
}
function* walk(dir){for(const ent of fs.readdirSync(dir,{withFileTypes:true})){const full=path.join(dir,ent.name);if(ent.isDirectory())yield* walk(full);else if(ent.isFile())yield full;}}
export function loadLock(){return JSON.parse(fs.readFileSync(path.join(ROOT,'evals/live/qualification-lock.json'),'utf8'));}
export function loadCases(){
  const sets={}; for(const [kind,file] of Object.entries({activation:'activation-cases.json',semantic:'semantic-cases.json',security:'security-cases.json',e2e:'repository-e2e-cases.json'}))sets[kind]=JSON.parse(fs.readFileSync(path.join(ROOT,'evals/live',file),'utf8')).cases;
  return sets;
}
export function selectedCases(tier){const t=loadLock().tiers[tier];if(!t)throw new Error(`unknown tier ${tier}`);const sets=loadCases();const index=new Map([...sets.activation,...sets.semantic,...sets.security].map(c=>[c.id,c]));return {semantic:t.semantic_case_ids.map(id=>{const c=index.get(id);if(!c)throw new Error(`missing case ${id}`);return c;}),e2e:t.repository_e2e_case_ids.map(id=>{const c=sets.e2e.find(x=>x.id===id);if(!c)throw new Error(`missing e2e ${id}`);return c;}),promotion_eligible:!!t.promotion_eligible};}
export const ACTIVATION_RESULTS=['AUTO_ACTIVATED','SOFT_DISCOVERY_ACTIVATED','NOT_ACTIVATED','UNSUPPORTED','PENDING'];
// Probe set for measuring activation WITHOUT naming any Agent SDLC skill in the prompt.
export function activationProbeCases({positive=6,negative=4}={}){
  const all=JSON.parse(fs.readFileSync(path.join(ROOT,'evals/activation/deterministic-cases.json'),'utf8')).cases;
  const pick=(group,n)=>all.filter(c=>c.group===group).slice(0,n);
  return [...pick('positive',positive),...pick('negative',negative)];
}
export function activationExpectations(){return JSON.parse(fs.readFileSync(path.join(ROOT,'evals/activation/provider-expectations.json'),'utf8'));}
export function packagePath(host){return path.join(ROOT,'dist',`agent-sdlc-${host}-${VERSION}.zip`);}
export function packageDir(host){return path.join(ROOT,'dist',`agent-sdlc-${host}-${VERSION}`);}
export function packageDigest(host){const p=packagePath(host);return fs.existsSync(p)?sha256File(p):null;}
export function resolveBinary(host,override){const candidates=[override,process.env[HOST_BIN_ENV[host]],HOST_BIN[host],...(host==='antigravity'?['antigravity']:[])].filter(Boolean);for(const bin of candidates){const r=spawnSync(bin,['--version'],{encoding:'utf8',timeout:10000});if(r.status===0)return {binary:bin,version:(r.stdout||r.stderr||'').trim()};}return null;}
export function hostPreflight(host,{binary=null}={}){
  const resolved=resolveBinary(host,binary); if(!resolved)return {schema:'agent-sdlc/host-preflight/v2',version:VERSION,host,status:'PENDING',reason:'HOST_CLI_NOT_FOUND',resolved_binary:null,host_version:null,checks:[]};
  const h=spawnSync(resolved.binary,HOST_HELP_ARGS[host],{encoding:'utf8',timeout:15000,maxBuffer:5*1024*1024});
  const help=(h.stdout||'')+'\n'+(h.stderr||''); if(h.status!==0)return {schema:'agent-sdlc/host-preflight/v2',version:VERSION,host,status:'FAIL',reason:'HELP_COMMAND_FAILED',resolved_binary:resolved.binary,host_version:resolved.version,checks:[{name:'help',status:'FAIL',exit_code:h.status}]};
  const missing=HOST_REQUIRED_TOKENS[host].filter(t=>!help.includes(t));
  return {schema:'agent-sdlc/host-preflight/v2',version:VERSION,host,status:missing.length?'BLOCKED':'READY',reason:missing.length?'CLI_CAPABILITY_MISMATCH':null,resolved_binary:resolved.binary,host_version:resolved.version,checks:[{name:'version',status:'PASS'},{name:'cli_contract',status:missing.length?'BLOCKED':'PASS',required_tokens:HOST_REQUIRED_TOKENS[host],missing_tokens:missing}]};
}
export function environmentFingerprint(){return {platform:process.platform,arch:process.arch,node:process.version,kernel:os.release()};}
export function runtimeContract(host,pf){return {host,cli_version:pf?.host_version||null,required_help_tokens:HOST_REQUIRED_TOKENS[host],requested_model:process.env[`AGENT_SDLC_QUAL_MODEL_${host.toUpperCase()}`]||null,requested_effort:process.env[`AGENT_SDLC_QUAL_EFFORT_${host.toUpperCase()}`]||null};}
export function runtimeContractDigest(host,pf){return sha256Bytes(Buffer.from(JSON.stringify(runtimeContract(host,pf))));}
export function parseJsonObject(text,requiredKey){
  const s=(text||'').trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');
  try{const v=JSON.parse(s);if(v&&typeof v==='object'&&requiredKey in v)return v;}catch{}
  const dec=[];for(let i=0;i<s.length;i++){if(s[i]!=='{')continue;for(let j=s.length;j>i;j--){if(s[j-1]!=='}')continue;try{const v=JSON.parse(s.slice(i,j));if(v&&typeof v==='object'&&requiredKey in v){dec.push(v);break;}}catch{}}}return dec.at(-1)||null;
}
export function extractStructured(stdout,finalFile,requiredKey){
  if(finalFile&&fs.existsSync(finalFile)){const v=parseJsonObject(fs.readFileSync(finalFile,'utf8'),requiredKey);if(v)return v;}
  let v=parseJsonObject(stdout,requiredKey);if(v)return v;
  for(const line of (stdout||'').split(/\r?\n/)){try{const o=JSON.parse(line);for(const key of ['structured_output','response','result','output','message','content','text']){const x=o?.[key];if(x&&typeof x==='object'&&requiredKey in x)return x;if(typeof x==='string'){v=parseJsonObject(x,requiredKey);if(v)return v;}}}catch{}}
  return null;
}
export function classifyFailure(text,exit){const t=(text||'').toLowerCase();if(/not logged in|login required|authentication required|unauthorized|missing api key|api key is required|please authenticate|credentials not found|not authenticated|sign in required/.test(t))return 'PENDING_AUTH';if(/rate limit|too many requests|overloaded|temporarily unavailable|service unavailable|connection reset|network is unreachable|could not resolve|timed out|timeout|quota exceeded|capacity/.test(t))return 'BLOCKED_TRANSIENT';if(/unknown option|unrecognized option|unexpected argument|unknown flag|no such option|invalid option/.test(t))return 'FAIL_CLI_CONTRACT';return exit===0?'NONE':'FAIL_UNCLASSIFIED';}
export function extractUsage(text,prompt='',output=''){
  let input=0,outputTok=0,cached=0,total=0,found=false,model=null;
  const visit=v=>{if(Array.isArray(v))return v.forEach(visit);if(!v||typeof v!=='object')return;for(const [k,x] of Object.entries(v)){const key=k.toLowerCase();if(typeof x==='number'){if(['input_tokens','prompt_tokens','inputtokencount'].includes(key)){input+=x;found=true;}else if(['output_tokens','completion_tokens','outputtokencount'].includes(key)){outputTok+=x;found=true;}else if(['cached_input_tokens','cache_read_input_tokens','cachedcontenttokencount'].includes(key)){cached+=x;found=true;}else if(['total_tokens','totaltokencount'].includes(key)){total=Math.max(total,x);found=true;}}else if(typeof x==='string'&&key==='model'&&!model)model=x;else visit(x);}};
  for(const line of (text||'').split(/\r?\n/)){try{visit(JSON.parse(line));}catch{}} try{visit(JSON.parse(text));}catch{}
  if(found)return {source:'ACTUAL_HOST_REPORTED',input_tokens:input||null,cached_input_tokens:cached||null,output_tokens:outputTok||null,total_tokens:total||((input||0)+(outputTok||0))||null,model};
  const estIn=Math.ceil((prompt||'').length/4), estOut=Math.ceil((output||'').length/4);return {source:'PROXY_ESTIMATE',input_tokens:estIn,cached_input_tokens:null,output_tokens:estOut,total_tokens:estIn+estOut,model:null};
}
export function summarizeUsage(rows){const out={source:'UNAVAILABLE',input_tokens:0,cached_input_tokens:0,output_tokens:0,total_tokens:0,cases:0,actual_cases:0,proxy_cases:0};for(const u of rows.filter(Boolean)){out.cases++;out.input_tokens+=u.input_tokens||0;out.cached_input_tokens+=u.cached_input_tokens||0;out.output_tokens+=u.output_tokens||0;out.total_tokens+=u.total_tokens||0;if(u.source==='ACTUAL_HOST_REPORTED')out.actual_cases++;else if(u.source==='PROXY_ESTIMATE')out.proxy_cases++;}out.source=out.actual_cases===out.cases&&out.cases?'ACTUAL_HOST_REPORTED':out.actual_cases?'MIXED':out.proxy_cases?'PROXY_ESTIMATE':'UNAVAILABLE';return out;}
export function sanitizeDiagnostic(s){return (s||'').replace(/(?:sk-|AKIA|AIza)[A-Za-z0-9_\-]{8,}/g,'[REDACTED_TOKEN]').slice(-1600);}
export function evidenceInputs(){return {corpus_sha256:corpusDigest(),qualification_subject_sha256:qualificationSubjectDigest()};}
export function freshEnough(iso){const lock=loadLock();const ts=Date.parse(iso);if(!Number.isFinite(ts))return {valid:false,reason:'INVALID_TIMESTAMP'};const age=(Date.now()-ts)/3600000;const future=(ts-Date.now())/60000;if(future>lock.future_skew_minutes)return {valid:false,reason:'FUTURE_TIMESTAMP'};if(age>lock.evidence_max_age_hours)return {valid:false,reason:'STALE_EVIDENCE',age_hours:age};return {valid:true,age_hours:age};}
