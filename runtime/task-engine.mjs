// Task lifecycle engine: materialize a validated TaskPlan into durable task
// records, and enforce the inner task state machine.
//
// The outer run/feature state machine (runtime/orchestrator.mjs) stays canonical.
// This engine owns only what happens *inside* an execution-relevant outer stage,
// and a worker never mutates outer state: it returns a structured result and the
// engine performs the transition.
//
// Invariants enforced here:
// - a task reaches DONE only with verification evidence and clean reviews;
// - a dependency is complete only when it is DONE;
// - a retry needs new concrete evidence and remaining retry budget;
// - a diff outside approved write scope is a planning event, not a retry.
import path from 'node:path';
import {now,readJson,sha256} from './util.mjs';
import {saveTask,loadTask,listTasks,saveTaskGraph,loadTaskGraph,emitTaskEvent,hasTask} from './store.mjs';
import {validateTaskPlan} from './plan-validator.mjs';

let smCache=null;
export function getTaskStateMachine(root){
  if(!smCache)smCache=readJson(path.join(root,'config','task-state-machine.json'));
  return smCache;
}
const arr=x=>Array.isArray(x)?x:[];

export const TASK_STATUSES=['CREATED','READY','RUNNING','VERIFYING','SPEC_REVIEW','QUALITY_REVIEW','DONE','BLOCKED','FAILED','INVALIDATED','SUPERSEDED'];

// ---------------------------------------------------------------------------
// Materialization
// ---------------------------------------------------------------------------

function taskFromPlanned(t,{runId,planId,profile}){
  const changesBehavior=t.changes_behavior!==false;
  return {
    schema:'agent-sdlc/task/v1',
    task_id:t.task_id,
    run_id:runId,
    plan_id:planId,
    title:t.title||t.task_id,
    goal:t.goal,
    category:t.category||'implementation',
    status:'CREATED',
    depends_on:arr(t.depends_on),
    acceptance_criteria:arr(t.acceptance_criteria),
    design_decisions:arr(t.design_decisions),
    changes_behavior:changesBehavior,
    scope:{
      read:arr(t.read_scope),
      write:arr(t.write_scope),
      interfaces:arr(t.interface_scope),
      forbidden:arr(t.forbidden_scope),
      modules:arr(t.modules),
      symbols:arr(t.likely_symbols)
    },
    verification:{
      targeted_tests:arr(t.verification?.targeted_tests),
      expected_behavior:arr(t.verification?.expected_behavior),
      required_evidence:arr(t.verification?.required_evidence)
    },
    compatibility_obligations:arr(t.compatibility_obligations),
    rollback_obligations:arr(t.rollback_obligations),
    done_conditions:arr(t.done_conditions),
    risk:{
      profile:t.risk?.profile||profile||'STANDARD',
      security:t.risk?.security||'LOW',
      data:t.risk?.data||'LOW',
      destructive_data_change:t.risk?.destructive_data_change===true
    },
    execution:{
      fresh_context:true,
      // A task that writes needs its own workspace; a read-only task does not.
      isolated_workspace:arr(t.write_scope).length>0,
      workspace_mode:arr(t.write_scope).length>0?'isolated-worktree':'shared-readonly',
      max_retries:null,
      primary_writer:null,
      independent_review:(t.risk?.profile||profile)==='STRICT'||t.risk?.security==='HIGH',
      parallel_candidate:t.parallel_candidate===true,
      estimated_seconds:Number(t.estimated_seconds||0)
    },
    attempt:0,
    base_revision:null,
    diff_hash:null,
    context_manifest_ref:null,
    artifact_refs:[],
    evidence_refs:[],
    review_refs:[],
    failure:null,
    blocker:null,
    invalidation:null,
    history:[],
    created_at:now(),
    updated_at:now()
  };
}

/**
 * Materialize a validated TaskPlan into a persistent TaskGraph plus one durable
 * Task record per planned task. Refuses to run on an invalid plan: the plan
 * quality gate is upstream of the task runtime, not optional to it.
 *
 * Idempotent: an existing task record is preserved, never reset to CREATED.
 */
