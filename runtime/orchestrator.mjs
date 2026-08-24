import path from 'node:path';
import {now,readJson,uuid} from './util.mjs';
import {emit,saveRun} from './store.mjs';
import {validateDesignDecision,evaluateDesignGate,getDesignDiscoveryPolicy} from './design-discovery.mjs';
import {validateTaskPlan,planGateEvidence} from './plan-validator.mjs';

const SIDE_STATES=['NEEDS_CONFIRMATION','BLOCKED','FAILED','DEFERRED','SUPERSEDED'];
const TERMINAL_STATES=['FAILED','DEFERRED','SUPERSEDED'];

const stagePolicyOf=(root)=>readJson(path.join(root,'policies','stage-policy.json'));

// Some gate evidence may not be asserted by a caller. `runtime` tokens exist
// only when a deterministic validator produced them; `human` tokens exist only
// alongside a recorded approval. `--force` remains the documented operator
// escape hatch and is audited as such.
function guardEvidenceAuthority(root,run,evidence,{approval=null,internal=false,force=false}={}){
  if(internal||force||!evidence.length)return;
  const authority=stagePolicyOf(root).evidence_authority||{};
  for(const token of evidence){
    const required=authority[token];
    if(required==='runtime')throw new Error(`evidence ${token} must be produced by the deterministic validator (use design record / plan record), not asserted`);
    if(required==='human'&&!approval)throw new Error(`evidence ${token} requires a recorded human approval`);
  }
}

function addEvidence(projectRoot,run,stage,tokens){
  run.evidence[stage]=[...new Set([...(run.evidence[stage]||[]),...tokens])];
  saveRun(projectRoot,run);
  return run.evidence[stage];
}

export function newRun(root,projectRoot,{objective,route}){
  const workflows=readJson(path.join(root,'config','workflows.json')).workflows;
  const spec=workflows[route.workflow]; if(!spec)throw new Error(`unknown workflow ${route.workflow}`);
  const run={schema:'agent-sdlc/run/v1',run_id:uuid('run'),objective,workflow:route.workflow,profile:route.profile,overlays:route.overlays||[],state:spec.stages[0],stage_index:0,stages:spec.stages,created_at:now(),updated_at:now(),evidence:{},approvals:[],artifacts:[],provider_state:{},failure_counts:{},suspended_from:null};
  saveRun(projectRoot,run);emit(projectRoot,run,{type:'run.created',payload:{workflow:run.workflow,profile:run.profile}});return run;
}

export function transition(root,projectRoot,run,to,{evidence=[],approval=null,force=false,internal=false}={}){
  if(TERMINAL_STATES.includes(run.state))throw new Error(`terminal state ${run.state}`);
  guardEvidenceAuthority(root,run,evidence,{approval,internal,force});
  const stagePolicy=stagePolicyOf(root).stages;
  const workflowOrder=run.stages;
  const from=run.state;

  // Resume from a non-terminal side state only to the stage that was suspended, unless explicitly forced.
  if(['NEEDS_CONFIRMATION','BLOCKED'].includes(run.state)&&!SIDE_STATES.includes(to)){
    if(!force&&to!==run.suspended_from)throw new Error(`resume must return to suspended stage ${run.suspended_from}`);
    const targetIdx=workflowOrder.indexOf(to);if(targetIdx<0)throw new Error(`state ${to} not in workflow ${run.workflow}`);
    run.state=to;run.stage_index=targetIdx;run.suspended_from=null;
    if(approval)run.approvals.push({stage:to,approval,time:now()});
    saveRun(projectRoot,run);emit(projectRoot,run,{type:'stage.resumed',payload:{from,to,force}});return run;
  }

  if(SIDE_STATES.includes(to)){
    if(!SIDE_STATES.includes(run.state))run.suspended_from=run.state;
    run.state=to;
    if(approval)run.approvals.push({stage:run.suspended_from||from,approval,time:now()});
    saveRun(projectRoot,run);emit(projectRoot,run,{type:'stage.suspended',payload:{from,to,suspended_from:run.suspended_from}});return run;
  }

  const currentIdx=workflowOrder.indexOf(run.state);const targetIdx=workflowOrder.indexOf(to);
  if(targetIdx<0)throw new Error(`state ${to} not in workflow ${run.workflow}`);
  if(!force&&targetIdx===currentIdx+1){
    const req=stagePolicy[run.state]?.gate_requirements||[];
    const have=new Set([...(run.evidence[run.state]||[]),...evidence]);
    const missing=req.filter(x=>!have.has(x));
    if(missing.length)throw new Error(`gate blocked at ${run.state}; missing evidence: ${missing.join(', ')}`);
  }else if(!force&&targetIdx>currentIdx+1)throw new Error('cannot skip multiple workflow stages without --force');
  else if(!force&&targetIdx<currentIdx){
    // Re-entry is allowed only when the canonical state machine explicitly declares the edge.
    const sm=readJson(path.join(root,'config','state-machine.json'));
    const allowed=sm.edges.some(e=>e.from===run.state&&e.to===to&&e.kind==='reentry');
    if(!allowed)throw new Error(`reentry ${run.state}->${to} is not allowed`);
  }

  if(evidence.length)run.evidence[run.state]=[...new Set([...(run.evidence[run.state]||[]),...evidence])];
  if(approval)run.approvals.push({stage:run.state,approval,time:now()});
  run.state=to;run.stage_index=targetIdx;run.suspended_from=null;
  saveRun(projectRoot,run);emit(projectRoot,run,{type:'stage.transition',payload:{from,to,evidence,force}});return run;
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

export function nextState(run){
  if(['NEEDS_CONFIRMATION','BLOCKED'].includes(run.state))return run.suspended_from||null;
  const i=run.stages.indexOf(run.state);return i>=0&&i+1<run.stages.length?run.stages[i+1]:null;
}
