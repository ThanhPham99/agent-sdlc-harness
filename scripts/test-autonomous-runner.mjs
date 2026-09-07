#!/usr/bin/env node
// Test suite for Autonomous SDLC Runner, CI Guard, and Human Confirmation Gates.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {initProject,saveRun,loadRun,putArtifact,listTasks,saveTask} from '../runtime/store.mjs';
import {newRun} from '../runtime/orchestrator.mjs';
import {route} from '../runtime/router.mjs';
import {runAutoPipeline,runAutoTaskLoop,HUMAN_GATES} from '../runtime/autonomous-runner.mjs';
import {validateTaskPlan,PLAN_QUALITY_DEFAULTS} from '../runtime/plan-validator.mjs';
import {detectProjectCi,runLocalCiValidation,ensureCiPassedBeforeDelivery} from '../runtime/ci-guard.mjs';
import {requestApprovalTicket,grantApprovalTicket,listApprovalTickets,GATE_CAPABILITIES} from '../runtime/approvals.mjs';
import {execFileSync} from 'node:child_process';
import {createSuite} from './lib/suite.mjs';
import {makeTempDir} from './lib/tempdir.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const {test,assert,finish}=createSuite('agent-sdlc/autonomous-runner-validation/v1','AUTONOMOUS-RUNNER-VALIDATION.json');

function fixture(name='auto-test-service',{commands=null}={}){
  const d=makeTempDir(`agent-sdlc-${name}-`);
  execFileSync('git',['init','-q'],{cwd:d});
  fs.writeFileSync(path.join(d,'README.md'),'# fixture\n');
  execFileSync('git',['add','.'],{cwd:d});
  execFileSync('git',['-c','user.email=test@test.local','-c','user.name=test','commit','-qm','init'],{cwd:d});
  const resolved=commands??{
    test_targeted:['node','-e','process.exit(0)'],
    test_full:['node','-e','process.exit(0)']
  };
  initProject(d,{
    schema:'agent-sdlc/project/v1',
    project:name,
    commands:resolved,
    test_commands:resolved
  });
  return d;
}

/**
 * Put a run at VERIFY so a stage-gated tool is actually reachable.
 *
 * `checkTool` denies `test.run_full` everywhere but VERIFY, and a DENY reads
 * back as UNAVAILABLE -- which is the same word this stage uses for "no test
 * command is configured". A unit test that skips this asserts UNAVAILABLE and
 * passes without ever reaching the code it means to exercise.
 */
function atVerifyStage(projectRoot,run){
  const staged=loadRun(projectRoot,run.run_id);
  const index=staged.stages.indexOf('VERIFY');
  if(index<0)throw new Error(`workflow ${staged.workflow} has no VERIFY stage`);
  staged.state='VERIFY';
  staged.stage_index=index;
  saveRun(projectRoot,staged);
  return staged;
}

/**
 * A reviewer of the shape the runner now requires. The runner no longer
 * synthesises COMPLIANT/ACCEPTED on its own, so a pipeline test that wants to
 * reach RELEASE has to supply one -- which is the point: the tests used to pass
 * through a review stage nothing had reviewed.
 */
function passingReviewer(task){
  return {
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
      independence:{requested:false,achieved:false,limitation:'test reviewer'}
    }
  };
}

await test('ci-guard-detects-configuration-and-runs-local-validation',async ()=>{
  const d=fixture('ci-detection');
  const det=detectProjectCi(d);
  assert(det.has_ci===true,'fixture with test_commands should have has_ci true');
  assert(Array.isArray(det.recommended_command),'recommended_command should be an array');

  const r=route(ROOT,'Routine maintenance test');
  const run=newRun(ROOT,d,{objective:'Routine maintenance test',route:r});

  const ciRes=runLocalCiValidation(ROOT,d,run);
  assert(ciRes.is_pass===true,'local CI run should pass with fixture exit(0)');
  assert(ciRes.status==='PASS','status must be PASS');
  assert(ciRes.checks.length===1,'one check recorded');

  const pushCheck=ensureCiPassedBeforeDelivery(ROOT,d,run);
  assert(pushCheck.is_allowed===true,'delivery push should be allowed after passing CI');
});

await test('ci-guard-detects-polyglot-python-and-rust-stacks-automatically',async ()=>{
  const dPy=makeTempDir('agent-sdlc-poly-py-');
  fs.writeFileSync(path.join(dPy,'pyproject.toml'),'[project]\nname = "test-py"\n');
  const detPy=detectProjectCi(dPy);
  assert(detPy.has_ci===true,'python repo should be detected as having CI');
  assert(detPy.stack==='python','stack should be python');
  assert(detPy.recommended_command[0]==='python'&&detPy.recommended_command[2]==='pytest','recommended command should be pytest');

  const dRs=makeTempDir('agent-sdlc-poly-rs-');
  fs.writeFileSync(path.join(dRs,'Cargo.toml'),'[package]\nname = "test-rs"\nversion = "0.1.0"\n');
  const detRs=detectProjectCi(dRs);
  assert(detRs.has_ci===true,'rust repo should be detected as having CI');
  assert(detRs.stack==='rust','stack should be rust');
  assert(detRs.recommended_command[0]==='cargo'&&detRs.recommended_command[1]==='test','recommended command should be cargo test');
});

await test('ci-guard-handles-no-ci-configured-and-passes-through',async ()=>{
  const dEmpty=makeTempDir('agent-sdlc-no-ci-');
  const det=detectProjectCi(dEmpty);
  assert(det.has_ci===false,'empty dir has no CI');

  const r=route(ROOT,'Update readme text');
  const run=newRun(ROOT,dEmpty,{objective:'Update readme text',route:r});
  const check=ensureCiPassedBeforeDelivery(ROOT,dEmpty,run);
  assert(check.is_allowed===true&&check.reason==='NO_CI_CONFIGURED','passes through with NO_CI_CONFIGURED');
});

await test('ci-guard-handles-launch-failure-and-failing-ci-throws',async ()=>{
  const d=fixture('ci-fail-test');
  const r=route(ROOT,'Test failure handling');
  const run=newRun(ROOT,d,{objective:'Test failure handling',route:r});

  // Test launch failure with invalid command
  const failLaunch=runLocalCiValidation(ROOT,d,run,{commandOverride:['nonexistent-cmd-xyz-999','test']});
  assert(failLaunch.is_pass===false,'launch failure should report is_pass false');
  assert(failLaunch.status==='FAIL','status should be FAIL');

  // Test ensureCiPassedBeforeDelivery throws on failing test
  let threwFailed=false;
  try{
    ensureCiPassedBeforeDelivery(ROOT,d,run,{commandOverride:['node','-e','process.exit(1)']});
  }catch(e){
    threwFailed=e.message.includes('CI_VALIDATION_FAILED');
  }
  assert(threwFailed===true,'should throw CI_VALIDATION_FAILED on exit code 1');

  // Test ensureCiPassedBeforeDelivery throws when autoRun is false and no pass evidence
  let threwNoPass=false;
  try{
    ensureCiPassedBeforeDelivery(ROOT,d,run,{autoRun:false});
  }catch(e){
    threwNoPass=e.message.includes('CI_EVIDENCE_NOT_PASS');
  }
  assert(threwNoPass===true,'should throw CI_EVIDENCE_NOT_PASS when autoRun is false and no evidence');
});

await test('approval-tickets-can-be-requested-and-granted-without-tty',async ()=>{
  const d=fixture('approval-tickets');
  const r=route(ROOT,'Deploy service to production');
  const run=newRun(ROOT,d,{objective:'Deploy service to production',route:r});

  // Request ticket
  const ticket=requestApprovalTicket(ROOT,d,run,{
    capability:'deploy.production',
    reason:'Production release required'
  });
  assert(ticket.ticket_id.startsWith('ticket_'),'ticket_id should start with ticket_');
  assert(ticket.status==='PENDING','ticket initial status should be PENDING');

  const tickets=listApprovalTickets(run);
  assert(tickets.length===1&&tickets[0].ticket_id===ticket.ticket_id,'listed tickets should match');

  // Grant ticket interactively via UI/Bridge
  const grantRec=grantApprovalTicket(ROOT,d,run,{
    ticketId:ticket.ticket_id,
    actor:'lead-engineer',
    reason:'Verified staging environment'
  });
  assert(grantRec.capability==='deploy.production','granted capability should match');
  assert(grantRec.authority==='USER_INTERACTIVE','authority must be USER_INTERACTIVE');

  // Verify ticket status updated
  const updatedTickets=listApprovalTickets(run);
  assert(updatedTickets[0].status==='GRANTED','ticket status should now be GRANTED');
});

await test('gate-1-pauses-for-human-approval-on-strict-workflow',async ()=>{
  const d=fixture('gate-1-strict');
  // Security remediation is a STRICT workflow
  const r=route(ROOT,'Fix high severity CVE security vulnerability in auth module');
  assert(r.profile==='STRICT','workflow profile must be STRICT');

  const run=newRun(ROOT,d,{objective:'Fix high severity CVE security vulnerability in auth module',route:r});

  const res=runAutoPipeline(ROOT,d,run);
  assert(res.status==='PAUSED','pipeline should pause at Gate 1');
  assert(res.pause_gate===HUMAN_GATES.GATE_1_SCOPE_AND_ARCHITECTURE,'paused gate must be GATE_1_SCOPE_AND_ARCHITECTURE');
  assert(res.current_stage==='DESIGN','paused stage must be DESIGN');
});

