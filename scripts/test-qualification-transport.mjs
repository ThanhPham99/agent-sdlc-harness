#!/usr/bin/env node
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawnSync} from 'node:child_process';import {ROOT,VERSION,HOSTS} from './qualification-lib.mjs';
import {writeReport} from './lib/report-io.mjs';
let pass=0,fail=0;const rows=[];const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'agent-sdlc-transport-'));
function test(name,fn){try{fn();pass++;rows.push({name,status:'PASS'});}catch(e){fail++;rows.push({name,status:'FAIL',error:e.message});}}
for(const h of HOSTS){test(`smoke-transport-${h}`,()=>{const name=h==='antigravity'?'agy':h;const bin=path.join(tmp,name+'.mjs');fs.copyFileSync(path.join(ROOT,'evals','fake-host-cli.mjs'),bin);const out=path.join(tmp,`${h}.json`);const r=spawnSync(process.execPath,[path.join(ROOT,'scripts','qualify-host.mjs'),'--host',h,'--tier','SMOKE','--binary',bin,'--output',out],{cwd:ROOT,encoding:'utf8',timeout:120000,maxBuffer:20*1024*1024});if(r.status!==0)throw Error(`exit=${r.status} stderr=${(r.stderr||'').slice(-1000)} stdout=${(r.stdout||'').slice(-1000)}`);const d=JSON.parse(fs.readFileSync(out,'utf8'));if(d.status!=='QUALIFIED'||d.semantic_summary.PASS!==18||d.repository_e2e_summary.PASS!==2)throw Error(JSON.stringify({status:d.status,semantic:d.semantic_summary,e2e:d.repository_e2e_summary}));if(d.promotion_evidence!==false)throw Error('SMOKE must never be promotion evidence');if(d.token_usage.source!=='ACTUAL_HOST_REPORTED')throw Error(JSON.stringify(d.token_usage));});}
// Silence is not a wrong answer, and the run must not be QUALIFIED either.
// The fake host returns the exact shape Antigravity 1.1.23 returns when it
// says nothing: exit 0, a SUCCESS envelope, an empty response.
test('a-host-that-says-nothing-is-blocked-not-failed',()=>{
  const bin=path.join(tmp,'silent-claude.mjs');
  fs.copyFileSync(path.join(ROOT,'evals','fake-host-cli.mjs'),path.join(tmp,'claude.mjs'));
  fs.copyFileSync(path.join(ROOT,'evals','fake-host-cli.mjs'),bin);
  const out=path.join(tmp,'silent.json');
  const r=spawnSync(process.execPath,[path.join(ROOT,'scripts','qualify-host.mjs'),'--host','claude','--tier','SMOKE','--binary',path.join(tmp,'claude.mjs'),'--output',out],
    {cwd:ROOT,encoding:'utf8',timeout:120000,maxBuffer:20*1024*1024,env:{...process.env,FAKE_HOST_SILENT_ALL:'1'}});
  if(!fs.existsSync(out))throw Error(`no evidence written: ${(r.stderr||r.stdout||'').slice(-600)}`);
  const d=JSON.parse(fs.readFileSync(out,'utf8'));
  const rows=[...d.results,...d.repository_e2e_results];
  const graded=rows.filter(x=>x.status==='FAIL'&&x.reason==='NO_STRUCTURED_DECISION');
  if(graded.length)throw Error(`silence graded as a wrong answer: ${JSON.stringify(graded.map(x=>x.id))}`);
  const blocked=rows.filter(x=>x.status==='BLOCKED'&&x.reason==='HOST_RETURNED_NO_OUTPUT');
  if(blocked.length!==rows.length)throw Error(`${blocked.length} of ${rows.length} rows blocked: ${JSON.stringify(rows.map(x=>[x.id,x.status,x.reason]))}`);
  if(d.status==='QUALIFIED'||d.promotion_evidence)throw Error('a silent host was qualified');
  // host_silence spans the activation probe too, so it counts more rows than
  // the graded corpus does.
  const hs=d.host_silence;
  if(hs.cases<rows.length||hs.silent_after_retry!==hs.cases||hs.rescued_by_retry!==0)throw Error(JSON.stringify(hs));
  // Retried once, not more.
  if(rows.some(x=>x.attempts!==2))throw Error(`silence was not retried exactly once: ${JSON.stringify(rows.map(x=>x.attempts))}`);
});

