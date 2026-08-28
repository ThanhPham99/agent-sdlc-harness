// Alpha5 task-runtime evaluation suite.
//
// Shared by `npm test` (which asserts zero failures) and
// `scripts/validate-task-engine.mjs` (which turns the same results into release
// evidence), so the gate and the evidence can never disagree.
//
// Fully offline: a temporary git repository, project commands that are plain
// `node -e` exits, and no model or host involvement anywhere.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {initProject,listTasks,loadTask,saveTask,loadTaskGraph,putArtifact,listTaskEvents,getTaskContextManifest} from '../runtime/store.mjs';
import {route} from '../runtime/router.mjs';
import {newRun,transition,recordDesignDecision,recordTaskPlan,materializeRunTasks,recordImplementationComplete} from '../runtime/orchestrator.mjs';
import {materializeTaskGraph,refreshReadiness,transitionTask,evaluateTransition,dependencyState,taskProgress,requireTask} from '../runtime/task-engine.mjs';
import {scheduleTasks,readySet,scopeConflicts,mustSerialize,scopeOverlap as schedulerOverlap} from '../runtime/task-scheduler.mjs';
import {scopeOverlap as sharedOverlap} from '../runtime/scope.mjs';
import {computeScopeConflicts} from '../runtime/plan-validator.mjs';
import {buildTaskContext,renderTaskPrompt,EXCLUDED_BY_DEFAULT} from '../runtime/task-context.mjs';
import {createTaskWorkspace,cleanupTaskWorkspace,checkWriterIsolation,listTaskWorkspaces,scrubbedEnv,workspaceDiff,getTaskWorkspace} from '../runtime/workspace.mjs';
import {verifyTask,scopeAudit,verificationStrategy,plannedCommands} from '../runtime/task-verification.mjs';
import {validateSpecComplianceReview,validateCodeQualityReview,recordTaskReview} from '../runtime/task-review.mjs';
import {classifyTaskFailure,planRecovery,applyRecovery,evidenceFingerprint,hasNewEvidence,outerEscalation} from '../runtime/task-recovery.mjs';
import {startTask,advanceTask,captureTaskDiff,taskCheckpoint,recordTaskUsage,resumeFromCheckpoint} from '../runtime/task-runner.mjs';
import {migrateRunToTaskRuntime} from '../runtime/task-migration.mjs';
import {reportRunTaskUsage} from '../runtime/cost.mjs';
import {taskMetrics} from '../runtime/telemetry.mjs';

const gitq=(cwd,...a)=>execFileSync('git',a,{cwd,stdio:'ignore'});

/** A throwaway git project with deterministic, always-passing commands. */
export function makeFixture({failingTests=false,commands=null}={}){
  const d=fs.mkdtempSync(path.join(os.tmpdir(),'agent-sdlc-taskrt-'));
  gitq(d,'init','-q');
  fs.mkdirSync(path.join(d,'src','auth'),{recursive:true});
  fs.mkdirSync(path.join(d,'src','notify'),{recursive:true});
  fs.writeFileSync(path.join(d,'.gitignore'),'.agent-sdlc/\n');
  fs.writeFileSync(path.join(d,'src','auth','token-store.js'),'export const store=new Map();\n');
  fs.writeFileSync(path.join(d,'src','notify','reset-email.js'),'export const send=()=>true;\n');
  gitq(d,'add','.');
  execFileSync('git',['-c','user.email=a@b.c','-c','user.name=t','commit','-qm','init'],{cwd:d,stdio:'ignore'});
  initProject(d,{
    schema:'agent-sdlc/project/v1',project:'task-fixture',
    commands:commands||{
      test_targeted:['node','-e',failingTests?'process.exit(1)':'process.exit(0)'],
      test_full:['node','-e','process.exit(0)'],
      build:['node','-e','process.exit(0)']
    },
    context:{project_invariants:['do not edit generated files']},
    providers:{preferred:['claude','codex','antigravity']}
  });
  return d;
}

const TASK=(over={})=>({
  task_id:'TASK-001',title:'Persist reset tokens',goal:'Store single-use reset tokens with an expiry',
  category:'implementation',acceptance_criteria:['AC-001'],design_decisions:['DESIGN-001'],
  modules:['auth'],write_scope:['src/auth/token-store.js'],read_scope:['src/auth/'],
  likely_symbols:['store'],
  verification:{targeted_tests:['tests/auth/token-store.test.js'],expected_behavior:['an expired token is rejected']},
  done_conditions:['tokens persist and expire; targeted tests pass'],
  ...over
});

export function basePlan(over={}){
  return {
    schema:'agent-sdlc/task-plan/v1',plan_id:'PLAN-001',objective:'Add password reset confirmation',
    profile:'STANDARD',requirements:['AC-001'],design_decisions:['DESIGN-001'],
    tasks:[TASK()],
    ...over
  };
}

/** Drive a run to PLAN with real gate evidence, then to IMPLEMENT. */
function runAtImplement(root,projectRoot,{plan=basePlan()}={}){
  const run=newRun(root,projectRoot,{objective:plan.objective,route:route(root,'Add password reset feature')});
  transition(root,projectRoot,run,'REQUIREMENTS');
  transition(root,projectRoot,run,'DESIGN',{evidence:['requirements_confirmed']});
  recordDesignDecision(root,projectRoot,run,{
    schema:'agent-sdlc/design-decision/v1',decision_id:'DESIGN-001',objective:plan.objective,mode:'COMPACT',
    requirements:['AC-001'],decision:'Reuse the existing token store',
    approval:{required:false,status:'NOT_REQUIRED'},verification_obligations:['targeted reset tests']
  });
  transition(root,projectRoot,run,'PLAN');
  const rec=recordTaskPlan(root,projectRoot,run,plan);
  if(!rec.recorded)throw new Error(`fixture plan invalid: ${JSON.stringify(rec.validation.errors)}`);
  const mat=materializeRunTasks(root,projectRoot,run,plan,{sourceRevision:null});
  if(!mat.materialized)throw new Error(`fixture materialization failed: ${JSON.stringify(mat.validation.errors)}`);
  transition(root,projectRoot,run,'IMPLEMENT');
  refreshReadiness(root,projectRoot,run.run_id);
  return {run,materialization:mat};
}

/** Simulate a writer producing the change its task was authorized to make. */
function writeInWorkspace(projectRoot,run,taskId,relPath,content){
  const ws=getTaskWorkspace(projectRoot,run.run_id,taskId);
  const target=path.join(ws.root,relPath);
  fs.mkdirSync(path.dirname(target),{recursive:true});
  fs.writeFileSync(target,content);
  return target;
}

const specReviewFor=(task,over={})=>({
  schema:'agent-sdlc/spec-compliance-review/v1',task_id:task.task_id,run_id:task.run_id,
  attempt:task.attempt,diff_hash:task.diff_hash,
  acceptance_criteria_checked:[...(task.acceptance_criteria||[])],
  design_decisions_checked:[...(task.design_decisions||[])],
  verdict:'COMPLIANT',findings:[],
  independence:{requested:false,achieved:false,mode:'SAME_CONTEXT',limitation:'single-agent fixture run',worker_reasoning_withheld:true},
  ...over
});
const qualityReviewFor=(task,over={})=>({
  schema:'agent-sdlc/code-quality-review/v1',task_id:task.task_id,run_id:task.run_id,
  attempt:task.attempt,diff_hash:task.diff_hash,verdict:'ACCEPTED',findings:[],
  independence:{requested:false,achieved:false,mode:'SAME_CONTEXT',limitation:'single-agent fixture run',worker_reasoning_withheld:true},
  ...over
});

// ---------------------------------------------------------------------------