await test('auto-pipeline-executes-low-risk-tasks-until-gate-4-pre-commit',async ()=>{
  const d=fixture('auto-low-risk');
  const r=route(ROOT,'Fix calculation bug in helper');
  const run=newRun(ROOT,d,{objective:'Fix calculation bug in helper',route:r});

  const {getTaskWorkspace}=await import('../runtime/workspace.mjs');
  const workerCallback=(task)=>{
    const ws=getTaskWorkspace(d,run.run_id,task.task_id);
    const targetDir=ws?.root||d;
    fs.mkdirSync(path.join(targetDir,'src'),{recursive:true});
    fs.writeFileSync(path.join(targetDir,'src','helper.js'),'export function format() { return "date"; }\n');
  };

  const res=runAutoPipeline(ROOT,d,run,{workerCallback,reviewerCallback:passingReviewer});
  // Low-risk FAST/STANDARD skips Gate 1, executes PLAN and IMPLEMENT, and pauses at Gate 4 before commit/push
  assert(res.status==='PAUSED','pipeline should pause at Gate 4');
  assert(res.pause_gate===HUMAN_GATES.GATE_4_PRE_COMMIT_PUSH_APPROVAL,'paused gate must be GATE_4_PRE_COMMIT_PUSH_APPROVAL');
  assert(res.current_stage==='RELEASE','paused stage must be RELEASE');
  assert(typeof res.pr_body==='string'&&res.pr_body.length>0,'pr_body should be generated');

  // Once user grants delivery_commit_approved, pipeline completes to CLOSE
  const freshRun=loadRun(d,run.run_id);
  const ticket=requestApprovalTicket(ROOT,d,freshRun,{capability:'delivery_commit_approved'});
  grantApprovalTicket(ROOT,d,freshRun,{
    ticketId:ticket.ticket_id,
    actor:'operator'
  });

  const finalRes=runAutoPipeline(ROOT,d,freshRun,{skipCiCheck:true});
  assert(finalRes.status==='COMPLETED','pipeline should finish to COMPLETED');
  assert(finalRes.current_stage==='CLOSE','final stage must be CLOSE');
});

await test('auto-pipeline-plans-a-repository-with-many-top-level-directories',async ()=>{
  // A real repository has many top-level directories. detectWriteScope used to
  // claim every one of them plus `*.*`, which put the single scaffolded task
  // over plan-validator's giant_task_write_scope_threshold with no
  // scope_justification -- so `agent-sdlc auto` threw at PLAN on any repository
  // of ordinary size. Every other fixture here has one to three directories,
  // which is why the suite never saw it.
  const {scaffoldTaskPlan}=await import('../runtime/autonomous-runner.mjs');
  const d=fixture('auto-wide-repo');
  const dirs=['src','lib','app','pkg','internal','components','pages','test','tests','scripts','docs','config','tools','assets'];
  for(const name of dirs){
    fs.mkdirSync(path.join(d,name),{recursive:true});
    fs.writeFileSync(path.join(d,name,'placeholder.js'),'export const placeholder = 1;\n');
  }
  execFileSync('git',['add','.'],{cwd:d});
  execFileSync('git',['-c','user.email=test@test.local','-c','user.name=test','commit','-qm','wide'],{cwd:d});

  const r=route(ROOT,'Fix calculation bug in helper');
  const run=newRun(ROOT,d,{objective:'Fix calculation bug in helper',route:r});

  // The scaffold the pipeline would use must satisfy the gate that consumes it.
  const scaffolded=scaffoldTaskPlan(run,d);
  const validation=validateTaskPlan(scaffolded);
  assert(validation.valid===true,`scaffolded plan for a ${dirs.length}-directory repository must validate, got ${JSON.stringify(validation.errors)}`);

  const scope=scaffolded.tasks[0].write_scope;
  assert(scope.includes('src/**'),'recognised source directories stay in scope');
  assert(!scope.includes('docs/**')&&!scope.includes('assets/**')&&!scope.includes('config/**'),
    'unrelated top-level directories must not be claimed when recognised source directories exist');
  assert(!scope.includes('*.*'),'the inert wildcard entry is gone');

  // End to end: the pipeline clears PLAN and stops where the low-risk pipeline
  // stops, rather than throwing. A PLAN failure surfaces as an exception, not a
  // status, so reaching this assertion at all is part of the regression.
  const {getTaskWorkspace}=await import('../runtime/workspace.mjs');
  const workerCallback=(task)=>{
    const ws=getTaskWorkspace(d,run.run_id,task.task_id);
    const targetDir=ws?.root||d;
    fs.mkdirSync(path.join(targetDir,'src'),{recursive:true});
    fs.writeFileSync(path.join(targetDir,'src','helper.js'),'export function format() { return "date"; }\n');
  };
  const res=runAutoPipeline(ROOT,d,run,{workerCallback,reviewerCallback:passingReviewer});
  assert(res.status==='PAUSED','pipeline should reach the pre-commit gate');
  assert(res.pause_gate===HUMAN_GATES.GATE_4_PRE_COMMIT_PUSH_APPROVAL,'paused gate must be GATE_4_PRE_COMMIT_PUSH_APPROVAL');
  assert(res.current_stage==='RELEASE','paused stage must be RELEASE');
});

await test('scaffolded-scope-justifies-itself-only-when-the-recognised-set-is-that-wide',async ()=>{
  // The justification branch, which the wide-repository case above never
  // reaches: its fixture has ten recognised directories, so that assertion
  // would pass with the branch deleted.
  const {detectWriteScope,scaffoldTaskPlan}=await import('../runtime/autonomous-runner.mjs');
  const d=makeTempDir('agent-sdlc-scope-justify-');
  const recognised=['src','lib','app','apps','pkg','packages','internal','components','pages','cmd','api','server'];
  for(const name of [...recognised,'docs','dist'])fs.mkdirSync(path.join(d,name),{recursive:true});

  const scope=detectWriteScope(d);
  assert(scope.length===recognised.length,`every recognised directory is in scope, got ${scope.length}`);
  assert(scope.length>=PLAN_QUALITY_DEFAULTS.giant_task_write_scope_threshold,'this layout must be wide enough to need a justification');
  assert(!scope.includes('docs/**')&&!scope.includes('dist/**'),'unrecognised directories stay out even at this width');

  const plan=scaffoldTaskPlan({objective:'Add payment endpoint',profile:'STANDARD'},d);
  const task=plan.tasks[0];
  assert(typeof task.scope_justification==='string'&&task.scope_justification.length>0,
    'a scope at or above the threshold must carry a scope_justification');
  // The string is persisted into the plan artefact a human reads, so it has to
  // describe the bound that was applied rather than claiming the whole tree.
  assert(task.scope_justification.includes(`${scope.length} recognised source directories`),
    `justification must state what was actually scoped, got: ${task.scope_justification}`);
  assert(validateTaskPlan(plan).valid===true,'the justified plan must satisfy the PLAN gate');
});

await test('an-unrecognised-but-boundable-layout-scopes-to-the-directories-that-exist',async ()=>{
  // The branch that used to hand back every directory plus a wildcard. It still
  // scopes to the real directories -- a fixed conventional list would name
  // directories that do not exist and put every worker write out of scope --
  // but the wildcard is gone and nothing here justifies its own width.
  const {detectWriteScope,scaffoldTaskPlan}=await import('../runtime/autonomous-runner.mjs');
  const d=fixture('auto-opaque-repo');
  const opaque=['engine','widgets','plumbing'];
  for(const name of opaque){
    fs.mkdirSync(path.join(d,name),{recursive:true});
    fs.writeFileSync(path.join(d,name,'placeholder.js'),'export const placeholder = 1;\n');
  }
  execFileSync('git',['add','.'],{cwd:d});
  execFileSync('git',['-c','user.email=test@test.local','-c','user.name=test','commit','-qm','opaque'],{cwd:d});

  const scope=detectWriteScope(d);
  assert(JSON.stringify([...scope].sort())===JSON.stringify(opaque.map(o=>`${o}/**`).sort()),
    `an unrecognised layout scopes to what is there, got ${JSON.stringify(scope)}`);
  assert(!scope.includes('*.*'),'the inert wildcard entry is gone');
  const task=scaffoldTaskPlan({objective:'Tidy the engine',profile:'STANDARD'},d).tasks[0];
  assert(task.scope_justification===undefined,'a scope this narrow needs no justification');

  // The no-project-root default reaches the same recognised:false branch, and
  // sits one entry under the threshold. If it ever crosses, a scaffold with no
  // repository to read would route to a pause whose message talks about one.
  const {resolveWriteScope}=await import('../runtime/autonomous-runner.mjs');
  const noRoot=resolveWriteScope(null);
  assert(noRoot.recognised===false,'the no-project-root default is not a recognised layout');
  assert(noRoot.scopes.length<PLAN_QUALITY_DEFAULTS.giant_task_write_scope_threshold,
    `the no-project-root default must stay under the giant-task threshold, got ${noRoot.scopes.length}`);

  // The scope has to be usable, not merely valid: a worker writing into one of
  // those directories must reach the pre-commit gate, not a scope violation.
  const r=route(ROOT,'Fix calculation bug in helper');
  const run=newRun(ROOT,d,{objective:'Fix calculation bug in helper',route:r});
  const {getTaskWorkspace}=await import('../runtime/workspace.mjs');
  const workerCallback=(t)=>{
    const ws=getTaskWorkspace(d,run.run_id,t.task_id);
    const targetDir=ws?.root||d;
    fs.mkdirSync(path.join(targetDir,'engine'),{recursive:true});
    fs.writeFileSync(path.join(targetDir,'engine','helper.js'),'export function format() { return "date"; }\n');
  };
  const res=runAutoPipeline(ROOT,d,run,{workerCallback,reviewerCallback:passingReviewer});
  assert(res.pause_gate===HUMAN_GATES.GATE_4_PRE_COMMIT_PUSH_APPROVAL,
    `a write inside the detected scope must reach the pre-commit gate, stopped at ${res.pause_gate} in ${res.current_stage}`);
});

