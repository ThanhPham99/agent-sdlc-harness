import path from 'node:path';
import {now,readJson,uuid} from './util.mjs';
import {emit,saveRun} from './store.mjs';

const SIDE_STATES=['NEEDS_CONFIRMATION','BLOCKED','FAILED','DEFERRED','SUPERSEDED'];
const TERMINAL_STATES=['FAILED','DEFERRED','SUPERSEDED'];

export function newRun(root,projectRoot,{objective,route}){
  const workflows=readJson(path.join(root,'config','workflows.json')).workflows;
  const spec=workflows[route.workflow]; if(!spec)throw new Error(`unknown workflow ${route.workflow}`);
  const run={schema:'agent-sdlc/run/v1',run_id:uuid('run'),objective,workflow:route.workflow,profile:route.profile,overlays:route.overlays||[],state:spec.stages[0],stage_index:0,stages:spec.stages,created_at:now(),updated_at:now(),evidence:{},approvals:[],artifacts:[],provider_state:{},failure_counts:{},suspended_from:null};
  saveRun(projectRoot,run);emit(projectRoot,run,{type:'run.created',payload:{workflow:run.workflow,profile:run.profile}});return run;
}

export function transition(root,projectRoot,run,to,{evidence=[],approval=null,force=false}={}){
  if(TERMINAL_STATES.includes(run.state))throw new Error(`terminal state ${run.state}`);
  const stagePolicy=readJson(path.join(root,'policies','stage-policy.json')).stages;
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

export function nextState(run){
  if(['NEEDS_CONFIRMATION','BLOCKED'].includes(run.state))return run.suspended_from||null;
  const i=run.stages.indexOf(run.state);return i>=0&&i+1<run.stages.length?run.stages[i+1]:null;
}
