import path from 'node:path';
import {now,readJson,uuid} from './util.mjs';
import {emit,saveRun,loadTaskGraph,listTasks} from './store.mjs';
import {validateDesignDecision,evaluateDesignGate,getDesignDiscoveryPolicy} from './design-discovery.mjs';
import {validateTaskPlan,planGateEvidence} from './plan-validator.mjs';
import {materializeTaskGraph,taskProgress} from './task-engine.mjs';
import {findValidApproval} from './approvals.mjs';
import {evaluateGate} from './gates.mjs';
import {attachRun} from './features.mjs';

const arr=x=>Array.isArray(x)?x:[];

const SIDE_STATES=['NEEDS_CONFIRMATION','BLOCKED','FAILED','DEFERRED','SUPERSEDED'];
const TERMINAL_STATES=['FAILED','DEFERRED','SUPERSEDED'];

const stagePolicyOf=(root)=>readJson(path.join(root,'policies','stage-policy.json'));

// Some gate evidence may not be asserted by a caller. `runtime` tokens exist
// only when a deterministic validator produced them; `human` tokens exist only
// when a trusted approval record for that exact token has been recorded
// through the approvals subsystem, not merely because some string was present
// on this call. `internal` is not reachable from CLI/MCP; it exists only for
// the orchestrator's own gate-recording functions and test fixtures that seed
// pre-vetted evidence directly.
function guardEvidenceAuthority(root,run,evidence,{internal=false}={}){
  if(internal||!evidence.length)return;
  const authority=stagePolicyOf(root).evidence_authority||{};
  for(const token of evidence){
    const required=authority[token];
    if(required==='runtime')throw new Error(`evidence ${token} must be produced by the deterministic validator (use design record / plan record), not asserted`);
    if(required==='human'&&!findValidApproval(run,token))throw new Error(`evidence ${token} requires a recorded human approval`);
  }
}

function addEvidence(projectRoot,run,stage,tokens){
  run.evidence[stage]=[...new Set([...(run.evidence[stage]||[]),...tokens])];
  saveRun(projectRoot,run);
  return run.evidence[stage];
}

export function newRun(root,projectRoot,{objective,route,featureId=null,phaseId=null,parentRunId=null,runKind=null}){
  const workflows=readJson(path.join(root,'config','workflows.json')).workflows;
  const spec=workflows[route.workflow]; if(!spec)throw new Error(`unknown workflow ${route.workflow}`);
  const run={schema:'agent-sdlc/run/v1',run_id:uuid('run'),objective,workflow:route.workflow,profile:route.profile,overlays:route.overlays||[],state:spec.stages[0],stage_index:0,stages:spec.stages,created_at:now(),updated_at:now(),revision:0,evidence:{},approvals:[],artifacts:[],provider_state:{},failure_counts:{},suspended_from:null,
    feature_id:featureId,phase_id:phaseId,parent_run_id:parentRunId,run_kind:runKind};
  saveRun(projectRoot,run);emit(projectRoot,run,{type:'run.created',payload:{workflow:run.workflow,profile:run.profile}});
  // Mechanical binding only -- which feature/phase a run belongs to is a
  // policy decision made by the caller (see resolveFeatureBinding in
  // features.mjs), not guessed here.
  if(featureId&&phaseId)attachRun(projectRoot,{featureId,phaseId,runId:run.run_id});
  return run;
}