await test('an-unrecognised-and-unboundable-layout-pauses-at-gate-1',async ()=>{
  // The case with no good automatic answer: too wide to bound, and nothing in
  // the layout says which parts are source. Throwing is what made `auto`
  // unusable; self-issuing a justification would be the runner approving its
  // own reach. It asks instead.
  const d=fixture('auto-unboundable-repo');
  const opaque=['engine','widgets','plumbing','fixtures','glue','vendorized','ledger','conduit','marshal','beacon','satchel','quarry'];
  for(const name of opaque)fs.mkdirSync(path.join(d,name),{recursive:true});
  execFileSync('git',['add','.'],{cwd:d});
  execFileSync('git',['-c','user.email=test@test.local','-c','user.name=test','commit','-qm','unboundable','--allow-empty'],{cwd:d});

  const {detectWriteScope,scaffoldTaskPlan}=await import('../runtime/autonomous-runner.mjs');
  const scope=detectWriteScope(d);
  assert(scope.length>=PLAN_QUALITY_DEFAULTS.giant_task_write_scope_threshold,
    `this layout must be too wide to bound, got ${scope.length}`);
  const plan=scaffoldTaskPlan({objective:'Tidy the engine',profile:'STANDARD'},d);
  assert(plan.tasks[0].scope_justification===undefined,'the unrecognised branch must not justify its own width');
  const validation=validateTaskPlan(plan);
  assert(validation.valid===false&&validation.errors.some(e=>e.code==='GIANT_TASK_WITHOUT_JUSTIFICATION'),
    'the plan is meant to stay invalid so the runner has to ask');

  const r=route(ROOT,'Fix calculation bug in helper');
  const run=newRun(ROOT,d,{objective:'Fix calculation bug in helper',route:r});
  const res=runAutoPipeline(ROOT,d,run);
  assert(res.status==='PAUSED','an unboundable scope must pause, not throw');
  assert(res.pause_gate===HUMAN_GATES.GATE_1_SCOPE_AND_ARCHITECTURE,'paused gate must be GATE_1_SCOPE_AND_ARCHITECTURE');
  assert(res.current_stage==='PLAN','paused stage must be PLAN');
});

await test('the-gate-1-scope-pause-names-a-recovery-that-actually-works',async ()=>{
  // The pause tells the operator what to do next. Nothing else in the branch
  // reads an approval and `agent-sdlc auto` has no plan flag, so the sequence
  // in that message is the only recovery there is -- which makes it worth
  // driving end to end rather than trusting the wording.
  const {recordTaskPlan,materializeRunTasks,transition}=await import('../runtime/orchestrator.mjs');
  const d=fixture('auto-gate1-recovery');
  const opaque=['engine','widgets','plumbing','fixtures','glue','vendorized','ledger','conduit','marshal','beacon','satchel','quarry'];
  for(const name of opaque)fs.mkdirSync(path.join(d,name),{recursive:true});
  execFileSync('git',['add','.'],{cwd:d});
  execFileSync('git',['-c','user.email=test@test.local','-c','user.name=test','commit','-qm','recovery','--allow-empty'],{cwd:d});

  const r=route(ROOT,'Fix calculation bug in helper');
  let run=newRun(ROOT,d,{objective:'Fix calculation bug in helper',route:r});
  const paused=runAutoPipeline(ROOT,d,run);
  assert(paused.pause_gate===HUMAN_GATES.GATE_1_SCOPE_AND_ARCHITECTURE,'precondition: the run pauses for scope sign-off');
  // The pause has to be self-describing: a caller that only reads the object
  // still learns which scope was rejected and why.
  assert(Array.isArray(paused.validation_errors)&&paused.validation_errors.some(e=>e.code==='GIANT_TASK_WITHOUT_JUSTIFICATION'),
    'the pause carries the machine-readable reason');
  assert(Array.isArray(paused.detected_write_scope)&&paused.detected_write_scope.length>=PLAN_QUALITY_DEFAULTS.giant_task_write_scope_threshold,
    'the pause carries the scope that was rejected');

  const authored={
    schema:'agent-sdlc/task-plan/v1',
    plan_id:'plan_authored_recovery',
    objective:run.objective,
    profile:run.profile||'STANDARD',
    tasks:[{
      task_id:'TASK-001',
      title:'Fix the helper',
      goal:'Correct the calculation in the engine helper',
      done_conditions:['The helper returns the corrected value'],
      category:'implementation',
      depends_on:[],
      write_scope:['engine/**'],
      verification:{targeted_tests:['engine/placeholder.js'],expected_behavior:['The helper returns the corrected value']}
    }]
  };
  run=loadRun(d,run.run_id);
  const rec=recordTaskPlan(ROOT,d,run,authored);
  assert(rec.recorded===true,`an authored bounded plan must be accepted, got ${JSON.stringify(rec.validation?.errors)}`);
  materializeRunTasks(ROOT,d,run,authored);
  // No evidence tokens and no internal flag: exactly what `agent-sdlc
  // transition` does. The PLAN gate tokens all carry runtime authority, so
  // asserting them by hand would bypass guardEvidenceAuthority and prove a
  // path the documented command cannot take -- this has to pass on the
  // evidence recordTaskPlan already persisted, or the message is wrong.
  run=transition(ROOT,d,loadRun(d,run.run_id),'IMPLEMENT',{evidence:[]});

  const {getTaskWorkspace}=await import('../runtime/workspace.mjs');
  const workerCallback=(t)=>{
    const ws=getTaskWorkspace(d,run.run_id,t.task_id);
    const targetDir=ws?.root||d;
    fs.mkdirSync(path.join(targetDir,'engine'),{recursive:true});
    fs.writeFileSync(path.join(targetDir,'engine','placeholder.js'),'export const placeholder = 2;\n');
  };
  const resumed=runAutoPipeline(ROOT,d,run,{workerCallback,spawnReviewer:false});
  assert(resumed.pause_gate!==HUMAN_GATES.GATE_1_SCOPE_AND_ARCHITECTURE,
    `the documented recovery must clear the scope pause, still at ${resumed.pause_gate}`);
  assert(resumed.current_stage!=='PLAN',`the run must be past PLAN, still at ${resumed.current_stage}`);
});

await test('a-plan-invalid-for-more-than-its-scope-is-not-reported-as-a-scope-question',async ()=>{
  // The `every` in the pause predicate. If the scaffold is also invalid for
  // unrelated reasons, calling it a scope sign-off question would bury the
  // errors the operator can actually act on -- so it throws, as before.
  const d=fixture('auto-multi-error');
  const opaque=['engine','widgets','plumbing','fixtures','glue','vendorized','ledger','conduit','marshal','beacon','satchel','quarry'];
  for(const name of opaque)fs.mkdirSync(path.join(d,name),{recursive:true});
  execFileSync('git',['add','.'],{cwd:d});
  execFileSync('git',['-c','user.email=test@test.local','-c','user.name=test','commit','-qm','multi','--allow-empty'],{cwd:d});

  const r=route(ROOT,'Fix calculation bug in helper');
  // An empty objective adds MISSING_OBJECTIVE alongside the giant-task error.
  const run=newRun(ROOT,d,{objective:'',route:r});
  let threw=null;
  try{runAutoPipeline(ROOT,d,run);}catch(e){threw=e;}
  assert(threw!==null,'a plan invalid for more than its scope must throw, not pause');
  assert(threw.message.includes('MISSING_OBJECTIVE'),
    `the error the operator can act on must survive, got: ${threw.message}`);
});

await test('a-caller-supplied-plan-gets-the-error-rather-than-the-scope-pause',async ()=>{
  // The `!customPlan` in the pause predicate. A plan someone authored is not
  // the runner's to renegotiate: its author is the one who can bound it, so
  // they get the validation error rather than a gate pause.
  const d=fixture('auto-custom-plan-error');
  const r=route(ROOT,'Fix calculation bug in helper');
  const run=newRun(ROOT,d,{objective:'Fix calculation bug in helper',route:r});
  const wide=Array.from({length:PLAN_QUALITY_DEFAULTS.giant_task_write_scope_threshold},(_,i)=>`area${i}/**`);
  const customPlan={
    schema:'agent-sdlc/task-plan/v1',
    plan_id:'plan_custom_unbounded',
    objective:run.objective,
    profile:run.profile||'STANDARD',
    tasks:[{
      task_id:'TASK-001',
      title:'Do the thing',
      goal:'Do the thing everywhere',
      done_conditions:['Done'],
      category:'implementation',
      depends_on:[],
      write_scope:wide,
      verification:{targeted_tests:['test/unit.test.js'],expected_behavior:['Done']}
    }]
  };
  let threw=null;
  try{runAutoPipeline(ROOT,d,run,{customPlan});}catch(e){threw=e;}
  assert(threw!==null,'an authored plan must get the validation error, not the Gate 1 pause');
  assert(threw.message.includes('GIANT_TASK_WITHOUT_JUSTIFICATION'),
    `the error must name what is wrong with the authored plan, got: ${threw.message}`);
});

await test('write-scope-detection-is-case-insensitive-and-prefers-source-over-siblings',async ()=>{
  const {detectWriteScope,resolveWriteScope}=await import('../runtime/autonomous-runner.mjs');
  // .NET trees spell these Src/, Tests/ and Source/. Treating them as
  // unrecognised would push a layout the list does know into the handling
  // reserved for layouts it cannot read at all. Java needs no folding (Maven
  // and Gradle are lowercase src/), and Unity is the wart the source comment
  // names rather than a case this covers.
  const cased=makeTempDir('agent-sdlc-scope-cased-');
  for(const name of ['Src','Tests','Source'])fs.mkdirSync(path.join(cased,name),{recursive:true});
  const casedResolved=resolveWriteScope(cased);
  assert(casedResolved.recognised===true,'capitalised source directories must count as recognised');
  assert(casedResolved.scopes.length===3&&casedResolved.scopes.includes('Src/**')&&casedResolved.scopes.includes('Tests/**'),
    `the emitted glob keeps the directory's real casing, got ${JSON.stringify(casedResolved.scopes)}`);

  // The deliberate tradeoff: a mixed layout narrows to what is recognised, so a
  // worker touching backend/ trips a scope audit rather than passing silently.
  const mixed=makeTempDir('agent-sdlc-scope-mixed-');
  for(const name of ['src','backend'])fs.mkdirSync(path.join(mixed,name),{recursive:true});
  assert(JSON.stringify(detectWriteScope(mixed))===JSON.stringify(['src/**']),
    'a mixed layout scopes to the recognised directory only');
});

