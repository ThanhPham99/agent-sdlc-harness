// Two-stage task review with two distinct contracts.
//
//   Spec compliance: did this implement exactly the task goal, acceptance
//   criteria, design decisions and scope boundaries?
//
//   Code quality: given that the specification is accepted, is the
//   implementation safe and maintainable?
//
// Keeping them separate stops the quality pass from re-arguing the spec and
// stops the spec pass from bikeshedding style. This module validates and
// records the reviews structurally; the judgement itself comes from a reviewer
// agent, and an independence claim it cannot back up is recorded as a
// limitation rather than asserted.
import {now} from './util.mjs';
import {putArtifact,emitTaskEvent,saveTask} from './store.mjs';

const arr=x=>Array.isArray(x)?x:[];
export const BLOCKING='BLOCKING';

const blockingFindings=r=>arr(r?.findings).filter(f=>f.severity===BLOCKING&&f.resolved!==true);

function validateIndependence(review,task){
  const errors=[];const warnings=[];
  const ind=review?.independence;
  const required=task?.execution?.independent_review===true;
  if(!ind){
    if(required)errors.push('INDEPENDENCE_NOT_RECORDED');
    return {errors,warnings,independent:false,limitation:required?'not recorded':null};
  }
  if(ind.requested!==required&&required)warnings.push('INDEPENDENCE_REQUIRED_BUT_NOT_REQUESTED');
  if(ind.achieved===true&&['SAME_CONTEXT','UNAVAILABLE'].includes(ind.mode)){
    // Claiming independence while admitting a shared context is the one thing
    // this contract exists to prevent.
    errors.push('INDEPENDENCE_CLAIM_CONTRADICTS_MODE');
  }
  if(ind.achieved===false&&!ind.limitation)errors.push('INDEPENDENCE_NOT_ACHIEVED_WITHOUT_RECORDED_LIMITATION');
  if(ind.achieved===true&&ind.worker_reasoning_withheld===false)errors.push('INDEPENDENT_REVIEW_SAW_WORKER_REASONING');
  return {errors,warnings,independent:ind.achieved===true,limitation:ind.limitation??null};
}

export function validateSpecComplianceReview(review,task){
  const errors=[];const warnings=[];
  const r=review||{};
  if(r.schema!=='agent-sdlc/spec-compliance-review/v1')errors.push('SCHEMA_MISMATCH');
  if(r.task_id!==task?.task_id)errors.push('TASK_ID_MISMATCH');
  if(r.attempt!==task?.attempt)errors.push(`ATTEMPT_MISMATCH:${r.attempt}!=${task?.attempt}`);
  // The binding, not an optional courtesy. Checking it only when the review
  // volunteered a diff_hash meant omitting the field skipped the check, and
  // neither JSON schema requires it -- so a review could validate clean while
  // bound to nothing. `attempt` was already mandatory; this is the same
  // binding. task.diff_hash is always set by review time, because
  // RUNNING -> VERIFYING requires diff_captured.
  if(task?.diff_hash&&!r.diff_hash)errors.push('REVIEW_NOT_BOUND_TO_A_DIFF');
  else if(r.diff_hash&&task?.diff_hash&&r.diff_hash!==task.diff_hash)errors.push('REVIEW_NOT_BOUND_TO_CURRENT_DIFF');
  if(!['COMPLIANT','NON_COMPLIANT','PENDING'].includes(r.verdict))errors.push('INVALID_VERDICT');
  const blocking=blockingFindings(r);
  if(r.verdict==='COMPLIANT'&&blocking.length)errors.push('COMPLIANT_WITH_BLOCKING_FINDINGS');
  if(r.verdict==='NON_COMPLIANT'&&!arr(r.findings).length)errors.push('NON_COMPLIANT_WITHOUT_FINDINGS');
  for(const f of arr(r.findings)){
    if(!f.evidence)errors.push(`FINDING_WITHOUT_EVIDENCE:${f.category||'?'}`);
  }
  // Every acceptance criterion the task owns must actually have been looked at.
  const owed=arr(task?.acceptance_criteria);
  const checked=new Set(arr(r.acceptance_criteria_checked));
  const unchecked=owed.filter(ac=>!checked.has(ac));
  if(owed.length&&unchecked.length)errors.push(`ACCEPTANCE_CRITERIA_NOT_CHECKED:${unchecked.join(',')}`);
  const ind=validateIndependence(r,task);
  errors.push(...ind.errors);warnings.push(...ind.warnings);
  return {
    schema:'agent-sdlc/spec-review-validation/v1',
    valid:errors.length===0,
    blocking_findings:blocking.length,
    clean:errors.length===0&&r.verdict==='COMPLIANT'&&blocking.length===0,
    independent:ind.independent,
    independence_limitation:ind.limitation,
    errors,warnings
  };
}

