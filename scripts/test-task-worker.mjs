// Tests for autonomous worker subagent execution.
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

import {buildWorkerPrompt,executeTaskWithAgent} from '../runtime/task-worker.mjs';
import {initProject,loadTask,listArtifacts,listTaskEvents} from '../runtime/store.mjs';
import {newRun,materializeRunTasks} from '../runtime/orchestrator.mjs';
import {route} from '../runtime/router.mjs';
import {createTaskWorkspace} from '../runtime/workspace.mjs';
import {runAutoTaskLoop} from '../runtime/autonomous-runner.mjs';
import {makeTempDir as registerTempDir} from './lib/tempdir.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');

// The shared helper, rather than a scratch base of this suite's own. The
// previous base was inside the project's own .agent-sdlc tree, which is neither
// config, evidence, cache nor docs -- it was a namespace only this suite used,
// and it left fixtures behind in the state directory it was testing.
const makeTempDir=(prefix='agent-sdlc-worker-test-')=>registerTempDir(prefix);

let passed=0;let failed=0;
async function test(name,fn){
  try{
    await fn();
    passed++;
    console.log(`PASS ${name}`);
  }catch(e){
    failed++;
    console.error(`FAIL ${name}: ${e.message}`);
    console.error(e.stack);
  }
}

function finish(){
  console.log(`\n${passed} passed, ${failed} failed`);
  if(failed>0)process.exit(1);
}

// 1. Prompt builder tests
await test('buildWorkerPrompt-includes-spec-and-scope',async ()=>{
  const task={
    task_id:'TASK-001',
    title:'Add authentication endpoint',
    goal:'Implement token-based auth in src/auth.js',
    acceptance_criteria:['Returns JWT on valid login','Returns 401 on bad credentials'],
    done_conditions:['Tests pass'],
    design_decisions:['Use HMAC SHA256'],
    write_scope:['src/auth.js'],
    interface_scope:['/api/auth/login'],
    compatibility_obligations:['Preserve existing sessions'],
    verification:{targeted_tests:['npm test tests/auth.test.js']}
  };

  const prompt=buildWorkerPrompt(ROOT,ROOT,{},task);
  assert(prompt.includes('TASK TASK-001: Add authentication endpoint'),'contains title');
  assert(prompt.includes('Implement token-based auth'),'contains goal');
  assert(prompt.includes('Returns JWT on valid login'),'contains criteria');
  assert(prompt.includes('src/auth.js'),'contains write scope');
  assert(prompt.includes('npm test tests/auth.test.js'),'contains test command');
  assert(prompt.includes('DECLARED WRITE SCOPE'),'contains security invariant');
});

await test('buildWorkerPrompt-includes-prevFailure-context',async ()=>{
  const task={
    task_id:'TASK-002',
    goal:'Fix bug in billing calculation',
    write_scope:['src/billing.js']
  };

  const prevFailure={
    attempt:2,
    failure:{class:'VERIFICATION_FAILED'},
    verification:{output:'AssertionError: expected 100 to equal 90'},
    findings:[
      {severity:'BLOCKING',category:'CORRECTNESS',finding:'Discount not applied for annual plan',evidence:'src/billing.js:42'}
    ]
  };

  const prompt=buildWorkerPrompt(ROOT,ROOT,{},task,{prevFailure});
  assert(prompt.includes('PREVIOUS ATTEMPT FAILURE & REVIEW FEEDBACK'),'contains feedback header');
  assert(prompt.includes('Attempt count: 2'),'contains attempt count');
  assert(prompt.includes('VERIFICATION_FAILED'),'contains failure class');
  assert(prompt.includes('AssertionError: expected 100 to equal 90'),'contains verification output');
  assert(prompt.includes('Discount not applied for annual plan'),'contains finding description');
  assert(prompt.includes('src/billing.js:42'),'contains finding evidence');
});

await test('worker-prompt-sources-tdd-from-the-registry',()=>{
  const tdd=fs.readFileSync(path.join(ROOT,'harness','internal-skills','tdd.md'),'utf8');
  const marker='NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST';
  assert(tdd.includes(marker),'tdd.md no longer states the Iron Law: fix the fixture, not the test');
  const prompt=buildWorkerPrompt(ROOT,ROOT,
    {run_id:'r1',state:'IMPLEMENT',workflow:'bug-fix',profile:'STRICT',overlays:[],objective:'x'},
    {task_id:'TASK-001',title:'t',goal:'g',write_scope:['src/a.js'],verification:{targeted_tests:['npm test']}});
  assert(prompt.includes(marker),'worker prompt lost the Iron Law');
  const src=fs.readFileSync(path.join(ROOT,'runtime','task-worker.mjs'),'utf8');
  assert(!src.includes(marker),'task-worker.mjs still hardcodes the Iron Law: it must read tdd.md');
});

