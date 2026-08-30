import fs from 'node:fs';
import path from 'node:path';
import {stateDir,listTasks,loadTaskGraph,listTaskEvents} from './store.mjs';
import {reportUsage,reportRunTaskUsage} from './cost.mjs';

const div=(a,b)=>b?Number((a/b).toFixed(4)):null;

/**
 * Task-level telemetry for one run. The primary efficiency metric is cost per
 * verified DONE task; the rest explains it.
 */
export function taskMetrics(projectRoot,runId){
  const tasks=listTasks(projectRoot,runId);
  if(!tasks.length)return {schema:'agent-sdlc/task-metrics/v1',run_id:runId,tasks:0};
  const events=listTaskEvents(projectRoot,runId);
  const eventTypes={};
  for(const e of events)eventTypes[e.type]=(eventTypes[e.type]||0)+1;
  const byStatus={};
  for(const t of tasks)byStatus[t.status]=(byStatus[t.status]||0)+1;

  const attempted=tasks.filter(t=>(t.attempt||0)>0);
  const done=tasks.filter(t=>t.status==='DONE');
  const firstTry=done.filter(t=>(t.attempt||0)===1);
  const retried=attempted.filter(t=>(t.attempt||0)>1);
  const contextManifests=tasks.filter(t=>t.context_manifest_ref).length;
  const dispatchEvents=events.filter(e=>e.type==='task.dispatched');
  const parallelDispatches=dispatchEvents.filter(e=>(e.payload?.selected_with||[]).length>1).length;
  const reviewCatches=events.filter(e=>
    ['task.spec_reviewed','task.quality_reviewed'].includes(e.type)&&e.payload?.clean===false).length;
  const reviews=events.filter(e=>['task.spec_reviewed','task.quality_reviewed'].includes(e.type)).length;
  const cost=reportRunTaskUsage(projectRoot,runId,tasks);

  return {
    schema:'agent-sdlc/task-metrics/v1',
    run_id:runId,
    graph_present:!!loadTaskGraph(projectRoot,runId),
    tasks:tasks.length,
    by_status:byStatus,
    event_types:eventTypes,
    derived:{
      'success@1':div(firstTry.length,attempted.length),
      retry_rate:div(retried.length,attempted.length),
      context_manifest_coverage:div(contextManifests,tasks.length),
      average_attempts_per_task:div(tasks.reduce((a,t)=>a+(t.attempt||0),0),tasks.length),
      average_model_calls_per_task:cost.efficiency.average_model_calls_per_task,
      average_tool_calls_per_task:cost.efficiency.average_tool_calls_per_task,
      review_defect_catch_rate:div(reviewCatches,reviews),
      scheduler_parallel_efficiency:div(parallelDispatches,dispatchEvents.length),
      blocked:byStatus.BLOCKED||0,
      failed:byStatus.FAILED||0,
      invalidated:byStatus.INVALIDATED||0
    },
    cost_per_verified_done_task:cost.per_verified_done_task,
    verified_done_tasks:cost.verified_done_tasks
  };
}

export function metrics(projectRoot){
  const d=stateDir(projectRoot);
  const runsDir=path.join(d,'runs');
  const eventDir=path.join(d,'events');
  const runs=fs.existsSync(runsDir)
    ?fs.readdirSync(runsDir).filter(x=>x.endsWith('.json')).sort().map(x=>JSON.parse(fs.readFileSync(path.join(runsDir,x),'utf8')))
    :[];
  const states={};const workflows={};const eventTypes={};
  for(const r of runs){
    states[r.state]=(states[r.state]||0)+1;
    workflows[r.workflow]=(workflows[r.workflow]||0)+1;
    const p=path.join(eventDir,`${r.run_id}.jsonl`);
    if(fs.existsSync(p))for(const line of fs.readFileSync(p,'utf8').split('\n').filter(Boolean)){
      const e=JSON.parse(line);eventTypes[e.type]=(eventTypes[e.type]||0)+1;
    }
  }
  const token={input_tokens:0,cached_input_tokens:0,output_tokens:0,reasoning_tokens:0,wall_ms:0};
  for(const r of runs){
    const u=reportUsage(projectRoot,r.run_id).total;
    for(const k of Object.keys(token))token[k]+=u[k]||0;
  }
  const taskRuns=runs.map(r=>taskMetrics(projectRoot,r.run_id)).filter(m=>m.tasks>0);
  const taskTotals={total:0,done:0,blocked:0,failed:0};
  for(const m of taskRuns){
    taskTotals.total+=m.tasks;
    taskTotals.done+=m.by_status?.DONE||0;
    taskTotals.blocked+=m.by_status?.BLOCKED||0;
    taskTotals.failed+=m.by_status?.FAILED||0;
  }
  return {
    schema:'agent-sdlc/metrics/v1',
    runs:runs.length,states,workflows,event_types:eventTypes,usage:token,
    derived:{
      completed:runs.filter(r=>r.state==='CLOSE').length,
      blocked:runs.filter(r=>['BLOCKED','NEEDS_CONFIRMATION'].includes(r.state)).length
    },
    tasks:{runs_with_tasks:taskRuns.length,...taskTotals,per_run:taskRuns}
  };
}