export function transition(root,projectRoot,run,to,{evidence=[],internal=false}={}){
  if(TERMINAL_STATES.includes(run.state))throw new Error(`terminal state ${run.state}`);
  guardEvidenceAuthority(root,run,evidence,{internal});
  const workflowOrder=run.stages;
  const from=run.state;

  // Resume from a non-terminal side state only to the stage that was suspended.
  // There is no generic override: a resume that wants to land somewhere else is
  // a new, explicit transition, not this one relabelled.
  if(['NEEDS_CONFIRMATION','BLOCKED'].includes(run.state)&&!SIDE_STATES.includes(to)){
    if(to!==run.suspended_from)throw new Error(`resume must return to suspended stage ${run.suspended_from}`);
    const targetIdx=workflowOrder.indexOf(to);if(targetIdx<0)throw new Error(`state ${to} not in workflow ${run.workflow}`);
    run.state=to;run.stage_index=targetIdx;run.suspended_from=null;
    saveRun(projectRoot,run);emit(projectRoot,run,{type:'stage.resumed',payload:{from,to}});return run;
  }

  if(SIDE_STATES.includes(to)){
    if(!SIDE_STATES.includes(run.state))run.suspended_from=run.state;
    run.state=to;
    saveRun(projectRoot,run);emit(projectRoot,run,{type:'stage.suspended',payload:{from,to,suspended_from:run.suspended_from}});return run;
  }

  const currentIdx=workflowOrder.indexOf(run.state);const targetIdx=workflowOrder.indexOf(to);
  if(targetIdx<0)throw new Error(`state ${to} not in workflow ${run.workflow}`);
  if(targetIdx===currentIdx+1){
    const have=[...(run.evidence[run.state]||[]),...evidence];
    const gate=evaluateGate(root,projectRoot,run,run.state,have);
    if(gate.decision!=='PASS'){
      const parts=[];
      if(gate.missing.length)parts.push(`missing evidence: ${gate.missing.join(', ')}`);
      if(gate.stale.length)parts.push(`stale evidence (workspace changed since it was recorded): ${gate.stale.join(', ')}`);
      throw new Error(`gate blocked at ${run.state}; ${parts.join('; ')}`);
    }
  }else if(targetIdx>currentIdx+1)throw new Error('cannot skip multiple workflow stages');
  else if(targetIdx<currentIdx){
    // Re-entry is allowed only when the canonical state machine explicitly declares the edge.
    const sm=readJson(path.join(root,'config','state-machine.json'));
    const allowed=sm.edges.some(e=>e.from===run.state&&e.to===to&&e.kind==='reentry');
    if(!allowed)throw new Error(`reentry ${run.state}->${to} is not allowed`);
  }

  if(evidence.length)run.evidence[run.state]=[...new Set([...(run.evidence[run.state]||[]),...evidence])];
  run.state=to;run.stage_index=targetIdx;run.suspended_from=null;
  saveRun(projectRoot,run);emit(projectRoot,run,{type:'stage.transition',payload:{from,to,evidence}});return run;
}

/**
 * DESIGN gate: validate a structured design decision and, only on success,
 * record the gate evidence the stage policy demands. A HUMAN-required decision
 * without recorded approval cannot produce evidence here.
 */
export function recordDesignDecision(root,projectRoot,run,decision,{artifactRef=null,approvals=null}={}){
  if(run.state!=='DESIGN')throw new Error(`design decisions are recorded in DESIGN, not ${run.state}`);
  const validation=validateDesignDecision(decision);
  const humanApprovalRequired=decision?.approval?.required===true;
  const gate=evaluateDesignGate({
    mode:decision?.mode??null,
    evidence:validation.gate_evidence,
    humanApprovalRequired,
    approvals:approvals??(run.approvals||[]).map(a=>a.approval)
  });
  const derived=getDesignDiscoveryPolicy().gate.derived_evidence;
  if(!validation.valid||!gate.valid){
    emit(projectRoot,run,{type:'design.decision_rejected',payload:{errors:validation.errors,missing:gate.missing}});
    return {schema:'agent-sdlc/design-gate-record/v1',recorded:false,validation,gate,evidence:[]};
  }
  const evidence=[...validation.gate_evidence,derived];
  addEvidence(projectRoot,run,'DESIGN',evidence);
  emit(projectRoot,run,{
    type:'design.decision_recorded',
    artifact_refs:artifactRef?[artifactRef]:[],
    payload:{decision_id:decision.decision_id,mode:decision.mode,evidence}
  });
  return {schema:'agent-sdlc/design-gate-record/v1',recorded:true,validation,gate,evidence};
}

/**
 * PLAN gate: validate a structured TaskPlan and, only on success, record the
 * plan gate evidence. An invalid graph or uncovered acceptance criterion means
 * PLAN -> IMPLEMENT stays closed.
 */
