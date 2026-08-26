// Procedure registry resolver: makes the detailed methodology files under
// harness/internal-skills/ conditionally reachable, instead of registered in
// config/skills.json and never selected by anything. Deliberately separate
// from the broad, always-on skill groups in runtime/context.mjs -- a group
// file stays a compact contract; a procedure supplies the deeper how-to only
// when the "when" condition actually fires for the run's current state.
import path from 'node:path';
import fs from 'node:fs';
import {readJson,readTextFile} from './util.mjs';
import {selectDesignDiscoveryMode} from './design-discovery.mjs';
import {taskProgress} from './task-engine.mjs';

// Every condition here resolves from canonical run/artifact state -- never
// from matching keywords in the free-text objective. Where the ideal signal
// does not exist yet as a first-class field (e.g. a declared build strategy
// for "tdd"), the nearest real proxy is used and called out below, rather
// than fabricating a keyword match or defaulting the procedure to "always".
const WHEN_HANDLERS={
  // Registered but intentionally excluded from automatic resolution: harness
  // self-maintenance is operator-invoked, not part of any run's own context.
  manual:()=>false,
  always:()=>true,
  'workflow:requirement-update':(root,projectRoot,run)=>run.workflow==='requirement-update',
  'workflow:technical-spike':(root,projectRoot,run)=>run.workflow==='technical-spike',
  'workflow:new-feature':(root,projectRoot,run)=>run.workflow==='new-feature',
  // No dedicated "investigating a defect" flag exists on Run yet; the workflow
  // chosen to start the run is the closest canonical proxy for "concrete
  // failure evidence" driving the work.
  bug_workflow:(root,projectRoot,run)=>['bug-fix','hotfix','incident-response'].includes(run.workflow),
  // No "build_strategy" field exists on Run yet; STRICT is the closest proxy
  // for "TDD selected" until that field exists.
  strict:(root,projectRoot,run)=>run.profile==='STRICT',
  // The same deterministic mode selection the real DESIGN gate uses --
  // selectDesignDiscoveryMode reads its own fixed policy path, independent of
  // the harness root passed here, so this never diverges from the gate.
  design_mode_not_skip:(root,projectRoot,run)=>selectDesignDiscoveryMode({profile:run.profile,objective:run.objective}).mode!=='SKIP',
  // A materialized task graph with more than one task is real evidence of
  // multiple workstreams; before materialization (early PLAN), STRICT stands
  // in for "explicit dependency graph need".
  plan_multi_workstream:(root,projectRoot,run)=>{
    if(run.profile==='STRICT')return true;
    try{return taskProgress(projectRoot,run.run_id).total>1;}catch{return false;}
  }
};

function loadRegistry(root){
  return readJson(path.join(root,'config','procedures.json')).procedures||{};
}

export function resolveProcedures(root,projectRoot,run){
  const registry=loadRegistry(root);
  const selected=[];
  for(const [id,spec] of Object.entries(registry)){
    if(!spec.stages?.includes(run.state))continue;
    const handler=WHEN_HANDLERS[spec.when];
    if(!handler)throw new Error(`procedure ${id} has unknown "when" condition ${spec.when}`);
    if(!handler(root,projectRoot,run))continue;
    let instructions='';
    try{instructions=readTextFile(path.join(root,spec.instructions)).trim();}catch{}
    selected.push({id,group:spec.group,when:spec.when,instructions});
  }
  return selected;
}

export function validateProcedureRegistry(root){
  const registry=loadRegistry(root);
  const problems=[];
  for(const [id,spec] of Object.entries(registry)){
    if(!spec.instructions||!fs.existsSync(path.join(root,spec.instructions)))problems.push(`${id}: missing instructions file ${spec.instructions}`);
    if(!WHEN_HANDLERS[spec.when])problems.push(`${id}: unknown when condition ${spec.when}`);
    if(!spec.stages?.length)problems.push(`${id}: no stages declared`);
  }
  return {valid:problems.length===0,problems};
}

// D5 orphan check: every procedure file under harness/internal-skills/ must be
// accounted for either by this registry or by the broad-skill resolver in
// runtime/context.mjs (legacyReachableSkillIds) -- never silently unreachable.
export function auditProcedureCoverage(root,legacyReachableIds){
  const dir=path.join(root,'harness','internal-skills');
  const files=fs.readdirSync(dir).filter(f=>f.endsWith('.md')).map(f=>f.replace(/\.md$/,''));
  const registry=loadRegistry(root);
  const registered=new Set(Object.keys(registry));
  const legacy=new Set(legacyReachableIds);
  const orphaned=files.filter(id=>!registered.has(id)&&!legacy.has(id));
  return {schema:'agent-sdlc/procedure-coverage-audit/v1',total:files.length,orphaned};
}
