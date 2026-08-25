#!/usr/bin/env node
// Coverage signal for the runtime, with no dependencies.
//
// The eval suites are hand-rolled runners that report pass/fail only, so there
// was no way to see which runtime modules they never execute. V8's own coverage
// output (NODE_V8_COVERAGE) needs no test framework and no packages: run the
// deterministic suite under it and summarize what it touched.
//
// The metric is V8 block coverage in bytes, innermost range wins. It answers the
// question that matters here -- which modules and branches the suite never
// reaches -- not a line-precise industry number.
//
//   node scripts/coverage-report.mjs            measure and enforce the floor
//   node scripts/coverage-report.mjs --update   rewrite the recorded floor
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const FLOOR_FILE=path.join(ROOT,'evals','COVERAGE-FLOOR.json');
const ENTRY='evals/run-deterministic.mjs';
const SUBJECT_DIR=path.join(ROOT,'runtime');
const update=process.argv.includes('--update');

const outDir=fs.mkdtempSync(path.join(os.tmpdir(),'agent-sdlc-cov-'));
const run=spawnSync(process.execPath,[ENTRY],{cwd:ROOT,encoding:'utf8',
  env:{...process.env,NODE_V8_COVERAGE:outDir},maxBuffer:64*1024*1024});
if(run.status!==0){
  console.error(`coverage subject failed (${ENTRY} exited ${run.status}); fix the suite before measuring`);
  process.exit(run.status||1);
}

const files=fs.readdirSync(outDir).filter(f=>f.startsWith('coverage-')&&f.endsWith('.json'));
if(!files.length){console.error(`no coverage output in ${outDir}`);process.exit(1);}

const subjectPrefix=pathToFileURL(SUBJECT_DIR+path.sep).href;
// url -> covered/total bytes. A module loaded by several processes is merged by
// taking the best result, not by summing bytes.
const byFile=new Map();

for(const f of files){
  const doc=JSON.parse(fs.readFileSync(path.join(outDir,f),'utf8'));
  for(const script of doc.result||[]){
    if(!script.url.startsWith(subjectPrefix))continue;
    const rel=path.relative(ROOT,fileURLToPath(script.url)).split(path.sep).join('/');
    const ranges=[];
    for(const fn of script.functions||[])for(const r of fn.ranges||[])ranges.push(r);
    if(!ranges.length)continue;
    const total=Math.max(...ranges.map(r=>r.endOffset));
    if(!total)continue;
    // Outermost first, so a nested range overwrites its parent's verdict.
    ranges.sort((a,b)=>a.startOffset-b.startOffset||b.endOffset-a.endOffset);
    const covered=new Uint8Array(total);
    for(const r of ranges)covered.fill(r.count>0?1:0,r.startOffset,Math.min(r.endOffset,total));
    let hit=0;for(let i=0;i<total;i++)if(covered[i])hit++;
    const prev=byFile.get(rel);
    const pct=hit/total;
    if(!prev||pct>prev.covered/prev.total)byFile.set(rel,{covered:hit,total});
  }
}

// Modules the suite never loaded at all do not appear in the coverage output.
const loaded=new Set(byFile.keys());
for(const name of fs.readdirSync(SUBJECT_DIR).filter(f=>f.endsWith('.mjs'))){
  const rel=`runtime/${name}`;
  if(!loaded.has(rel))byFile.set(rel,{covered:0,total:fs.statSync(path.join(SUBJECT_DIR,name)).size,never_loaded:true});
}

const pct=({covered,total})=>total?Math.round((covered/total)*1000)/10:0;
const modules=[...byFile.entries()].map(([file,v])=>({file,percent:pct(v),covered_bytes:v.covered,total_bytes:v.total,...(v.never_loaded?{never_loaded:true}:{})}))
  .sort((a,b)=>a.percent-b.percent||a.file.localeCompare(b.file));
const totals=modules.reduce((a,m)=>({covered:a.covered+m.covered_bytes,total:a.total+m.total_bytes}),{covered:0,total:0});
const overall=pct(totals);

const floor=fs.existsSync(FLOOR_FILE)?JSON.parse(fs.readFileSync(FLOOR_FILE,'utf8')):null;
const problems=[];
if(floor&&!update){
  if(overall<floor.overall_percent)problems.push(`overall runtime coverage fell to ${overall}% (floor ${floor.overall_percent}%)`);
  // A module that used to be executed and now is not is a coverage regression
  // even when the overall percentage still clears the floor.
  const regressed=modules.filter(m=>m.never_loaded&&!(floor.never_loaded||[]).includes(m.file));
  for(const m of regressed)problems.push(`${m.file} is no longer executed by ${ENTRY}`);
}

const report={
  schema:'agent-sdlc/coverage-report/v1',
  subject:ENTRY,
  measured:'v8-block-bytes',
  overall_percent:overall,
  covered_bytes:totals.covered,
  total_bytes:totals.total,
  modules,
  never_loaded:modules.filter(m=>m.never_loaded).map(m=>m.file),
  floor:floor?{overall_percent:floor.overall_percent,never_loaded:floor.never_loaded||[]}:null,
  problems,
  status:problems.length?'FAIL':'PASS'
};
fs.writeFileSync(path.join(ROOT,'evals','COVERAGE.json'),JSON.stringify(report,null,2)+'\n');
if(update){
  fs.writeFileSync(FLOOR_FILE,JSON.stringify({
    schema:'agent-sdlc/coverage-floor/v1',
    note:'Ratchet, not a target. Raise it with scripts/coverage-report.mjs --update when coverage improves; a drop fails CI.',
    overall_percent:Math.floor(overall),
    never_loaded:report.never_loaded
  },null,2)+'\n');
}
console.log(JSON.stringify({...report,modules:modules.slice(0,12)},null,2));
process.exit(problems.length?1:0);
