// Declarative replacement for the three navigation maps that used to be
// hardcoded in runtime/context.mjs (CORE_SKILL_BY_STAGE, WORKFLOW_SKILLS,
// OVERLAY_SKILLS) plus the three conditional rules inlined in resolveSkills.
//
// Navigation is policy, not code: an agent asks which skill its state names
// and activates that, instead of a module deciding for it. A `retired` id is
// one whose file no longer exists; its one-line guidance still reaches the
// agent through the compiled context, so removing a stub file never removes
// what it said.
import path from 'node:path';
import {readJson} from './util.mjs';
import {getProjectKnowledgeStatus} from './project-knowledge.mjs';
import {resolveProcedures} from './procedures.mjs';

const arr=x=>Array.isArray(x)?x:[];

export function loadNavigationPolicy(root){
  return readJson(path.join(root,'policies','skill-navigation.json'));
}

// Each condition resolves from canonical run state, never from keywords in the
// objective -- the same rule the procedure registry follows.
const CONDITIONALS={
  'stage_in':(spec,{run})=>spec.split(',').includes(run.state),
  'strict_and_stage_in':(spec,{run})=>run.profile==='STRICT'&&spec.split(',').includes(run.state),
  'new_feature_without_project_knowledge':(spec,{run,projectRoot})=>{
    if(run.workflow!=='new-feature')return false;
    if(!['INTAKE','REQUIREMENTS'].includes(run.state))return false;
    return getProjectKnowledgeStatus(projectRoot).status!=='READY';
  }
};

function conditionHolds(when,ctx){
  const i=String(when).indexOf(':');
  const name=i===-1?String(when):String(when).slice(0,i);
  const spec=i===-1?'':String(when).slice(i+1);
  const handler=CONDITIONALS[name];
  if(!handler)throw new Error(`skill-navigation: unknown conditional "${when}"`);
  return handler(spec,ctx);
}

/**
 * @returns {{stage:string,stage_skill:string|null,core_skill_ids:string[],
 *            guidance:Array<{id:string,text:string}>}}
 */
export function resolveNavigation(root,projectRoot,run){
  const policy=loadNavigationPolicy(root);
  const stageEntry=policy.stages?.[run.state]||{};
  const live=[]; const retired=[];
  const take=(entry,liveKey,retiredKey)=>{
    for(const id of arr(entry?.[liveKey]))if(!live.includes(id))live.push(id);
    for(const id of arr(entry?.[retiredKey]))if(!retired.includes(id))retired.push(id);
  };

  take(stageEntry,'core','retired_core');
  take(policy.workflow_skills?.[run.workflow],'skills','retired');
  for(const overlay of arr(run.overlays))take(policy.overlay_skills?.[overlay],'skills','retired');
  for(const rule of arr(policy.conditional)){
    if(!conditionHolds(rule.when,{run,projectRoot}))continue;
    for(const id of arr(rule.add)){
      if(arr(policy.retired_ids).includes(id)){if(!retired.includes(id))retired.push(id);}
      else if(!live.includes(id))live.push(id);
    }
  }

  return {
    stage:run.state,
    stage_skill:stageEntry.stage_skill||null,
    core_skill_ids:live,
    guidance:retired
      .filter(id=>policy.guidance?.[id])
      .map(id=>({id,text:policy.guidance[id]}))
  };
}

/**
 * The compact `navigation` block both the CLI `status` command and the MCP
 * `agent_sdlc_status` tool report -- {stage, stage_skill, procedure_skills,
 * fallback_instructions_inlined}. Defined once here so the two surfaces can
 * never hand-drift apart on the same run. `procedure_skills` comes from
 * resolveProcedures (the ids that survive each entry's `when` condition for
 * this run), not from the navigation policy -- the same set `context`
 * compiles.
 */
export function resolveNavigationSummary(root,projectRoot,run){
  const nav=resolveNavigation(root,projectRoot,run);
  return {
    stage:nav.stage,
    stage_skill:nav.stage_skill,
    procedure_skills:resolveProcedures(root,projectRoot,run).map(p=>p.id),
    fallback_instructions_inlined:true
  };
}

/**
 * Every id any navigation path can reach, live or retired. The procedure
 * coverage audit uses this to prove no guidance file is unreachable.
 */
export function navigableSkillIds(root){
  const policy=loadNavigationPolicy(root);
  const ids=new Set();
  for(const e of Object.values(policy.stages||{})){
    for(const id of arr(e.core))ids.add(id);
    for(const id of arr(e.retired_core))ids.add(id);
  }
  for(const group of [policy.workflow_skills,policy.overlay_skills]){
    for(const e of Object.values(group||{})){
      for(const id of arr(e.skills))ids.add(id);
      for(const id of arr(e.retired))ids.add(id);
    }
  }
  for(const rule of arr(policy.conditional))for(const id of arr(rule.add))ids.add(id);
  return ids;
}
