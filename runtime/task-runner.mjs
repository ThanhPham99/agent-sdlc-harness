// Task execution driver.
//
//   load task -> validate READY -> compile bounded context -> prepare isolated
//   workspace -> select provider/model -> run one bounded objective -> capture
//   diff/evidence -> targeted verify -> spec review -> quality review ->
//   DONE or re-entry/block/fail
//
// The worker never mutates run or task state. It returns a structured result;
// this module owns every transition, and every transition goes through the task
// state machine, so an unverified or badly-reviewed task cannot reach DONE by
// any path a worker controls.
import {now} from './util.mjs';
import {loadTask,listTasks,saveTask,emitTaskEvent} from './store.mjs';
import {transitionTask,evaluateTransition,dependencyState,requireTask} from './task-engine.mjs';
import {buildTaskContext,renderTaskPrompt} from './task-context.mjs';
import {createTaskWorkspace,checkpointTaskWorkspace,workspaceDiff,getTaskWorkspace,cleanupTaskWorkspace} from './workspace.mjs';
import {verifyTask} from './task-verification.mjs';
import {recordTaskReview} from './task-review.mjs';
import {classifyTaskFailure,planRecovery,applyRecovery,evidenceFingerprint,hasNewEvidence,outerEscalation} from './task-recovery.mjs';
import {routeModel} from './model-router.mjs';
import {addUsage} from './cost.mjs';

const arr=x=>Array.isArray(x)?x:[];

/**
 * Prepare one READY task for execution: bind the writer, compile the bounded
 * context, create the single workspace, and move it to RUNNING.
 */
export function startTask(root,projectRoot,run,taskId,{writer=null,model=null}={}){
  const task=requireTask(projectRoot,run.run_id,taskId);
  const tasks=listTasks(projectRoot,run.run_id);
  if(task.status!=='READY'){
    const dep=dependencyState(tasks,task);
    return {schema:'agent-sdlc/task-start/v1',started:false,reason:`task is ${task.status}`,dependency:dep,task};
  }
  const primaryWriter=writer||`writer:${task.task_id}`;
  const workspace=createTaskWorkspace(projectRoot,{run,task,writer:primaryWriter});
  const manifest=buildTaskContext(root,projectRoot,run,task);
  emitTaskEvent(projectRoot,task,{type:'task.context_compiled',payload:{context_hash:manifest.context_hash,estimated_tokens:manifest.estimated_tokens,budget_status:manifest.context_budget_status,excluded:manifest.excluded.length}});

  const routing=model?{model}:safeRoute(root,projectRoot,run,task);
  transitionTask(root,projectRoot,task,'RUNNING',{
    tasks,reason:'dispatched',primaryWriter,contextManifest:manifest.context_hash
  });
  task.base_revision=workspace.base_revision??task.base_revision;
  saveTask(projectRoot,task);
  return {
    schema:'agent-sdlc/task-start/v1',
    started:true,
    task,
    workspace,
    context_manifest:manifest,
    prompt:renderTaskPrompt(root,manifest),
    routing
  };
}

function safeRoute(root,projectRoot,run,task){
  try{
    return routeModel(root,projectRoot,run,{
      task:task.category,
      provider:'auto',
      requireStructured:true
    });
  }catch(e){return {status:'ROUTING_UNAVAILABLE',reason:e.message};}
}

/** Capture the workspace diff for the current attempt. */
export function captureTaskDiff(projectRoot,run,task){
  const ws=getTaskWorkspace(projectRoot,run.run_id,task.task_id);
  if(!ws)throw new Error(`no workspace for ${task.task_id}`);
  const d=workspaceDiff(projectRoot,ws);
  task.base_revision=d.base_revision??task.base_revision;
  task.diff_hash=d.diff_hash??task.diff_hash;
  saveTask(projectRoot,task);
  checkpointTaskWorkspace(projectRoot,{run,task,label:`attempt-${task.attempt||0}`});
  emitTaskEvent(projectRoot,task,{type:'task.diff_captured',payload:{diff_hash:d.diff_hash,changed:d.changed_paths.length}});
  return d;
}

/**
 * Advance one task through verify -> spec review -> quality review -> DONE,
 * applying recovery instead of advancing whenever a stage does not pass.
 *
 * Reviews are supplied by the caller (a reviewer agent produced them); this
 * function decides what they mean.
 */
