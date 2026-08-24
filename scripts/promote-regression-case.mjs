#!/usr/bin/env node
// Promote a real failure into a candidate regression fixture.
//
// Writes to evals/regressions/candidates/ only. Nothing here edits a policy or
// an existing eval corpus: a candidate must pass deterministic eval and human
// review before adoption, and this script refuses to pretend otherwise.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildRegressionCandidate,validateRegressionCandidate,toEvalCase,LEARNING_SOURCES} from '../runtime/learning.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const argv=process.argv.slice(2);
const val=k=>{const i=argv.indexOf(k);return i>=0?argv[i+1]:null;};
const has=k=>argv.includes(k);

if(has('--help')||!argv.length){
  console.log(`usage: promote-regression-case.mjs --source <SOURCE> --title "..." --observed "..." --expected "..."
              [--failure-class C] [--run-id id] [--task-id id] [--paths a,b] [--evidence ref,ref]
              [--diagnostic "..."] [--policy-hypothesis "..."] [--project-root dir] [--dry-run] [--list]

sources: ${LEARNING_SOURCES.join(', ')}`);
  process.exit(argv.length?0:1);
}

const dir=path.join(ROOT,'evals','regressions','candidates');

if(has('--list')){
  const files=fs.existsSync(dir)?fs.readdirSync(dir).filter(f=>f.endsWith('.json')).sort():[];
  console.log(JSON.stringify({schema:'agent-sdlc/regression-candidate-list/v1',count:files.length,
    candidates:files.map(f=>{const c=JSON.parse(fs.readFileSync(path.join(dir,f),'utf8'));
      return {candidate_id:c.candidate_id,source:c.facts?.source,suite:c.suite,status:c.status,title:c.facts?.title};})},null,2));
  process.exit(0);
}

const list=k=>{const v=val(k);return v?String(v).split(',').map(s=>s.trim()).filter(Boolean):[];};
let candidate;
try{
  candidate=buildRegressionCandidate({
    source:val('--source'),
    title:val('--title'),
    observed:val('--observed'),
    expected:val('--expected'),
    failureClass:val('--failure-class'),
    runId:val('--run-id'),
    taskId:val('--task-id'),
    paths:list('--paths'),
    evidence:list('--evidence'),
    diagnostic:val('--diagnostic'),
    policyHypothesis:val('--policy-hypothesis'),
    projectRoot:val('--project-root')||process.cwd()
  });
}catch(e){
  console.error(JSON.stringify({status:'ERROR',error:e.message},null,2));
  process.exit(1);
}

const validation=validateRegressionCandidate(candidate);
const evalCase=toEvalCase(candidate);
const target=path.join(dir,`${candidate.candidate_id}.json`);

if(!validation.valid){
  console.error(JSON.stringify({status:'REJECTED',reason:'candidate failed sanitization or contract validation',
    validation,candidate_id:candidate.candidate_id},null,2));
  process.exit(1);
}
if(!has('--dry-run')){
  fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(target,JSON.stringify({...candidate,eval_case:evalCase},null,2)+'\n');
}
console.log(JSON.stringify({
  status:has('--dry-run')?'DRY_RUN':'CANDIDATE_WRITTEN',
  candidate_id:candidate.candidate_id,
  suite:candidate.suite,
  file:has('--dry-run')?null:path.relative(ROOT,target),
  validation,
  eval_case:evalCase,
  next_steps:['run the target suite against this case','review it as a human','only then adopt it into the corpus or change policy'],
  policy_mutated:false
},null,2));
