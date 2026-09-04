#!/usr/bin/env node
// CI coverage vs. the `check` script.
//
// `npm run check` is the documented local gate and enumerates every offline
// suite. `.github/workflows/ci.yml` enumerated its own list by hand, and the
// two drifted: test:gates, test:tasks, test:alpha6 and both qualification
// suites were green locally but ungated in CI, so a regression in the task
// engine, plan-quality gates or learning runtime could merge unnoticed.
//
// This asserts every suite reachable from `check` is actually run by CI, either
// directly or through an aggregate script CI invokes (`test:integrity` covers
// its four children). Named steps are kept so a failure says which suite broke;
// drift now fails instead of silently narrowing the gate.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {jobScriptSequence} from './lib/ci-workflow.mjs';
import {STAGES,planScripts} from './lib/check-plan.mjs';
import {writeReport} from './lib/report-io.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const pkg=JSON.parse(fs.readFileSync(path.join(ROOT,'package.json'),'utf8'));
const VERSION=JSON.parse(fs.readFileSync(path.join(ROOT,'agent-sdlc.manifest.json'),'utf8')).version;
const WORKFLOW='.github/workflows/ci.yml';
const ci=fs.readFileSync(path.join(ROOT,WORKFLOW),'utf8');

// F5: this used to scan the whole file as one blob, so a suite present only
// in windows-validation -- an intentional, documented SUBSET of the full gate
// for platform-sensitive suites, not a second complete gate -- could satisfy
// membership meant for the complete chain. offline-validation is the job that
// runs every suite `check` reaches; it is the one this validator holds to the
// full chain. Not configurable from outside this file: which job is "the full
// gate" is a fact about this specific workflow, not something a suite
// argument should be able to redirect.
const FULL_GATE_JOB='offline-validation';

// F4: `check`'s subject suites ran once for pass/fail inside offline-validation
// and test:coverage then re-ran all 16 of them again under NODE_V8_COVERAGE --
// the longest segment of the run, on every CI leg that measured it. Nothing
// downstream (verify:dist, package:release) reads evals/COVERAGE.json, and
// none of coverage-report.mjs's own subject suites need a built package, so
// test:coverage moved to its own job (`coverage-floor`) that starts alongside
// offline-validation instead of running at its tail -- wall-clock drops by
// roughly the coverage step's own duration instead of adding it serially.
// A suite named here is checked for membership/order against THAT job
// instead of FULL_GATE_JOB. This is a deliberate, explicit relocation of one
// suite to its own dedicated job -- not a general escape hatch -- so it does
// not reopen the job-blindness F5 fixed: a suite with no entry here still
// must run inside FULL_GATE_JOB specifically.
const ALTERNATE_JOB={'test:coverage':'coverage-floor'};

const CHECK_SCRIPT='check';

// Suites CI is allowed to skip, with the reason. Live host qualification needs
// provider credentials and runs from live-qualification.yml instead.
// F14: restore-tracked-reports' whole purpose is local git-tree hygiene after
// `npm run check` -- CI's checkout is discarded after the job and the freshly
// written reports are what CI uploads as artifacts, so it is a deliberate
// no-op there (checked via `process.env.CI`, which GitHub Actions always
// sets) rather than a suite CI is expected to run at all.
const EXEMPT={'restore-tracked-reports':'local git-tree hygiene only; a documented no-op in CI'};

/**
 * npm scripts a script body invokes, in order.
 *
 * `check` is the exception: it is no longer an `&&` chain to read but a runner
 * over scripts/lib/check-plan.mjs, so its children come from the plan. That is
 * the point of the plan -- one declaration the runner executes and this
 * validator holds CI to, instead of a string both had to parse.
 */
function children(name){
  if(name===CHECK_SCRIPT)return planScripts();
  const body=pkg.scripts[name];
  if(!body)return [];
  const out=[...body.matchAll(/npm run ([a-z0-9:-]+)/g)].map(m=>m[1]);
  if(/(^|&&\s*)npm test(\s|$)/.test(body)&&!out.includes('test'))out.unshift('test');
  return out;
}

// One extraction, shared by membership and order: a `run:` line naming a
// script, in the order it appears within its job. Membership used to
// substring-match the whole file (so a mention inside a comment would have
// satisfied it too); this is now exactly what order-checking already used.
// Cached per job since a suite can name a different job than the default.
const jobSequenceCache=new Map();
function sequenceFor(jobName){
  if(!jobSequenceCache.has(jobName))jobSequenceCache.set(jobName,jobScriptSequence(ci,jobName));
  return jobSequenceCache.get(jobName);
}
const ciSequence=sequenceFor(FULL_GATE_JOB);