export function advanceTask(root,projectRoot,run,taskId,{specReview=null,qualityReview=null,escalateVerification=false,providerError=null,permissionDenied=false,budgetExhausted=false,designInvalidated=false,requirementAmbiguity=false,recoveryDecision=false,infrastructureAttempts=0,dryRunVerification=false}={}){
  let task=requireTask(projectRoot,run.run_id,taskId);
  const tasks=listTasks(projectRoot,run.run_id);
  const steps=[];

  const fail=(verification=null)=>{
    const dep=dependencyState(tasks,task);
    const failure=classifyTaskFailure({verification,specReview,qualityReview,dependency:dep,providerError,permissionDenied,budgetExhausted,designInvalidated,requirementAmbiguity});
    const fingerprint=evidenceFingerprint({task,verification,specReview,qualityReview});
    const plan=planRecovery(root,task,failure,{infrastructureAttempts,newEvidence:hasNewEvidence(task,fingerprint)});
    task=applyRecovery(root,projectRoot,task,plan,{tasks,fingerprint,recoveryDecision});
    steps.push({step:'recovery',failure_class:failure.class,action:plan.action,to:plan.to,reason:plan.reason});
    return {
      schema:'agent-sdlc/task-advance/v1',advanced:false,task,steps,
      failure,recovery:plan,outer_escalation:outerEscalation(plan),verification
    };
  };

  if(['DONE','SUPERSEDED'].includes(task.status)){
    return {schema:'agent-sdlc/task-advance/v1',advanced:false,task,steps,reason:`task is terminal (${task.status})`};
  }
  if(providerError||permissionDenied||budgetExhausted||designInvalidated||requirementAmbiguity){
    return fail(null);
  }

  // --- RUNNING -> VERIFYING ------------------------------------------------
  if(task.status==='RUNNING'){
    captureTaskDiff(projectRoot,run,task);
    task=loadTask(projectRoot,run.run_id,taskId);
    const check=evaluateTransition(root,task,'VERIFYING',{tasks});
    if(!check.allowed)return fail(null);
    task=transitionTask(root,projectRoot,task,'VERIFYING',{tasks,reason:'diff captured'});
    steps.push({step:'verifying'});
  }

  // --- VERIFYING -> SPEC_REVIEW -------------------------------------------
  let verification=null;
  if(task.status==='VERIFYING'){
    const v=verifyTask(root,projectRoot,run,task,{escalate:escalateVerification,dryRun:dryRunVerification});
    verification=v.evidence;
    task=loadTask(projectRoot,run.run_id,taskId);
    steps.push({step:'verified',status:verification.status,strategy:verification.strategy});
    if(verification.status!=='PASS')return fail(verification);
    task=transitionTask(root,projectRoot,task,'SPEC_REVIEW',{tasks,verification,reason:'verification passed'});
  }

  // --- SPEC_REVIEW -> QUALITY_REVIEW --------------------------------------
  if(task.status==='SPEC_REVIEW'){
    if(!specReview)return {schema:'agent-sdlc/task-advance/v1',advanced:false,task,steps,
      awaiting:'SPEC_COMPLIANCE_REVIEW',verification,
      review_contract:'agent-sdlc/spec-compliance-review/v1'};
    const rec=recordTaskReview(projectRoot,run,task,specReview,{kind:'spec'});
    task=loadTask(projectRoot,run.run_id,taskId);
    steps.push({step:'spec_review',valid:rec.validation.valid,clean:rec.validation.clean,errors:rec.validation.errors});
    if(!rec.validation.clean)return fail(verification);
    task=transitionTask(root,projectRoot,task,'QUALITY_REVIEW',{tasks,specReview,reason:'spec compliance clean'});
  }

  // --- QUALITY_REVIEW -> DONE ---------------------------------------------
  if(task.status==='QUALITY_REVIEW'){
    if(!qualityReview)return {schema:'agent-sdlc/task-advance/v1',advanced:false,task,steps,
      awaiting:'CODE_QUALITY_REVIEW',verification,
      review_contract:'agent-sdlc/code-quality-review/v1'};
    const rec=recordTaskReview(projectRoot,run,task,qualityReview,{kind:'quality'});
    task=loadTask(projectRoot,run.run_id,taskId);
    steps.push({step:'quality_review',valid:rec.validation.valid,clean:rec.validation.clean,errors:rec.validation.errors});
    if(!rec.validation.clean)return fail(verification);
    if(!verification){
      // Resuming mid-lifecycle: re-verify rather than trust an earlier attempt.
      const v=verifyTask(root,projectRoot,run,task,{escalate:escalateVerification,dryRun:dryRunVerification});
      verification=v.evidence;
      task=loadTask(projectRoot,run.run_id,taskId);
      if(verification.status!=='PASS')return fail(verification);
    }
    task=transitionTask(root,projectRoot,task,'DONE',{tasks,verification,specReview,qualityReview,reason:'verified and reviewed'});
    steps.push({step:'done'});
    const cleanup=cleanupTaskWorkspace(projectRoot,{run,task});
    steps.push({step:'workspace',status:cleanup.status});
    return {schema:'agent-sdlc/task-advance/v1',advanced:true,task,steps,verification,completed_at:now()};
  }

  return {schema:'agent-sdlc/task-advance/v1',advanced:false,task,steps,reason:`no advance defined from ${task.status}`,verification};
}

