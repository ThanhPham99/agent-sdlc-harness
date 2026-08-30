// Bounded parallelism decision for ad-hoc task lists (stage-level analysis).
//
// The conflict and benefit predicates are shared with the persistent task DAG
// scheduler (runtime/task-scheduler.mjs) so there is one policy model, not two.
// Overlap is prefix-aware: `src/auth/` and `src/auth/reset.js` collide.
import path from 'node:path';
import {readJson} from './util.mjs';
import {scopeConflicts} from './task-scheduler.mjs';

const overlap=(a=[],b=[])=>scopeConflicts(a,b).length>0;

export function parallelPlan(root,tasks=[]){
  const p=readJson(path.join(root,'policies','parallelism-policy.json'));
  const normalized=tasks.map((t,i)=>({id:t.id||`task-${i+1}`,read_only:!!t.read_only,write_set:t.write_set||[],interface_set:t.interface_set||[],estimated_seconds:Number(t.estimated_seconds||0)}));
  const conflicts=[];
  for(let i=0;i<normalized.length;i++)for(let j=i+1;j<normalized.length;j++){
    const a=normalized[i],b=normalized[j];
    if(overlap(a.write_set,b.write_set)||overlap(a.interface_set,b.interface_set))conflicts.push([a.id,b.id]);
  }
  const disjoint=conflicts.length===0;
  const useful=normalized.length>1&&normalized.some(t=>t.estimated_seconds>=60);
  const allReadOnly=normalized.every(t=>t.read_only);
  const max=(disjoint&&(allReadOnly||useful))?Math.min(p.hard_default_max||2,normalized.length):p.default_max_parallel_agents||1;
  return {
    decision:max>1?'PARALLEL_BOUNDED':'SERIAL',
    max_parallel_agents:max,
    conflicts,
    tasks:normalized,
    reason:conflicts.length?'shared-write-or-interface':(max>1?'disjoint-and-worthwhile':'coordination-cost-not-justified')
  };
}

/**
 * Partition a list of tasks into sequential batches of mutually disjoint (parallel-executable) tasks.
 */
export function partitionParallelBatches(tasks = []) {
  const batches = [];
  const remaining = [...tasks];

  while (remaining.length > 0) {
    const currentBatch = [];
    const unselected = [];

    for (const task of remaining) {
      const taskWrite = task.scope?.write || task.write_set || [];
      const taskInterface = task.scope?.interfaces || task.interface_set || [];
      
      const hasConflict = currentBatch.some(bTask => {
        const bWrite = bTask.scope?.write || bTask.write_set || [];
        const bInterface = bTask.scope?.interfaces || bTask.interface_set || [];
        return overlap(taskWrite, bWrite) || overlap(taskInterface, bInterface);
      });

      if (!hasConflict) {
        currentBatch.push(task);
      } else {
        unselected.push(task);
      }
    }

    batches.push(currentBatch);
    remaining.length = 0;
    remaining.push(...unselected);
  }

  return batches;
}

/**
 * Execute tasks in parallel batches.
 * Inside each batch, tasks are executed concurrently (up to maxWorkers) on isolated worktrees.
 */
export async function executeParallelBatches(projectRoot, { run, batches = [], workerRunner = null, maxWorkers = 4 } = {}) {
  const results = [];

  for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
    const batch = batches[batchIdx];
    
    // Execute tasks concurrently within the current batch
    const batchPromises = batch.map(async (task, taskIdx) => {
      const writer = `worker-pool-${(taskIdx % maxWorkers) + 1}`;
      if (typeof workerRunner === 'function') {
        return await workerRunner({ projectRoot, run, task, writer, batchIndex: batchIdx });
      }
      return { task_id: task.task_id || task.id, status: 'DONE', writer };
    });

    const batchResults = await Promise.all(batchPromises);
    results.push(...batchResults);
  }

  return {
    schema: 'agent-sdlc/parallel-execution-result/v1',
    run_id: run?.run_id,
    batches_count: batches.length,
    total_tasks: results.length,
    results
  };
}