/** true when the job this script is meant to run in actually runs it. */
const invoked=name=>sequenceFor(ALTERNATE_JOB[name]||FULL_GATE_JOB).includes(name);

/**
 * Leaf suites reachable from `check`, each with the ancestor chain that could
 * satisfy it. A leaf is gated when CI invokes it or any of its ancestors.
 */
function leaves(name,chain=[],seen=new Set()){
  if(seen.has(name))return [];
  const kids=children(name);
  if(!kids.length)return [{script:name,covered_by:[name,...chain]}];
  const nextSeen=new Set([...seen,name]);
  return kids.flatMap(k=>leaves(k,[name,...chain],nextSeen));
}

const rows=leaves(CHECK_SCRIPT).map(({script,covered_by})=>{
  if(EXEMPT[script])return {script,status:'EXEMPT',reason:EXEMPT[script],problems:[]};
  const via=covered_by.filter(n=>n!==CHECK_SCRIPT).find(invoked)||null;
  const job=ALTERNATE_JOB[script]||FULL_GATE_JOB;
  const problems=via?[]:[`\`npm run ${script}\` is reachable from \`npm run ${CHECK_SCRIPT}\` but ${WORKFLOW}'s \`${job}\` job never runs it (directly or via ${covered_by.filter(n=>n!==script&&n!==CHECK_SCRIPT).join(', ')||'an aggregate'}) -- another job running it does not count`];
  return {script,status:problems.length?'FAIL':'PASS',gated_via:via,problems};
});

// A workflow that runs nothing at all must not pass by vacuum.
if(!rows.length)rows.push({script:CHECK_SCRIPT,status:'FAIL',problems:[`no suites reachable from \`npm run ${CHECK_SCRIPT}\`; the check chain is empty`]});

/**
 * Order, not just membership. Checking only that a suite appears somewhere let
 * CI run the qualification suites before `build`, so they validated packages
 * that did not exist yet and every case failed with PACKAGE_VALIDATION_FAILED.
 * The chain encodes real dependencies; CI must respect them.
 */
// A script running in its own parallel job has no sequential relationship to
// FULL_GATE_JOB's steps to check -- parallel jobs have no relative order.
// An EXEMPT script is never run by CI at all, so it has no position in
// ciSequence to check order against either.
//
// Order is judged per STAGE, not per script. The plan's stage boundaries are
// the real dependencies (nothing reads dist/ before `build` writes it); within
// a stage the suites run concurrently, so their relative order in CI carries no
// meaning and must not be asserted. Holding CI to the old flat chain would have
// demanded an order the plan itself does not have.
const runnable=s=>!ALTERNATE_JOB[s]&&!EXEMPT[s];
const orderProblems=[];
let cursor=-1,previousStage=null;
for(const stage of STAGES){
  const present=stage.parallel.filter(runnable).filter(s=>ciSequence.includes(s));
  if(!present.length)continue;
  const positions=present.map(s=>({script:s,at:ciSequence.indexOf(s)}));
  for(const p of positions.filter(p=>p.at<=cursor)){
    orderProblems.push(`\`${p.script}\` is in the \`${stage.name}\` stage of \`${CHECK_SCRIPT}\`, which runs after the \`${previousStage}\` stage, but ${WORKFLOW}'s \`${FULL_GATE_JOB}\` job runs it before that stage completes`);
  }
  cursor=Math.max(cursor,...positions.map(p=>p.at));
  previousStage=stage.name;
}
if(orderProblems.length)rows.push({script:`${CHECK_SCRIPT} (step order)`,status:'FAIL',problems:orderProblems});

const failures=rows.filter(r=>r.status==='FAIL');
const report={
  schema:'agent-sdlc/ci-coverage-validation/v1',
  version:VERSION,
  workflow:WORKFLOW,
  check_script:CHECK_SCRIPT,
  checks:rows.length,
  passes:rows.filter(r=>r.status==='PASS').length,
  failures:failures.length,
  suites:rows,
  status:failures.length?'FAIL':'PASS'
};
writeReport(path.join(ROOT,'evals','CI-COVERAGE-VALIDATION.json'),report);
console.log(JSON.stringify({...report,suites:failures.length?failures:'all-gated'},null,2));
process.exit(failures.length?1:0);
