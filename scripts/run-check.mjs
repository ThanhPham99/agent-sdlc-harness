#!/usr/bin/env node
// `npm run check` -- the documented local gate.
//
// Runs scripts/lib/check-plan.mjs: stages in sequence, the suites within a
// stage concurrently. Two behaviours differ from the `&&` chain it replaced,
// both deliberate:
//
//   Every suite in a stage runs even after one of them fails, so one run tells
//   you about every broken suite in that stage rather than the first. A failed
//   stage still stops the run before the next one -- there is no point building
//   distributions from a tree whose runtime suites are red.
//
//   Output is captured per suite and printed grouped, not interleaved. Thirteen
//   concurrent processes writing to one terminal produce unreadable output.
//   A passing suite prints one line; a failing one prints its captured output
//   in full, because that is the output you actually need.
//
// --serial falls back to one-at-a-time with live output, for when a suite is
// misbehaving and the interleaving is the thing you want to see.
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {STAGES} from './lib/check-plan.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const SERIAL=process.argv.includes('--serial');
// `npm run check -- --update` could not work while `check` was an `&&` chain:
// npm appends extra args to the END of the whole chain's text, so they landed
// on restore-tracked-reports' invocation without the `--` npm needs, and
// `--update` silently expanded to `--update-notifier`. With a single runner in
// front there is one argv to read, so the flag documented in
// scripts/restore-tracked-reports.mjs finally reaches it -- forwarded through
// the env var, which is the form that suite already honours.
const KEEP_REPORTS=process.argv.includes('--update')||process.argv.includes('--keep-reports');
// One process per core is the useful ceiling here: every suite is CPU-bound
// node work, and oversubscribing only lengthens the slowest one.
const LIMIT=SERIAL?1:Math.max(1,Math.min(STAGES[0].parallel.length,os.availableParallelism?.()??os.cpus().length));

const ms=n=>`${(n/1000).toFixed(1)}s`;

function runScript(script){
  // A shell, and a command string rather than an args array: npm on Windows is
  // npm.cmd, which spawn will not find without one, and passing an args array
  // WITH a shell is deprecated (DEP0190) because the args are concatenated
  // unescaped. Nothing untrusted reaches here -- the names come from the plan
  // module, not from argv -- but the warning is noise on every run.
  // `npm test` is not `npm run test` to npm's CLI; the plan names the script,
  // and the runner spells the invocation.
  const command=script==='test'?'npm test':`npm run ${script}`;
  const started=Date.now();
  return new Promise(resolve=>{
    const child=spawn(command,{cwd:ROOT,shell:true,
      env:KEEP_REPORTS?{...process.env,AGENT_SDLC_KEEP_REPORTS:'1'}:process.env,
      stdio:SERIAL?'inherit':['ignore','pipe','pipe']});
    let out='';
    if(!SERIAL){
      child.stdout.on('data',d=>{out+=d;});
      child.stderr.on('data',d=>{out+=d;});
    }
    child.on('error',e=>resolve({script,code:1,ms:Date.now()-started,output:`failed to spawn \`${command}\`: ${e.message}`}));
    child.on('close',code=>resolve({script,code:code??1,ms:Date.now()-started,output:out}));
  });
}

/** Run `scripts` with at most LIMIT in flight, preserving result order. */
async function runStage(scripts){
  const results=new Array(scripts.length);
  let next=0;
  const worker=async()=>{
    while(next<scripts.length){
      const i=next++;
      const r=await runScript(scripts[i]);
      results[i]=r;
      console.log(`${r.code===0?'PASS':'FAIL'}  ${scripts[i].padEnd(28)} ${ms(r.ms)}`);
    }
  };
  await Promise.all(Array.from({length:Math.min(LIMIT,scripts.length)},worker));
  return results;
}

const started=Date.now();
const all=[];
let failed=[];
for(const stage of STAGES){
  console.log(`\n== ${stage.name} (${stage.parallel.length} suite${stage.parallel.length===1?'':'s'}${LIMIT>1&&stage.parallel.length>1?`, up to ${LIMIT} at a time`:''})`);
  const results=await runStage(stage.parallel);
  all.push(...results);
  failed=results.filter(r=>r.code!==0);
  if(failed.length)break;
}

if(failed.length){
  for(const r of failed){
    console.log(`\n---- ${r.script} (exit ${r.code}) ----`);
    console.log(r.output.trimEnd()||'(no output)');
  }
}
console.log(`\n${JSON.stringify({schema:'agent-sdlc/check-run/v1',
  suites:all.length,passes:all.filter(r=>r.code===0).length,failures:failed.length,
  failed:failed.map(r=>r.script),wall_clock:ms(Date.now()-started),
  status:failed.length?'FAIL':'PASS'},null,2)}`);
process.exit(failed.length?1:0);