export function runTaskRuntimeSuite(root){
  const groups={};
  const group=name=>{groups[name]=groups[name]||[];return (title,fn)=>{
    try{fn();groups[name].push({name:title,status:'PASS'});}
    catch(e){groups[name].push({name:title,status:'FAIL',error:e.message});}
  };};
  const fail=m=>{throw new Error(m);};

  // ======================= state machine =================================
  {
    const t=group('state_machine');
    const projectRoot=makeFixture();

    t('legal-forward-flow-reaches-done',()=>{
      const {run}=runAtImplement(root,projectRoot);
      const started=startTask(root,projectRoot,run,'TASK-001',{writer:'writer-a'});
      if(!started.started)fail(JSON.stringify(started));
      if(started.task.status!=='RUNNING')fail(started.task.status);
      writeInWorkspace(projectRoot,run,'TASK-001','src/auth/token-store.js','export const store=new Map();\nexport const ttl=900;\n');
      let out=advanceTask(root,projectRoot,run,'TASK-001');
      if(out.awaiting!=='SPEC_COMPLIANCE_REVIEW')fail(`expected spec review, got ${JSON.stringify(out.awaiting||out.steps)}`);
      let task=requireTask(projectRoot,run.run_id,'TASK-001');
      out=advanceTask(root,projectRoot,run,'TASK-001',{specReview:specReviewFor(task)});
      if(out.awaiting!=='CODE_QUALITY_REVIEW')fail(`expected quality review, got ${JSON.stringify(out.awaiting||out.steps)}`);
      task=requireTask(projectRoot,run.run_id,'TASK-001');
      out=advanceTask(root,projectRoot,run,'TASK-001',{specReview:specReviewFor(task),qualityReview:qualityReviewFor(task)});
      if(!out.advanced)fail(JSON.stringify(out.steps));
      if(out.task.status!=='DONE')fail(out.task.status);
      const gate=recordImplementationComplete(root,projectRoot,run);
      if(!gate.recorded)fail(JSON.stringify(gate.problems));
      transition(root,projectRoot,run,'VERIFY');
      if(run.state!=='VERIFY')fail(run.state);
    });

    t('illegal-status-skip-rejected',()=>{
      const {run}=runAtImplement(root,projectRoot);
      const task=requireTask(projectRoot,run.run_id,'TASK-001');
      const check=evaluateTransition(root,task,'DONE',{tasks:[task]});
      if(check.allowed)fail('READY->DONE was allowed');
      if(!check.problems.some(p=>p.startsWith('ILLEGAL_TRANSITION')))fail(JSON.stringify(check.problems));
    });

    t('done-requires-verification-evidence',()=>{
      const {run}=runAtImplement(root,projectRoot);
      let task=requireTask(projectRoot,run.run_id,'TASK-001');
      // Walk to QUALITY_REVIEW by force, carrying no evidence at all.
      for(const to of ['RUNNING','VERIFYING','SPEC_REVIEW','QUALITY_REVIEW'])
        task=transitionTask(root,projectRoot,task,to,{force:true,reason:'fixture'});
      const check=evaluateTransition(root,task,'DONE',{tasks:[task]});
      if(check.allowed)fail('DONE allowed with no verification evidence');
      if(!check.problems.includes('NO_VERIFICATION_EVIDENCE'))fail(JSON.stringify(check.problems));
    });

    t('done-blocked-by-blocking-review-finding',()=>{
      const {run}=runAtImplement(root,projectRoot);
      let task=requireTask(projectRoot,run.run_id,'TASK-001');
      for(const to of ['RUNNING','VERIFYING','SPEC_REVIEW','QUALITY_REVIEW'])
        task=transitionTask(root,projectRoot,task,to,{force:true,reason:'fixture'});
      const verification={status:'PASS',attempt:task.attempt,scope:{respected:true,out_of_scope_paths:[]}};
      const quality=qualityReviewFor(task,{verdict:'ACCEPTED',findings:[
        {category:'SECURITY_OR_PRIVACY',severity:'BLOCKING',summary:'token compared with ==',evidence:'src/auth/token-store.js:12'}
      ]});
      const check=evaluateTransition(root,task,'DONE',{tasks:[task],verification,
        specReview:specReviewFor(task),qualityReview:quality});
      if(check.allowed)fail('DONE allowed with a blocking quality finding');
      if(!check.problems.some(p=>p.startsWith('QUALITY_REVIEW_BLOCKING_FINDINGS')))fail(JSON.stringify(check.problems));
    });

    t('retry-requires-new-evidence',()=>{
      const {run}=runAtImplement(root,projectRoot);
      let task=requireTask(projectRoot,run.run_id,'TASK-001');
      task=transitionTask(root,projectRoot,task,'RUNNING',{force:true});
      task=transitionTask(root,projectRoot,task,'VERIFYING',{force:true});
      const without=evaluateTransition(root,task,'RUNNING',{tasks:[task],newEvidence:false});
      if(without.allowed)fail('retry allowed without new evidence');
      if(!without.problems.includes('RETRY_WITHOUT_NEW_EVIDENCE'))fail(JSON.stringify(without.problems));
      const withEvidence=evaluateTransition(root,task,'RUNNING',{tasks:[task],newEvidence:true});
      if(!withEvidence.allowed)fail(JSON.stringify(withEvidence.problems));
    });

    t('terminal-done-cannot-restart',()=>{
      const {run}=runAtImplement(root,projectRoot);
      let task=requireTask(projectRoot,run.run_id,'TASK-001');
      task=transitionTask(root,projectRoot,task,'RUNNING',{force:true});
      task.status='DONE';saveTask(projectRoot,task);
      const check=evaluateTransition(root,task,'RUNNING',{tasks:[task]});
      if(check.allowed)fail('DONE->RUNNING allowed');
    });

    t('dependency-not-done-keeps-downstream-unready',()=>{
      const plan=basePlan({requirements:['AC-001','AC-002'],tasks:[
        TASK(),
        TASK({task_id:'TASK-002',title:'Confirm reset',goal:'Confirm a reset with a valid token',
          depends_on:['TASK-001'],acceptance_criteria:['AC-002'],write_scope:['src/auth/reset-confirm.js']})
      ]});
      const {run}=runAtImplement(root,projectRoot,{plan});
      const tasks=listTasks(projectRoot,run.run_id);
      const two=tasks.find(t=>t.task_id==='TASK-002');
      if(two.status!=='CREATED')fail(`TASK-002 is ${two.status}`);
      const dep=dependencyState(tasks,two);
      if(dep.satisfied)fail('dependency reported satisfied while TASK-001 is not DONE');
      const check=evaluateTransition(root,two,'READY',{tasks});
      if(check.allowed)fail('READY allowed with an unfinished dependency');
    });

    t('failed-dependency-blocks-downstream',()=>{
      const plan=basePlan({requirements:['AC-001','AC-002'],tasks:[
        TASK(),
        TASK({task_id:'TASK-002',goal:'downstream',depends_on:['TASK-001'],acceptance_criteria:['AC-002'],write_scope:['src/auth/reset-confirm.js']})
      ]});
      const {run}=runAtImplement(root,projectRoot,{plan});
      let one=requireTask(projectRoot,run.run_id,'TASK-001');
      one=transitionTask(root,projectRoot,one,'RUNNING',{force:true});
      transitionTask(root,projectRoot,one,'FAILED',{force:true,failureClass:'IMPLEMENTATION_DEFECT'});
      const r=refreshReadiness(root,projectRoot,run.run_id);
      if(!r.blocked.includes('TASK-002'))fail(JSON.stringify(r));
      const two=requireTask(projectRoot,run.run_id,'TASK-002');
      if(two.status!=='BLOCKED')fail(two.status);
      if(two.blocker?.class!=='DEPENDENCY_BLOCKED')fail(JSON.stringify(two.blocker));
    });

    t('invalidated-resume-requires-refreshed-upstream',()=>{
      const {run}=runAtImplement(root,projectRoot);
      let task=requireTask(projectRoot,run.run_id,'TASK-001');
      task=transitionTask(root,projectRoot,task,'INVALIDATED',{reason:'design changed',invalidationSource:'DESIGN-001'});
      if(task.invalidation?.source!=='DESIGN-001')fail(JSON.stringify(task.invalidation));
      const without=evaluateTransition(root,task,'READY',{tasks:[task]});
      if(without.allowed)fail('INVALIDATED->READY allowed without a refreshed upstream');
      const withRefresh=evaluateTransition(root,task,'READY',{tasks:[task],upstreamRefreshed:true});
      if(!withRefresh.allowed)fail(JSON.stringify(withRefresh.problems));
    });

    t('one-primary-writer-per-task-enforced',()=>{
      const {run}=runAtImplement(root,projectRoot);
      const task=requireTask(projectRoot,run.run_id,'TASK-001');
      createTaskWorkspace(projectRoot,{run,task,writer:'writer-a'});
      let rejected=false;
      try{createTaskWorkspace(projectRoot,{run,task,writer:'writer-b'});}
      catch(e){rejected=/exactly one writer/.test(e.message);}
      if(!rejected)fail('a second writer was bound to the same task');
      const iso=checkWriterIsolation(projectRoot,run.run_id);
      if(!iso.valid)fail(JSON.stringify(iso.violations));
    });

    t('writer-workspace-strips-production-credentials',()=>{
      const {removed,env}=scrubbedEnv({PATH:'/x',PROD_DEPLOY_TOKEN:'s',PRODUCTION_DB_PASSWORD:'s',AWS_SESSION_TOKEN:'s',SAFE_VAR:'ok'});
      if(!removed.includes('PROD_DEPLOY_TOKEN')||!removed.includes('AWS_SESSION_TOKEN'))fail(JSON.stringify(removed));
      if(env.SAFE_VAR!=='ok'||env.PATH!=='/x')fail('scrubbing removed benign variables');
      if('PROD_DEPLOY_TOKEN' in env)fail('credential survived scrubbing');
    });

    t('materialization-refuses-an-invalid-plan',()=>{
      const bad=basePlan({tasks:[TASK({depends_on:['TASK-404']})]});
      const run=newRun(root,projectRoot,{objective:'bad plan',route:route(root,'Add password reset feature')});
      transition(root,projectRoot,run,'REQUIREMENTS');
      transition(root,projectRoot,run,'DESIGN',{evidence:['requirements_confirmed']});
      recordDesignDecision(root,projectRoot,run,{schema:'agent-sdlc/design-decision/v1',decision_id:'DESIGN-001',
        objective:'x',mode:'SKIP',skip_reason:'fixture',approval:{required:false,status:'NOT_REQUIRED'}});
      transition(root,projectRoot,run,'PLAN');
      const out=materializeTaskGraph(root,projectRoot,run,bad);
      if(out.materialized)fail('an invalid plan was materialized');
      if(!out.validation.errors.some(e=>e.code==='UNKNOWN_DEPENDENCY'))fail(JSON.stringify(out.validation.errors));
      if(listTasks(projectRoot,run.run_id).length)fail('tasks were created from an invalid plan');
    });

    t('materialization-is-idempotent',()=>{
      const {run}=runAtImplement(root,projectRoot);
      let task=requireTask(projectRoot,run.run_id,'TASK-001');
      task=transitionTask(root,projectRoot,task,'RUNNING',{force:true});
      const again=materializeTaskGraph(root,projectRoot,run,basePlan());
      if(!again.materialized)fail(JSON.stringify(again.validation.errors));
      if(again.created.length)fail(`re-materialization recreated ${again.created.join(',')}`);
      if(!again.preserved.includes('TASK-001'))fail(JSON.stringify(again.preserved));
      if(requireTask(projectRoot,run.run_id,'TASK-001').status!=='RUNNING')fail('an in-flight task was reset');
    });

    t('implement-gate-closed-until-every-task-is-done',()=>{
      const {run}=runAtImplement(root,projectRoot);
      const gate=recordImplementationComplete(root,projectRoot,run);
      if(gate.recorded)fail('IMPLEMENT gate opened with open tasks');
      if(!gate.problems.some(p=>p.startsWith('TASKS_NOT_DONE')))fail(JSON.stringify(gate.problems));
      let blocked=false;
      try{transition(root,projectRoot,run,'VERIFY');}catch(e){blocked=/implementation_artifact|task_graph_complete/.test(e.message);}
      if(!blocked)fail('IMPLEMENT->VERIFY opened without task completion');
    });

    t('implement-gate-evidence-cannot-be-asserted',()=>{
      const {run}=runAtImplement(root,projectRoot);
      let refused=false;
      try{transition(root,projectRoot,run,'VERIFY',{evidence:['implementation_artifact']});}
      catch(e){refused=/deterministic validator/.test(e.message);}
      if(!refused)fail('implementation_artifact was accepted as caller-asserted evidence');
    });
  }

  // ========================== scheduler ===================================
  {
    const t=group('scheduler');
    const projectRoot=makeFixture();
    const parallelPair=(over={})=>basePlan({
      requirements:['AC-001','AC-002'],
      tasks:[
        TASK({parallel_candidate:true,estimated_seconds:120,...over.a}),
        TASK({task_id:'TASK-002',title:'Send reset email',goal:'Send the reset notification',
          acceptance_criteria:['AC-002'],modules:['notify'],write_scope:['src/notify/reset-email.js'],
          read_scope:['src/notify/'],parallel_candidate:true,estimated_seconds:120,...over.b})
      ],
      ...over.plan
    });

    t('linear-dag-dispatches-one-then-the-next',()=>{
      const plan=basePlan({requirements:['AC-001','AC-002'],tasks:[
        TASK(),
        TASK({task_id:'TASK-002',goal:'downstream',depends_on:['TASK-001'],acceptance_criteria:['AC-002'],write_scope:['src/auth/reset-confirm.js']})
      ]});
      const {run}=runAtImplement(root,projectRoot,{plan});
      let d=scheduleTasks(root,projectRoot,run);
      if(d.selected.join(',')!=='TASK-001')fail(JSON.stringify(d.selected));
      let one=requireTask(projectRoot,run.run_id,'TASK-001');
      one.status='DONE';saveTask(projectRoot,one);
      refreshReadiness(root,projectRoot,run.run_id);
      d=scheduleTasks(root,projectRoot,run);
      if(d.selected.join(',')!=='TASK-002')fail(JSON.stringify(d.selected));
    });

    t('disjoint-parallel-candidates-dispatch-together',()=>{
      const {run}=runAtImplement(root,projectRoot,{plan:parallelPair()});
      const d=scheduleTasks(root,projectRoot,run);
      if(d.selected.length!==2)fail(JSON.stringify(d));
      if(d.conflicts.length)fail(JSON.stringify(d.conflicts));
      if(d.reason!=='disjoint-and-worthwhile')fail(d.reason);
    });

    // The plan validator rejects overlapping parallel candidates upstream, so
    // these fixtures start from a valid plan and then widen scope on the task
    // records — the runtime case where scope grows after planning. The
    // scheduler must catch it independently of the plan gate.
    const widenScope=(projectRoot,run,taskId,patch)=>{
      const task=requireTask(projectRoot,run.run_id,taskId);
      task.scope={...task.scope,...patch};
      saveTask(projectRoot,task);
    };

    t('overlapping-write-scope-serializes',()=>{
      const {run}=runAtImplement(root,projectRoot,{plan:parallelPair()});
      widenScope(projectRoot,run,'TASK-001',{write:['src/auth/']});
      widenScope(projectRoot,run,'TASK-002',{write:['src/auth/token-store.js']});
      const d=scheduleTasks(root,projectRoot,run);
      if(d.selected.length!==1)fail(JSON.stringify(d.selected));
      if(!d.conflicts.some(c=>c.kind==='WRITE_SCOPE'))fail(JSON.stringify(d.conflicts));
    });

    t('overlapping-interface-scope-serializes',()=>{
      const {run}=runAtImplement(root,projectRoot,{plan:parallelPair()});
      widenScope(projectRoot,run,'TASK-001',{interfaces:['GET /v1/orders']});
      widenScope(projectRoot,run,'TASK-002',{interfaces:['GET /v1/orders']});
      const d=scheduleTasks(root,projectRoot,run);
      if(d.selected.length!==1)fail(JSON.stringify(d.selected));
      if(!d.conflicts.some(c=>c.kind==='INTERFACE_SCOPE'))fail(JSON.stringify(d.conflicts));
    });

    t('short-writer-tasks-are-not-worth-parallelizing',()=>{
      const {run}=runAtImplement(root,projectRoot,{plan:parallelPair({
        a:{estimated_seconds:5},b:{estimated_seconds:5}
      })});
      const d=scheduleTasks(root,projectRoot,run);
      if(d.selected.length!==1)fail(JSON.stringify(d.selected));
      if(!d.deferred.some(x=>x.reason.startsWith('NO_BENEFIT')))fail(JSON.stringify(d.deferred));
    });

    t('read-only-tasks-parallelize-without-a-time-threshold',()=>{
      const plan=basePlan({requirements:['AC-001','AC-002'],tasks:[
        TASK({changes_behavior:false,write_scope:[],parallel_candidate:true,estimated_seconds:5,category:'verification'}),
        TASK({task_id:'TASK-002',goal:'audit the notify path',changes_behavior:false,write_scope:[],
          acceptance_criteria:['AC-002'],read_scope:['src/notify/'],parallel_candidate:true,estimated_seconds:5,category:'verification'})
      ]});
      const {run}=runAtImplement(root,projectRoot,{plan});
      const d=scheduleTasks(root,projectRoot,run);
      if(d.selected.length!==2)fail(JSON.stringify(d));
      if(d.writers.length)fail(`read-only tasks were counted as writers: ${d.writers.join(',')}`);
    });

    t('writer-cap-is-two-by-default-and-one-under-strict',()=>{
      const three=basePlan({requirements:['AC-001','AC-002','AC-003'],tasks:[
        TASK({parallel_candidate:true,estimated_seconds:120}),
        TASK({task_id:'TASK-002',goal:'b',acceptance_criteria:['AC-002'],write_scope:['src/notify/reset-email.js'],parallel_candidate:true,estimated_seconds:120}),
        TASK({task_id:'TASK-003',goal:'c',acceptance_criteria:['AC-003'],write_scope:['src/other/c.js'],parallel_candidate:true,estimated_seconds:120})
      ]});
      const {run}=runAtImplement(root,projectRoot,{plan:three});
      const d=scheduleTasks(root,projectRoot,run);
      if(d.selected.length!==2)fail(`expected 2 writers, got ${JSON.stringify(d.selected)}`);
      if(!d.deferred.some(x=>x.reason.startsWith('WRITER_CAP')))fail(JSON.stringify(d.deferred));
      const strictRun={...run,profile:'STRICT'};
      const s=scheduleTasks(root,projectRoot,strictRun);
      if(s.selected.length!==1)fail(`STRICT dispatched ${JSON.stringify(s.selected)}`);
    });

    t('migration-category-runs-alone',()=>{
      const plan=basePlan({requirements:['AC-001','AC-002'],tasks:[
        TASK({task_id:'TASK-001',category:'migration',goal:'backfill tenant_id',
          write_scope:['migrations/0007.sql'],rollback_obligations:['restore from snapshot'],
          risk:{profile:'STRICT',data:'HIGH',destructive_data_change:true},
          parallel_candidate:true,estimated_seconds:600}),
        TASK({task_id:'TASK-002',goal:'b',acceptance_criteria:['AC-002'],write_scope:['src/notify/reset-email.js'],parallel_candidate:true,estimated_seconds:600})
      ]});
      const {run}=runAtImplement(root,projectRoot,{plan});
      const d=scheduleTasks(root,projectRoot,run);
      if(d.selected.length!==1||d.selected[0]!=='TASK-001')fail(JSON.stringify(d.selected));
      if(!d.notes.some(n=>n.includes('serialized')))fail(JSON.stringify(d.notes));
      if(!d.deferred.some(x=>x.reason==='HEAD_IS_SERIALIZED_BOUNDARY'))fail(JSON.stringify(d.deferred));
    });

    t('categories-illegal-in-the-outer-stage-are-excluded',()=>{
      const plan=basePlan({requirements:['AC-001'],tasks:[
        TASK({category:'release',goal:'cut the release',write_scope:['CHANGELOG.md']})
      ]});
      const {run}=runAtImplement(root,projectRoot,{plan});
      const d=scheduleTasks(root,projectRoot,run,{outerStage:'IMPLEMENT'});
      if(d.selected.length)fail(JSON.stringify(d.selected));
      if(!d.excluded.some(x=>x.reasons.some(r=>r.startsWith('CATEGORY_NOT_LEGAL_IN_IMPLEMENT'))))fail(JSON.stringify(d.excluded));
      const release=scheduleTasks(root,projectRoot,run,{outerStage:'RELEASE'});
      if(release.selected.join(',')!=='TASK-001')fail(JSON.stringify(release.selected));
    });

    t('blocked-and-in-flight-tasks-are-never-dispatched',()=>{
      const {run}=runAtImplement(root,projectRoot);
      let task=requireTask(projectRoot,run.run_id,'TASK-001');
      task=transitionTask(root,projectRoot,task,'BLOCKED',{reason:'waiting on approval',failureClass:'PERMISSION_DENIED'});
      const d=scheduleTasks(root,projectRoot,run);
      if(d.selected.length)fail(JSON.stringify(d.selected));
      if(!d.excluded.some(x=>x.reasons.includes('STATUS:BLOCKED')))fail(JSON.stringify(d.excluded));
    });

    t('budget-exhaustion-prevents-dispatch',()=>{
      const {run}=runAtImplement(root,projectRoot);
      const d=scheduleTasks(root,projectRoot,run,{budget:{remaining_model_calls:1}});
      if(d.selected.length)fail(JSON.stringify(d));
      if(d.reason!=='budget-exhausted')fail(d.reason);
    });

    t('scheduling-is-deterministic',()=>{
      const {run}=runAtImplement(root,projectRoot,{plan:parallelPair()});
      const a=scheduleTasks(root,projectRoot,run);
      const b=scheduleTasks(root,projectRoot,run);
      if(JSON.stringify(a.selected)!==JSON.stringify(b.selected))fail(`${a.selected} vs ${b.selected}`);
      if(a.reason!==b.reason)fail(`${a.reason} vs ${b.reason}`);
    });

    t('scope-overlap-is-prefix-aware',()=>{
      if(!scopeConflicts(['src/auth/'],['src/auth/reset.js']).length)fail('directory prefix missed');
      if(scopeConflicts(['src/auth/a.js'],['src/auth/b.js']).length)fail('siblings reported as overlapping');
      if(!scopeConflicts(['src/*'],['src/auth/a.js']).length)fail('glob stem missed');
      // `src/auth` must NOT collide with `src/authentication`: the prefix test
      // is at directory boundaries, and a raw startsWith would serialize two
      // tasks that share nothing.
      if(scopeConflicts(['src/auth'],['src/authentication/x.js']).length)fail('non-boundary prefix reported as overlapping');
    });

    t('the-plan-gate-and-the-scheduler-share-one-overlap-predicate',()=>{
      // The PLAN gate decides whether parallel candidates may coexist; the
      // scheduler decides whether they may be dispatched together. They carried
      // separate copies of the predicate, outside the "one policy model" claim
      // in scripts/validate-task-engine.mjs, so a fix to one would have let a
      // plan be accepted and then refused at dispatch, or the reverse.
      if(schedulerOverlap!==sharedOverlap)fail('the scheduler no longer re-exports the shared predicate');
      // And the gate's verdict must agree with the scheduler's on the corpus,
      // which is what catches a copy reintroduced inside plan-validator.
      const pairs=[
        ['src/auth/','src/auth/reset.js',true],
        ['src/auth/a.js','src/auth/b.js',false],
        ['src/*','src/auth/a.js',true],
        ['src/auth','src/authentication/x.js',false],
        ['*','anything/at/all.js',true],
        ['./src/a.js','src/a.js',true]
      ];
      for(const [a,b,expected] of pairs){
        const plan={
          schema:'agent-sdlc/task-plan/v1',plan_id:'PLAN-1',run_id:'RUN-1',
          tasks:[
            {task_id:'TASK-1',parallel_candidate:true,write_scope:[a],interface_scope:[]},
            {task_id:'TASK-2',parallel_candidate:true,write_scope:[b],interface_scope:[]}
          ]
        };
        const gate=computeScopeConflicts(plan).some(c=>c.kind==='WRITE_SCOPE');
        const sched=scopeConflicts([a],[b]).length>0;
        if(gate!==sched)fail(`gate ${gate} vs scheduler ${sched} for ${a} | ${b}`);
        if(sched!==expected)fail(`${a} | ${b} -> ${sched}, expected ${expected}`);
      }
    });
  }

  // =========================== context ====================================
  {
    const t=group('context');
    const projectRoot=makeFixture();
    const plan=basePlan({requirements:['AC-001','AC-002'],tasks:[
      TASK(),
      TASK({task_id:'TASK-002',title:'Send reset email',goal:'Send the reset notification',
        depends_on:['TASK-001'],acceptance_criteria:['AC-002'],modules:['notify'],
        write_scope:['src/notify/reset-email.js'],read_scope:['src/notify/'],likely_symbols:['send']})
    ]});
    const {run}=runAtImplement(root,projectRoot,{plan});

    t('task-context-carries-only-this-task-scope',()=>{
      const task=requireTask(projectRoot,run.run_id,'TASK-002');
      const m=buildTaskContext(root,projectRoot,run,task);
      if(m.objective!==task.goal)fail('context objective is not the task goal');
      if(JSON.stringify(m.acceptance_criteria)!=='["AC-002"]')fail(JSON.stringify(m.acceptance_criteria));
      const serialized=JSON.stringify(m);
      if(serialized.includes('token-store.js'))fail('an unrelated module reached the task context');
      if(!m.files.includes('src/notify/reset-email.js'))fail(JSON.stringify(m.files));
      if(!m.symbols.includes('send'))fail(JSON.stringify(m.symbols));
    });

    t('dependency-outputs-are-included-for-declared-dependencies-only',()=>{
      const task=requireTask(projectRoot,run.run_id,'TASK-002');
      const m=buildTaskContext(root,projectRoot,run,task);
      if(m.dependency_outputs.length!==1||m.dependency_outputs[0].task_id!=='TASK-001')fail(JSON.stringify(m.dependency_outputs));
      const one=requireTask(projectRoot,run.run_id,'TASK-001');
      const mOne=buildTaskContext(root,projectRoot,run,one);
      if(mOne.dependency_outputs.length)fail('a task with no dependencies received dependency outputs');
    });

    t('context-names-what-it-excluded',()=>{
      const task=requireTask(projectRoot,run.run_id,'TASK-001');
      const m=buildTaskContext(root,projectRoot,run,task);
      for(const key of EXCLUDED_BY_DEFAULT)if(!m.excluded.includes(key))fail(`missing exclusion ${key}`);
      if(m.excluded.length!==EXCLUDED_BY_DEFAULT.length)fail(JSON.stringify(m.excluded));
    });

    t('context-budget-is-derived-from-the-stage-and-enforced',()=>{
      const task=requireTask(projectRoot,run.run_id,'TASK-001');
      const m=buildTaskContext(root,projectRoot,run,task);
      if(!(m.budget.max_context_tokens_estimate<m.budget.stage_max))fail(JSON.stringify(m.budget));
      if(m.context_budget_status!=='WITHIN_BUDGET')fail(`${m.estimated_tokens} > ${m.budget.max_context_tokens_estimate}`);
      if(!m.estimated_tokens)fail('no token estimate recorded');
    });

    t('context-manifest-is-persisted-and-replayable',()=>{
      const task=requireTask(projectRoot,run.run_id,'TASK-001');
      const m=buildTaskContext(root,projectRoot,run,task);
      const stored=getTaskContextManifest(projectRoot,run.run_id,'TASK-001');
      if(stored?.context_hash!==m.context_hash)fail('manifest was not persisted with a matching hash');
      const again=buildTaskContext(root,projectRoot,run,task);
      if(again.context_hash!==m.context_hash)fail('context hash is not stable for identical inputs');
    });

    t('oversized-artifacts-are-truncated-not-dropped-silently',()=>{
      const task=requireTask(projectRoot,run.run_id,'TASK-001');
      const big=putArtifact(projectRoot,{kind:'tool-log',content:'x'.repeat(200000),runId:run.run_id,stage:'IMPLEMENT'});
      const m=buildTaskContext(root,projectRoot,run,task,{extraArtifactRefs:[big.artifact_id]});
      const summary=m.artifact_summaries.find(a=>a.ref===big.artifact_id);
      if(!summary)fail('artifact silently dropped');
      if(!summary.truncated)fail('a 200KB artifact was not truncated');
      if(m.context_budget_status!=='WITHIN_BUDGET')fail('truncation did not keep the context within budget');
    });

    t('rendered-prompt-forbids-state-mutation-and-scope-escape',()=>{
      const task=requireTask(projectRoot,run.run_id,'TASK-001');
      const prompt=renderTaskPrompt(root,buildTaskContext(root,projectRoot,run,task));
      for(const needle of ['WRITE SCOPE (exhaustive)','YOU MAY NOT','transition the outer run','mark the task DONE'])
        if(!prompt.includes(needle))fail(`prompt is missing "${needle}"`);
    });

    t('risk-constraints-are-derived-from-task-risk',()=>{
      const risky=requireTask(projectRoot,run.run_id,'TASK-001');
      risky.risk={profile:'STRICT',security:'HIGH',data:'HIGH',destructive_data_change:true};
      risky.scope.interfaces=['GET /v1/orders'];
      saveTask(projectRoot,risky);
      const m=buildTaskContext(root,projectRoot,run,risky);
      const text=m.risk_constraints.join('|');
      for(const needle of ['security-critical','data-affecting','destructive data change','public interface'])
        if(!text.includes(needle))fail(`missing constraint for ${needle}: ${text}`);
    });
  }

  // ==================== verification and review ===========================
  {
    const t=group('verification_review');

    t('worker-self-claim-is-not-enough-for-done',()=>{
      const projectRoot=makeFixture();
      const {run}=runAtImplement(root,projectRoot);
      let task=requireTask(projectRoot,run.run_id,'TASK-001');
      // The "worker" asserts success by setting every field it can reach.
      task.diff_hash='claimed-by-worker';
      task.done_conditions=['worker says done'];
      saveTask(projectRoot,task);
      const check=evaluateTransition(root,task,'DONE',{tasks:[task]});
      if(check.allowed)fail('a worker self-claim reached DONE');
    });

    t('targeted-test-failure-prevents-done',()=>{
      const projectRoot=makeFixture({failingTests:true});
      const {run}=runAtImplement(root,projectRoot);
      startTask(root,projectRoot,run,'TASK-001',{writer:'writer-a'});
      writeInWorkspace(projectRoot,run,'TASK-001','src/auth/token-store.js','export const store=new Map();\nexport const ttl=1;\n');
      const out=advanceTask(root,projectRoot,run,'TASK-001');
      if(out.advanced)fail('advanced despite a failing targeted test');
      if(out.verification?.status!=='FAIL')fail(JSON.stringify(out.verification?.status));
      if(out.failure?.class!=='VERIFICATION_FAILURE')fail(JSON.stringify(out.failure));
      if(out.task.status!=='RUNNING')fail(`expected retry into RUNNING, got ${out.task.status}`);
      if(out.task.attempt!==2)fail(`attempt ${out.task.attempt}`);
    });

    t('out-of-scope-change-is-a-scope-expansion-not-a-defect',()=>{
      const projectRoot=makeFixture();
      const {run}=runAtImplement(root,projectRoot);
      startTask(root,projectRoot,run,'TASK-001',{writer:'writer-a'});
      writeInWorkspace(projectRoot,run,'TASK-001','src/auth/token-store.js','export const store=new Map();\n// scoped\n');
      writeInWorkspace(projectRoot,run,'TASK-001','src/notify/reset-email.js','export const send=()=>false;\n');
      const out=advanceTask(root,projectRoot,run,'TASK-001');
      if(out.advanced)fail('advanced despite writing outside the approved scope');
      if(out.verification?.scope?.respected!==false)fail(JSON.stringify(out.verification?.scope));
      if(out.failure?.class!=='SCOPE_EXPANSION')fail(JSON.stringify(out.failure));
      if(out.outer_escalation?.outer_state!=='PLAN')fail(JSON.stringify(out.outer_escalation));
      const events=listTaskEvents(projectRoot,run.run_id,'TASK-001');
      if(!events.some(e=>e.type==='task.scope_violation'))fail('no scope violation event recorded');
    });

    t('no-change-captured-is-an-implementation-defect',()=>{
      const projectRoot=makeFixture();
      const {run}=runAtImplement(root,projectRoot);
      startTask(root,projectRoot,run,'TASK-001',{writer:'writer-a'});
      const out=advanceTask(root,projectRoot,run,'TASK-001');
      if(out.advanced)fail('advanced with no captured change');
      if(out.verification?.reason!=='NO_CHANGE_CAPTURED')fail(JSON.stringify(out.verification?.reason));
      if(out.failure?.class!=='IMPLEMENTATION_DEFECT')fail(JSON.stringify(out.failure));
    });

    t('spec-review-blocking-finding-re-enters-running',()=>{
      const projectRoot=makeFixture();
      const {run}=runAtImplement(root,projectRoot);
      startTask(root,projectRoot,run,'TASK-001',{writer:'writer-a'});
      writeInWorkspace(projectRoot,run,'TASK-001','src/auth/token-store.js','export const store=new Map();\nexport const ttl=900;\n');
      advanceTask(root,projectRoot,run,'TASK-001');
      const task=requireTask(projectRoot,run.run_id,'TASK-001');
      if(task.status!=='SPEC_REVIEW')fail(task.status);
      const out=advanceTask(root,projectRoot,run,'TASK-001',{specReview:specReviewFor(task,{
        verdict:'NON_COMPLIANT',
        findings:[{category:'MISSING_REQUIRED_BEHAVIOR',severity:'BLOCKING',
          summary:'expiry is never checked on read',evidence:'src/auth/token-store.js:2'}]
      })});
      if(out.advanced)fail('advanced past a blocking spec finding');
      if(out.failure?.class!=='SPEC_MISMATCH')fail(JSON.stringify(out.failure));
      if(out.task.status!=='RUNNING')fail(out.task.status);
    });

    t('quality-blocker-re-enters-running',()=>{
      const projectRoot=makeFixture();
      const {run}=runAtImplement(root,projectRoot);
      startTask(root,projectRoot,run,'TASK-001',{writer:'writer-a'});
      writeInWorkspace(projectRoot,run,'TASK-001','src/auth/token-store.js','export const store=new Map();\nexport const ttl=900;\n');
      advanceTask(root,projectRoot,run,'TASK-001');
      let task=requireTask(projectRoot,run.run_id,'TASK-001');
      advanceTask(root,projectRoot,run,'TASK-001',{specReview:specReviewFor(task)});
      task=requireTask(projectRoot,run.run_id,'TASK-001');
      if(task.status!=='QUALITY_REVIEW')fail(task.status);
      const out=advanceTask(root,projectRoot,run,'TASK-001',{
        specReview:specReviewFor(task),
        qualityReview:qualityReviewFor(task,{verdict:'CHANGES_REQUIRED',findings:[
          {category:'CORRECTNESS',severity:'BLOCKING',summary:'ttl is compared in seconds against a ms clock',
            evidence:'src/auth/token-store.js:2',failure_scenario:'a token issued 1s ago is treated as expired'}
        ]})
      });
      if(out.advanced)fail('advanced past a blocking quality finding');
      if(out.failure?.class!=='QUALITY_BLOCKER')fail(JSON.stringify(out.failure));
      if(out.task.status!=='RUNNING')fail(out.task.status);
    });

    t('reviews-are-two-distinct-contracts',()=>{
      const projectRoot=makeFixture();
      const {run}=runAtImplement(root,projectRoot);
      const task=requireTask(projectRoot,run.run_id,'TASK-001');
      const spec=validateSpecComplianceReview(qualityReviewFor(task),task);
      if(spec.valid)fail('a code-quality review satisfied the spec-compliance contract');
      const quality=validateCodeQualityReview(specReviewFor(task),task);
      if(quality.valid)fail('a spec-compliance review satisfied the code-quality contract');
    });

    t('review-must-be-bound-to-the-current-diff-and-attempt',()=>{
      const projectRoot=makeFixture();
      const {run}=runAtImplement(root,projectRoot);
      const task=requireTask(projectRoot,run.run_id,'TASK-001');
      task.diff_hash='current';task.attempt=2;saveTask(projectRoot,task);
      const stale=validateSpecComplianceReview(specReviewFor(task,{diff_hash:'previous',attempt:1}),task);
      if(stale.valid)fail('a review bound to a previous diff was accepted');
      if(!stale.errors.includes('REVIEW_NOT_BOUND_TO_CURRENT_DIFF'))fail(JSON.stringify(stale.errors));
      if(!stale.errors.some(e=>e.startsWith('ATTEMPT_MISMATCH')))fail(JSON.stringify(stale.errors));
    });

    t('a-review-that-declares-no-diff-is-not-bound-to-anything',()=>{
      // The binding was checked only when the review volunteered a diff_hash,
      // and neither JSON schema requires the field. So omitting it skipped the
      // check entirely -- a review could come back COMPLIANT/ACCEPTED, validate
      // clean and open the gate while bound to no diff at all. `attempt` was
      // already mandatory; this is the same binding, half-enforced.
      //
      // task.diff_hash is always set by review time: RUNNING -> VERIFYING
      // requires diff_captured, so there is no legitimate reason to omit it.
      const projectRoot=makeFixture();
      const {run}=runAtImplement(root,projectRoot);
      const task=requireTask(projectRoot,run.run_id,'TASK-001');
      task.diff_hash='current';saveTask(projectRoot,task);
      const cur=requireTask(projectRoot,run.run_id,'TASK-001');

      for(const [label,build,validate] of [
        ['spec',specReviewFor,validateSpecComplianceReview],
        ['quality',qualityReviewFor,validateCodeQualityReview]
      ]){
        const bound=validate(build(cur),cur);
        if(!bound.clean)fail(`${label}: a correctly bound review was refused: ${JSON.stringify(bound.errors)}`);

        const review=build(cur);
        delete review.diff_hash;
        const unbound=validate(review,cur);
        if(unbound.clean)fail(`${label}: a review declaring no diff was accepted as clean`);
        if(!unbound.errors.includes('REVIEW_NOT_BOUND_TO_A_DIFF'))fail(`${label}: ${JSON.stringify(unbound.errors)}`);

        const wrong=validate(build(cur,{diff_hash:'previous'}),cur);
        if(wrong.clean)fail(`${label}: a review bound to another diff was accepted`);
      }
    });

    t('acceptance-criteria-must-actually-be-checked',()=>{
      const projectRoot=makeFixture();
      const {run}=runAtImplement(root,projectRoot);
      const task=requireTask(projectRoot,run.run_id,'TASK-001');
      const v=validateSpecComplianceReview(specReviewFor(task,{acceptance_criteria_checked:[]}),task);
      if(v.valid)fail('a review that checked nothing was accepted');
      if(!v.errors.some(e=>e.startsWith('ACCEPTANCE_CRITERIA_NOT_CHECKED')))fail(JSON.stringify(v.errors));
    });

    t('a-clean-verdict-cannot-carry-blocking-findings',()=>{
      const projectRoot=makeFixture();
      const {run}=runAtImplement(root,projectRoot);
      const task=requireTask(projectRoot,run.run_id,'TASK-001');
      const v=validateSpecComplianceReview(specReviewFor(task,{verdict:'COMPLIANT',findings:[
        {category:'SCOPE_CREEP',severity:'BLOCKING',summary:'touched an unrelated module',evidence:'src/notify/reset-email.js:1'}
      ]}),task);
      if(v.valid)fail('COMPLIANT with a blocking finding was accepted');
      if(!v.errors.includes('COMPLIANT_WITH_BLOCKING_FINDINGS'))fail(JSON.stringify(v.errors));
    });

    t('blocking-correctness-finding-needs-a-failure-scenario',()=>{
      const projectRoot=makeFixture();
      const {run}=runAtImplement(root,projectRoot);
      const task=requireTask(projectRoot,run.run_id,'TASK-001');
      const v=validateCodeQualityReview(qualityReviewFor(task,{verdict:'CHANGES_REQUIRED',findings:[
        {category:'CORRECTNESS',severity:'BLOCKING',summary:'this looks wrong',evidence:'src/auth/token-store.js:2'}
      ]}),task);
      if(v.valid)fail('a blocking correctness claim with no failure path was accepted');
      if(!v.errors.includes('BLOCKING_CORRECTNESS_FINDING_WITHOUT_FAILURE_SCENARIO'))fail(JSON.stringify(v.errors));
    });

    t('strict-independence-limitation-is-recorded-not-faked',()=>{
      const projectRoot=makeFixture();
      const {run}=runAtImplement(root,projectRoot);
      const task=requireTask(projectRoot,run.run_id,'TASK-001');
      task.execution.independent_review=true;saveTask(projectRoot,task);
      const faked=validateSpecComplianceReview(specReviewFor(task,{
        independence:{requested:true,achieved:true,mode:'SAME_CONTEXT',limitation:null,worker_reasoning_withheld:true}
      }),task);
      if(faked.valid)fail('an independence claim contradicting its own mode was accepted');
      if(!faked.errors.includes('INDEPENDENCE_CLAIM_CONTRADICTS_MODE'))fail(JSON.stringify(faked.errors));
      const honest=validateSpecComplianceReview(specReviewFor(task,{
        independence:{requested:true,achieved:false,mode:'UNAVAILABLE',limitation:'host cannot spawn a fresh-context reviewer',worker_reasoning_withheld:true}
      }),task);
      if(!honest.valid)fail(JSON.stringify(honest.errors));
      if(honest.independent)fail('a recorded limitation was reported as independence');
      if(honest.independence_limitation!=='host cannot spawn a fresh-context reviewer')fail(honest.independence_limitation);
    });

    t('independent-review-must-not-see-worker-reasoning',()=>{
      const projectRoot=makeFixture();
      const {run}=runAtImplement(root,projectRoot);
      const task=requireTask(projectRoot,run.run_id,'TASK-001');
      const v=validateSpecComplianceReview(specReviewFor(task,{
        independence:{requested:true,achieved:true,mode:'FRESH_CONTEXT_SUBAGENT',limitation:null,worker_reasoning_withheld:false}
      }),task);
      if(v.valid)fail('an independent review that saw worker reasoning was accepted');
      if(!v.errors.includes('INDEPENDENT_REVIEW_SAW_WORKER_REASONING'))fail(JSON.stringify(v.errors));
    });

    t('verification-strategy-escalates-with-risk',()=>{
      if(verificationStrategy({category:'implementation',risk:{}})!=='TARGETED')fail('plain task should stay targeted');
      if(verificationStrategy({category:'implementation',risk:{security:'HIGH'}})!=='AFFECTED_INTEGRATION')fail('security risk did not escalate');
      if(verificationStrategy({category:'integration',risk:{}})!=='AFFECTED_INTEGRATION')fail('integration did not escalate');
      if(verificationStrategy({category:'implementation',risk:{}},{escalate:true})!=='BROAD_SUITE')fail('explicit escalation ignored');
    });

    t('verification-evidence-is-bound-to-a-revision-and-diff',()=>{
      const projectRoot=makeFixture();
      const {run}=runAtImplement(root,projectRoot);
      startTask(root,projectRoot,run,'TASK-001',{writer:'writer-a'});
      writeInWorkspace(projectRoot,run,'TASK-001','src/auth/token-store.js','export const store=new Map();\nexport const ttl=900;\n');
      const task=requireTask(projectRoot,run.run_id,'TASK-001');
      captureTaskDiff(projectRoot,run,task);
      const fresh=requireTask(projectRoot,run.run_id,'TASK-001');
      const {evidence}=verifyTask(root,projectRoot,run,fresh);
      if(evidence.status!=='PASS')fail(JSON.stringify(evidence.reason));
      if(!evidence.base_revision||!evidence.diff_hash)fail(JSON.stringify({base:evidence.base_revision,diff:evidence.diff_hash}));
      if(!evidence.commands.length||evidence.commands[0].exit_code!==0)fail(JSON.stringify(evidence.commands));
      if(!evidence.environment.platform)fail('no environment fingerprint');
      if(evidence.attempt!==fresh.attempt)fail(`attempt ${evidence.attempt} != ${fresh.attempt}`);
    });

    t('a-failed-verification-does-not-satisfy-the-verification-gate',()=>{
      // task.evidence_refs is appended for every verification run, passing or
      // not (task-verification.mjs records the artifact before it branches on
      // status). The gate accepted "this task has some evidence ref" as
      // satisfaction whenever no verification object was passed in, so a task
      // whose verification had FAILED could still be moved VERIFYING ->
      // SPEC_REVIEW from the CLI, with no --force -- sending unverified work to
      // review, past the one gate that exists to stop it.
      const projectRoot=makeFixture();
      const {run}=runAtImplement(root,projectRoot);
      startTask(root,projectRoot,run,'TASK-001',{writer:'writer-a'});
      writeInWorkspace(projectRoot,run,'TASK-001','src/auth/token-store.js','export const store=new Map();\n');
      let task=requireTask(projectRoot,run.run_id,'TASK-001');
      captureTaskDiff(projectRoot,run,task);
      task=transitionTask(root,projectRoot,requireTask(projectRoot,run.run_id,'TASK-001'),'VERIFYING',{reason:'diff captured'});

      // A recorded verification that did not pass still leaves a ref behind.
      task.evidence_refs=['artifact://sha256/'+'0'.repeat(64)];
      saveTask(projectRoot,task);
      const withoutObject=evaluateTransition(root,requireTask(projectRoot,run.run_id,'TASK-001'),'SPEC_REVIEW',{});
      if(withoutObject.allowed)fail('a bare evidence ref satisfied the verification gate');
      if(!withoutObject.problems.some(p=>p.startsWith('NO_VERIFICATION_EVIDENCE')))
        fail(`unexpected problems: ${JSON.stringify(withoutObject.problems)}`);

      // The gate still opens for a passing verification bound to this attempt,
      // and still refuses one bound to a different one.
      const cur=requireTask(projectRoot,run.run_id,'TASK-001');
      const passing={status:'PASS',attempt:cur.attempt};
      if(!evaluateTransition(root,cur,'SPEC_REVIEW',{verification:passing}).allowed)
        fail('a passing verification for this attempt was refused');
      const otherAttempt=evaluateTransition(root,cur,'SPEC_REVIEW',{verification:{status:'PASS',attempt:(cur.attempt||0)+1}});
      if(otherAttempt.allowed)fail('verification from another attempt was accepted');
      const failing=evaluateTransition(root,cur,'SPEC_REVIEW',{verification:{status:'FAIL',attempt:cur.attempt}});
      if(failing.allowed)fail('a failing verification was accepted');
    });

    t('a-verification-record-with-no-scope-audit-does-not-satisfy-the-scope-gate',()=>{
      // `scope_respected` is required on QUALITY_REVIEW -> DONE, and the check
      // was `if(scope && scope.respected===false)`. `scope` is optional in
      // TaskVerification.schema.json, and `task transition --verification
      // <file>` reads the record from a caller-supplied path -- so a
      // schema-valid record that simply omits the scope block skipped the gate
      // entirely and the task reached DONE with no scope proof at all. Absence
      // of a violation report is not a report of no violation.
      const projectRoot=makeFixture();
      const {run}=runAtImplement(root,projectRoot);
      startTask(root,projectRoot,run,'TASK-001',{writer:'writer-a'});
      writeInWorkspace(projectRoot,run,'TASK-001','src/auth/token-store.js','export const store=new Map();\n');
      let task=requireTask(projectRoot,run.run_id,'TASK-001');
      captureTaskDiff(projectRoot,run,task);
      task=requireTask(projectRoot,run.run_id,'TASK-001');
      task.status='QUALITY_REVIEW';
      saveTask(projectRoot,task);

      const cur=requireTask(projectRoot,run.run_id,'TASK-001');
      const base={
        qualityReview:{verdict:'ACCEPTED',findings:[]},
        verification:{status:'PASS',attempt:cur.attempt}
      };
      const noScope=evaluateTransition(root,cur,'DONE',base);
      if(noScope.allowed)fail('a verification with no scope audit satisfied scope_respected');
      if(!noScope.problems.includes('NO_SCOPE_EVIDENCE'))
        fail(`unexpected problems: ${JSON.stringify(noScope.problems)}`);

      // A scope block that reports out-of-scope paths but never says so in
      // `respected` is the same evasion one field down.
      const halfScope=evaluateTransition(root,cur,'DONE',
        {...base,verification:{...base.verification,scope:{out_of_scope_paths:['src/notify/x.js']}}});
      if(halfScope.allowed)fail('a scope block with no boolean verdict satisfied the gate');

      // The gate still reports a real violation, and still opens for a clean audit.
      const violated=evaluateTransition(root,cur,'DONE',
        {...base,verification:{...base.verification,scope:{respected:false,out_of_scope_paths:['src/notify/x.js']}}});
      if(violated.allowed)fail('a scope violation was accepted');
      if(!violated.problems.some(p=>p.startsWith('SCOPE_VIOLATION:')))
        fail(`unexpected problems: ${JSON.stringify(violated.problems)}`);
      const clean=evaluateTransition(root,cur,'DONE',
        {...base,verification:{...base.verification,scope:{respected:true,out_of_scope_paths:[]}}});
      if(!clean.allowed)fail(`a clean scope audit was refused: ${JSON.stringify(clean.problems)}`);
    });

    t('scope-audit-treats-declared-directories-as-covering',()=>{
      const a=scopeAudit({scope:{write:['src/auth/']}},['src/auth/token-store.js']);
      if(!a.respected)fail(JSON.stringify(a));
      const b=scopeAudit({scope:{write:['src/auth/token-store.js']}},['src/notify/reset-email.js']);
      if(b.respected)fail('an out-of-scope path was accepted');
      const c=scopeAudit({scope:{write:['src/'],forbidden:['src/auth/']}},['src/auth/token-store.js']);
      if(c.respected)fail('a forbidden path was accepted because a parent was allowed');
    });

    // F15: this module reads the same project command config the tool gateway
    // does and used to hand it straight to spawnSync -- so `npm` was ENOENT on
    // Windows, that ENOENT read as "the tests failed", and the literal string
    // "{selector}" reached the test runner.
    const SELECTOR_CMDS={
      test_targeted:['node','-e','if(!process.argv[1])process.exit(3);console.log("ran "+process.argv.slice(1).join(","));','{selector}'],
      test_full:['node','-e','process.exit(0)'],
      build:['node','-e','process.exit(0)']
    };

    t('planned-commands-splices-the-task-targeted-tests',()=>{
      const projectRoot=makeFixture({commands:SELECTOR_CMDS});
      const task={task_id:'TASK-001',verification:{targeted_tests:['tests/a.test.js','tests/b.test.js']}};
      const cmds=plannedCommands(projectRoot,task,'TARGETED',{root});
      const targeted=cmds.find(c=>c.kind==='test_targeted');
      if(!targeted)fail('no test_targeted command planned');
      if(targeted.command.some(x=>String(x).includes('{selector}')))fail(`placeholder survived: ${JSON.stringify(targeted.command)}`);
      if(!targeted.command.includes('tests/a.test.js')||!targeted.command.includes('tests/b.test.js'))fail(JSON.stringify(targeted.command));
      if(targeted.unsatisfied_selector)fail('a task with targeted_tests must not be marked unsatisfied');
    });

    t('planned-commands-refuses-a-selector-template-with-no-targeted-tests',()=>{
      const projectRoot=makeFixture({commands:SELECTOR_CMDS});
      const cmds=plannedCommands(projectRoot,{task_id:'TASK-002',verification:{targeted_tests:[]}},'TARGETED',{root});
      const targeted=cmds.find(c=>c.kind==='test_targeted');
      if(!targeted)fail('the command must still be planned, so the refusal is visible');
      if(targeted.unsatisfied_selector!==true)fail('must be marked unsatisfied rather than silently skipped');
    });

    t('planned-commands-leaves-a-selectorless-template-alone',()=>{
      const projectRoot=makeFixture({commands:SELECTOR_CMDS});
      const cmds=plannedCommands(projectRoot,{task_id:'TASK-003',verification:{targeted_tests:[]}},'BROAD_SUITE',{root});
      const full=cmds.find(c=>c.kind==='test_full');
      if(!full)fail('no test_full command planned');
      if(full.unsatisfied_selector)fail('test_full has no {selector} and must not be marked unsatisfied');
    });

    t('task-verification-reports-an-unstartable-command-as-error',()=>{
      // Not "the tests failed". The previous behaviour was exit_code 1 with an
      // empty summary and no artifact, indistinguishable from a real failure.
      const projectRoot=makeFixture({commands:{
        test_targeted:['definitely-not-a-real-binary-9f3','{selector}'],
        test_full:['node','-e','process.exit(0)'],
        build:['node','-e','process.exit(0)']
      }});
      const {run}=runAtImplement(root,projectRoot);
      startTask(root,projectRoot,run,'TASK-001',{writer:'writer-a'});
      writeInWorkspace(projectRoot,run,'TASK-001','src/auth/token-store.js','export const store=new Map();\n// touched\n');
      const out=advanceTask(root,projectRoot,run,'TASK-001');
      if(out.advanced)fail('advanced despite a command that never started');
      const executed=(out.verification?.commands||[]).find(e=>e.kind==='test_targeted');
      if(!executed)fail(`no test_targeted entry recorded: ${JSON.stringify(out.verification?.commands)}`);
      if(executed.reason!=='TOOL_NOT_EXECUTABLE')fail(`expected TOOL_NOT_EXECUTABLE, got ${JSON.stringify(executed)}`);
      if(executed.exit_code!==null)fail(JSON.stringify(executed));
      if(out.verification?.status==='PASS')fail('an unstartable command must not verify a task');
    });
  }

  // ========================== recovery ====================================
  {
    const t=group('recovery');
    const projectRoot=makeFixture();

    t('classification-prefers-the-structural-cause',()=>{
      const scope=classifyTaskFailure({verification:{status:'FAIL',reason:'COMMAND_FAILED',scope:{respected:false,out_of_scope_paths:['x.js']}}});
      if(scope.class!=='SCOPE_EXPANSION')fail(scope.class);
      const dep=classifyTaskFailure({dependency:{satisfied:false,pending:['TASK-001'],failed:[],missing:[]}});
      if(dep.class!=='DEPENDENCY_BLOCKED')fail(dep.class);
      const transient=classifyTaskFailure({providerError:'429 rate limit exceeded'});
      if(transient.class!=='INFRA_TRANSIENT')fail(transient.class);
      const provider=classifyTaskFailure({providerError:'model returned malformed output'});
      if(provider.class!=='PROVIDER_FAILURE')fail(provider.class);
      const budget=classifyTaskFailure({budgetExhausted:true,verification:{status:'FAIL'}});
      if(budget.class!=='BUDGET_EXHAUSTED')fail(budget.class);
    });

    t('identical-retry-without-new-evidence-is-refused',()=>{
      const {run}=runAtImplement(root,projectRoot);
      let task=requireTask(projectRoot,run.run_id,'TASK-001');
      task=transitionTask(root,projectRoot,task,'RUNNING',{force:true});
      task=transitionTask(root,projectRoot,task,'VERIFYING',{force:true});
      const verification={status:'FAIL',reason:'COMMAND_FAILED',commands:[{kind:'test_targeted',exit_code:1}]};
      const fp=evidenceFingerprint({task,verification});
      const plan=planRecovery(root,task,{class:'VERIFICATION_FAILURE',detail:'x'},{newEvidence:true});
      if(plan.action!=='RETRY_TASK')fail(JSON.stringify(plan));
      task=applyRecovery(root,projectRoot,task,plan,{tasks:[task],fingerprint:fp});
      if(hasNewEvidence(task,fp))fail('the same fingerprint was still treated as new evidence');
      const refused=planRecovery(root,task,{class:'VERIFICATION_FAILURE',detail:'x'},{newEvidence:hasNewEvidence(task,fp)});
      if(refused.action!=='BLOCK')fail(JSON.stringify(refused));
      if(!/no new evidence/.test(refused.reason))fail(refused.reason);
    });

    t('retry-budget-exhaustion-fails-the-task',()=>{
      const {run}=runAtImplement(root,projectRoot);
      let task=requireTask(projectRoot,run.run_id,'TASK-001');
      task.attempt=(task.execution.max_retries||2)+1;saveTask(projectRoot,task);
      const plan=planRecovery(root,task,{class:'VERIFICATION_FAILURE',detail:'x'},{newEvidence:true});
      if(plan.action!=='FAIL'||plan.to!=='FAILED')fail(JSON.stringify(plan));
      if(!/retry budget exhausted/.test(plan.reason))fail(plan.reason);
    });

    t('spec-mismatch-escalates-upstream-when-retries-run-out',()=>{
      const {run}=runAtImplement(root,projectRoot);
      let task=requireTask(projectRoot,run.run_id,'TASK-001');
      task.attempt=(task.execution.max_retries||2)+1;saveTask(projectRoot,task);
      const plan=planRecovery(root,task,{class:'SPEC_MISMATCH',detail:'x'},{newEvidence:true});
      if(plan.action!=='INVALIDATE'||plan.to!=='INVALIDATED')fail(JSON.stringify(plan));
      if(outerEscalation(plan).outer_state!=='DESIGN')fail(JSON.stringify(outerEscalation(plan)));
    });

    t('infrastructure-retries-are-bounded-and-free',()=>{
      const {run}=runAtImplement(root,projectRoot);
      const task=requireTask(projectRoot,run.run_id,'TASK-001');
      const first=planRecovery(root,task,{class:'INFRA_TRANSIENT',detail:'timeout'},{infrastructureAttempts:0});
      if(first.action!=='RETRY_INFRASTRUCTURE'||first.requires_new_evidence!==false)fail(JSON.stringify(first));
      const exhausted=planRecovery(root,task,{class:'INFRA_TRANSIENT',detail:'timeout'},{infrastructureAttempts:3});
      if(exhausted.action!=='BLOCK')fail(JSON.stringify(exhausted));
      if(!/infrastructure retries exhausted/.test(exhausted.reason))fail(exhausted.reason);
    });

    t('requirement-ambiguity-escalates-to-needs-confirmation',()=>{
      const {run}=runAtImplement(root,projectRoot);
      const task=requireTask(projectRoot,run.run_id,'TASK-001');
      const plan=planRecovery(root,task,{class:'REQUIREMENT_AMBIGUITY',detail:'which policy applies?'});
      const esc=outerEscalation(plan);
      if(!esc.required||esc.outer_state!=='NEEDS_CONFIRMATION')fail(JSON.stringify(esc));
    });

    t('design-invalidation-escalates-the-outer-workflow',()=>{
      const {run}=runAtImplement(root,projectRoot);
      const task=requireTask(projectRoot,run.run_id,'TASK-001');
      const plan=planRecovery(root,task,{class:'DESIGN_INVALIDATED',detail:'DESIGN-001 superseded'});
      if(plan.to!=='INVALIDATED')fail(JSON.stringify(plan));
      const esc=outerEscalation(plan);
      if(esc.kind!=='REENTRY'||esc.outer_state!=='DESIGN')fail(JSON.stringify(esc));
    });

    t('permission-denied-blocks-and-requires-approval-or-an-alternative',()=>{
      const {run}=runAtImplement(root,projectRoot);
      const task=requireTask(projectRoot,run.run_id,'TASK-001');
      const plan=planRecovery(root,task,{class:'PERMISSION_DENIED',detail:'deploy.production denied'});
      if(plan.to!=='BLOCKED'||!plan.requires_approval_or_alternative)fail(JSON.stringify(plan));
    });

    t('provider-fallback-checkpoint-carries-artifacts-not-reasoning',()=>{
      const {run}=runAtImplement(root,projectRoot);
      startTask(root,projectRoot,run,'TASK-001',{writer:'writer-a'});
      writeInWorkspace(projectRoot,run,'TASK-001','src/auth/token-store.js','export const store=new Map();\nexport const ttl=900;\n');
      const task=requireTask(projectRoot,run.run_id,'TASK-001');
      captureTaskDiff(projectRoot,run,task);
      const fresh=requireTask(projectRoot,run.run_id,'TASK-001');
      const cp=taskCheckpoint(projectRoot,run,fresh);
      if(!cp.context_manifest_ref||!cp.base_revision||!cp.diff_hash)fail(JSON.stringify(cp));
      for(const key of ['provider_conversation_history','hidden_chain_of_thought','worker_scratch_reasoning'])
        if(!cp.excludes.includes(key))fail(`checkpoint does not exclude ${key}`);
      const serialized=JSON.stringify(cp);
      if(/reasoning":"/.test(serialized))fail('the checkpoint carried reasoning content');
    });

    t('provider-fallback-resumes-from-task-checkpoint',()=>{
      const {run}=runAtImplement(root,projectRoot);
      startTask(root,projectRoot,run,'TASK-001',{writer:'writer-a'});
      writeInWorkspace(projectRoot,run,'TASK-001','src/auth/token-store.js','export const store=new Map();\nexport const ttl=900;\n');
      const task=requireTask(projectRoot,run.run_id,'TASK-001');
      captureTaskDiff(projectRoot,run,task);
      const res=resumeFromCheckpoint(root,projectRoot,run,'TASK-001',{
        originalProvider:'claude',
        fallbackProvider:'codex',
        reason:'rate limit'
      });
      if(!res.resumed||res.fallback_provider!=='codex')fail(JSON.stringify(res));
      if(!res.base_revision||!res.diff_hash)fail('missing base_revision or diff_hash');
      if(!res.transferred.includes('context manifest hash'))fail('missing context manifest in transferred list');
    });

    t('workspace-worktree-reuses-existing-branch-on-retry',()=>{
      const {run}=runAtImplement(root,projectRoot);
      const task=requireTask(projectRoot,run.run_id,'TASK-001');
      const ws1=createTaskWorkspace(projectRoot,{run,task,writer:'writer-1',mode:'isolated-worktree'});
      if(ws1.mode==='isolated-worktree'&&ws1.branch){
        // Simulate workspace cleanup or retry where the branch already exists in git
        const fakeTask={...task,task_id:'TASK-RETRY-BRANCH'};
        // Create branch first
        gitq(projectRoot,'branch',`agent-sdlc/${String(run.run_id).replace(/^run_/,'')}/task-retry-branch`,ws1.base_revision);
        const ws2=createTaskWorkspace(projectRoot,{run,task:fakeTask,writer:'writer-2',mode:'isolated-worktree'});
        if(ws2.status!=='ACTIVE')fail(JSON.stringify(ws2));
      }
    });
  }

  // ==================== migration and telemetry ===========================
  {
    const t=group('migration_telemetry');
    const projectRoot=makeFixture();

    t('migration-materializes-tasks-from-a-recorded-plan',()=>{
      const plan=basePlan();
      const run=newRun(root,projectRoot,{objective:plan.objective,route:route(root,'Add password reset feature')});
      transition(root,projectRoot,run,'REQUIREMENTS');
      transition(root,projectRoot,run,'DESIGN',{evidence:['requirements_confirmed']});
      recordDesignDecision(root,projectRoot,run,{schema:'agent-sdlc/design-decision/v1',decision_id:'DESIGN-001',
        objective:plan.objective,mode:'SKIP',skip_reason:'fixture',approval:{required:false,status:'NOT_REQUIRED'}});
      transition(root,projectRoot,run,'PLAN');
      const artifact=putArtifact(projectRoot,{kind:'task-plan',content:JSON.stringify(plan,null,2)+'\n',
        runId:run.run_id,stage:'PLAN',filename:'task-plan.json'});
      recordTaskPlan(root,projectRoot,run,plan,{artifactRef:artifact.artifact_id});
      const dry=migrateRunToTaskRuntime(root,projectRoot,run,{dryRun:true});
      if(dry.status!=='DRY_RUN'||dry.would_create!==1)fail(JSON.stringify(dry));
      if(listTasks(projectRoot,run.run_id).length)fail('a dry run created task records');
      const out=migrateRunToTaskRuntime(root,projectRoot,run);
      if(out.status!=='MIGRATED')fail(JSON.stringify(out));
      if(out.plan_artifact_ref!==artifact.artifact_id)fail('the original plan artifact ref was not preserved');
      const tasks=listTasks(projectRoot,run.run_id);
      if(tasks.length!==1||tasks[0].status!=='CREATED')fail(JSON.stringify(tasks.map(x=>x.status)));
      const again=migrateRunToTaskRuntime(root,projectRoot,run);
      if(again.status!=='SKIPPED')fail(JSON.stringify(again));
    });

    t('migration-of-a-post-implement-run-marks-legacy-stage-evidence',()=>{
      const plan=basePlan({plan_id:'PLAN-002'});
      const run=newRun(root,projectRoot,{objective:'legacy run',route:route(root,'Add password reset feature')});
      putArtifact(projectRoot,{kind:'task-plan',content:JSON.stringify(plan,null,2)+'\n',runId:run.run_id,stage:'PLAN',filename:'task-plan.json'});
      run.state='REVIEW';
      const out=migrateRunToTaskRuntime(root,projectRoot,run);
      if(out.status!=='MIGRATED')fail(JSON.stringify(out));
      if(out.evidence_class!=='LEGACY_STAGE_EVIDENCE')fail(out.evidence_class);
      const graph=loadTaskGraph(projectRoot,run.run_id);
      if(graph.legacy_stage_evidence!==true)fail('graph is not marked legacy');
      if(listTasks(projectRoot,run.run_id).some(x=>x.status==='DONE'))fail('migration fabricated DONE tasks');
    });

    t('migration-fails-closed-on-an-unknown-plan-schema',()=>{
      const run=newRun(root,projectRoot,{objective:'future plan',route:route(root,'Add password reset feature')});
      putArtifact(projectRoot,{kind:'task-plan',
        content:JSON.stringify({...basePlan({plan_id:'PLAN-003'}),schema:'agent-sdlc/task-plan/v9'},null,2)+'\n',
        runId:run.run_id,stage:'PLAN',filename:'task-plan.json'});
      const out=migrateRunToTaskRuntime(root,projectRoot,run);
      if(out.status!=='FAILED_CLOSED')fail(JSON.stringify(out));
      if(listTasks(projectRoot,run.run_id).length)fail('tasks were created from an unknown schema');
    });

    t('migration-assigns-stable-ids-only-when-absent',()=>{
      const run=newRun(root,projectRoot,{objective:'unnamed tasks',route:route(root,'Add password reset feature')});
      const plan=basePlan({plan_id:'PLAN-004',requirements:['AC-001','AC-002'],tasks:[
        TASK({task_id:'TASK-007'}),
        {...TASK({acceptance_criteria:['AC-002'],write_scope:['src/notify/reset-email.js']}),task_id:undefined}
      ]});
      putArtifact(projectRoot,{kind:'task-plan',content:JSON.stringify(plan,null,2)+'\n',runId:run.run_id,stage:'PLAN',filename:'task-plan.json'});
      const out=migrateRunToTaskRuntime(root,projectRoot,run);
      if(out.status!=='MIGRATED')fail(JSON.stringify(out));
      if(out.generated_task_ids.length!==1)fail(JSON.stringify(out.generated_task_ids));
      const ids=listTasks(projectRoot,run.run_id).map(x=>x.task_id).sort();
      if(!ids.includes('TASK-007'))fail(`existing id was rewritten: ${ids.join(',')}`);
    });

    t('per-task-cost-and-telemetry-are-attributed',()=>{
      const {run}=runAtImplement(root,projectRoot,{plan:basePlan({plan_id:'PLAN-005'})});
      const task=requireTask(projectRoot,run.run_id,'TASK-001');
      recordTaskUsage(projectRoot,run,task,{provider:'claude',model:'m',input_tokens:100,output_tokens:40,model_calls:2,tool_calls:5,wall_ms:1200});
      const report=reportRunTaskUsage(projectRoot,run.run_id,listTasks(projectRoot,run.run_id));
      const row=report.tasks.find(r=>r.task_id==='TASK-001');
      if(!row||row.total.output_tokens!==40||row.total.model_calls!==2)fail(JSON.stringify(report.tasks));
      if(report.unattributed.entries!==0)fail(JSON.stringify(report.unattributed));
      const m=taskMetrics(projectRoot,run.run_id);
      if(!m.graph_present)fail('telemetry did not see the task graph');
      if(m.derived.context_manifest_coverage===null)fail(JSON.stringify(m.derived));
      if(typeof m.cost_per_verified_done_task!=='object')fail(JSON.stringify(m.cost_per_verified_done_task));
    });

    t('workspace-cleanup-refuses-to-destroy-unpersisted-evidence',()=>{
      const {run}=runAtImplement(root,projectRoot,{plan:basePlan({plan_id:'PLAN-006'})});
      const task=requireTask(projectRoot,run.run_id,'TASK-001');
      const ws=createTaskWorkspace(projectRoot,{run,task,writer:'writer-a'});
      if(!ws.writable)fail('a task with a write scope got a read-only workspace');
      const refused=cleanupTaskWorkspace(projectRoot,{run,task,evidencePersisted:false});
      if(refused.status!=='REFUSED_EVIDENCE_NOT_PERSISTED')fail(JSON.stringify(refused));
      const still=listTaskWorkspaces(projectRoot,run.run_id).find(w=>w.task_id==='TASK-001');
      if(still.status!=='ACTIVE')fail('the workspace was cleaned despite unpersisted evidence');
      const forced=cleanupTaskWorkspace(projectRoot,{run,task,evidencePersisted:false,force:true});
      if(forced.status!=='CLEANED')fail(JSON.stringify(forced));
    });
  }

  const results=Object.entries(groups).map(([group,rows])=>({
    group,
    checks:rows.length,
    passes:rows.filter(r=>r.status==='PASS').length,
    failures:rows.filter(r=>r.status!=='PASS').length,
    results:rows
  }));
  return {
    schema:'agent-sdlc/task-runtime-suite/v1',
    groups:results,
    checks:results.reduce((a,g)=>a+g.checks,0),
    passes:results.reduce((a,g)=>a+g.passes,0),
    failures:results.reduce((a,g)=>a+g.failures,0)
  };
}