// One retry is what makes an intermittently silent host measurable at all.
test('a-host-silent-once-is-rescued-by-one-retry-and-still-counted',()=>{
  const state=path.join(tmp,'silence-state');fs.mkdirSync(state,{recursive:true});
  fs.copyFileSync(path.join(ROOT,'evals','fake-host-cli.mjs'),path.join(tmp,'claude.mjs'));
  const out=path.join(tmp,'silent-once.json');
  const r=spawnSync(process.execPath,[path.join(ROOT,'scripts','qualify-host.mjs'),'--host','claude','--tier','SMOKE','--binary',path.join(tmp,'claude.mjs'),'--output',out],
    {cwd:ROOT,encoding:'utf8',timeout:120000,maxBuffer:20*1024*1024,env:{...process.env,FAKE_HOST_SILENT_ONCE_MATCH:'wishlist',FAKE_HOST_STATE_DIR:state}});
  if(!fs.existsSync(out))throw Error(`no evidence written: ${(r.stderr||r.stdout||'').slice(-600)}`);
  const d=JSON.parse(fs.readFileSync(out,'utf8'));
  if(d.status!=='QUALIFIED')throw Error(`one retry did not rescue the run: ${d.status} ${JSON.stringify(d.results.filter(x=>x.status!=='PASS'))}`);
  if(d.host_silence.silent_on_first_attempt!==1||d.host_silence.rescued_by_retry!==1||d.host_silence.silent_after_retry!==0)
    throw Error(JSON.stringify(d.host_silence));
  const retried=[...d.results,...d.repository_e2e_results].filter(x=>x.attempts===2);
  if(retried.length!==1)throw Error(`expected exactly one retried case: ${JSON.stringify(retried.map(x=>x.id))}`);
});

// A wrong answer is never retried; that would be fishing for a better score.
test('a-wrong-answer-is-not-retried',()=>{
  fs.copyFileSync(path.join(ROOT,'evals','fake-host-cli.mjs'),path.join(tmp,'claude.mjs'));
  const out=path.join(tmp,'baseline.json');
  spawnSync(process.execPath,[path.join(ROOT,'scripts','qualify-host.mjs'),'--host','claude','--tier','SMOKE','--binary',path.join(tmp,'claude.mjs'),'--output',out],
    {cwd:ROOT,encoding:'utf8',timeout:120000,maxBuffer:20*1024*1024});
  const d=JSON.parse(fs.readFileSync(out,'utf8'));
  const rows=[...d.results,...d.repository_e2e_results];
  // Only rows where a host actually ran carry attempts; a run that never got
  // past package validation produces rows with no attempt at all.
  const ran=rows.filter(x=>'attempts' in x);
  if(!ran.length)throw Error('no case reached the host');
  if(ran.some(x=>x.attempts!==1))throw Error(`a case was retried without silence: ${JSON.stringify(ran.filter(x=>x.attempts!==1).map(x=>[x.id,x.reason]))}`);
  if(d.host_silence.silent_on_first_attempt!==0)throw Error(JSON.stringify(d.host_silence));
});

fs.rmSync(tmp,{recursive:true,force:true});const report={schema:'agent-sdlc/qualification-transport-regression/v1',version:VERSION,checks:rows.length,passes:pass,failures:fail,results:rows};writeReport(path.join(ROOT,'evals','QUALIFICATION-TRANSPORT-REGRESSION.json'),report);console.log(JSON.stringify(report,null,2));process.exit(fail?1:0);
