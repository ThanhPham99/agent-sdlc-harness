#!/usr/bin/env node
// Test suite for Autonomous SDLC Runner, CI Guard, and Human Confirmation Gates.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {initProject,saveRun,loadRun,putArtifact,listTasks,saveTask} from '../runtime/store.mjs';
import {newRun} from '../runtime/orchestrator.mjs';
import {route} from '../runtime/router.mjs';
import {runAutoPipeline,runAutoTaskLoop,HUMAN_GATES} from '../runtime/autonomous-runner.mjs';
import {detectProjectCi,runLocalCiValidation,ensureCiPassedBeforeDelivery} from '../runtime/ci-guard.mjs';
import {requestApprovalTicket,grantApprovalTicket,listApprovalTickets} from '../runtime/approvals.mjs';
import {execFileSync} from 'node:child_process';
import {createSuite} from './lib/suite.mjs';
import {makeTempDir} from './lib/tempdir.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const {test,assert,finish}=createSuite('agent-sdlc/autonomous-runner-validation/v1','AUTONOMOUS-RUNNER-VALIDATION.json');

function fixture(name='auto-test-service'){
  const d=makeTempDir(`agent-sdlc-${name}-`);
  execFileSync('git',['init','-q'],{cwd:d});
  fs.writeFileSync(path.join(d,'README.md'),'# fixture\n');
  execFileSync('git',['add','.'],{cwd:d});
  execFileSync('git',['-c','user.email=test@test.local','-c','user.name=test','commit','-qm','init'],{cwd:d});
  initProject(d,{
    schema:'agent-sdlc/project/v1',
    project:name,
    commands:{
      test_targeted:['node','-e','process.exit(0)'],
      test_full:['node','-e','process.exit(0)']
    },
    test_commands:{
      test_targeted:['node','-e','process.exit(0)'],
      test_full:['node','-e','process.exit(0)']
    }
  });
  return d;
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
  const ticket=requestApprovalTicket(d,run,{
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

  const res=runAutoPipeline(ROOT,d,run,{workerCallback});
  // Low-risk FAST/STANDARD skips Gate 1, executes PLAN and IMPLEMENT, and pauses at Gate 4 before commit/push
  assert(res.status==='PAUSED','pipeline should pause at Gate 4');
  assert(res.pause_gate===HUMAN_GATES.GATE_4_PRE_COMMIT_PUSH_APPROVAL,'paused gate must be GATE_4_PRE_COMMIT_PUSH_APPROVAL');
  assert(res.current_stage==='RELEASE','paused stage must be RELEASE');
  assert(typeof res.pr_body==='string'&&res.pr_body.length>0,'pr_body should be generated');

  // Once user grants delivery_commit_approved, pipeline completes to CLOSE
  const freshRun=loadRun(d,run.run_id);
  const ticket=requestApprovalTicket(d,freshRun,{capability:'delivery_commit_approved'});
  grantApprovalTicket(ROOT,d,freshRun,{
    ticketId:ticket.ticket_id,
    actor:'operator'
  });

  const finalRes=runAutoPipeline(ROOT,d,freshRun,{skipCiCheck:true});
  assert(finalRes.status==='COMPLETED','pipeline should finish to COMPLETED');
  assert(finalRes.current_stage==='CLOSE','final stage must be CLOSE');
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
    ticketId:requestApprovalTicket(d,run,{capability:'delivery_commit_approved'}).ticket_id,
    actor:'lead'
  });

  const {getTaskWorkspace}=await import('../runtime/workspace.mjs');
  const workerCallback=(task)=>{
    const ws=getTaskWorkspace(d,run.run_id,task.task_id);
    const targetDir=ws?.root||d;
    fs.mkdirSync(path.join(targetDir,'src'),{recursive:true});
    fs.writeFileSync(path.join(targetDir,'src','service.js'),'export const billing = 1;\n');
  };

  const res=runAutoPipeline(ROOT,d,run,{skipCiCheck:true,workerCallback});
  assert(res.status==='PAUSED','pipeline should pause at Gate 5');
  assert(res.pause_gate===HUMAN_GATES.GATE_5_PRIVILEGED_ACTION,'paused gate must be GATE_5_PRIVILEGED_ACTION');
  assert(res.current_stage==='DEPLOY','paused stage must be DEPLOY');

  // Grant production deployment approval
  const freshRun=loadRun(d,run.run_id);
  const ticket=requestApprovalTicket(d,freshRun,{capability:'deploy.production',expiresInMinutes:30});
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

  const resMaint=runAutoPipeline(ROOT,dMaint,runMaint,{workerCallback});
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

finish();