export function materializeTaskGraph(root,projectRoot,run,plan,{planArtifactRef=null,sourceRevision=null,legacyStageEvidence=false}={}){
  const validation=validateTaskPlan(plan,{profile:plan?.profile||run.profile});
  if(!validation.valid){
    return {schema:'agent-sdlc/task-graph-record/v1',materialized:false,validation,graph:null,created:[],preserved:[]};
  }
  const planId=plan.plan_id;
  const created=[];const preserved=[];
  for(const planned of arr(plan.tasks)){
    if(hasTask(projectRoot,run.run_id,planned.task_id)){preserved.push(planned.task_id);continue;}
    const task=taskFromPlanned(planned,{runId:run.run_id,planId,profile:plan.profile||run.profile});
    task.execution.max_retries=maxRetries(root,task);
    saveTask(projectRoot,task);
    emitTaskEvent(projectRoot,task,{type:'task.created',payload:{plan_id:planId,category:task.category,depends_on:task.depends_on}});
    created.push(task.task_id);
  }
  const graph={
    schema:'agent-sdlc/task-graph/v1',
    run_id:run.run_id,
    plan_id:planId,
    plan_artifact_ref:planArtifactRef,
    plan_sha256:sha256(JSON.stringify(plan)),
    source_revision:sourceRevision??plan.source_revision??null,
    requirements:arr(plan.requirements),
    design_decisions:arr(plan.design_decisions),
    integration_tasks:arr(plan.integration_tasks),
    nodes:arr(plan.tasks).map(t=>({task_id:t.task_id,category:t.category||'implementation',depends_on:arr(t.depends_on)})),
    edges:arr(plan.tasks).flatMap(t=>arr(t.depends_on).map(d=>({from:d,to:t.task_id,kind:'depends_on'}))),
    legacy_stage_evidence:!!legacyStageEvidence,
    created_at:now(),
    updated_at:now()
  };
  saveTaskGraph(projectRoot,graph);
  return {schema:'agent-sdlc/task-graph-record/v1',materialized:true,validation,graph,created,preserved};
}

export function maxRetries(root,task){
  const policy=readJson(path.join(root,'policies','task-failure-policy.json'));
  const profile=task?.risk?.profile||'STANDARD';
  return policy.profile_max_retries[profile]??policy.default_max_retries;
}

// ---------------------------------------------------------------------------
// Readiness and dependency truth
// ---------------------------------------------------------------------------

/** A dependency counts as satisfied only when the dependency task is DONE. */
export function dependencyState(tasks,task){
  const byId=new Map(tasks.map(t=>[t.task_id,t]));
  const missing=[],pending=[],failed=[],done=[];
  for(const id of arr(task.depends_on)){
    const dep=byId.get(id);
    if(!dep){missing.push(id);continue;}
    if(dep.status==='DONE')done.push(id);
    else if(['FAILED','SUPERSEDED'].includes(dep.status))failed.push(id);
    else pending.push(id);
  }
  return {satisfied:!missing.length&&!pending.length&&!failed.length,done,pending,failed,missing};
}

/** Promote CREATED tasks whose dependencies are now DONE. Deterministic. */
export function refreshReadiness(root,projectRoot,runId){
  const tasks=listTasks(projectRoot,runId);
  const promoted=[];const blocked=[];
  for(const task of tasks){
    if(task.status!=='CREATED')continue;
    const dep=dependencyState(tasks,task);
    if(dep.satisfied){
      transitionTask(root,projectRoot,task,'READY',{reason:'dependencies satisfied',tasks,internal:true});
      promoted.push(task.task_id);
    }else if(dep.failed.length||dep.missing.length){
      transitionTask(root,projectRoot,task,'BLOCKED',{
        reason:dep.missing.length?`unknown dependency ${dep.missing.join(',')}`:`dependency failed: ${dep.failed.join(',')}`,
        failureClass:'DEPENDENCY_BLOCKED',tasks,internal:true
      });
      blocked.push(task.task_id);
    }
  }
  return {promoted,blocked};
}

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

function edgeFor(root,from,to){
  return getTaskStateMachine(root).edges.find(e=>e.from===from&&e.to===to)||null;
}

