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
import {getProjectKnowledgeStatus} from './project-knowledge.mjs';

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
  },
  // The registry's `stages` filter already confines project-bootstrap to
  // INTAKE/REQUIREMENTS; this only needs to reproduce the other two clauses
  // of the old g0-bootstrap-project-knowledge conditional
  // (policies/skill-navigation.json, pre-Task-3): the new-feature workflow,
  // and project knowledge not yet READY. Same canonical-state rule as every
  // other handler here -- no keyword matching on the objective.
  new_feature_without_project_knowledge:(root,projectRoot,run)=>
    run.workflow==='new-feature'&&getProjectKnowledgeStatus(projectRoot).status!=='READY',
  // Reproduces the old overlay_skills.client-impact gate: frontend-integration
  // loaded only when the run carries the client-impact overlay, not on every
  // DESIGN/PLAN/IMPLEMENT/VERIFY run regardless of overlays.
  'overlay:client-impact':(root,projectRoot,run)=>Array.isArray(run.overlays)&&run.overlays.includes('client-impact')
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

// Procedure files carry an orchestrator-only preamble -- a `# Workflow
// Module: <id>` title, its blockquote banner, and often a `## Workflow
// preflight` section -- that assumes an orchestrator channel and `BLOCKED`
// semantics a standalone subprocess (a spawned task worker, or a task's
// compiled context with no orchestrator loop of its own) has neither.
// Strip it structurally, by heading shape, never by matching one file's own
// wording, so any procedure this is pointed at gets the same treatment.
// Shared by runtime/task-worker.mjs and runtime/task-context.mjs -- both
// inject procedure text into a prompt with no orchestrator channel behind
// it, so both must strip the same preamble the same way.
export function stripModulePreamble(text){
  const lines=text.split(/\r?\n/);
  const isBlank=l=>(l||'').trim()==='';
  let i=0;
  // Only ever strip when the preamble is positively identified (a
  // `# Workflow Module: <id>` title and/or its blockquote banner) -- a file
  // without that signature is returned untouched, real title included.
  let sawModuleBanner=false;
  if(/^#\s+Workflow Module:/.test(lines[i]||'')){i++;sawModuleBanner=true;}
  while(isBlank(lines[i]))i++;
  if(/^>/.test(lines[i]||'')){
    while(/^>/.test(lines[i]||''))i++;
    sawModuleBanner=true;
  }
  if(!sawModuleBanner)return text;
  while(isBlank(lines[i]))i++;
  if(/^#\s+/.test(lines[i]||'')&&!/^##/.test(lines[i]||''))i++;
  while(isBlank(lines[i]))i++;
  if(/^##\s+Workflow preflight/i.test(lines[i]||'')){
    // Only skip the section when a later heading actually bounds it -- a
    // handful of procedure files (e.g. frontend-integration.md) put the
    // module's entire body under this one heading with no subheading to
    // stop at, and running to end-of-file there would strip all real
    // guidance along with the boilerplate, emptying the module for that
    // task category. Leaving the section untouched in that case is the
    // safe fallback: keeping one boilerplate sentence beats losing the
    // module's content outright.
    let j=i+1;
    while(j<lines.length&&!/^#{1,2}\s+/.test(lines[j]))j++;
    if(j<lines.length)i=j;
  }
  return lines.slice(i).join('\n');
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

// D5 orphan check: every guidance file under harness/internal-skills/ must be
// reachable -- registered in this registry, or named by
// policies/skill-navigation.json. There is no third path and no legacy set,
// so this reads both sources itself rather than taking a caller-supplied id
// list. (Read policies/skill-navigation.json directly, not through
// runtime/skill-navigation.mjs's navigableSkillIds -- that module imports
// resolveProcedures from this one, so importing it back here would be
// circular.)
export function auditProcedureCoverage(root){
  const dir=path.join(root,'harness','internal-skills');
  const files=fs.readdirSync(dir).filter(f=>f.endsWith('.md')).map(f=>f.replace(/\.md$/,''));
  const registry=loadRegistry(root);
  const registered=new Set(Object.keys(registry));
  const policy=readJson(path.join(root,'policies','skill-navigation.json'));
  const navigable=new Set(Object.keys(policy.guidance||{}));
  const orphaned=files.filter(id=>!registered.has(id)&&!navigable.has(id));
  return {schema:'agent-sdlc/procedure-coverage-audit/v1',total:files.length,orphaned};
}
