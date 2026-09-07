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
import fs from 'node:fs';
import path from 'node:path';
import {now} from './util.mjs';
import {loadTask,listTasks,saveTask,emitTaskEvent,getArtifact} from './store.mjs';
import {transitionTask,evaluateTransition,dependencyState,requireTask} from './task-engine.mjs';
import {buildTaskContext,renderTaskPrompt} from './task-context.mjs';
import {createTaskWorkspace,checkpointTaskWorkspace,workspaceDiff,getTaskWorkspace,cleanupTaskWorkspace} from './workspace.mjs';
import {verifyTask} from './task-verification.mjs';
import {recordTaskReview,BLOCKING} from './task-review.mjs';
import {classifyTaskFailure,planRecovery,applyRecovery,evidenceFingerprint,hasNewEvidence,outerEscalation} from './task-recovery.mjs';
import {routeModel} from './model-router.mjs';
import {addUsage} from './cost.mjs';
import {auditCodingStandards} from './coding-standards-linter.mjs';
import * as layout from './layout.mjs';

const arr=x=>Array.isArray(x)?x:[];

/** Files the standards linter understands. Anything else it cannot judge. */
const LINTABLE=/\.(mjs|cjs|js|jsx|ts|tsx)$/;

/**
 * How many non-blocking standards violations travel in a review. A file with
 * twenty unprefixed booleans would otherwise bury the reviewer's own findings
 * in machine noise, and the reader needs the pattern, not every instance. The
 * blocking ones are never dropped -- they decide the gate.
 */
export const MAX_REPORTED_STANDARDS_NITS=10;

/**
 * Which policy governs this project, and whether the audit runs at all.
 *
 * The harness policy is opinionated -- snake_case properties, no `var`, no
 * `any` -- and applying it unasked to an arbitrary target repository would
 * block every task in a codebase with different conventions. So a project may
 * override it or switch it off through `.agent-sdlc/project.json`:
 *
 *   "coding_standards": { "enabled": false }
 *   "coding_standards": { "policy_path": "config/our-standards.json" }
 *
 * A relative `policy_path` is resolved against the project root. With nothing
 * configured, a project-level `policies/coding-standards.json` wins over the
 * harness's, which is what a project that vendored its own would expect.
 */
export function resolveCodingStandardsPolicy(root,projectRoot){
  let configured={};
  try{
    const cfg=JSON.parse(fs.readFileSync(layout.projectConfigFile(projectRoot),'utf8'));
    configured=cfg.coding_standards||{};
  }catch{/* no project config: the defaults below still apply */}
  if(configured.enabled===false)return {is_enabled:false,policy_path:null,reason:'disabled in .agent-sdlc/project.json'};
  if(configured.policy_path){
    const resolved=path.resolve(projectRoot,configured.policy_path);
    return {is_enabled:true,policy_path:resolved,source:'project_config'};
  }
  const vendored=path.join(projectRoot,'policies','coding-standards.json');
  if(fs.existsSync(vendored))return {is_enabled:true,policy_path:vendored,source:'project_policies'};
  return {is_enabled:true,policy_path:path.join(root,'policies','coding-standards.json'),source:'harness'};
}

/**
 * Audit the task's own changed files against the coding-standards policy and
 * return the violations as code-quality findings.
 *
 * The policy was enforced by prompt alone: implementation.md told the writer the
 * rules and code-review.md told the reviewer to check them, and a reviewer that
 * simply did not look produced an ACCEPTED verdict indistinguishable from one
 * that did. The linter existed the whole time and nothing called it. This runs
 * it over the diff -- never the repository, so a task does not inherit debt it
 * did not write -- and merges the result into the review, where a BLOCKING
 * violation decides the verdict rather than being argued about.
 *
 * The returned `status` is the point of the return shape. An audit that found
 * nothing and an audit that never ran produce the same empty finding list, and
 * a review artifact that cannot tell them apart is exactly the kind of clean
 * document proving nothing that this change exists to remove. So the status
 * travels into the review, and a failure to run is recorded rather than passed
 * off as compliance -- but it does not block, because a broken linter must not
 * become a new way for a task to be stuck.
 */
