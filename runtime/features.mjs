// Feature/Phase identity: the project -> features -> phases model as
// first-class runtime state, not a naming convention.
//
// Before this module, "a feature" existed only as an objective string typed
// into one run. `continue-feature` and `requirement-update` were workflow
// names with no actual feature to continue or update -- each run started
// from INTAKE exactly like a brand-new one, with no way to say "this is the
// third run against the same durable piece of work" or to keep phase-1
// history visible once phase-2 starts. This module makes that identity real:
// a feature can span multiple runs and multiple phases, phase history is
// never overwritten (only superseded, status changed), and run completion
// (`run.state==='CLOSE'`) is never equated with feature completion -- a run
// can close out one phase while the feature still carries deferred work.
import fs from 'node:fs';
import path from 'node:path';
import {now,readJson,writeJson,uuid} from './util.mjs';
import {stateDir} from './store.mjs';

const featuresDir=projectRoot=>path.join(stateDir(projectRoot),'features');
const featurePath=(projectRoot,featureId)=>path.join(featuresDir(projectRoot),`${featureId}.json`);
const phasesDir=(projectRoot,featureId)=>path.join(featuresDir(projectRoot),featureId,'phases');
const phasePath=(projectRoot,featureId,phaseId)=>path.join(phasesDir(projectRoot,featureId),`${phaseId}.json`);

export const FEATURE_STATUSES=['ACTIVE','NEEDS_CONFIRMATION','BLOCKED','DEFERRED','COMPLETE','SUPERSEDED'];
export const PHASE_STATUSES=['PLANNED','ACTIVE','NEEDS_CONFIRMATION','BLOCKED','COMPLETE','DEFERRED','SUPERSEDED'];
const OPEN_PHASE_STATUSES=['PLANNED','ACTIVE','NEEDS_CONFIRMATION','BLOCKED'];

export function createFeature(projectRoot,{title,workflowFamily='new-feature',sourceRefs=[]}={}){
  if(!title)throw new Error('feature title is required');
  const feature_id=uuid('feature');
  const feature={schema:'agent-sdlc/feature/v1',feature_id,title,status:'ACTIVE',current_phase_id:null,
    workflow_family:workflowFamily,created_at:now(),updated_at:now(),source_refs:sourceRefs,artifact_refs:[],
    open_questions:[],deferred_items:[],resume:null};
  writeJson(featurePath(projectRoot,feature_id),feature);
  return feature;
}

export function loadFeature(projectRoot,featureId){
  if(!featureId)throw new Error('featureId is required');
  return readJson(featurePath(projectRoot,featureId)); // throws if unknown
}

export function updateFeature(projectRoot,featureId,patch){
  if(patch.status&&!FEATURE_STATUSES.includes(patch.status))throw new Error(`unknown feature status ${patch.status}`);
  const feature=loadFeature(projectRoot,featureId);
  const next={...feature,...patch,feature_id:featureId,updated_at:now()};
  writeJson(featurePath(projectRoot,featureId),next);
  return next;
}

export function listFeatures(projectRoot){
  const dir=featuresDir(projectRoot);
  if(!fs.existsSync(dir))return [];
  return fs.readdirSync(dir).filter(f=>f.endsWith('.json')).map(f=>readJson(path.join(dir,f)));
}

export function createPhase(projectRoot,featureId,{name=null,objective=null,sourceRefs=[],supersedesPhaseId=null}={}){
  const feature=loadFeature(projectRoot,featureId); // throws if the feature does not exist
  const phase_id=uuid('phase');
  const phase={schema:'agent-sdlc/phase/v1',phase_id,feature_id:featureId,name:name||phase_id,
    status:'ACTIVE',objective:objective||feature.title,source_refs:sourceRefs,accepted_requirements:[],
    artifact_refs:[],run_ids:[],started_at:now(),completed_at:null,
    supersedes_phase_id:supersedesPhaseId,resume_from:null};
  writeJson(phasePath(projectRoot,featureId,phase_id),phase);
  updateFeature(projectRoot,featureId,{current_phase_id:phase_id});
  return phase;
}

export function loadPhase(projectRoot,featureId,phaseId){
  if(!phaseId)throw new Error('phaseId is required');
  return readJson(phasePath(projectRoot,featureId,phaseId)); // throws if unknown
}