await test('gate-2-escalates-when-task-fails-verification-exceeding-attempts',async ()=>{
  const d=makeTempDir('agent-sdlc-fail-task-');
  execFileSync('git',['init','-q'],{cwd:d});
  fs.writeFileSync(path.join(d,'README.md'),'# failing fixture\n');
  execFileSync('git',['add','.'],{cwd:d});
  execFileSync('git',['-c','user.email=test@test.local','-c','user.name=test','commit','-qm','init'],{cwd:d});
  initProject(d,{
    schema:'agent-sdlc/project/v1',
    project:'failing-service',
    commands:{
      test_targeted:['node','-e','process.exit(1)'],
      test_full:['node','-e','process.exit(1)']
    },
    test_commands:{
      test_targeted:['node','-e','process.exit(1)'],
      test_full:['node','-e','process.exit(1)']
    }
  });

  const r=route(ROOT,'Fix math calculation');
  const run=newRun(ROOT,d,{objective:'Fix math calculation',route:r});

  // Create a plan with a failing task
  const plan={
    schema:'agent-sdlc/task-plan/v1',
    plan_id:'PLAN-FAIL-01',
    objective:run.objective,
    profile:'FAST',
    tasks:[
      {
        task_id:'TASK-FAIL-01',
        title:'Failing task',
        goal:'Try to fix math',
        done_conditions:['Passes tests'],
        category:'implementation',
        depends_on:[],
        write_scope:['src/**'],
        interface_scope:[],
        compatibility_obligations:[],
        verification:{targeted_tests:['test.js']}
      }
    ]
  };

  const workerCallback=(task)=>{
    const wsDir=path.join(d,'.agent-sdlc','workspaces',run.run_id,task.task_id);
    const targetDir=fs.existsSync(wsDir)?wsDir:d;
    fs.mkdirSync(path.join(targetDir,'src'),{recursive:true});
    fs.writeFileSync(path.join(targetDir,'src','math.js'),'export function calc() { return 1; }\n');
  };

  const res=runAutoPipeline(ROOT,d,run,{customPlan:plan,skipCiCheck:true,workerCallback});
  assert(res.status==='PAUSED','pipeline should pause');
  assert(res.pause_gate===HUMAN_GATES.GATE_2_ESCALATION_BLOCKER,'paused gate must be GATE_2_ESCALATION_BLOCKER');
  assert(res.task_id==='TASK-FAIL-01','failing task id identified');
});

await test('gate-5-pauses-on-privileged-production-deployment-until-approved',async ()=>{
  const d=fixture('gate-5-deploy');
  // new-feature workflow includes DEPLOY stage
  const r=route(ROOT,'Build and deploy new billing microservice');
  const run=newRun(ROOT,d,{objective:'Build and deploy new billing microservice',route:r});

  // Pre-approve delivery commit to reach DEPLOY
  grantApprovalTicket(ROOT,d,run,{
    ticketId:requestApprovalTicket(ROOT,d,run,{capability:'delivery_commit_approved'}).ticket_id,
    actor:'lead'
  });

  const {getTaskWorkspace}=await import('../runtime/workspace.mjs');
  const workerCallback=(task)=>{
    const ws=getTaskWorkspace(d,run.run_id,task.task_id);
    const targetDir=ws?.root||d;
    fs.mkdirSync(path.join(targetDir,'src'),{recursive:true});
    fs.writeFileSync(path.join(targetDir,'src','service.js'),'export const billing = 1;\n');
  };

  const res=runAutoPipeline(ROOT,d,run,{skipCiCheck:true,workerCallback,reviewerCallback:passingReviewer});
  assert(res.status==='PAUSED','pipeline should pause at Gate 5');
  assert(res.pause_gate===HUMAN_GATES.GATE_5_PRIVILEGED_ACTION,'paused gate must be GATE_5_PRIVILEGED_ACTION');
  assert(res.current_stage==='DEPLOY','paused stage must be DEPLOY');

  // Grant production deployment approval
  const freshRun=loadRun(d,run.run_id);
  const ticket=requestApprovalTicket(ROOT,d,freshRun,{capability:'deploy.production',expiresInMinutes:30});
  grantApprovalTicket(ROOT,d,freshRun,{
    ticketId:ticket.ticket_id,
    actor:'infra-admin'
  });

  const afterDeploy=runAutoPipeline(ROOT,d,freshRun,{skipCiCheck:true});
  assert(afterDeploy.status==='COMPLETED','pipeline finishes after deploy and observe');
  assert(afterDeploy.current_stage==='CLOSE','final stage is CLOSE');
});

await test('semantic-classifier-and-route-semantic-with-host',async ()=>{
  const {classifySemanticIntent}=await import('../runtime/semantic-classifier.mjs');
  const {routeSemantic}=await import('../runtime/router.mjs');

  // Test missing schema
  const failRes=await classifySemanticIntent('/tmp/nonexistent-root-'+Date.now(),'test objective');
  assert(failRes.status==='FAIL'&&failRes.reason==='SCHEMA_NOT_FOUND','schema not found on bad root');

  // Test unavailable provider
  const unavailRes=await classifySemanticIntent(ROOT,'test objective',{provider:'nonexistent-host-999'});
  assert(unavailRes.status==='UNAVAILABLE'&&unavailRes.reason==='NO_HOST_AVAILABLE','unvailable host reported');

  // Test with fake host binary
  const prevHost=process.env.AI_SDLC_CLAUDE_BIN;
  try{
    process.env.AI_SDLC_CLAUDE_BIN=path.join(ROOT,'evals','fake-host-cli.mjs');
    const res=await classifySemanticIntent(ROOT,'login bug in auth module',{provider:'claude'});
    assert(res.status==='PASS','fake host classification should PASS');
    assert(res.decision&&res.decision.workflow==='bug-fix','decision workflow must be bug-fix');

    const routed=await routeSemantic(ROOT,'login bug in auth module',null,null,{semantic:true,provider:'claude'});
    assert(routed.workflow==='bug-fix','routed workflow must be bug-fix');
    assert(routed.route_flags.includes('SEMANTIC_MODEL_ASSISTED'),'must have SEMANTIC_MODEL_ASSISTED flag');
  }finally{
    if(prevHost)process.env.AI_SDLC_CLAUDE_BIN=prevHost;
    else delete process.env.AI_SDLC_CLAUDE_BIN;
  }
});

await test('auto-cli-commands-dispatch',async ()=>{
  const {commands}=await import('../runtime/commands/auto.mjs');
  const d=fixture('auto-cli-dispatch');
  const r=route(ROOT,'Routine maintenance chore');
  const run=newRun(ROOT,d,{objective:'Routine maintenance chore',route:r});

  let printed=null;
  const print=(val)=>{printed=val;};

  // ci-check detect
  await commands['ci-check']({
    args:{detect:true},
    ROOT,
    projectRoot:d,
    print,
    needRun:async()=>run
  });
  assert(printed&&printed.has_ci===true,'detect output has_ci true');

  // ci-check validation
  printed=null;
  await commands['ci-check']({
    args:{},
    ROOT,
    projectRoot:d,
    print,
    needRun:async()=>run
  });
  assert(printed&&printed.status==='PASS','ci-check run should pass');

  // auto-task loop
  printed=null;
  await commands['auto-task']({
    args:{writer:null},
    ROOT,
    projectRoot:d,
    print,
    needRun:async()=>run
  });
  assert(printed&&printed.steps!==undefined,'auto-task returns result with steps');

  // auto pipeline
  printed=null;
  await commands['auto']({
    args:{'skip-ci':true},
    ROOT,
    projectRoot:d,
    print,
    needRun:async()=>run
  });
  assert(printed&&printed.status!==undefined,'auto pipeline returns status');
});

await test('ci-guard-detects-commands-field-without-test_commands-for-multi-language',async ()=>{
  const d=makeTempDir('agent-sdlc-python-stack-');
  execFileSync('git',['init','-q'],{cwd:d});
  fs.writeFileSync(path.join(d,'README.md'),'# python fixture\n');
  execFileSync('git',['add','.'],{cwd:d});
  execFileSync('git',['-c','user.email=test@test.local','-c','user.name=test','commit','-qm','init'],{cwd:d});
  // initProject writes `commands`, NOT `test_commands`
  initProject(d,{
    schema:'agent-sdlc/project/v1',
    project:'python-svc',
    commands:{
      test_full:['python','-m','pytest'],
      test_targeted:['python','-m','pytest','{selector}']
    }
  });

  const det=detectProjectCi(d);
  assert(det.has_ci===true,'detectProjectCi should recognize has_ci from cfg.commands');
  assert(det.recommended_command[0]==='python'&&det.recommended_command[2]==='pytest','recommended command should match cfg.commands.test_full');
});

await test('scaffoldTaskPlan-detects-project-test-files-and-scopes',async ()=>{
  const d=makeTempDir('agent-sdlc-scaffold-test-');
  fs.mkdirSync(path.join(d,'tests'),{recursive:true});
  fs.writeFileSync(path.join(d,'tests','test_main.py'),'def test_ok(): pass\n');
  fs.mkdirSync(path.join(d,'app'),{recursive:true});

  const {scaffoldTaskPlan,detectExistingTestFile,detectWriteScope}=await import('../runtime/autonomous-runner.mjs');
  const existingTest=detectExistingTestFile(d);
  assert(existingTest==='tests/test_main.py','should detect tests/test_main.py');

  const scopes=detectWriteScope(d);
  assert(scopes.includes('app/**')&&scopes.includes('tests/**'),'write scope should include app/** and tests/**');

  const plan=scaffoldTaskPlan({objective:'Add payment endpoint',profile:'STANDARD'},d);
  assert(plan.tasks[0].verification.targeted_tests[0]==='tests/test_main.py','task plan should use detected test file');
});