/**
 * Evaluate whether a transition is legal *and* whether its declared conditions
 * hold. Returns the reasons rather than throwing, so callers can report a
 * blocked task without exception plumbing.
 */
export function evaluateTransition(root,task,to,{tasks=[],verification=null,specReview=null,qualityReview=null,newEvidence=false,recoveryDecision=false,upstreamRefreshed=false,upstreamChange=false,blockerResolved=false,contextManifest=null,primaryWriter=null}={}){
  const sm=getTaskStateMachine(root);
  const problems=[];
  if(!sm.statuses.includes(to))problems.push(`UNKNOWN_STATUS:${to}`);
  const edge=edgeFor(root,task.status,to);
  if(!edge)problems.push(`ILLEGAL_TRANSITION:${task.status}->${to}`);
  const need=new Set(edge?.requires||[]);

  if(need.has('dependencies_satisfied')){
    const dep=dependencyState(tasks.length?tasks:[task],task);
    if(!dep.satisfied)problems.push(`DEPENDENCIES_NOT_SATISFIED:${[...dep.pending,...dep.failed,...dep.missing].join(',')}`);
  }
  if(need.has('primary_writer_bound')){
    const writer=primaryWriter??task.execution?.primary_writer;
    if(!writer)problems.push('NO_PRIMARY_WRITER_BOUND');
  }
  if(need.has('context_manifest')&&!(contextManifest||task.context_manifest_ref))problems.push('NO_TASK_CONTEXT_MANIFEST');
  if(need.has('diff_captured')&&!task.diff_hash)problems.push('NO_DIFF_CAPTURED');
  if(need.has('verification_evidence')){
    const v=verification||null;
    if(!v&&!task.evidence_refs?.length)problems.push('NO_VERIFICATION_EVIDENCE');
    else if(v&&v.status!=='PASS')problems.push(`VERIFICATION_NOT_PASSING:${v.status}`);
    else if(v&&v.attempt!==task.attempt)problems.push(`VERIFICATION_ATTEMPT_MISMATCH:${v.attempt}!=${task.attempt}`);
  }
  if(need.has('spec_review_clean')){
    if(!specReview)problems.push('NO_SPEC_REVIEW');
    else{
      if(specReview.verdict!=='COMPLIANT')problems.push(`SPEC_REVIEW_${specReview.verdict}`);
      const blocking=arr(specReview.findings).filter(f=>f.severity==='BLOCKING'&&f.resolved!==true);
      if(blocking.length)problems.push(`SPEC_REVIEW_BLOCKING_FINDINGS:${blocking.length}`);
    }
  }
  if(need.has('quality_review_clean')){
    if(!qualityReview)problems.push('NO_QUALITY_REVIEW');
    else{
      if(qualityReview.verdict!=='ACCEPTED')problems.push(`QUALITY_REVIEW_${qualityReview.verdict}`);
      const blocking=arr(qualityReview.findings).filter(f=>f.severity==='BLOCKING'&&f.resolved!==true);
      if(blocking.length)problems.push(`QUALITY_REVIEW_BLOCKING_FINDINGS:${blocking.length}`);
    }
  }
  if(need.has('scope_respected')){
    const scope=verification?.scope;
    if(scope&&scope.respected===false)problems.push(`SCOPE_VIOLATION:${arr(scope.out_of_scope_paths).join(',')}`);
  }
  if(need.has('new_evidence')&&!newEvidence)problems.push('RETRY_WITHOUT_NEW_EVIDENCE');
  if(need.has('retry_budget')){
    const budget=task.execution?.max_retries??0;
    if(task.attempt>=budget+1)problems.push(`RETRY_BUDGET_EXHAUSTED:${task.attempt}/${budget}`);
  }
  if(need.has('blocker_resolved')&&!blockerResolved)problems.push('BLOCKER_NOT_RESOLVED');
  if(need.has('recovery_decision')&&!recoveryDecision)problems.push('NO_RECOVERY_DECISION');
  if(need.has('upstream_refreshed')&&!upstreamRefreshed)problems.push('UPSTREAM_NOT_REFRESHED');
  if(need.has('upstream_change')&&!upstreamChange)problems.push('NO_RECORDED_UPSTREAM_CHANGE');

  return {
    schema:'agent-sdlc/task-transition-check/v1',
    task_id:task.task_id,from:task.status,to,
    kind:edge?.kind??null,
    required:[...need],
    allowed:problems.length===0,
    problems
  };
}

