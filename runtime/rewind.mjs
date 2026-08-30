// Time-Travel Rollback & Run Rewind Engine for Agent SDLC Harness.
import fs from 'node:fs';
import path from 'node:path';
import {saveRun,emit,saveTaskGraph,loadTaskGraph} from './store.mjs';
import {readJson,now} from './util.mjs';

/**
 * Rewind a run's state and task graph back to a specific target stage or task.
 */
export function rewindRun(root, projectRoot, run, { toStage, toTaskId=null, preserveEvidence=false } = {}) {
  const workflows = readJson(path.join(root, 'config', 'workflows.json')).workflows;
  const spec = workflows[run.workflow];
  if (!spec) throw new Error(`unknown workflow ${run.workflow}`);

  const targetStage = toStage ? toStage.toUpperCase() : null;
  if (targetStage && !spec.stages.includes(targetStage)) {
    throw new Error(`stage "${targetStage}" is not in workflow "${run.workflow}" (available: ${spec.stages.join(', ')})`);
  }

  const fromStage = run.state;
  const targetIndex = targetStage ? spec.stages.indexOf(targetStage) : 0;
  const currentIndex = spec.stages.indexOf(fromStage);

  if (targetStage && targetIndex > currentIndex) {
    throw new Error(`cannot rewind forward from ${fromStage} (index ${currentIndex}) to ${targetStage} (index ${targetIndex}); use transition instead`);
  }

  const finalStage = targetStage || fromStage;
  const prunedEvidence = {};

  if (!preserveEvidence) {
    for (let i = targetIndex + 1; i < spec.stages.length; i++) {
      const s = spec.stages[i];
      if (run.evidence && run.evidence[s]) {
        prunedEvidence[s] = run.evidence[s];
        delete run.evidence[s];
      }
    }
  }

  run.state = finalStage;
  run.stage_index = targetIndex;
  run.updated_at = now();

  let resetTasksCount = 0;
  const graph = loadTaskGraph(projectRoot, run.run_id);
  if (graph && Array.isArray(graph.tasks)) {
    for (const t of graph.tasks) {
      if (toTaskId && t.task_id === toTaskId) {
        t.status = 'READY';
        resetTasksCount++;
      } else if (targetIndex < currentIndex && t.status !== 'DONE') {
        t.status = 'PENDING';
        resetTasksCount++;
      }
    }
    saveTaskGraph(projectRoot, graph);
  }

  saveRun(projectRoot, run);

  emit(projectRoot, run, {
    type: 'run.rewound',
    payload: {
      from_stage: fromStage,
      to_stage: finalStage,
      to_task_id: toTaskId,
      pruned_stages: Object.keys(prunedEvidence),
      reset_tasks_count: resetTasksCount,
      revision: run.revision,
      time: now()
    }
  });

  return {
    status: 'REWOUND',
    run_id: run.run_id,
    from_stage: fromStage,
    to_stage: finalStage,
    to_task_id: toTaskId,
    pruned_evidence: prunedEvidence,
    reset_tasks_count: resetTasksCount,
    revision: run.revision
  };
}