export function validateCodeQualityReview(review,task){
  const errors=[];const warnings=[];
  const r=review||{};
  if(r.schema!=='agent-sdlc/code-quality-review/v1')errors.push('SCHEMA_MISMATCH');
  if(r.task_id!==task?.task_id)errors.push('TASK_ID_MISMATCH');
  if(r.attempt!==task?.attempt)errors.push(`ATTEMPT_MISMATCH:${r.attempt}!=${task?.attempt}`);
  // The binding, not an optional courtesy. Checking it only when the review
  // volunteered a diff_hash meant omitting the field skipped the check, and
  // neither JSON schema requires it -- so a review could validate clean while
  // bound to nothing. `attempt` was already mandatory; this is the same
  // binding. task.diff_hash is always set by review time, because
  // RUNNING -> VERIFYING requires diff_captured.
  if(task?.diff_hash&&!r.diff_hash)errors.push('REVIEW_NOT_BOUND_TO_A_DIFF');
  else if(r.diff_hash&&task?.diff_hash&&r.diff_hash!==task.diff_hash)errors.push('REVIEW_NOT_BOUND_TO_CURRENT_DIFF');
  if(!['ACCEPTED','CHANGES_REQUIRED','PENDING'].includes(r.verdict))errors.push('INVALID_VERDICT');
  const blocking=blockingFindings(r);
  if(r.verdict==='ACCEPTED'&&blocking.length)errors.push('ACCEPTED_WITH_BLOCKING_FINDINGS');
  if(r.verdict==='CHANGES_REQUIRED'&&!arr(r.findings).length)errors.push('CHANGES_REQUIRED_WITHOUT_FINDINGS');
  for(const f of arr(r.findings)){
    if(!f.evidence)errors.push(`FINDING_WITHOUT_EVIDENCE:${f.category||'?'}`);
    if(f.severity===BLOCKING&&f.category==='CORRECTNESS'&&!f.failure_scenario){
      // A blocking correctness claim without a concrete failure path is a guess.
      errors.push('BLOCKING_CORRECTNESS_FINDING_WITHOUT_FAILURE_SCENARIO');
    }
  }
  const ind=validateIndependence(r,task);
  errors.push(...ind.errors);warnings.push(...ind.warnings);
  return {
    schema:'agent-sdlc/quality-review-validation/v1',
    valid:errors.length===0,
    blocking_findings:blocking.length,
    clean:errors.length===0&&r.verdict==='ACCEPTED'&&blocking.length===0,
    independent:ind.independent,
    independence_limitation:ind.limitation,
    errors,warnings
  };
}

/** Persist a validated review and attach its ref to the task. */
export function recordTaskReview(projectRoot,run,task,review,{kind}={}){
  if(!['spec','quality'].includes(kind))throw new Error(`unknown review kind ${kind}`);
  const validation=kind==='spec'?validateSpecComplianceReview(review,task):validateCodeQualityReview(review,task);
  const ref=putArtifact(projectRoot,{
    kind:kind==='spec'?'spec-compliance-review':'code-quality-review',
    content:JSON.stringify(review,null,2)+'\n',
    runId:run.run_id,stage:run.state,sourceRevision:review?.base_revision??task.base_revision,
    filename:`${task.task_id}-${kind}-review-attempt${task.attempt||0}.json`
  }).artifact_id;
  task.review_refs=[...new Set([...(task.review_refs||[]),ref])];
  saveTask(projectRoot,task);
  emitTaskEvent(projectRoot,task,{
    type:kind==='spec'?'task.spec_reviewed':'task.quality_reviewed',
    artifact_refs:[ref],
    payload:{verdict:review?.verdict??null,valid:validation.valid,clean:validation.clean,
      blocking_findings:validation.blocking_findings,independent:validation.independent,
      independence_limitation:validation.independence_limitation,errors:validation.errors}
  });
  return {schema:'agent-sdlc/task-review-record/v1',kind,recorded:true,artifact_ref:ref,validation,recorded_at:now()};
}
