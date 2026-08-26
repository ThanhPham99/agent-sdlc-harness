// Requirement update / selective invalidation, wired to a real prior run.
//
// runtime/traceability.mjs already computes a deterministic invalidation
// closure and applies it (marking affected nodes invalid, preserving graph
// history) -- but nothing ever called it across two different runs. A
// `requirement-update` run walked the full state machine from INTAKE exactly
// like a brand-new feature, indistinguishable from "we know nothing changed
// but the interface", giving zero signal about what was actually settled and
// what the new information actually touches.
//
// This module closes that specific gap: link a new run to the prior run its
// update targets, compute the closure against the PRIOR run's own graph, and
// carry forward the artifacts the closure proves are still valid.
//
// What this deliberately does NOT do: skip the new run's own state-machine
// gates. Feature/Phase identity -- a durable link that would let one run's
// evidence stand in for another's -- does not exist in this codebase yet.
// Attempting to fabricate "skip DESIGN, it's still valid" without that
// identity model and without adversarial testing of the provenance chain
// would recreate exactly the kind of evidence-bypass this codebase spent
// several rounds closing. What exists here is honest signal -- what changed,
// what's preserved, the earliest stage the delta actually reaches -- so the
// model does not blindly redo settled work, while every gate the new run
// passes through still requires its own real evidence.
import fs from 'node:fs';
import path from 'node:path';
import {now,readJson,writeJson} from './util.mjs';
import {loadRun,saveRun,emit,stateDir} from './store.mjs';
import {loadTraceabilityGraph,computeInvalidationClosure,applyInvalidation} from './traceability.mjs';

const planPath=(projectRoot,runId)=>path.join(stateDir(projectRoot),'requirement-update',`${runId}.json`);

function preservedArtifactRefs(graph,closure){
  const preservedIds=new Set(closure.preserved.map(n=>n.id));
  return [...new Set(graph.nodes.filter(n=>preservedIds.has(n.id)&&n.ref).map(n=>n.ref))];
}

export function planRequirementUpdate(projectRoot,newRun,{continuesRunId,nodeId,deltaClass,reason='requirement update',dryRun=false}={}){
  if(!continuesRunId)throw new Error('--continues (the prior run this update targets) is required');
  if(!nodeId)throw new Error('--node (the changed node, e.g. ACCEPTANCE_CRITERION:AC-001) is required');
  loadRun(projectRoot,continuesRunId); // throws a clear error if the prior run does not exist
  const graph=loadTraceabilityGraph(projectRoot,continuesRunId);
  if(!graph)throw new Error(`no traceability graph for ${continuesRunId}; run \`trace build --run-id ${continuesRunId}\` first`);
  const closure=computeInvalidationClosure(graph,nodeId,deltaClass);
  const refs=preservedArtifactRefs(graph,closure);

  if(dryRun){
    return {schema:'agent-sdlc/requirement-update-plan/v1',run_id:newRun.run_id,continues_run_id:continuesRunId,
      changed:closure.changed,changed_exists:closure.changed_exists,delta_class:closure.delta_class,
      affected_count:closure.affected_count,preserved_count:closure.preserved_count,
      earliest_outer_gate:closure.earliest_outer_gate,preserved_artifact_refs:refs,dry_run:true};
  }

  const invalidation=applyInvalidation(projectRoot,graph,closure,{reason});
  const plan={schema:'agent-sdlc/requirement-update-plan/v1',run_id:newRun.run_id,continues_run_id:continuesRunId,
    changed:closure.changed,changed_exists:closure.changed_exists,delta_class:closure.delta_class,
    affected_count:closure.affected_count,preserved_count:closure.preserved_count,
    earliest_outer_gate:closure.earliest_outer_gate,preserved_artifact_refs:refs,
    invalidation_time:invalidation.time,created_at:now(),dry_run:false};
  writeJson(planPath(projectRoot,newRun.run_id),plan);

  if(refs.length){
    newRun.artifacts=[...new Set([...(newRun.artifacts||[]),...refs])];
    saveRun(projectRoot,newRun);
  }
  emit(projectRoot,newRun,{type:'requirement_update.planned',artifact_refs:refs,
    payload:{continues_run_id:continuesRunId,delta_class:deltaClass,earliest_outer_gate:closure.earliest_outer_gate,
      affected_count:closure.affected_count,preserved_count:closure.preserved_count}});
  return plan;
}

export function loadRequirementUpdatePlan(projectRoot,runId){
  const p=planPath(projectRoot,runId);
  return fs.existsSync(p)?readJson(p):null;
}