await test('worker-prompt-strips-orchestrator-preamble-from-tdd-procedure',()=>{
  const prompt=buildWorkerPrompt(ROOT,ROOT,
    {run_id:'r1',state:'IMPLEMENT'},
    {task_id:'TASK-001',title:'t',goal:'g',write_scope:['src/a.js'],verification:{targeted_tests:['npm test']}});
  // stripModulePreamble removes exactly the `# Workflow Module:` title and
  // its blockquote banner -- the "Return control to `sdlc-orchestrator`;
  // never mark the global workflow COMPLETE yourself" instruction -- and
  // nothing past it. tdd.md's own `## Workflow preflight` sentence
  // ("return `BLOCKED`; do not bypass the orchestrator") is real per-module
  // content like the rest of that section in most of the 24 procedure
  // files, not boilerplate, and deliberately stays: no bound past the
  // banner is safe across all 24 files (measured; see
  // runtime/procedures.mjs#stripModulePreamble and
  // .superpowers/sdd/2026-09-09-skill-first-navigation/final-fix-report.md).
  // It is conditional advice about being invoked out of order, not the
  // actively wrong mark-COMPLETE/return-control instruction, which is still
  // gone.
  assert(!prompt.includes('sdlc-orchestrator'),'worker prompt leaked orchestrator-channel text the worker cannot act on');
  assert(prompt.includes('## The Iron Law'),'worker prompt lost the real TDD content while stripping the preamble');
});

await test('worker-prompt-warns-and-degrades-when-tdd-procedure-entry-is-missing',()=>{
  const d=makeTempDir();
  fs.mkdirSync(path.join(d,'config'),{recursive:true});
  fs.writeFileSync(path.join(d,'config','procedures.json'),JSON.stringify({schema:'agent-sdlc/procedure-registry/v1',procedures:{}}));
  const warnings=[];
  const originalError=console.error;
  console.error=(...args)=>warnings.push(args.join(' '));
  let prompt;
  try{
    prompt=buildWorkerPrompt(d,d,{run_id:'r1',state:'IMPLEMENT'},
      {task_id:'TASK-001',title:'t',goal:'g',write_scope:['src/a.js'],verification:{targeted_tests:['npm test']}});
  }finally{console.error=originalError;}
  assert(prompt.includes('TASK TASK-001'),'buildWorkerPrompt still returned a usable prompt despite the missing entry');
  assert(warnings.some(w=>w.includes('tdd')),'a missing procedure entry must warn loudly, naming the id');
});

await test('worker-prompt-warns-and-degrades-when-tdd-instructions-file-is-missing',()=>{
  const d=makeTempDir();
  fs.mkdirSync(path.join(d,'config'),{recursive:true});
  const missingPath='harness/internal-skills/does-not-exist.md';
  fs.writeFileSync(path.join(d,'config','procedures.json'),JSON.stringify({
    schema:'agent-sdlc/procedure-registry/v1',
    procedures:{tdd:{group:'implementation',stages:['IMPLEMENT'],instructions:missingPath,when:'strict'}}
  }));
  const warnings=[];
  const originalError=console.error;
  console.error=(...args)=>warnings.push(args.join(' '));
  let prompt;
  try{
    prompt=buildWorkerPrompt(d,d,{run_id:'r1',state:'IMPLEMENT'},
      {task_id:'TASK-001',title:'t',goal:'g',write_scope:['src/a.js'],verification:{targeted_tests:['npm test']}});
  }finally{console.error=originalError;}
  assert(prompt.includes('TASK TASK-001'),'buildWorkerPrompt still returned a usable prompt despite the dangling path');
  assert(warnings.some(w=>w.includes('tdd')&&w.includes('does-not-exist.md')),'a dangling instructions path must warn loudly, naming the id and the path it looked for');
});

