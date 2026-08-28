// Task DAG scheduler.
//
// Answers one question deterministically: given the persisted task graph, which
// tasks may be dispatched right now, and how many at once?
//
// It reuses the conflict/benefit principles of runtime/parallel.mjs rather than
// inventing a second policy model: `scopeConflicts` and `benefitJustified` are
// the same predicates, lifted so both callers share them.
import path from 'node:path';
import {now,readJson} from './util.mjs';
import {listTasks,loadTaskGraph,emitTaskEvent} from './store.mjs';
import {dependencyState} from './task-engine.mjs';

const arr=x=>Array.isArray(x)?x:[];

// The predicate itself lives in ./scope.mjs so the PLAN gate can share it
// without importing this module (which would close a cycle through
// task-engine.mjs). Re-exported here because this is where callers already
// import it from.
export {scopeOverlap,scopeConflicts} from './scope.mjs';
import {scopeConflicts} from './scope.mjs';

/** A task whose boundary must not interleave with anything else. */
export function mustSerialize(policy,task){
  const s=policy.serialize_on;
  const reasons=[];
  if(arr(s.categories).includes(task.category))reasons.push(`CATEGORY:${task.category}`);
  if(arr(s.risk?.security).includes(task.risk?.security))reasons.push(`SECURITY_RISK:${task.risk.security}`);
  if(arr(s.risk?.data).includes(task.risk?.data))reasons.push(`DATA_RISK:${task.risk.data}`);
  if(s.destructive_data_change&&task.risk?.destructive_data_change===true)reasons.push('DESTRUCTIVE_DATA_CHANGE');
  return reasons;
}

export function isWriter(task){return arr(task.scope?.write).length>0;}

/** Parallelism only pays above a wall-time threshold. */
export function benefitJustified(policy,tasks){
  if(tasks.every(t=>!isWriter(t)))return {justified:true,reason:'read-only'};
  const threshold=policy.benefit_threshold.min_estimated_seconds;
  const anyLong=tasks.some(t=>Number(t.execution?.estimated_seconds||0)>=threshold);
  return anyLong
    ?{justified:true,reason:`estimated_seconds>=${threshold}`}
    :{justified:false,reason:'coordination-cost-not-justified'};
}

/** Tasks dispatchable right now, ignoring conflicts and caps. */
export function readySet(projectRoot,runId,{outerStage=null,root=null}={}){
  const tasks=listTasks(projectRoot,runId);
  const policy=root?readJson(path.join(root,'policies','task-scheduling.json')):null;
  const legalCategories=policy&&outerStage?policy.stage_categories[outerStage]??null:null;
  const rows=[];
  for(const task of tasks){
    const dep=dependencyState(tasks,task);
    const reasons=[];
    if(task.status!=='READY')reasons.push(`STATUS:${task.status}`);
    if(!dep.satisfied)reasons.push(`DEPENDENCIES:${[...dep.pending,...dep.failed,...dep.missing].join(',')||'unsatisfied'}`);
    if(legalCategories&&!legalCategories.includes(task.category))reasons.push(`CATEGORY_NOT_LEGAL_IN_${outerStage}:${task.category}`);
    rows.push({task_id:task.task_id,status:task.status,category:task.category,writer:isWriter(task),
      estimated_seconds:Number(task.execution?.estimated_seconds||0),eligible:reasons.length===0,reasons});
  }
  return {
    schema:'agent-sdlc/task-ready-set/v1',
    run_id:runId,
    outer_stage:outerStage,
    ready:rows.filter(r=>r.eligible).map(r=>r.task_id).sort(),
    excluded:rows.filter(r=>!r.eligible),
    all:rows
  };
}

/**
 * Choose the dispatch set. Deterministic: eligible tasks are considered in
 * task_id order and admitted only when every parallel requirement holds.
 */
