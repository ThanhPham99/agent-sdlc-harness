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
import {spawn,spawnSync} from 'node:child_process';
import {planScripts} from './lib/check-plan.mjs';
import {writeReport} from './lib/report-io.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const FLOOR_FILE=path.join(ROOT,'evals','COVERAGE-FLOOR.json');
// Spawned children inherit NODE_V8_COVERAGE and write into the same directory,
// so the CLI contract suite contributes the coverage of every CLI process it
// starts. Without it runtime/cli.mjs -- the largest module, and the surface the
// skills tell the model to call -- measured zero.
// Every offline suite that exercises runtime/. This list is the measurement's
// definition of "the suite", so a suite left out of it does not just go
// uncounted -- the modules it covers are reported as untested, which sends the
// next person to write tests that already exist. runtime/codex-bootstrap.mjs
// read 40% while thirteen dedicated tests were passing, because
// test-codex-bootstrap.mjs was not listed here.
const ENTRIES=[
  'evals/run-deterministic.mjs',
  'scripts/test-cli-contract.mjs',
  'scripts/test-normalize.mjs',
  'scripts/test-provider.mjs',
  'scripts/test-compat.mjs',
  'scripts/test-mcp.mjs',
  'scripts/test-project-detection.mjs',
  'scripts/test-auto-bootstrap.mjs',
  'scripts/test-claude-bootstrap-hook.mjs',
  'scripts/test-antigravity-bootstrap-hook.mjs',
  'scripts/test-codex-bootstrap.mjs',
  'scripts/test-dev-link.mjs',
  'scripts/validate-gates.mjs',
  'scripts/validate-task-engine.mjs',
  'scripts/validate-alpha6.mjs',
  'scripts/validate-cli-surface.mjs',
  'scripts/test-prompt-caching.mjs',
  'scripts/test-error-triage.mjs',
  'scripts/test-worktree-isolation.mjs',
  'scripts/test-live-dashboard.mjs',
  'scripts/test-parallel-execution.mjs',
  'scripts/test-secret-scanner.mjs',
  'scripts/test-budget-governor.mjs',
  'scripts/test-tui.mjs',
  'scripts/test-adaptive-fallback.mjs',
  'scripts/test-failure-memory.mjs',
  'scripts/test-flaky-detector.mjs',
  'scripts/test-mcp-gateway.mjs',
  'scripts/test-test-impact.mjs',
  'scripts/test-pr-synthesizer.mjs',
  'scripts/test-security-linter.mjs',
  'scripts/test-webhook-retry.mjs',
  'scripts/test-sse-stream.mjs',
  'scripts/test-dead-code.mjs',
  'scripts/test-arch-linter.mjs'
];

// Suites deliberately not measured, each with the reason. Naming them rather
// than merely leaving them out is what makes the completeness check below
// possible: a new suite has to be classified, not silently forgotten.
const NOT_MEASURED={
  'scripts/build-dist.mjs':'produces the packaged tree; measures no runtime behaviour',
  'scripts/verify-dist.mjs':'measures a built tree, not this one',
  'scripts/package-release.mjs':'aggregates reports into a release candidate',
  'scripts/coverage-report.mjs':'this script',
  'scripts/test-qualification-harness.mjs':'needs the built packages; would tie coverage to build order',
  'scripts/test-qualification-transport.mjs':'needs the built packages; would tie coverage to build order',
  'scripts/test-github-installers.mjs':'drives installers against fake host CLIs, outside runtime/',
  'scripts/validate-github-install.mjs':'checks install surfaces, not runtime behaviour',
  'scripts/validate-versions.mjs':'file consistency check; never enters runtime/',
  'scripts/validate-registry.mjs':'file consistency check; never enters runtime/',
  'scripts/validate-root-sync.mjs':'file consistency check; never enters runtime/',
  'scripts/validate-ci-coverage.mjs':'checks the CI step list; never enters runtime/',
  'scripts/validate-guard.mjs':'runs the host guard in adapters/, outside runtime/',
  'scripts/validate-test-output-guard.mjs':'runs the host guard in adapters/, outside runtime/',
  'scripts/test-statusline.mjs':'exercises the opt-in statusline script in adapters/, outside runtime/',
  'scripts/validate-syntax.mjs':'parses each .mjs file with `node --check`; never imports or executes runtime/',
  'scripts/restore-tracked-reports.mjs':'local git-tree hygiene (git status/checkout on evals/); never enters runtime/',
  'scripts/test-restore-tracked-reports.mjs':'exercises restore-tracked-reports.mjs against a throwaway git fixture; never enters runtime/',
  'scripts/test-root-sync.mjs':'exercises validate-root-sync.mjs against a throwaway file tree; never enters runtime/',
  'scripts/validate-types.mjs':'validates type definitions; never enters runtime/',
  'scripts/run-check.mjs':'runs the other suites as child processes; never enters runtime/ itself, and each child is measured on its own'
};