export function codingStandardsFindings(root,projectRoot,run,task){
  const skipped=(status,reason)=>({status,reason,findings:[],files_checked:0,report:null});
  const policy=resolveCodingStandardsPolicy(root,projectRoot);
  if(!policy.is_enabled)return skipped('DISABLED',policy.reason);
  try{
    const ws=getTaskWorkspace(projectRoot,run.run_id,task.task_id);
    // Without a workspace there is no diff to scope the audit to, and linting
    // the whole project root here would judge the task on code it never wrote.
    if(!ws)return skipped('SKIPPED','the task has no workspace to diff');
    const diff=workspaceDiff(projectRoot,ws);
    const changed=arr(diff?.changed_paths).map(String);
    const files=changed.filter(p=>LINTABLE.test(p));
    if(!files.length){
      return {...skipped('NO_LINTABLE_FILES',changed.length?`${changed.length} changed path(s), none in a language the linter reads`:'the diff is empty'),status:'NO_LINTABLE_FILES'};
    }
    const report=auditCodingStandards({root_dir:ws.root,files,policy_path:policy.policy_path});
    const toFinding=v=>({
      severity:v.severity,
      // `category` is an enum in CodeQualityReview.schema.json, and a standards
      // violation is a maintainability one. An invented category validated fine
      // against the hand-rolled checks in task-review.mjs and would have been
      // rejected by the published contract -- which now matters concretely,
      // because that schema is handed to the reviewer host as --json-schema.
      category:'MAINTAINABILITY',
      rule_id:v.rule_id,
      summary:v.message,
      // The validator rejects a finding with no evidence, and rightly: the
      // file:line the linter already knows is exactly that evidence.
      evidence:`${v.file_path}:${v.line_number}`
    });
    const violations=arr(report.violations);
    const blocking=violations.filter(v=>v.severity===BLOCKING);
    const rest=violations.filter(v=>v.severity!==BLOCKING);
    const kept=rest.slice(0,MAX_REPORTED_STANDARDS_NITS);
    return {
      status:'RAN',
      findings:[...blocking,...kept].map(toFinding),
      files_checked:report.total_files_checked,
      violations_omitted:rest.length-kept.length,
      policy_source:policy.source,
      report
    };
  }catch(e){
    return skipped('ERROR',e.message);
  }
}

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

  // The quality review the gate actually judged, which is the reviewer's
  // document plus whatever the standards linter proved. Classification and the
  // retry fingerprint have to see the same thing the gate saw, or a task that
  // failed on standards violations would look like a repeat of an untouched
  // attempt and the engine would refuse the retry that fixes it.
  let effectiveQualityReview=qualityReview;

  const fail=(verification=null)=>{
    const dep=dependencyState(tasks,task);
    const failure=classifyTaskFailure({verification,specReview,qualityReview:effectiveQualityReview,dependency:dep,providerError,permissionDenied,budgetExhausted,designInvalidated,requirementAmbiguity});
    const fingerprint=evidenceFingerprint({task,verification,specReview,qualityReview:effectiveQualityReview});
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

  // `task review --kind spec --file r.json` validates a review, stores it, and
  // binds it to the task -- and advance then asked for it again, because it read
  // only its own arguments. The two commands look like they compose. They should.
  // An inline review still wins: it is the newer statement of the same thing.
  const recorded=(kind)=>{
    const want=kind==='spec'?'agent-sdlc/spec-compliance-review/v1':'agent-sdlc/code-quality-review/v1';
    for(const ref of [...(task.review_refs||[])].reverse()){
      let doc;try{doc=JSON.parse(getArtifact(projectRoot,ref).content);}catch{continue;}
      // Bound to THIS attempt and THIS diff, or it is a review of something else.
      if(doc?.schema===want&&doc.attempt===task.attempt&&doc.diff_hash===task.diff_hash)return doc;
    }
    return null;
  };

  // --- SPEC_REVIEW -> QUALITY_REVIEW --------------------------------------
  if(task.status==='SPEC_REVIEW'){
    const review=specReview??recorded('spec');
    if(!review)return {schema:'agent-sdlc/task-advance/v1',advanced:false,task,steps,
      awaiting:'SPEC_COMPLIANCE_REVIEW',verification,
      review_contract:'agent-sdlc/spec-compliance-review/v1'};
    const rec=recordTaskReview(projectRoot,run,task,review,{kind:'spec'});
    task=loadTask(projectRoot,run.run_id,taskId);
    steps.push({step:'spec_review',valid:rec.validation.valid,clean:rec.validation.clean,errors:rec.validation.errors});
    if(!rec.validation.clean)return fail(verification);
    task=transitionTask(root,projectRoot,task,'QUALITY_REVIEW',{tasks,specReview:review,reason:'spec compliance clean'});
  }

  // --- QUALITY_REVIEW -> DONE ---------------------------------------------
  if(task.status==='QUALITY_REVIEW'){
    const review=qualityReview??recorded('quality');
    if(!review)return {schema:'agent-sdlc/task-advance/v1',advanced:false,task,steps,
      awaiting:'CODE_QUALITY_REVIEW',verification,
      review_contract:'agent-sdlc/code-quality-review/v1'};
    // Deterministic evidence before model inference: the reviewer's verdict is
    // merged with what the linter can prove, and a BLOCKING standards violation
    // makes an ACCEPTED verdict invalid rather than being argued about.
    const standards=codingStandardsFindings(root,projectRoot,run,task);
    const standardsBlocking=standards.findings.filter(f=>f.severity===BLOCKING);
    // Recorded on every review, including the ones with nothing to report: the
    // artifact has to say whether the audit ran, or a reader cannot tell a
    // compliant diff from an audit that silently did not happen.
    let merged={...review,standards_audit:{
      status:standards.status,
      files_checked:standards.files_checked,
      violations:standards.findings.length,
      blocking:standardsBlocking.length,
      violations_omitted:standards.violations_omitted??0,
      policy_source:standards.policy_source??null,
      reason:standards.reason??null
    }};
    if(standards.findings.length){
      merged={...merged,findings:[...arr(review.findings),...standards.findings]};
      // A proven BLOCKING violation settles the verdict. Leaving it ACCEPTED
      // would fail validation as reviewer malpractice; CHANGES_REQUIRED is what
      // actually happened, and it classifies as QUALITY_BLOCKER so the recovery
      // path hands the writer the violations to fix.
      if(standardsBlocking.length)merged={...merged,verdict:'CHANGES_REQUIRED'};
    }
    steps.push({step:'coding_standards',status:standards.status,violations:standards.findings.length,blocking:standardsBlocking.length});
    effectiveQualityReview=merged;
    const rec=recordTaskReview(projectRoot,run,task,merged,{kind:'quality'});
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
    task=transitionTask(root,projectRoot,task,'DONE',{tasks,verification,specReview:specReview??recorded('spec'),qualityReview:merged,reason:'verified and reviewed'});
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