/**
 * Perform a task transition. Throws on an illegal or unsatisfied transition
 * unless `force` is set (operator escape hatch, recorded in history).
 */
export function transitionTask(root,projectRoot,task,to,{
  tasks=[],reason=null,force=false,internal=false,
  verification=null,specReview=null,qualityReview=null,
  newEvidence=false,recoveryDecision=false,upstreamRefreshed=false,upstreamChange=false,blockerResolved=false,
  contextManifest=null,primaryWriter=null,failureClass=null,failureDetail=null,invalidationSource=null
}={}){
  const check=evaluateTransition(root,task,to,{tasks,verification,specReview,qualityReview,newEvidence,recoveryDecision,upstreamRefreshed,upstreamChange,blockerResolved,contextManifest,primaryWriter});
  if(!check.allowed&&!force){
    emitTaskEvent(projectRoot,task,{type:'task.transition_rejected',payload:{to,problems:check.problems}});
    throw new Error(`task ${task.task_id} ${task.status}->${to} rejected: ${check.problems.join('; ')}`);
  }
  const from=task.status;
  const kind=check.kind||(force?'forced':'unknown');

  // A retry re-enters RUNNING as a new attempt so evidence never straddles attempts.
  if(kind==='retry'||(from==='READY'&&to==='RUNNING'))task.attempt=(task.attempt||0)+1;

  if(to==='BLOCKED')task.blocker={reason:reason||'unspecified',class:failureClass||'UNSPECIFIED',time:now()};
  else if(from==='BLOCKED')task.blocker=null;
  if(to==='FAILED')task.failure={class:failureClass||'UNCLASSIFIED',detail:failureDetail||reason||'',evidence_ref:null,time:now()};
  else if(to==='READY'||to==='RUNNING')task.failure=null;
  if(to==='INVALIDATED')task.invalidation={reason:reason||'upstream change',source:invalidationSource||'unspecified',time:now()};
  else if(to==='READY')task.invalidation=null;
  if(primaryWriter)task.execution.primary_writer=primaryWriter;
  if(contextManifest)task.context_manifest_ref=contextManifest;

  task.status=to;
  task.history=[...arr(task.history),{from,to,kind,reason:reason??null,attempt:task.attempt||0,time:now()}];
  saveTask(projectRoot,task);

  const eventByStatus={DONE:'task.done',BLOCKED:'task.blocked',FAILED:'task.failed',INVALIDATED:'task.invalidated',SUPERSEDED:'task.superseded'};
  emitTaskEvent(projectRoot,task,{
    type:eventByStatus[to]||'task.transition',
    payload:{from,to,kind,reason:reason??null,forced:!!force&&!check.allowed,internal:!!internal,problems:check.allowed?[]:check.problems}
  });
  return task;
}

/** Aggregate progress for one run's task graph. */
export function taskProgress(projectRoot,runId){
  const tasks=listTasks(projectRoot,runId);
  const byStatus={};
  for(const s of TASK_STATUSES)byStatus[s]=0;
  for(const t of tasks)byStatus[t.status]=(byStatus[t.status]||0)+1;
  const required=tasks.filter(t=>t.status!=='SUPERSEDED');
  const done=required.filter(t=>t.status==='DONE');
  return {
    schema:'agent-sdlc/task-progress/v1',
    run_id:runId,
    total:tasks.length,
    by_status:byStatus,
    required_count:required.length,
    done_count:done.length,
    complete:required.length>0&&done.length===required.length,
    open:required.filter(t=>t.status!=='DONE').map(t=>({task_id:t.task_id,status:t.status,category:t.category})),
    graph_present:!!loadTaskGraph(projectRoot,runId)
  };
}

/** Load one task, or throw a clear error naming the run. */
export function requireTask(projectRoot,runId,taskId){
  if(!hasTask(projectRoot,runId,taskId))throw new Error(`unknown task ${taskId} in run ${runId}`);
  return loadTask(projectRoot,runId,taskId);
}