/**
 * Every suite `check` runs, expanded through its npm-script aliases.
 *
 * The suite list comes from scripts/lib/check-plan.mjs, not from parsing an
 * `&&` chain. When `check` became a runner over that plan, chain-parsing found
 * exactly one file -- the runner itself -- and this completeness check, whose
 * entire job is to refuse an unclassified suite, silently went vacuous.
 */
function checkChainSuites(){
  const scripts=JSON.parse(fs.readFileSync(path.join(ROOT,'package.json'),'utf8')).scripts;
  const expand=cmd=>String(cmd||'').split('&&').map(s=>s.trim())
    .flatMap(s=>s.startsWith('npm run ')?expand(scripts[s.slice(8).trim()]):[s]);
  return [...new Set(planScripts().flatMap(name=>expand(scripts[name]))
    .flatMap(c=>[...c.matchAll(/(?:scripts|evals)\/[a-z0-9-]+\.mjs/g)].map(m=>m[0])))];
}

const SUBJECT_DIR=path.join(ROOT,'runtime');
const update=process.argv.includes('--update');

// A suite missing from ENTRIES does not merely go uncounted: the modules it
// covers are reported as untested, which sends the next person to write tests
// that already exist. Classify every suite, one way or the other.
const unclassified=checkChainSuites().filter(s=>!ENTRIES.includes(s)&&!NOT_MEASURED[s]);
if(unclassified.length){
  console.error(`coverage measures an incomplete suite list. Add each of these to ENTRIES, or to NOT_MEASURED with the reason it cannot be measured:\n  ${unclassified.join('\n  ')}`);
  process.exit(1);
}

const outDir=fs.mkdtempSync(path.join(os.tmpdir(),'agent-sdlc-cov-'));
const concurrency=Math.max(1,Math.min(ENTRIES.length,os.availableParallelism?.()??os.cpus().length));

function runEntry(entry){
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[entry],{
      cwd:ROOT,
      env:{...process.env,NODE_V8_COVERAGE:outDir},
      stdio:['ignore','pipe','pipe']
    });
    let err='';
    child.stderr.on('data',d=>{err+=d;});
    child.on('error',reject);
    child.on('close',code=>{
      if(code===0)resolve();
      else reject(new Error(`coverage subject failed (${entry} exited ${code}); fix the suite before measuring\n${err}`));
    });
  });
}

let nextIdx=0;
const workers=Array.from({length:concurrency},async()=>{
  while(nextIdx<ENTRIES.length){
    const i=nextIdx++;
    await runEntry(ENTRIES[i]);
  }
});
await Promise.all(workers);

const files=fs.readdirSync(outDir).filter(f=>f.startsWith('coverage-')&&f.endsWith('.json'));
if(!files.length){console.error(`no coverage output in ${outDir}`);process.exit(1);}

const subjectPrefix=pathToFileURL(SUBJECT_DIR+path.sep).href;
// One entry per module: every process that loaded it contributes its own range
// set. The CLI is a long if/else chain, so each spawned process executes exactly
// one branch -- taking the best single process instead of the union of them all
// reported 10% for a module the suite actually walks through end to end.
const instances=new Map();

for(const f of files){
  const doc=JSON.parse(fs.readFileSync(path.join(outDir,f),'utf8'));
  for(const script of doc.result||[]){
    if(!script.url.startsWith(subjectPrefix))continue;
    const rel=path.relative(ROOT,fileURLToPath(script.url)).split(path.sep).join('/');
    const ranges=[];
    for(const fn of script.functions||[])for(const r of fn.ranges||[])ranges.push(r);
    if(!ranges.length)continue;
    if(!instances.has(rel))instances.set(rel,[]);
    instances.get(rel).push(ranges);
  }
}

const byFile=new Map();
for(const [rel,runs] of instances){
  const total=Math.max(...runs.flat().map(r=>r.endOffset));
  if(!total)continue;
  const union=new Uint8Array(total);
  for(const ranges of runs){
    // Outermost first, so a nested range overwrites its parent's verdict within
    // this process; the result is then OR-ed into the union.
    ranges.sort((a,b)=>a.startOffset-b.startOffset||b.endOffset-a.endOffset);
    const covered=new Uint8Array(total);
    for(const r of ranges)covered.fill(r.count>0?1:0,r.startOffset,Math.min(r.endOffset,total));
    for(let i=0;i<total;i++)if(covered[i])union[i]=1;
  }
  let hit=0;for(let i=0;i<total;i++)if(union[i])hit++;
  byFile.set(rel,{covered:hit,total});
}

// Modules the suite never loaded at all do not appear in the coverage output.
// The sweep recurses: the commands each live in runtime/commands/ now, and a
// top-level-only listing would have made a whole command module that no test
// ever loads invisible to the ratchet rather than reporting it at 0%.
function subjectFiles(dir=SUBJECT_DIR){
  return fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>{
    const full=path.join(dir,e.name);
    if(e.isDirectory())return subjectFiles(full);
    return e.name.endsWith('.mjs')?[full]:[];
  });
}
const loaded=new Set(byFile.keys());
for(const full of subjectFiles()){
  const rel=`runtime/${path.relative(SUBJECT_DIR,full).split(path.sep).join('/')}`;
  if(!loaded.has(rel))byFile.set(rel,{covered:0,total:fs.statSync(full).size,never_loaded:true});
}

