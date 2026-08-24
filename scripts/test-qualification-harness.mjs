#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {
  ROOT,VERSION,HOSTS,packageDigest,corpusDigest,qualificationSubjectDigest,hostPreflight,
  extractStructured,extractUsage
} from './qualification-lib.mjs';

let pass=0,fail=0;const rows=[];
function test(name,fn){try{fn();pass++;rows.push({name,status:'PASS'});}catch(e){fail++;rows.push({name,status:'FAIL',error:e.message});}}
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'agent-sdlc-qual-reg-'));
function fakeCli(name,missing=''){
  const p=path.join(tmp,name);
  const all={
    claude:'--bare --plugin-dir --print --output-format --json-schema --no-session-persistence --max-turns',
    codex:'--ephemeral --json --output-schema --output-last-message --sandbox --skip-git-repo-check',
    antigravity:'--sandbox --print --print-timeout --output-format --json-schema'
  }[name].split(' ').filter(x=>x!==missing).join(' ');
  fs.writeFileSync(p,`#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo '${name} fake-1.0'; exit 0; fi\necho '${all}'\nexit 0\n`);fs.chmodSync(p,0o755);return p;
}
for(const h of HOSTS)test(`preflight-compatible-${h}`,()=>{const p=hostPreflight(h,{binary:fakeCli(h)});if(p.status!=='READY')throw Error(JSON.stringify(p));});
test('preflight-incompatible-blocked',()=>{const p=hostPreflight('claude',{binary:fakeCli('claude','--json-schema')});if(p.status!=='BLOCKED'||!p.checks[1].missing_tokens.includes('--json-schema'))throw Error(JSON.stringify(p));});
test('structured-output-extraction',()=>{const x=extractStructured('{"response":"{\\"activate\\":true,\\"workflow\\":\\"new-feature\\"}"}',null,'activate');if(x?.workflow!=='new-feature')throw Error(JSON.stringify(x));});
test('token-usage-proxy-marked',()=>{const u=extractUsage('not-json','hello','world');if(u.source!=='PROXY_ESTIMATE'||!u.total_tokens)throw Error(JSON.stringify(u));});

function evidence(host,status='QUALIFIED',when=new Date().toISOString(),hash=packageDigest(host)){
  return {schema:'agent-sdlc/live-host-qualification/v1',version:VERSION,evaluated_at:when,host,tier:'FULL',status,promotion_evidence:status==='QUALIFIED',package:{file:`agent-sdlc-${host}-${VERSION}.zip`,sha256:hash,verified:true},bound_inputs:{corpus_sha256:corpusDigest(),qualification_subject_sha256:qualificationSubjectDigest()},preflight:{host_version:`${host} fake-1.0`},semantic_summary:{PASS:84,FAIL:0,SKIP:0,BLOCKED:0},repository_e2e_summary:{PASS:8,FAIL:0,SKIP:0,BLOCKED:0},required_semantic_case_count:84,required_repository_e2e_count:8,token_usage:{source:'ACTUAL_HOST_REPORTED',total_tokens:1000}};
}
function runAggregate(map,label){const out=path.join(tmp,`${label}-result.json`),approval=path.join(tmp,`${label}-approval.json`);const args=[path.join(ROOT,'scripts','qualify-release.mjs'),'--output',out,'--approval',approval];for(const h of HOSTS){const p=path.join(tmp,`${label}-${h}.json`);fs.writeFileSync(p,JSON.stringify(map[h],null,2));args.push('--evidence',`${h}=${p}`);}const r=spawnSync(process.execPath,args,{cwd:ROOT,encoding:'utf8'});return {code:r.status,out,approval,stdout:r.stdout,stderr:r.stderr};}
test('promotion-accepts-exact-fresh-qualified-evidence',()=>{const m=Object.fromEntries(HOSTS.map(h=>[h,evidence(h)]));const r=runAggregate(m,'good');if(r.code!==0||!fs.existsSync(r.approval))throw Error(`${r.code} ${r.stdout} ${r.stderr}`);const d=JSON.parse(fs.readFileSync(r.out,'utf8'));if(!d.promotion_to_rc_allowed)throw Error(JSON.stringify(d));});
test('promotion-rejects-package-digest-tamper',()=>{const m=Object.fromEntries(HOSTS.map(h=>[h,evidence(h)]));m.codex=evidence('codex','QUALIFIED',new Date().toISOString(),'0'.repeat(64));const r=runAggregate(m,'tamper');if(r.code!==1||fs.existsSync(r.approval))throw Error(`code=${r.code}`);});
test('promotion-rejects-stale-evidence',()=>{const m=Object.fromEntries(HOSTS.map(h=>[h,evidence(h)]));m.claude=evidence('claude','QUALIFIED',new Date(Date.now()-169*3600_000).toISOString());const r=runAggregate(m,'stale');if(r.code!==1||fs.existsSync(r.approval))throw Error(`code=${r.code}`);});
test('promotion-preserves-pending-as-exit-2',()=>{const m=Object.fromEntries(HOSTS.map(h=>[h,evidence(h)]));m.antigravity=evidence('antigravity','PENDING');m.antigravity.semantic_summary={PASS:0,FAIL:0,SKIP:84,BLOCKED:0};m.antigravity.repository_e2e_summary={PASS:0,FAIL:0,SKIP:8,BLOCKED:0};const r=runAggregate(m,'pending');if(r.code!==2||fs.existsSync(r.approval))throw Error(`code=${r.code}`);const d=JSON.parse(fs.readFileSync(r.out,'utf8'));if(d.status!=='LIVE_HOST_PENDING')throw Error(JSON.stringify(d));});

fs.rmSync(tmp,{recursive:true,force:true});
const report={schema:'agent-sdlc/qualification-harness-regression/v1',version:VERSION,checks:rows.length,passes:pass,failures:fail,results:rows};fs.mkdirSync(path.join(ROOT,'evals'),{recursive:true});fs.writeFileSync(path.join(ROOT,'evals','QUALIFICATION-HARNESS-REGRESSION.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));process.exit(fail?1:0);