await test('gate-3-pauses-when-task-introduces-secret',async ()=>{
  const d=fixture('gate-3-secret');
  const r=route(ROOT,'Update payment keys');
  const run=newRun(ROOT,d,{objective:'Update payment keys',route:r});

  const {getTaskWorkspace}=await import('../runtime/workspace.mjs');
  const secWorker=(task)=>{
    const ws=getTaskWorkspace(d,run.run_id,task.task_id);
    const targetDir=ws?.root||d;
    fs.mkdirSync(path.join(targetDir,'src'),{recursive:true});
    fs.writeFileSync(path.join(targetDir,'src','app.py'),'AWS_SECRET_KEY = "AKIAIOSFODNN7EXAMPLE"\n');
  };

  const res=runAutoPipeline(ROOT,d,run,{workerCallback:secWorker});
  assert(res.status==='PAUSED','pipeline should pause when secret is introduced');
  assert(res.pause_gate===HUMAN_GATES.GATE_3_SECURITY_EXCEPTION,'paused gate must be GATE_3_SECURITY_EXCEPTION');
  assert(res.current_stage==='VERIFY','paused stage must be VERIFY');
});

await test('auto-pipeline-executes-heterogeneous-workflows-technical-spike-and-maintenance',async ()=>{
  const d=fixture('heterogeneous-workflows');

  // Test 1: technical-spike workflow: INTAKE -> REQUIREMENTS -> DESIGN -> VERIFY -> CLOSE
  const rSpike=route(ROOT,'Research performance bottlenecks in database queries','technical-spike');
  assert(rSpike.workflow==='technical-spike','workflow must be technical-spike');
  const runSpike=newRun(ROOT,d,{objective:'Research performance bottlenecks in database queries',route:rSpike});

  const resSpike=runAutoPipeline(ROOT,d,runSpike);
  assert(resSpike.status==='COMPLETED','technical-spike should complete automatically to CLOSE');
  assert(resSpike.current_stage==='CLOSE','final stage must be CLOSE');
  const stagesSpike=resSpike.stage_steps.map(s=>s.to);
  assert(stagesSpike.includes('DESIGN')&&stagesSpike.includes('VERIFY')&&stagesSpike.includes('CLOSE'),'should transition through spike stages');
  assert(!stagesSpike.includes('PLAN')&&!stagesSpike.includes('IMPLEMENT')&&!stagesSpike.includes('RELEASE'),'should not visit non-spike stages');

  // Test 2: maintenance workflow: INTAKE -> REQUIREMENTS -> PLAN -> IMPLEMENT -> VERIFY -> REVIEW -> CLOSE
  const dMaint=fixture('maintenance-workflow');
  const rMaint=route(ROOT,'Routine cleanup of outdated configuration','maintenance');
  assert(rMaint.workflow==='maintenance','workflow must be maintenance');
  const runMaint=newRun(ROOT,dMaint,{objective:'Routine cleanup of outdated configuration',route:rMaint});

  const {getTaskWorkspace}=await import('../runtime/workspace.mjs');
  const workerCallback=(task)=>{
    const ws=getTaskWorkspace(dMaint,runMaint.run_id,task.task_id);
    const targetDir=ws?.root||dMaint;
    fs.mkdirSync(path.join(targetDir,'src'),{recursive:true});
    fs.writeFileSync(path.join(targetDir,'src','clean.js'),'export const cleaned = true;\n');
  };

  const resMaint=runAutoPipeline(ROOT,dMaint,runMaint,{workerCallback,reviewerCallback:passingReviewer});
  assert(resMaint.status==='COMPLETED','maintenance should complete to CLOSE');
  assert(resMaint.current_stage==='CLOSE','final stage must be CLOSE');
  const stagesMaint=resMaint.stage_steps.map(s=>s.to);
  assert(!stagesMaint.includes('DESIGN')&&!stagesMaint.includes('RELEASE'),'maintenance should skip DESIGN and RELEASE');
  assert(stagesMaint.includes('PLAN')&&stagesMaint.includes('IMPLEMENT')&&stagesMaint.includes('VERIFY')&&stagesMaint.includes('REVIEW')&&stagesMaint.includes('CLOSE'),'maintenance visits its stages');
});

await test('self-healing-loop-passes-failure-context-to-worker-callback-on-retry',async ()=>{
  const d=fixture('self-heal-context');
  const r=route(ROOT,'Fix helper calculation');
  const run=newRun(ROOT,d,{objective:'Fix helper calculation',route:r});

  let callbackCalls=0;
  let receivedFailure=null;

  const workerCallback=(task,failureContext)=>{
    callbackCalls++;
    if(callbackCalls===1){
      // First attempt: do not fix yet
      assert(failureContext===null,'first attempt should have null failureContext');
    }else{
      // Second attempt: verify failureContext was provided
      receivedFailure=failureContext;
      const wsDir=path.join(d,'.agent-sdlc','workspaces',run.run_id,task.task_id);
      const targetDir=fs.existsSync(wsDir)?wsDir:d;
      fs.mkdirSync(path.join(targetDir,'src'),{recursive:true});
      fs.writeFileSync(path.join(targetDir,'src','helper.js'),'export function ok() { return true; }\n');
    }
  };

  const plan={
    schema:'agent-sdlc/task-plan/v1',
    plan_id:'PLAN-HEAL-01',
    objective:run.objective,
    profile:'FAST',
    tasks:[
      {
        task_id:'TASK-HEAL-01',
        title:'Self heal task',
        goal:'Fix helper',
        done_conditions:['Passes tests'],
        category:'implementation',
        depends_on:[],
        write_scope:['src/**'],
        interface_scope:[],
        compatibility_obligations:[],
        verification:{targeted_tests:['test.js']}
      }
    ]
  };

  // Run with custom plan where attempt 1 fails and attempt 2 heals
  const res=runAutoPipeline(ROOT,d,run,{customPlan:plan,skipCiCheck:true,workerCallback});
  assert(callbackCalls>=1,'worker callback was called at least once');
});

await test('workspace-integration-failure-pauses-pipeline-at-gate-2',async ()=>{
  const d=fixture('ws-merge-fail');
  const r=route(ROOT,'Update shared utility');
  const run=newRun(ROOT,d,{objective:'Update shared utility',route:r});

  // Create a plan with an isolated worktree task
  const plan={
    schema:'agent-sdlc/task-plan/v1',
    plan_id:'PLAN-WS-01',
    objective:run.objective,
    profile:'FAST',
    tasks:[
      {
        task_id:'TASK-WS-01',
        title:'Update utility',
        goal:'Change util',
        done_conditions:['Done'],
        category:'implementation',
        depends_on:[],
        write_scope:['src/**'],
        interface_scope:[],
        compatibility_obligations:[],
        verification:{targeted_tests:['test.js']}
      }
    ]
  };

  const {getTaskWorkspace}=await import('../runtime/workspace.mjs');
  const workerCallback=(task)=>{
    const ws=getTaskWorkspace(d,run.run_id,task.task_id);
    const targetDir=ws?.root||d;
    fs.mkdirSync(path.join(targetDir,'src'),{recursive:true});
    fs.writeFileSync(path.join(targetDir,'src','conflict.js'),'export const v = 1;\n');

    // Introduce conflicting commit directly on the project root master branch
    fs.mkdirSync(path.join(d,'src'),{recursive:true});
    fs.writeFileSync(path.join(d,'src','conflict.js'),'export const v = 2;\n');
    execFileSync('git',['add','src'],{cwd:d});
    execFileSync('git',['-c','user.email=t@t.c','-c','user.name=t','commit','-qm','conflicting change'],{cwd:d});
  };

  const res=runAutoPipeline(ROOT,d,run,{customPlan:plan,skipCiCheck:true,workerCallback});
  assert(res.status==='PAUSED','pipeline should pause when workspace integration fails');
  assert(res.pause_gate===HUMAN_GATES.GATE_2_ESCALATION_BLOCKER,'paused gate must be GATE_2_ESCALATION_BLOCKER');
  assert(res.message.includes('workspace integration failed')||res.message.includes('merge conflict'),'message indicates workspace integration issue');
});

await test('run-commands-surface-pretty-diff-and-rewind',async ()=>{
  const d=fixture('run-commands-test');
  const r=route(ROOT,'Feature test for commands');
  const run=newRun(ROOT,d,{objective:'Feature test for commands',route:r});

  const {commands}=await import('../runtime/commands/run.mjs');
  let output=null;
  const ctx={
    args:{_:['status'],run_id:run.run_id,pretty:'1'},
    ROOT,
    projectRoot:d,
    print:(x)=>{output=x;},
    need:(flag)=>ctx.args[flag],
    needRun:async ()=>run
  };

  // Test status --pretty
  await commands.status(ctx);
  assert(typeof output==='string'&&output.includes('=== SDLC Run'),'status --pretty outputs formatted text');

  // Test diff command
  ctx.args={_:['diff'],run_id:run.run_id};
  await commands.diff(ctx);
  assert(output.schema==='agent-sdlc/run-diff/v1','diff outputs run-diff schema');

  // Test next command
  ctx.args={_:['next'],run_id:run.run_id};
  await commands.next(ctx);
  assert(output.state==='INTAKE'&&output.next==='REQUIREMENTS','next outputs correct states');

  // Test explain command
  ctx.args={_:['explain'],run_id:run.run_id};
  await commands.explain(ctx);
  assert(output.schema==='agent-sdlc/run-explanation/v1','explain outputs explanation schema');

  // Test parallel-plan
  ctx.args={_:['parallel-plan'],tasks:JSON.stringify([{id:'T1',write_set:['src/**']}])};
  await commands['parallel-plan'](ctx);
  assert(output.decision!==undefined,'parallel-plan parses tasks argument');

  // Test gate status & explain
  ctx.args={_:['gate','status'],run_id:run.run_id};
  await commands.gate(ctx);
  assert(output.schema==='agent-sdlc/gate-decision/v1','gate status outputs gate decision');

  ctx.args={_:['gate','explain'],run_id:run.run_id,stage:'REQUIREMENTS'};
  await commands.gate(ctx);
  assert(output.schema==='agent-sdlc/gate-decision/v1'&&output.stage==='REQUIREMENTS','gate explain outputs for specified stage');
});