const pct=({covered,total})=>total?Math.round((covered/total)*1000)/10:0;
const modules=[...byFile.entries()].map(([file,v])=>({file,percent:pct(v),covered_bytes:v.covered,total_bytes:v.total,...(v.never_loaded?{never_loaded:true}:{})}))
  .sort((a,b)=>a.percent-b.percent||a.file.localeCompare(b.file));
const totals=modules.reduce((a,m)=>({covered:a.covered+m.covered_bytes,total:a.total+m.total_bytes}),{covered:0,total:0});
const overall=pct(totals);

// Some subjects skip work when an external tool is absent -- the OOXML parsers
// need `unzip`, the PDF path needs `pdftotext` -- which lowers the measured
// number for reasons that are not a regression. On such a machine the floor is
// advisory, so a contributor is not sent hunting a phantom drop. CI has the
// tools, so the gate stays real there.
const optionalTools=Object.fromEntries(['unzip','pdftotext'].map(bin=>{
  const r=spawnSync(bin,['--help'],{encoding:'utf8',timeout:3000});
  return [bin,!r.error];
}));
const missingTools=Object.entries(optionalTools).filter(([,present])=>!present).map(([bin])=>bin);

const floor=fs.existsSync(FLOOR_FILE)?JSON.parse(fs.readFileSync(FLOOR_FILE,'utf8')):null;
const problems=[];
const advisory=[];

// The global floor is an average, so a well-covered module can hide a weak
// one: runtime/commands/* -- the surface skills instruct the model to call --
// sat at 70.9-75.2% per file while the 90% global floor was untouched. A
// per-path floor makes that specific layer's regression visible on its own,
// not just averaged away.
function pathAggregate(prefix){
  const matched=modules.filter(m=>m.file.startsWith(prefix));
  const totals=matched.reduce((a,m)=>({covered:a.covered+m.covered_bytes,total:a.total+m.total_bytes}),{covered:0,total:0});
  return {percent:pct(totals),...totals};
}
const pathFloors=floor?.path_floors||{};
const pathReport=Object.fromEntries(Object.keys(pathFloors).map(prefix=>[prefix,pathAggregate(prefix)]));

if(floor&&!update&&missingTools.length){
  if(overall<floor.overall_percent)advisory.push(`overall runtime coverage is ${overall}% against a floor of ${floor.overall_percent}%, but ${missingTools.join(' and ')} ${missingTools.length>1?'are':'is'} not installed here, so suites that need ${missingTools.length>1?'them':'it'} skipped; not treated as a regression`);
}
else if(floor&&!update){
  if(overall<floor.overall_percent)problems.push(`overall runtime coverage fell to ${overall}% (floor ${floor.overall_percent}%)`);
  // A module that used to be executed and now is not is a coverage regression
  // even when the overall percentage still clears the floor.
  const regressed=modules.filter(m=>m.never_loaded&&!(floor.never_loaded||[]).includes(m.file));
  for(const m of regressed)problems.push(`${m.file} is no longer executed by any coverage subject`);
  for(const [prefix,need] of Object.entries(pathFloors)){
    const got=pathReport[prefix].percent;
    if(got<need)problems.push(`${prefix} coverage fell to ${got}% (floor ${need}%)`);
  }
}

const report={
  schema:'agent-sdlc/coverage-report/v1',
  subjects:ENTRIES,
  measured:'v8-block-bytes',
  overall_percent:overall,
  covered_bytes:totals.covered,
  total_bytes:totals.total,
  modules,
  never_loaded:modules.filter(m=>m.never_loaded).map(m=>m.file),
  floor:floor?{overall_percent:floor.overall_percent,never_loaded:floor.never_loaded||[],path_floors:pathFloors}:null,
  path_coverage:pathReport,
  optional_tools:optionalTools,
  problems,
  ...(advisory.length?{advisory}:{}),
  status:problems.length?'FAIL':'PASS'
};
writeReport(path.join(ROOT,'evals','COVERAGE.json'),report);
if(update){
  fs.writeFileSync(FLOOR_FILE,JSON.stringify({
    schema:'agent-sdlc/coverage-floor/v1',
    note:'Ratchet, not a target. Raise it with scripts/coverage-report.mjs --update when coverage improves; a drop fails CI.',
    overall_percent:Math.floor(overall),
    never_loaded:report.never_loaded,
    path_floors:Object.fromEntries(Object.keys(pathFloors).map(prefix=>[prefix,Math.floor(pathReport[prefix].percent)]))
  },null,2)+'\n');
}
console.log(JSON.stringify({...report,modules:modules.slice(0,12)},null,2));
process.exit(problems.length?1:0);
