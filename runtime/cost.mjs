import path from 'node:path';
import fs from 'node:fs';
import {appendJsonl,now,readJson} from './util.mjs';
import {stateDir} from './store.mjs';

const FIELDS=['input_tokens','cached_input_tokens','output_tokens','reasoning_tokens','wall_ms'];
const COST_NOTE='Pricing is intentionally external; populate a current pricing registry before calculating billing estimates.';

export function addUsage(projectRoot,run,entry){
  const full={
    time:now(),run_id:run.run_id,stage:run.state,
    // alpha5: usage is attributable to one bounded task, not just one stage.
    task_id:entry.task_id??null,
    attempt:entry.attempt??null,
    provider:entry.provider||null,model:entry.model||null,
    input_tokens:Number(entry.input_tokens||0),
    cached_input_tokens:Number(entry.cached_input_tokens||0),
    output_tokens:Number(entry.output_tokens||0),
    reasoning_tokens:Number(entry.reasoning_tokens||0),
    wall_ms:Number(entry.wall_ms||0),
    model_calls:Number(entry.model_calls||0),
    tool_calls:Number(entry.tool_calls||0),
    retries:Number(entry.retries||0),
    provider_fallback:entry.provider_fallback===true,
    targeted_test_runs:Number(entry.targeted_test_runs||0),
    full_test_runs:Number(entry.full_test_runs||0),
    review_calls:Number(entry.review_calls||0),
    context_tokens:Number(entry.context_tokens||0),
    workspace_ms:Number(entry.workspace_ms||0),
    source:entry.source||'HOST_REPORTED_OR_USER_SUPPLIED'
  };
  appendJsonl(path.join(stateDir(projectRoot),'cost',`${run.run_id}.jsonl`),full);
  return full;
}

function rows(projectRoot,runId){
  const p=path.join(stateDir(projectRoot),'cost',`${runId}.jsonl`);
  return fs.existsSync(p)?fs.readFileSync(p,'utf8').split('\n').filter(Boolean).map(l=>JSON.parse(l)):[];
}
const sum=(list,fields)=>{
  const total=Object.fromEntries(fields.map(f=>[f,0]));
  for(const r of list)for(const f of fields)total[f]+=Number(r[f]||0);
  return total;
};

export function reportUsage(projectRoot,runId){
  const list=rows(projectRoot,runId);
  return {run_id:runId,entries:list.length,total:sum(list,FIELDS),cost_usd:null,cost_note:COST_NOTE};
}

const TASK_FIELDS=[...FIELDS,'model_calls','tool_calls','retries','targeted_test_runs','full_test_runs','review_calls','context_tokens','workspace_ms'];

/** Usage attributed to one task, across all of its attempts. */
export function reportTaskUsage(projectRoot,runId,taskId){
  const list=rows(projectRoot,runId).filter(r=>r.task_id===taskId);
  return {
    run_id:runId,task_id:taskId,entries:list.length,
    total:sum(list,TASK_FIELDS),
    provider_fallbacks:list.filter(r=>r.provider_fallback).length,
    cost_usd:null,cost_note:COST_NOTE
  };
}

/**
 * Per-task cost breakdown for one run, plus the primary efficiency metric:
 * cost per verified DONE task. Unattributed usage is reported separately rather
 * than silently folded into a task.
 */
export function reportRunTaskUsage(projectRoot,runId,tasks=[]){
  const list=rows(projectRoot,runId);
  const byTask={};
  for(const r of list){
    if(!r.task_id)continue;
    byTask[r.task_id]=byTask[r.task_id]||[];
    byTask[r.task_id].push(r);
  }
  const statusById=new Map(tasks.map(t=>[t.task_id,t.status]));
  const attemptById=new Map(tasks.map(t=>[t.task_id,t.attempt||0]));
  const perTask=Object.entries(byTask).sort(([a],[b])=>a.localeCompare(b)).map(([task_id,list])=>({
    task_id,
    status:statusById.get(task_id)??'UNKNOWN',
    attempts:attemptById.get(task_id)??null,
    entries:list.length,
    total:sum(list,TASK_FIELDS),
    provider_fallbacks:list.filter(r=>r.provider_fallback).length
  }));
  const doneTasks=perTask.filter(t=>t.status==='DONE');
  const doneTotal=sum(doneTasks.map(t=>t.total),TASK_FIELDS);
  const attempted=tasks.filter(t=>(t.attempt||0)>0);
  const firstTry=attempted.filter(t=>t.status==='DONE'&&(t.attempt||0)===1);
  const div=(a,b)=>b?Number((a/b).toFixed(4)):null;
  return {
    schema:'agent-sdlc/task-cost-report/v1',
    run_id:runId,
    tasks:perTask,
    unattributed:{entries:list.filter(r=>!r.task_id).length,total:sum(list.filter(r=>!r.task_id),TASK_FIELDS)},
    verified_done_tasks:doneTasks.length,
    per_verified_done_task:{
      output_tokens:div(doneTotal.output_tokens,doneTasks.length),
      input_tokens:div(doneTotal.input_tokens,doneTasks.length),
      model_calls:div(doneTotal.model_calls,doneTasks.length),
      tool_calls:div(doneTotal.tool_calls,doneTasks.length),
      wall_ms:div(doneTotal.wall_ms,doneTasks.length)
    },
    efficiency:{
      'success@1':div(firstTry.length,attempted.length),
      retry_rate:div(attempted.filter(t=>(t.attempt||0)>1).length,attempted.length),
      average_model_calls_per_task:div(sum(perTask.map(t=>t.total),TASK_FIELDS).model_calls,perTask.length),
      average_tool_calls_per_task:div(sum(perTask.map(t=>t.total),TASK_FIELDS).tool_calls,perTask.length)
    },
    cost_usd:null,
    cost_note:COST_NOTE
  };
}