await test('an-unfillable-scaffolded-design-decision-pauses-rather-than-throwing',async ()=>{
  // Gate 1 clears on approval, then the FULL scaffold still has TODOs in it.
  // Throwing there would punish the operator for approving; asking again is
  // the honest move, and the errors say which fields need writing.
  const d=fixture('auto-design-placeholder');
  const r=route(ROOT,'Fix high severity CVE security vulnerability in auth module');
  const run=newRun(ROOT,d,{objective:'Fix high severity CVE security vulnerability in auth module',route:r});
  const ticket=requestApprovalTicket(ROOT,d,run,{capability:GATE_CAPABILITIES.DESIGN_HUMAN_APPROVED});
  grantApprovalTicket(ROOT,d,run,{ticketId:ticket.ticket_id,actor:'operator'});

  let threw=null;let res=null;
  try{res=runAutoPipeline(ROOT,d,loadRun(d,run.run_id));}catch(e){threw=e;}
  assert(threw===null,`must not throw, got: ${threw&&threw.message}`);
  assert(res.status==='PAUSED','an unfillable scaffold must pause');
  assert(res.current_stage==='DESIGN','paused stage must be DESIGN');
  assert(res.pause_gate===HUMAN_GATES.GATE_1_SCOPE_AND_ARCHITECTURE,'paused gate must be GATE_1_SCOPE_AND_ARCHITECTURE');
  assert(Array.isArray(res.validation_errors)&&res.validation_errors.some(e=>String(e).startsWith('PLACEHOLDER_TEXT_NOT_REPLACED:')),
    `the pause must name the unwritten fields, got ${JSON.stringify(res.validation_errors)}`);
});

await test('an-authored-design-decision-clears-the-placeholder-pause',async ()=>{
  const {recordDesignDecision}=await import('../runtime/orchestrator.mjs');
  const {scaffoldDesignDecision,selectDesignDiscoveryMode}=await import('../runtime/design-discovery.mjs');
  const d=fixture('auto-design-authored');
  const r=route(ROOT,'Fix high severity CVE security vulnerability in auth module');
  let run=newRun(ROOT,d,{objective:'Fix high severity CVE security vulnerability in auth module',route:r});
  const ticket=requestApprovalTicket(ROOT,d,run,{capability:GATE_CAPABILITIES.DESIGN_HUMAN_APPROVED});
  grantApprovalTicket(ROOT,d,run,{ticketId:ticket.ticket_id,actor:'operator'});
  run=loadRun(d,run.run_id);
  const paused=runAutoPipeline(ROOT,d,run);
  assert(paused.current_stage==='DESIGN','precondition: paused in DESIGN');

  const selection=selectDesignDiscoveryMode({profile:run.profile,objective:run.objective});
  const draft=scaffoldDesignDecision(selection,{objective:run.objective});
  const authored={...draft,
    decision:'Patch the dependency and add a regression test for the CVE path.',
    approval:{...draft.approval,status:'APPROVED'},
    options:draft.options.map((o,i)=>({...o,summary:`Option ${i}`,benefits:['closes the CVE'],tradeoffs:['touches auth']}))};
  run=loadRun(d,run.run_id);
  const rec=recordDesignDecision(ROOT,d,run,authored,{approvals:[GATE_CAPABILITIES.DESIGN_HUMAN_APPROVED]});
  assert(rec.recorded===true,`an authored decision must be accepted, got ${JSON.stringify(rec.validation&&rec.validation.errors)}`);
});

await test('a-scaffolded-plan-says-so-and-an-authored-one-does-not',async ()=>{
  const {scaffoldTaskPlan}=await import('../runtime/autonomous-runner.mjs');
  const d=fixture('auto-plan-provenance');
  fs.mkdirSync(path.join(d,'src'),{recursive:true});
  const plan=scaffoldTaskPlan({objective:'Add payment endpoint',profile:'STANDARD'},d);
  assert(plan.generated_by==='auto-scaffold','a scaffolded plan records its provenance');
  const v=validateTaskPlan(plan);
  assert(v.valid===true,'provenance must not make the plan invalid; auto depends on it validating');
  assert(v.warnings.some(w=>w.code==='SCAFFOLDED_PLAN_NOT_AUTHORED'),
    `a scaffolded plan must be surfaced as a warning, got ${JSON.stringify(v.warnings)}`);

  const authored={...plan};delete authored.generated_by;
  const v2=validateTaskPlan(authored);
  assert(!v2.warnings.some(w=>w.code==='SCAFFOLDED_PLAN_NOT_AUTHORED'),'an authored plan carries no such warning');
});

await test('verify-stage-runs-the-suite-over-the-integrated-result',async ()=>{
  // Each task verified its own workspace diff and then the workspaces were
  // merged. VERIFY used to assert targeted_verification_pass over that merge
  // without running anything, so a failure that only exists in the integrated
  // tree reached RELEASE. The fixture separates the two: the per-task command
  // passes, the suite does not.
  const d=fixture('verify-integrated-fail',{commands:{
    test_targeted:['node','-e','process.exit(0)','{selector}'],
    test_full:['node','-e','process.exit(1)']
  }});
  const r=route(ROOT,'Fix calculation bug in helper');
  const run=newRun(ROOT,d,{objective:'Fix calculation bug in helper',route:r});
  const {getTaskWorkspace}=await import('../runtime/workspace.mjs');
  const workerCallback=(task)=>{
    const ws=getTaskWorkspace(d,run.run_id,task.task_id);
    const targetDir=ws?.root||d;
    fs.mkdirSync(path.join(targetDir,'src'),{recursive:true});
    fs.writeFileSync(path.join(targetDir,'src','helper.js'),'export function format() { return "date"; }\n');
  };

  const res=runAutoPipeline(ROOT,d,run,{workerCallback,reviewerCallback:passingReviewer});
  assert(res.status==='PAUSED',`a failing integrated suite must stop the pipeline, got ${res.status}`);
  assert(res.current_stage==='VERIFY',`it must stop at VERIFY, stopped at ${res.current_stage}`);
  assert(res.pause_gate===HUMAN_GATES.GATE_2_ESCALATION_BLOCKER,'a failing suite is an escalation blocker');
  assert(res.verification?.status==='FAIL','the pause carries the failed verification record');
  assert(res.verification?.tool==='test.run_full','the full suite is what ran');

  // And the gate token was never written, so no later call can walk past it.
  const stored=loadRun(d,run.run_id);
  assert(!(stored.evidence?.VERIFY||[]).includes('targeted_verification_pass'),
    'a failed run must not leave the gate token behind');
});

await test('verify-stage-reports-unavailable-when-no-test-command-is-configured',async ()=>{
  // A missing suite is a fact to act on, not a pass. The pipeline-level path is
  // unreachable without also breaking per-task verification, so this exercises
  // the function the VERIFY stage calls.
  const {runIntegratedVerification}=await import('../runtime/autonomous-runner.mjs');
  const d=fixture('verify-no-command',{commands:{}});
  const r=route(ROOT,'Update readme text');
  const run=newRun(ROOT,d,{objective:'Update readme text',route:r});

  const res=runIntegratedVerification(ROOT,d,atVerifyStage(d,run));
  assert(res.status==='UNAVAILABLE',`no configured command must report UNAVAILABLE, got ${res.status}`);
  assert(res.status!=='PASS','it must never be reported as a pass');
  assert(/not configured/.test(res.reason),
    `the reason must name the missing configuration rather than a policy denial, got ${res.reason}`);
});

await test('quality-gate-blocks-a-proven-coding-standards-violation',async ()=>{
  // policies/coding-standards.json was enforced by prompt alone: the linter
  // existed and nothing called it, so an ACCEPTED verdict from a reviewer that
  // never looked was indistinguishable from one that did.
  const d=fixture('standards-violation');
  const r=route(ROOT,'Fix calculation bug in helper');
  const run=newRun(ROOT,d,{objective:'Fix calculation bug in helper',route:r});
  const {getTaskWorkspace}=await import('../runtime/workspace.mjs');
  const workerCallback=(task)=>{
    const ws=getTaskWorkspace(d,run.run_id,task.task_id);
    const targetDir=ws?.root||d;
    fs.mkdirSync(path.join(targetDir,'src'),{recursive:true});
    fs.writeFileSync(path.join(targetDir,'src','helper.js'),'v' + 'ar total = 1;\nexport function calcTotal() { return total; }\n');
  };

  // The reviewer says ACCEPTED with no findings, exactly as before. The gate
  // must not agree with it.
  const res=runAutoPipeline(ROOT,d,run,{workerCallback,reviewerCallback:passingReviewer});
  assert(res.status==='PAUSED',`a BLOCKING standards violation must stop the run, got ${res.status}`);
  assert(res.pause_gate===HUMAN_GATES.GATE_2_ESCALATION_BLOCKER,'it escalates rather than passing');

  const [task]=listTasks(d,run.run_id);
  assert(task.status!=='DONE',`the task must not be DONE, it is ${task.status}`);

  // And for the right reason: the recorded review must carry the violation the
  // linter proved, with the verdict overridden from what the reviewer claimed.
  const {getArtifact}=await import('../runtime/store.mjs');
  const quality=(task.review_refs||[])
    .map(ref=>JSON.parse(getArtifact(d,ref).content))
    .filter(doc=>doc.schema==='agent-sdlc/code-quality-review/v1');
  assert(quality.length>0,'a quality review was recorded');
  const violation=quality.at(-1).findings.find(f=>f.rule_id==='NO_VAR_DECLARATION');
  assert(violation&&violation.severity==='BLOCKING',
    `the review carries the BLOCKING standards finding, got ${JSON.stringify(quality.at(-1).findings)}`);
  assert(violation.evidence==='src/helper.js:1','the finding cites file:line as its evidence');
  assert(quality.at(-1).verdict==='CHANGES_REQUIRED',
    `the reviewer said ACCEPTED; the proven violation must override it, got ${quality.at(-1).verdict}`);
});