export function recordTaskPlan(root,projectRoot,run,plan,{artifactRef=null,thresholds=null}={}){
  if(run.state!=='PLAN')throw new Error(`task plans are recorded in PLAN, not ${run.state}`);
  const validation=validateTaskPlan(plan,{profile:plan?.profile||run.profile,...(thresholds?{thresholds}:{})});
  if(!validation.valid){
    emit(projectRoot,run,{type:'plan.rejected',payload:{plan_id:plan?.plan_id??null,errors:validation.errors}});
    return {schema:'agent-sdlc/plan-gate-record/v1',recorded:false,validation,evidence:[]};
  }
  const evidence=planGateEvidence();
  addEvidence(projectRoot,run,'PLAN',evidence);
  emit(projectRoot,run,{
    type:'plan.validated',
    artifact_refs:artifactRef?[artifactRef]:[],
    payload:{plan_id:plan.plan_id,task_count:validation.task_count,edge_count:validation.edge_count,evidence}
  });
  return {schema:'agent-sdlc/plan-gate-record/v1',recorded:true,validation,evidence};
}

/**
 * PLAN -> IMPLEMENT handoff: turn the validated plan into a durable task graph.
 * Refuses outside PLAN/IMPLEMENT so a task runtime cannot appear from nowhere.
 */
export function materializeRunTasks(root,projectRoot,run,plan,{planArtifactRef=null,sourceRevision=null}={}){
  if(!['PLAN','IMPLEMENT'].includes(run.state)){
    throw new Error(`task graphs are materialized in PLAN or IMPLEMENT, not ${run.state}`);
  }
  const out=materializeTaskGraph(root,projectRoot,run,plan,{planArtifactRef,sourceRevision});
  emit(projectRoot,run,{
    type:out.materialized?'tasks.materialized':'tasks.materialization_rejected',
    artifact_refs:planArtifactRef?[planArtifactRef]:[],
    payload:out.materialized
      ?{plan_id:plan.plan_id,created:out.created,preserved:out.preserved,node_count:out.graph.nodes.length}
      :{plan_id:plan?.plan_id??null,errors:out.validation.errors}
  });
  return out;
}

/**
 * IMPLEMENT gate: `implementation_artifact` is derived from the task graph, not
 * asserted. Every non-superseded task must be DONE, and integration-category
 * obligations must be among them.
 */
export function recordImplementationComplete(root,projectRoot,run,{artifactRef=null}={}){
  if(run.state!=='IMPLEMENT')throw new Error(`implementation completion is recorded in IMPLEMENT, not ${run.state}`);
  const progress=taskProgress(projectRoot,run.run_id);
  const graph=loadTaskGraph(projectRoot,run.run_id);
  const problems=[];
  if(!progress.graph_present)problems.push('NO_TASK_GRAPH');
  if(!progress.total)problems.push('NO_TASKS');
  if(!progress.complete)problems.push(`TASKS_NOT_DONE:${progress.open.map(t=>`${t.task_id}(${t.status})`).join(',')}`);
  const integration=new Set(arr(graph?.integration_tasks));
  if(integration.size){
    const tasks=listTasks(projectRoot,run.run_id);
    const unfinished=tasks.filter(t=>integration.has(t.task_id)&&t.status!=='DONE').map(t=>t.task_id);
    if(unfinished.length)problems.push(`INTEGRATION_TASKS_NOT_DONE:${unfinished.join(',')}`);
  }
  if(problems.length){
    emit(projectRoot,run,{type:'implementation.incomplete',payload:{problems,progress:progress.by_status}});
    return {schema:'agent-sdlc/implementation-gate-record/v1',recorded:false,problems,progress,evidence:[]};
  }
  const evidence=['implementation_artifact','task_graph_complete'];
  addEvidence(projectRoot,run,'IMPLEMENT',evidence);
  emit(projectRoot,run,{
    type:'implementation.complete',
    artifact_refs:artifactRef?[artifactRef]:[],
    payload:{tasks:progress.total,done:progress.done_count,evidence}
  });
  return {schema:'agent-sdlc/implementation-gate-record/v1',recorded:true,problems:[],progress,evidence};
}

export function nextState(run){
  if(['NEEDS_CONFIRMATION','BLOCKED'].includes(run.state))return run.suspended_from||null;
  const i=run.stages.indexOf(run.state);return i>=0&&i+1<run.stages.length?run.stages[i+1]:null;
}
