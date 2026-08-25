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

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const pkg=JSON.parse(fs.readFileSync(path.join(ROOT,'package.json'),'utf8'));
const VERSION=JSON.parse(fs.readFileSync(path.join(ROOT,'agent-sdlc.manifest.json'),'utf8')).version;
const WORKFLOW='.github/workflows/ci.yml';
const ci=fs.readFileSync(path.join(ROOT,WORKFLOW),'utf8');

// Suites CI is allowed to skip, with the reason. Live host qualification needs
// provider credentials and runs from live-qualification.yml instead.
const EXEMPT={};

const CHECK_SCRIPT='check';

/** npm scripts a script body invokes, in order. */
function children(name){
  const body=pkg.scripts[name];
  if(!body)return [];
  const out=[...body.matchAll(/npm run ([a-z0-9:-]+)/g)].map(m=>m[1]);
  if(/(^|&&\s*)npm test(\s|$)/.test(body)&&!out.includes('test'))out.unshift('test');
  return out;
}

/** true when CI runs this exact script. */
const invoked=name=>name==='test'
  ? ci.includes('npm test')||ci.includes('npm run test ')
  : ci.includes(`npm run ${name}`);

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
  const problems=via?[]:[`\`npm run ${script}\` is reachable from \`npm run ${CHECK_SCRIPT}\` but ${WORKFLOW} never runs it (directly or via ${covered_by.filter(n=>n!==script&&n!==CHECK_SCRIPT).join(', ')||'an aggregate'})`];
  return {script,status:problems.length?'FAIL':'PASS',gated_via:via,problems};
});

// A workflow that runs nothing at all must not pass by vacuum.
if(!rows.length)rows.push({script:CHECK_SCRIPT,status:'FAIL',problems:[`no suites reachable from \`npm run ${CHECK_SCRIPT}\`; the check chain is empty`]});

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
fs.writeFileSync(path.join(ROOT,'evals','CI-COVERAGE-VALIDATION.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({...report,suites:failures.length?failures:'all-gated'},null,2));
process.exit(failures.length?1:0);