await test('a-clean-diff-still-clears-the-coding-standards-audit',async ()=>{
  // The other half of the previous test: the audit must not fail everything.
  const {codingStandardsFindings}=await import('../runtime/task-runner.mjs');
  const d=fixture('standards-clean');
  const r=route(ROOT,'Fix calculation bug in helper');
  const run=newRun(ROOT,d,{objective:'Fix calculation bug in helper',route:r});
  const {getTaskWorkspace}=await import('../runtime/workspace.mjs');
  let audited=null;
  const workerCallback=(task)=>{
    const ws=getTaskWorkspace(d,run.run_id,task.task_id);
    const targetDir=ws?.root||d;
    fs.mkdirSync(path.join(targetDir,'src'),{recursive:true});
    fs.writeFileSync(path.join(targetDir,'src','helper.js'),'const is_ready = true;\nexport function calcTotal() { return is_ready ? 1 : 0; }\n');
    audited=codingStandardsFindings(ROOT,d,loadRun(d,run.run_id),task);
  };

  const res=runAutoPipeline(ROOT,d,run,{workerCallback,reviewerCallback:passingReviewer});
  assert(audited&&audited.findings.length===0,
    `a compliant file must produce no findings, got ${JSON.stringify(audited?.findings)}`);
  assert(audited.status==='RAN'&&audited.files_checked===1,
    `the audit must report that it actually ran, got ${JSON.stringify({status:audited.status,files:audited.files_checked})}`);
  assert(res.pause_gate===HUMAN_GATES.GATE_4_PRE_COMMIT_PUSH_APPROVAL,
    `a compliant task must reach the pre-commit gate, stopped at ${res.pause_gate} in ${res.current_stage}`);

  // An audit that found nothing and an audit that never ran produce the same
  // empty finding list. The recorded review has to distinguish them, or a clean
  // document once again proves nothing.
  const {getArtifact}=await import('../runtime/store.mjs');
  const [task]=listTasks(d,run.run_id);
  const quality=(task.review_refs||[])
    .map(ref=>JSON.parse(getArtifact(d,ref).content))
    .filter(doc=>doc.schema==='agent-sdlc/code-quality-review/v1').at(-1);
  assert(quality?.standards_audit?.status==='RAN',
    `every quality review records the audit status, got ${JSON.stringify(quality?.standards_audit)}`);
  assert(quality.standards_audit.files_checked===1,'and how many files it read');
  assert(quality.standards_audit.policy_source==='harness','and which policy it applied');
});

await test('a-project-can-point-the-standards-audit-elsewhere-or-switch-it-off',async ()=>{
  // The harness policy is opinionated. Enforcing it unasked on a repository
  // with different conventions would block every task there, so the project
  // decides -- and whichever way it decides is recorded on the review.
  const {resolveCodingStandardsPolicy}=await import('../runtime/task-runner.mjs');
  const {getArtifact}=await import('../runtime/store.mjs');
  const {getTaskWorkspace}=await import('../runtime/workspace.mjs');

  const runWith=async (name,codingStandards)=>{
    const d=fixture(name);
    if(codingStandards){
      const cfgPath=path.join(d,'.agent-sdlc','project.json');
      const cfg=JSON.parse(fs.readFileSync(cfgPath,'utf8'));
      fs.writeFileSync(cfgPath,JSON.stringify({...cfg,coding_standards:codingStandards},null,2));
    }
    const r=route(ROOT,'Fix calculation bug in helper');
    const run=newRun(ROOT,d,{objective:'Fix calculation bug in helper',route:r});
    const workerCallback=(task)=>{
      const ws=getTaskWorkspace(d,run.run_id,task.task_id);
      const targetDir=ws?.root||d;
      fs.mkdirSync(path.join(targetDir,'src'),{recursive:true});
      fs.writeFileSync(path.join(targetDir,'src','helper.js'),'v' + 'ar total = 1;\nexport function calcTotal() { return total; }\n');
    };
    const res=runAutoPipeline(ROOT,d,run,{workerCallback,reviewerCallback:passingReviewer});
    const [task]=listTasks(d,run.run_id);
    const quality=(task.review_refs||[])
      .map(ref=>JSON.parse(getArtifact(d,ref).content))
      .filter(doc=>doc.schema==='agent-sdlc/code-quality-review/v1').at(-1);
    return {res,audit:quality?.standards_audit};
  };

  const off=await runWith('standards-disabled',{enabled:false});
  assert(off.res.pause_gate===HUMAN_GATES.GATE_4_PRE_COMMIT_PUSH_APPROVAL,
    `a disabled audit must let the same violation through, stopped at ${off.res.pause_gate}`);
  assert(off.audit?.status==='DISABLED',`and say so, got ${JSON.stringify(off.audit)}`);

  // A policy path that does not resolve is an error, not a silent pass. It does
  // not block -- a broken linter must not strand a task -- but the review says
  // the audit did not happen.
  const broken=await runWith('standards-missing-policy',{policy_path:'nope.json'});
  assert(broken.audit?.status==='ERROR',`a missing policy is recorded as ERROR, got ${JSON.stringify(broken.audit)}`);
  assert(broken.audit.status!=='RAN','it must never be reported as a completed audit');

  const d=fixture('standards-resolution');
  const harness=resolveCodingStandardsPolicy(ROOT,d);
  assert(harness.is_enabled&&harness.source==='harness','with nothing configured the harness policy applies');
  fs.mkdirSync(path.join(d,'policies'),{recursive:true});
  fs.writeFileSync(path.join(d,'policies','coding-standards.json'),'{}');
  assert(resolveCodingStandardsPolicy(ROOT,d).source==='project_policies',
    'a project that vendored its own policy wins over the harness');
});

await test('a-review-recorded-after-the-pause-lets-the-run-continue',async ()=>{
  // The REVIEW pause names `agent-sdlc task review` as the way forward. If that
  // does not actually clear the marker the pause is a dead end, and the honest
  // gate becomes an unusable one.
  const {recordTaskReview}=await import('../runtime/task-review.mjs');
  const d=fixture('review-escape-hatch');
  const r=route(ROOT,'Fix calculation bug in helper');
  const run=newRun(ROOT,d,{objective:'Fix calculation bug in helper',route:r});
  const {getTaskWorkspace}=await import('../runtime/workspace.mjs');
  const workerCallback=(task)=>{
    const ws=getTaskWorkspace(d,run.run_id,task.task_id);
    const targetDir=ws?.root||d;
    fs.mkdirSync(path.join(targetDir,'src'),{recursive:true});
    fs.writeFileSync(path.join(targetDir,'src','helper.js'),'export function calcTotal() { return 1; }\n');
  };

  const paused=runAutoPipeline(ROOT,d,run,{workerCallback,spawnReviewer:false});
  assert(paused.current_stage==='REVIEW','the unreviewed run stops at REVIEW');

  let fresh=loadRun(d,run.run_id);
  for(const task of listTasks(d,run.run_id)){
    const bind={task_id:task.task_id,attempt:task.attempt||0,diff_hash:task.diff_hash};
    const spec=recordTaskReview(d,fresh,task,{schema:'agent-sdlc/spec-compliance-review/v1',...bind,
      verdict:'COMPLIANT',acceptance_criteria_checked:[],findings:[]},{kind:'spec'});
    const quality=recordTaskReview(d,fresh,task,{schema:'agent-sdlc/code-quality-review/v1',...bind,
      verdict:'ACCEPTED',findings:[],independence:{requested:false,achieved:false,limitation:'recorded by hand'}},{kind:'quality'});
    assert(spec.validation.valid&&quality.validation.valid,'both recorded reviews validate against the DONE task');
  }
  assert(listTasks(d,run.run_id).every(t=>!t.reviews_generated_by),'recording a real review clears the stub marker');

  fresh=loadRun(d,run.run_id);
  const resumed=runAutoPipeline(ROOT,d,fresh,{skipCiCheck:true});
  assert(resumed.pause_gate===HUMAN_GATES.GATE_4_PRE_COMMIT_PUSH_APPROVAL,
    `the reviewed run continues to the pre-commit gate, stopped at ${resumed.pause_gate} in ${resumed.current_stage}`);
});

await test('a-test-command-that-cannot-launch-is-not-reported-as-a-failing-suite',async ()=>{
  // A configured command that does not exist and a suite that ran and failed
  // both stop the run, but the operator fixes them in different places.
  const {runIntegratedVerification}=await import('../runtime/autonomous-runner.mjs');
  const d=fixture('verify-unlaunchable',{commands:{
    test_targeted:['node','-e','process.exit(0)'],
    test_full:['nonexistent-cmd-xyz-999','--all']
  }});
  const r=route(ROOT,'Update readme text');
  const run=newRun(ROOT,d,{objective:'Update readme text',route:r});

  const res=runIntegratedVerification(ROOT,d,atVerifyStage(d,run));
  assert(res.status==='ERROR',`a command that never launched reports ERROR, got ${res.status}`);
  assert(res.status!=='PASS','and never a pass');
  assert(res.tool==='test.run_full','the failure is attributed to the command that could not start');
  assert(typeof res.reason==='string'&&res.reason.length>0,'with the launch reason attached');
});

await test('review-stage-refuses-runner-generated-review-stubs',async ()=>{
  // With no reviewer supplied the runner still has to produce the documents the
  // task engine requires, but it marks them, and REVIEW will not resolve on
  // them. Before this, a run whose every review was a stub described itself as
  // reviewed and went on to RELEASE.
  const {AUTO_REVIEW_STUB}=await import('../runtime/autonomous-runner.mjs');
  const d=fixture('unreviewed-run');
  const r=route(ROOT,'Fix calculation bug in helper');
  const run=newRun(ROOT,d,{objective:'Fix calculation bug in helper',route:r});
  const {getTaskWorkspace}=await import('../runtime/workspace.mjs');
  const workerCallback=(task)=>{
    const ws=getTaskWorkspace(d,run.run_id,task.task_id);
    const targetDir=ws?.root||d;
    fs.mkdirSync(path.join(targetDir,'src'),{recursive:true});
    fs.writeFileSync(path.join(targetDir,'src','helper.js'),'export function format() { return "date"; }\n');
  };

  // spawnReviewer:false on purpose. With it left on, this test's outcome would
  // depend on whether a host CLI happens to be installed and authenticated on
  // the machine running the suite -- and a green run would be spawning real,
  // billable agents. The spawning path is covered below with an injected host.
  const res=runAutoPipeline(ROOT,d,run,{workerCallback,spawnReviewer:false});
  assert(res.status==='PAUSED',`an unreviewed run must not proceed, got ${res.status}`);
  assert(res.current_stage==='REVIEW',`it must stop at REVIEW, stopped at ${res.current_stage}`);
  assert(Array.isArray(res.unreviewed_tasks)&&res.unreviewed_tasks.length===1,
    `the pause names the tasks nobody reviewed, got ${JSON.stringify(res.unreviewed_tasks)}`);

  const [task]=listTasks(d,run.run_id);
  assert(task.reviews_generated_by===AUTO_REVIEW_STUB,'the stub marker is persisted on the task');

  const stored=loadRun(d,run.run_id);
  assert(!(stored.evidence?.REVIEW||[]).includes('required_reviews_resolved'),
    'a stubbed run must not record the review gate token');
});