/** Record per-task usage against the run cost ledger. */
export function recordTaskUsage(projectRoot,run,task,usage={}){
  return addUsage(projectRoot,run,{
    ...usage,
    task_id:task.task_id,
    attempt:task.attempt||0,
    retries:usage.retries??Math.max(0,(task.attempt||0)-1),
    source:usage.source||'TASK_RUNNER'
  });
}

/**
 * Cross-provider continuation. The canonical handoff is the task checkpoint —
 * artifacts, refs and hashes — never provider conversation history. Nothing
 * about the risk policy relaxes because a provider changed.
 */
export function resumeFromCheckpoint(root,projectRoot,run,taskId,{
  originalProvider=null,fallbackProvider=null,failureClass='PROVIDER_FAILURE',reason=null
}={}){
  const task=requireTask(projectRoot,run.run_id,taskId);
  const before=taskCheckpoint(projectRoot,run,task);
  if(!fallbackProvider){
    return {schema:'agent-sdlc/task-fallback/v1',resumed:false,reason:'NO_FALLBACK_PROVIDER',checkpoint:before};
  }
  // Reconstruct the bounded context from durable state rather than replaying a
  // conversation: same task, same scope, same risk constraints.
  const manifest=buildTaskContext(root,projectRoot,run,task);
  const contextDelta=before.context_manifest_ref&&before.context_manifest_ref!==manifest.context_hash
    ?{changed:true,from:before.context_manifest_ref,to:manifest.context_hash}
    :{changed:false,hash:manifest.context_hash};
  task.context_manifest_ref=manifest.context_hash;
  saveTask(projectRoot,task);

  const record={
    schema:'agent-sdlc/task-fallback/v1',
    resumed:true,
    run_id:run.run_id,
    task_id:task.task_id,
    original_provider:originalProvider,
    fallback_provider:fallbackProvider,
    failure_class:failureClass,
    fallback_reason:reason||`continuing ${task.task_id} on ${fallbackProvider} from its task checkpoint`,
    resumed_from_status:task.status,
    attempt:task.attempt||0,
    base_revision:before.base_revision,
    diff_hash:before.diff_hash,
    context_delta:contextDelta,
    artifact_refs:before.artifact_refs,
    evidence_refs:before.evidence_refs,
    review_refs:before.review_refs,
    // Risk policy is a property of the task, not of the provider.
    risk_policy_preserved:{
      profile:task.risk?.profile??null,
      security:task.risk?.security??null,
      data:task.risk?.data??null,
      independent_review:task.execution?.independent_review===true
    },
    transferred:['context manifest hash','base revision','diff hash','artifact refs','evidence refs','review refs','failure class'],
    not_transferred:before.excludes,
    prompt:renderTaskPrompt(root,manifest),
    time:now()
  };
  emitTaskEvent(projectRoot,task,{
    type:'task.provider_fallback',
    provider:fallbackProvider,
    payload:{original_provider:originalProvider,failure_class:failureClass,
      context_delta:contextDelta,diff_hash:before.diff_hash,base_revision:before.base_revision}
  });
  return record;
}

/** Everything a provider fallback needs, and nothing a provider must not carry. */
export function taskCheckpoint(projectRoot,run,task){
  const ws=getTaskWorkspace(projectRoot,run.run_id,task.task_id);
  return {
    schema:'agent-sdlc/task-checkpoint/v1',
    run_id:run.run_id,
    task_id:task.task_id,
    status:task.status,
    attempt:task.attempt||0,
    context_manifest_ref:task.context_manifest_ref??null,
    base_revision:task.base_revision??ws?.base_revision??null,
    diff_hash:task.diff_hash??null,
    artifact_refs:arr(task.artifact_refs),
    evidence_refs:arr(task.evidence_refs),
    review_refs:arr(task.review_refs),
    open_findings:arr(task.review_refs).length?'see review_refs':[],
    failure:task.failure??null,
    workspace:ws?{mode:ws.mode,writable:ws.writable,branch:ws.branch,root_is_project:ws.root===projectRoot}:null,
    // Structured artifacts and observable evidence only. Never hidden reasoning.
    excludes:['provider_conversation_history','hidden_chain_of_thought','worker_scratch_reasoning'],
    time:now()
  };
}