export function scheduleTasks(root,projectRoot,run,{outerStage=null,budget=null,maxParallelOverride=null}={}){
  const policy=readJson(path.join(root,'policies','task-scheduling.json'));
  const stagePolicy=readJson(path.join(root,'policies','stage-policy.json')).stages;
  const stage=outerStage||run.state;
  const tasks=listTasks(projectRoot,runId(run));
  const byId=new Map(tasks.map(t=>[t.task_id,t]));
  const rs=readySet(projectRoot,runId(run),{outerStage:stage,root});
  const eligible=rs.ready.map(id=>byId.get(id)).filter(Boolean);

  // --- caps ---------------------------------------------------------------
  const profile=run.profile||'STANDARD';
  const stageMax=stagePolicy[stage]?.budget?.max_parallel_agents??1;
  const writerCaps=[
    policy.writers.hard_default_max,
    policy.profile_max_writers[profile]??policy.writers.default_max_concurrent,
    stageMax,
    policy.writers.absolute_max
  ];
  if(maxParallelOverride)writerCaps.push(Number(maxParallelOverride));
  let maxWriters=Math.max(1,Math.min(...writerCaps));
  const maxReadOnly=Math.max(1,Math.min(policy.read_only.hard_default_max,Math.max(stageMax,policy.read_only.default_max_concurrent)));

  const notes=[];
  // --- budget -------------------------------------------------------------
  if(policy.budget.respect_stage_max_model_calls&&budget){
    const remaining=Number(budget.remaining_model_calls??Infinity);
    const perDispatch=policy.budget.min_remaining_model_calls_per_dispatch;
    if(Number.isFinite(remaining)){
      const affordable=Math.floor(remaining/perDispatch);
      if(affordable<=0){
        const decision={schema:'agent-sdlc/task-schedule-decision/v1',run_id:runId(run),outer_stage:stage,
          ready:rs.ready,selected:[],max_parallel:0,conflicts:[],reason:'budget-exhausted',
          notes:[`remaining_model_calls=${remaining}`],time:now()};
        return decision;
      }
      if(affordable<maxWriters){maxWriters=affordable;notes.push(`budget caps writers at ${affordable}`);}
    }
  }

  // --- admission ----------------------------------------------------------
  const selected=[];const conflicts=[];const deferred=[];
  let writers=0,readers=0;
  for(let idx=0;idx<eligible.length;idx++){
    const task=eligible[idx];
    const writer=isWriter(task);
    const serialReasons=mustSerialize(policy,task);
    if(serialReasons.length){
      // A serialized boundary runs alone: admit it only as the sole selection.
      if(selected.length){deferred.push({task_id:task.task_id,reason:`SERIALIZED_BOUNDARY:${serialReasons.join('|')}`});continue;}
      selected.push(task);
      notes.push(`${task.task_id} serialized: ${serialReasons.join('|')}`);
      // Nothing else may run alongside it. Record the rest explicitly rather
      // than breaking out silently: a dropped candidate the caller cannot see
      // reads as "there was nothing else to do".
      for(const rest of eligible.slice(idx+1))deferred.push({task_id:rest.task_id,reason:'HEAD_IS_SERIALIZED_BOUNDARY'});
      break;
    }
    if(selected.some(s=>mustSerialize(policy,s).length)){deferred.push({task_id:task.task_id,reason:'HEAD_IS_SERIALIZED_BOUNDARY'});continue;}
    if(writer&&!task.execution?.parallel_candidate&&selected.length){
      deferred.push({task_id:task.task_id,reason:'NOT_A_PARALLEL_CANDIDATE'});continue;
    }
    if(writer&&writers>=maxWriters){deferred.push({task_id:task.task_id,reason:`WRITER_CAP:${maxWriters}`});continue;}
    if(!writer&&readers>=maxReadOnly){deferred.push({task_id:task.task_id,reason:`READ_ONLY_CAP:${maxReadOnly}`});continue;}

    let conflicted=false;
    for(const chosen of selected){
      const w=scopeConflicts(task.scope?.write,chosen.scope?.write);
      const i=scopeConflicts(task.scope?.interfaces,chosen.scope?.interfaces);
      if(w.length){conflicts.push({kind:'WRITE_SCOPE',tasks:[chosen.task_id,task.task_id],overlaps:w});conflicted=true;}
      if(i.length){conflicts.push({kind:'INTERFACE_SCOPE',tasks:[chosen.task_id,task.task_id],overlaps:i});conflicted=true;}
    }
    if(conflicted){deferred.push({task_id:task.task_id,reason:'SCOPE_CONFLICT'});continue;}

    // Admitting a second writer must actually save wall-clock time.
    if(writer&&writers>=1){
      const b=benefitJustified(policy,[...selected,task]);
      if(!b.justified){deferred.push({task_id:task.task_id,reason:`NO_BENEFIT:${b.reason}`});continue;}
    }
    selected.push(task);
    if(writer)writers++;else readers++;
  }

  const reason=!selected.length
    ?(rs.ready.length?'all-ready-tasks-deferred':'no-ready-tasks')
    :(selected.length===1?'serial':'disjoint-and-worthwhile');

  const decision={
    schema:'agent-sdlc/task-schedule-decision/v1',
    run_id:runId(run),
    outer_stage:stage,
    profile,
    ready:rs.ready,
    selected:selected.map(t=>t.task_id),
    writers:selected.filter(isWriter).map(t=>t.task_id),
    read_only:selected.filter(t=>!isWriter(t)).map(t=>t.task_id),
    max_parallel:Math.max(1,maxWriters),
    max_read_only:maxReadOnly,
    conflicts,
    deferred,
    excluded:rs.excluded,
    reason,
    notes,
    time:now()
  };
  for(const task of selected){
    emitTaskEvent(projectRoot,task,{type:'task.dispatched',payload:{outer_stage:stage,selected_with:decision.selected,reason}});
  }
  return decision;
}

function runId(run){return typeof run==='string'?run:run.run_id;}

/** Convenience view: the persisted graph plus current status per node. */
export function scheduleView(projectRoot,runId){
  const graph=loadTaskGraph(projectRoot,runId);
  const tasks=listTasks(projectRoot,runId);
  const status=Object.fromEntries(tasks.map(t=>[t.task_id,t.status]));
  return {schema:'agent-sdlc/task-graph-view/v1',run_id:runId,graph,status,
    nodes:(graph?.nodes||[]).map(n=>({...n,status:status[n.task_id]??'MISSING'}))};
}