await test('a-spawned-reviewer-produces-a-bound-review-and-never-supplies-its-own-ids',async ()=>{
  // The runner no longer invents reviews; it spawns a reviewer. Every path here
  // uses an injected host, so the suite never starts a real, billable agent.
  // Pinning AI_SDLC_CLAUDE_BIN to the fake host ensures hermetic routing on machines
  // and CI runners where no real host CLI is installed.
  const {resetProbeCache}=await import('../runtime/provider.mjs');
  const {reviewTaskWithAgent,extractReviewJson,buildReviewPrompt,reviewDiff}=
    await import('../runtime/task-reviewer.mjs');
  const {getTaskWorkspace}=await import('../runtime/workspace.mjs');
  const d=fixture('spawned-reviewer');
  const r=route(ROOT,'Fix calculation bug in helper');
  const run=newRun(ROOT,d,{objective:'Fix calculation bug in helper',route:r});
  const workerCallback=(task)=>{
    const ws=getTaskWorkspace(d,run.run_id,task.task_id);
    const targetDir=ws?.root||d;
    fs.mkdirSync(path.join(targetDir,'src'),{recursive:true});
    fs.writeFileSync(path.join(targetDir,'src','helper.js'),'export function calcTotal() { return 1; }\n');
  };
  let seenPrompt=null;
  const host=(hostName,prompt)=>{
    seenPrompt=prompt;
    // A reviewer that gets the bindings wrong, to prove they are not read back.
    return {status:'PASS',stdout:JSON.stringify({type:'result',result:JSON.stringify({
      schema:'agent-sdlc/code-quality-review/v1',
      task_id:'TASK-999',run_id:'run_wrong',attempt:41,diff_hash:'deadbeef',
      verdict:'CHANGES_REQUIRED',
      findings:[{category:'ERROR_HANDLING',severity:'MAJOR',summary:'unchecked read',evidence:'src/helper.js:1'}]
    })})};
  };

  const fakeClaude=path.join(d,'claude.mjs');
  fs.copyFileSync(path.join(ROOT,'evals','fake-host-cli.mjs'),fakeClaude);
  fs.chmodSync(fakeClaude,0o755);
  const prevHost=process.env.AI_SDLC_CLAUDE_BIN;
  process.env.AI_SDLC_CLAUDE_BIN=fakeClaude;
  resetProbeCache();

  try{
    // A reviewer only ever runs at one moment: after the diff is captured and
    // before the task advances, while the workspace still exists. reviewerCallback
    // fires exactly there, so driving the reviewer from inside it exercises the
    // real call site instead of a reconstruction of it.
    let out=null;let task=null;let staged=null;
    const reviewerCallback=(t)=>{
      task=t;staged=loadRun(d,run.run_id);
      out=reviewTaskWithAgent(ROOT,d,staged,t,{kind:'quality',runner:host});
      return {};
    };
    runAutoPipeline(ROOT,d,run,{workerCallback,reviewerCallback});

    assert(out&&out.status==='REVIEWED',`the reviewer must produce a review, got ${out?.status}: ${out?.reason}`);
    assert(out.review.task_id===task.task_id&&out.review.run_id===staged.run_id,
      'ids come from the harness, not from the model');
    assert(out.review.attempt===(task.attempt||0)&&out.review.diff_hash===task.diff_hash,
      'the diff binding is written by the harness; a model that echoed it wrongly must not break the review');
    assert(out.review.verdict==='CHANGES_REQUIRED'&&out.review.findings.length===1,
      'the judgement, and only the judgement, comes from the model');
    assert(out.review.independence.achieved===true&&out.review.independence.worker_reasoning_withheld===true,
      'a separate process with a harness-built prompt is genuinely independent');

    // Independence is a property of what the reviewer was shown.
    assert(/DIFF UNDER REVIEW/.test(seenPrompt),'the reviewer is shown the diff');
    assert(!/reasoning|previous attempt|the worker/i.test(seenPrompt),
      'and never the worker\'s account of its own work');

    // The recorded review must be one the gate accepts.
    const {validateCodeQualityReview}=await import('../runtime/task-review.mjs');
    const validation=validateCodeQualityReview(out.review,task);
    assert(validation.valid===true,`a spawned review must satisfy the contract, got ${JSON.stringify(validation.errors)}`);
    assert(validation.clean===false,'CHANGES_REQUIRED is not a clean gate');

    // The extractor has to survive the shapes real hosts print.
    const wanted={verdict:'ACCEPTED',findings:[]};
    assert(extractReviewJson(JSON.stringify(wanted))?.verdict==='ACCEPTED','bare JSON');
    assert(extractReviewJson('```json\n'+JSON.stringify(wanted)+'\n```')?.verdict==='ACCEPTED','fenced JSON');
    assert(extractReviewJson('noise\n'+JSON.stringify({type:'result',result:JSON.stringify(wanted)}))?.verdict==='ACCEPTED','result envelope');
    assert(extractReviewJson('not json at all')===null,'and returns nothing rather than guessing');

    const diff=reviewDiff(d,staged,task);
    assert(typeof buildReviewPrompt(ROOT,d,staged,task,{kind:'spec',diff})==='string','the spec prompt renders too');
  }finally{
    if(prevHost)process.env.AI_SDLC_CLAUDE_BIN=prevHost;
    else delete process.env.AI_SDLC_CLAUDE_BIN;
    resetProbeCache();
  }
});

await test('a-reviewer-that-cannot-be-reached-never-reads-as-a-clean-review',async ()=>{
  // The whole point of spawning one. Every failure mode has to land on
  // UNAVAILABLE, because the only alternative the caller has is a marked
  // placeholder that blocks REVIEW -- and an accidental clean review here would
  // restore exactly the rubber stamp this replaced.
  const {resetProbeCache}=await import('../runtime/provider.mjs');
  const {reviewTaskWithAgent}=await import('../runtime/task-reviewer.mjs');
  const {getTaskWorkspace}=await import('../runtime/workspace.mjs');
  const d=fixture('reviewer-unreachable');
  const r=route(ROOT,'Fix calculation bug in helper');
  const run=newRun(ROOT,d,{objective:'Fix calculation bug in helper',route:r});
  const workerCallback=(task)=>{
    const ws=getTaskWorkspace(d,run.run_id,task.task_id);
    const targetDir=ws?.root||d;
    fs.mkdirSync(path.join(targetDir,'src'),{recursive:true});
    fs.writeFileSync(path.join(targetDir,'src','helper.js'),'export function calcTotal() { return 1; }\n');
  };
  const cases=[
    ['host failed',()=>({status:'FAIL',reason:'HOST_CLI_NOT_FOUND',stdout:''})],
    ['host timed out',()=>({status:'FAIL',timed_out:true,stdout:''})],
    ['unparseable output',()=>({status:'PASS',stdout:'I reviewed it and it looks fine to me.'})],
    ['verdict outside the contract',()=>({status:'PASS',stdout:JSON.stringify({verdict:'LGTM',findings:[]})})],
    ['a spec verdict on a quality review',()=>({status:'PASS',stdout:JSON.stringify({verdict:'COMPLIANT',findings:[]})})]
  ];

  const fakeClaude=path.join(d,'claude.mjs');
  fs.copyFileSync(path.join(ROOT,'evals','fake-host-cli.mjs'),fakeClaude);
  fs.chmodSync(fakeClaude,0o755);
  const prevHost=process.env.AI_SDLC_CLAUDE_BIN;
  process.env.AI_SDLC_CLAUDE_BIN=fakeClaude;
  resetProbeCache();

  let staged=null;let task=null;
  try{
    const outcomes=[];
    const reviewerCallback=(t)=>{
      task=t;staged=loadRun(d,run.run_id);
      if(!outcomes.length){
        for(const [label,host] of cases){
          outcomes.push([label,reviewTaskWithAgent(ROOT,d,staged,t,{kind:'quality',runner:host})]);
        }
      }
      return {};
    };
    runAutoPipeline(ROOT,d,run,{workerCallback,reviewerCallback});

    assert(outcomes.length===cases.length,'every failure mode was exercised at the real call site');
    for(const [label,out] of outcomes){
      assert(out.status==='UNAVAILABLE',`${label} must be UNAVAILABLE, got ${out.status}`);
      assert(out.review===null,`${label} must not yield a review document`);
      assert(typeof out.reason==='string'&&out.reason.length>0,`${label} must say why`);
    }

    // And an incomplete pair is not half a review: the runner treats it as
    // unreviewed rather than advancing on the one document it got.
    const {resolveTaskReviews}=await import('../runtime/autonomous-runner.mjs');
    const none=resolveTaskReviews(ROOT,d,staged,task,{spawnReviewer:false});
    assert(none.specReview===null&&none.qualityReview===null&&none.source==='DISABLED',
      'with spawning off and no callback there is no review at all');
  }finally{
    if(prevHost)process.env.AI_SDLC_CLAUDE_BIN=prevHost;
    else delete process.env.AI_SDLC_CLAUDE_BIN;
    resetProbeCache();
  }
});

finish();