// 2. Worker execution tests
await test('executeTaskWithAgent-runs-in-workspace-and-saves-artifacts',async ()=>{
  const d=makeTempDir();
  execFileSync('git',['init','-q'],{cwd:d});
  fs.mkdirSync(path.join(d,'src'),{recursive:true});
  fs.writeFileSync(path.join(d,'src','calculator.js'),'module.exports={add:(a,b)=>a-b};\n');
  execFileSync('git',['add','.'],{cwd:d});
  execFileSync('git',['-c','user.email=t@t.local','-c','user.name=t','commit','-qm','init'],{cwd:d});
  initProject(d,{schema:'agent-sdlc/project/v1',project:'calc-repo'});

  const r=route(ROOT,'Fix calculator add function');
  const run=newRun(ROOT,d,{objective:'Fix calculator add function',route:r});
  const task={
    task_id:'TASK-001',
    run_id:run.run_id,
    goal:'Fix add function to return a + b',
    category:'implementation',
    scope:{write:['src/calculator.js']},
    write_scope:['src/calculator.js'],
    execution:{isolated_workspace:true,workspace_mode:'isolated-worktree'}
  };

  // Create workspace
  const ws=createTaskWorkspace(d,{run,task,writer:'writer:TASK-001'});
  assert(ws&&ws.root,'workspace created');

  let runnerInvoked=false;
  let runnerCwd=null;
  const mockRunner=(host,prompt,schemaPath,budget)=>{
    runnerInvoked=true;
    runnerCwd=budget.cwd;
    // Worker writes code into the workspace
    fs.writeFileSync(path.join(budget.cwd,'src','calculator.js'),'module.exports={add:(a,b)=>a+b};\n');
    return {
      status:'PASS',
      exit_code:0,
      stdout:'Fixed add function in src/calculator.js',
      stderr:''
    };
  };

  const res=executeTaskWithAgent(ROOT,d,run,task,{runner:mockRunner});
  assert(res.status==='EXECUTED','status is EXECUTED');
  assert(runnerInvoked,'runner was invoked');
  assert.strictEqual(runnerCwd,ws.root,'runner executed in task workspace cwd');
  assert(res.transcript_ref,'transcript artifact was created');

  const artifacts=listArtifacts(d,run.run_id);
  const workerLog=artifacts.find(a=>a.kind==='worker-execution-transcript');
  assert(workerLog,'artifact list contains worker transcript');

  const events=listTaskEvents(d,run.run_id,task.task_id);
  const workerEvent=events.find(e=>e.type==='task.worker_spawned');
  assert(workerEvent,'task.worker_spawned event was emitted');
});

// 3. Autonomous Task Loop with Worker Subagent end-to-end
await test('runAutoPipeline-spawns-worker-and-advances-to-done',async ()=>{
  const {runAutoPipeline}=await import('../runtime/autonomous-runner.mjs');
  const d=makeTempDir();
  execFileSync('git',['init','-q'],{cwd:d});
  fs.mkdirSync(path.join(d,'src'),{recursive:true});
  fs.writeFileSync(path.join(d,'src','index.js'),'module.exports={};\n');
  execFileSync('git',['add','.'],{cwd:d});
  execFileSync('git',['-c','user.email=t@t.local','-c','user.name=t','commit','-qm','init'],{cwd:d});
  initProject(d,{schema:'agent-sdlc/project/v1',project:'worker-e2e',commands:{test_targeted:['node','-e','process.exit(0)','{selector}']}});

  const r=route(ROOT,'Add feature export');
  const run=newRun(ROOT,d,{objective:'Add feature export',route:r});
  const plan={
    schema:'agent-sdlc/task-plan/v1',
    plan_id:'plan_worker_test',
    run_id:run.run_id,
    objective:run.objective,
    tasks:[{
      task_id:'TASK-001',
      title:'Export feature',
      goal:'Export status ok in src/index.js',
      category:'implementation',
      changes_behavior:true,
      scope:{write:['src/**']},
      write_scope:['src/**'],
      depends_on:[],
      acceptance_criteria:['status is ok'],
      done_conditions:['code written'],
      design_decisions:[],
      verification:{targeted_tests:['src/index.js'],expected_behavior:['status is ok']}
    }]
  };

  const mockWorkerRunner=(host,prompt,schemaPath,budget)=>{
    fs.writeFileSync(path.join(budget.cwd,'src','index.js'),'module.exports={status:"ok"};\n');
    return {
      status:'PASS',
      exit_code:0,
      stdout:'Wrote export status ok',
      stderr:''
    };
  };

  const passingReviewer=task=>({
    specReview:{
      schema:'agent-sdlc/spec-compliance-review/v1',
      task_id:task.task_id,
      attempt:task.attempt||0,
      diff_hash:task.diff_hash,
      verdict:'COMPLIANT',
      acceptance_criteria_checked:[...(task.acceptance_criteria||[])],
      findings:[]
    },
    qualityReview:{
      schema:'agent-sdlc/code-quality-review/v1',
      task_id:task.task_id,
      attempt:task.attempt||0,
      diff_hash:task.diff_hash,
      verdict:'ACCEPTED',
      findings:[],
      independence:{requested:true,achieved:true,mode:'FRESH_CONTEXT_SUBAGENT',worker_reasoning_withheld:true}
    }
  });

  // Execute pipeline without workerCallback -> automatically invokes mockWorkerRunner!
  const pipeRes=runAutoPipeline(ROOT,d,run,{
    customPlan:plan,
    spawnWorker:true,
    workerRunner:mockWorkerRunner,
    reviewerCallback:passingReviewer,
    skipCiCheck:true
  });

  assert(pipeRes.status==='PAUSED'||pipeRes.status==='COMPLETED',`pipeline ran, got ${pipeRes.status}`);
  const finalTask=loadTask(d,run.run_id,'TASK-001');
  assert.strictEqual(finalTask.status,'DONE','task advanced to DONE autonomously via worker subagent');
});

finish();