export function updatePhase(projectRoot,featureId,phaseId,patch){
  if(patch.status&&!PHASE_STATUSES.includes(patch.status))throw new Error(`unknown phase status ${patch.status}`);
  const phase=loadPhase(projectRoot,featureId,phaseId);
  const next={...phase,...patch,phase_id:phaseId,feature_id:featureId};
  writeJson(phasePath(projectRoot,featureId,phaseId),next);
  return next;
}

export function listPhases(projectRoot,featureId){
  const dir=phasesDir(projectRoot,featureId);
  if(!fs.existsSync(dir))return [];
  return fs.readdirSync(dir).filter(f=>f.endsWith('.json')).map(f=>readJson(path.join(dir,f)));
}

export function attachRun(projectRoot,{featureId,phaseId,runId}){
  if(!featureId||!phaseId||!runId)throw new Error('featureId, phaseId and runId are all required');
  const phase=loadPhase(projectRoot,featureId,phaseId);
  return updatePhase(projectRoot,featureId,phaseId,{run_ids:[...new Set([...(phase.run_ids||[]),runId])]});
}

/**
 * No silent guessing: an explicit featureId always wins (and must exist).
 * With none given, exactly one ACTIVE feature resolves unambiguously; zero
 * is a legitimate "nothing active yet" answer; more than one is reported as
 * ambiguous rather than picked for the caller.
 */
export function resolveActiveFeature(projectRoot,{featureId=null}={}){
  if(featureId)return loadFeature(projectRoot,featureId);
  const active=listFeatures(projectRoot).filter(f=>f.status==='ACTIVE');
  if(active.length===0)return null;
  if(active.length===1)return active[0];
  return {ambiguous:true,candidates:active.map(f=>({feature_id:f.feature_id,title:f.title}))};
}

export function resolveActivePhase(projectRoot,featureId,{phaseId=null}={}){
  if(phaseId)return loadPhase(projectRoot,featureId,phaseId);
  const feature=loadFeature(projectRoot,featureId);
  return feature.current_phase_id?loadPhase(projectRoot,featureId,feature.current_phase_id):null;
}

function reuseOrCreatePhase(projectRoot,featureId,feature,phaseId,fallbackName){
  const existing=phaseId?loadPhase(projectRoot,featureId,phaseId):
    (feature.current_phase_id?loadPhase(projectRoot,featureId,feature.current_phase_id):null);
  if(existing&&OPEN_PHASE_STATUSES.includes(existing.status))return {phase:existing,created:false};
  return {phase:createPhase(projectRoot,featureId,{name:fallbackName,objective:feature.title,
    supersedesPhaseId:existing?existing.phase_id:null}),created:true};
}

// B3: deterministic feature/phase binding per workflow family. continue-feature
// and requirement-update require an existing feature and refuse to invent one;
// new-feature creates one unless explicitly attached; every other workflow
// attaches only when the caller already identified a feature, and otherwise
// stays fully standalone -- the pre-existing, unchanged default behavior.
const REQUIRES_EXISTING_FEATURE=new Set(['continue-feature','requirement-update']);

export function resolveFeatureBinding(projectRoot,{workflow,featureId=null,phaseId=null,title=null}={}){
  if(REQUIRES_EXISTING_FEATURE.has(workflow)){
    if(!featureId)throw new Error(`${workflow} requires --feature-id (an existing feature); it is never created silently`);
    const feature=loadFeature(projectRoot,featureId);
    const {phase,created}=reuseOrCreatePhase(projectRoot,featureId,feature,phaseId,`continuation of ${feature.title}`);
    return {featureId,phaseId:phase.phase_id,created:{feature:false,phase:created}};
  }
  if(workflow==='new-feature'){
    if(featureId){
      const feature=loadFeature(projectRoot,featureId);
      const {phase,created}=reuseOrCreatePhase(projectRoot,featureId,feature,phaseId,title||feature.title);
      return {featureId,phaseId:phase.phase_id,created:{feature:false,phase:created}};
    }
    const feature=createFeature(projectRoot,{title:title||'untitled feature',workflowFamily:workflow});
    const phase=createPhase(projectRoot,feature.feature_id,{name:'initial',objective:feature.title});
    return {featureId:feature.feature_id,phaseId:phase.phase_id,created:{feature:true,phase:true}};
  }
  if(featureId){
    const feature=loadFeature(projectRoot,featureId);
    const {phase,created}=reuseOrCreatePhase(projectRoot,featureId,feature,phaseId,'maintenance');
    return {featureId,phaseId:phase.phase_id,created:{feature:false,phase:created}};
  }
  return {featureId:null,phaseId:null,created:{feature:false,phase:false}};
}
