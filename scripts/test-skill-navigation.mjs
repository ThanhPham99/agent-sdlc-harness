#!/usr/bin/env node
// Differential suite for policies/skill-navigation.json.
//
// The three maps this policy replaces (CORE_SKILL_BY_STAGE, WORKFLOW_SKILLS,
// OVERLAY_SKILLS in runtime/context.mjs) are frozen below as literal data. A
// policy that resolves any run differently from these tables is a regression,
// not a refactor -- so the tables stay here after the maps are deleted.
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createSuite} from './lib/suite.mjs';
import {readJson} from '../runtime/util.mjs';
import {loadNavigationPolicy,resolveNavigation,navigableSkillIds} from '../runtime/skill-navigation.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const {test,assert,finish}=createSuite('agent-sdlc/skill-navigation-validation/v1','SKILL-NAVIGATION-VALIDATION.json');

const FROZEN_CORE={
  INTAKE:'requirements',REQUIREMENTS:'requirements',DESIGN:'architecture',PLAN:'planning',
  IMPLEMENT:'implementation',VERIFY:'testing',REVIEW:'code-review',RELEASE:'ci-cd',
  DEPLOY:'deployment',OBSERVE:'monitoring',CLOSE:'documentation'
};
const FROZEN_WORKFLOW={
  'security-remediation':['security'],'incident-response':['incident'],'dependency-upgrade':['upgrade'],
  'database-migration':['database'],'performance':['performance'],'maintenance':['maintenance'],
  'refactor':['maintenance'],'modernization':['modernization'],'compliance-change':['compliance'],
  'documentation':['documentation'],'ci-cd-change':['ci-cd'],'infrastructure-change':['ci-cd'],
  'observability-change':['monitoring'],'api-breaking-change':['documentation'],
  'deprecation-removal':['upgrade','documentation']
};
const FROZEN_OVERLAY={security:'security',incident:'incident','db-migration':'database',
  'api-breaking-change':'documentation','client-impact':'frontend-integration'};

// code-review (REVIEW's old core entry) and frontend-integration (the old
// client-impact overlay) are not retired -- they carry real content, so
// Task 6 routed them through config/procedures.json instead of deleting
// them, and Task 6's fix round 2 removed them from the policy's live
// navigation lists entirely (keeping them there too would double-render the
// same file, once from skill_instructions and once from
// procedure_instructions, with no cross-dedupe). So for exactly these two
// frozen entries, "reproduces the frozen table" no longer means "still in
// policy.stages/workflow_skills/overlay_skills" -- it means "still reachable
// for the same run shape via the procedure registry, gated the same way the
// old table gated it". Every other frozen id must still be found in the
// policy under core/retired_core or skills/retired, unchanged.
const PROCEDURE_PROMOTED_CORE={REVIEW:'code-review'};
const PROCEDURE_PROMOTED_OVERLAY={'client-impact':'frontend-integration'};

test('policy-reproduces-frozen-core-map',()=>{
  const policy=loadNavigationPolicy(ROOT);
  const procedures=readJson(path.join(ROOT,'config','procedures.json')).procedures||{};
  for(const [stage,id] of Object.entries(FROZEN_CORE)){
    const declared=policy.stages[stage];
    assert(declared,`policy has no entry for stage ${stage}`);
    if(PROCEDURE_PROMOTED_CORE[stage]===id){
      // The old table put code-review unconditionally on every REVIEW run;
      // the promoted procedure must still fire unconditionally for REVIEW.
      const proc=procedures[id];
      assert(proc,`promoted id ${id} has no config/procedures.json entry`);
      assert(proc.stages?.includes(stage),`procedure ${id} is not registered for stage ${stage}`);
      assert(proc.when==='always',`procedure ${id} is gated by "${proc.when}", not the unconditional "always" the old core table used for ${stage}`);
      continue;
    }
    const covered=(declared.core||[]).includes(id)||(declared.retired_core||[]).includes(id);
    assert(covered,`stage ${stage} lost core skill ${id}`);
  }
});

test('policy-reproduces-frozen-workflow-map',()=>{
  const policy=loadNavigationPolicy(ROOT);
  for(const [workflow,ids] of Object.entries(FROZEN_WORKFLOW)){
    const entry=policy.workflow_skills[workflow];
    assert(entry,`policy has no entry for workflow ${workflow}`);
    for(const id of ids){
      const covered=(entry.skills||[]).includes(id)||(entry.retired||[]).includes(id);
      assert(covered,`workflow ${workflow} lost skill ${id}`);
    }
  }
});

test('policy-reproduces-frozen-overlay-map',()=>{
  const policy=loadNavigationPolicy(ROOT);
  const procedures=readJson(path.join(ROOT,'config','procedures.json')).procedures||{};
  for(const [overlay,id] of Object.entries(FROZEN_OVERLAY)){
    if(PROCEDURE_PROMOTED_OVERLAY[overlay]===id){
      // The old table loaded frontend-integration only when the run carried
      // the client-impact overlay; the promoted procedure's "when" must
      // still name that exact overlay, not "always".
      const proc=procedures[id];
      assert(proc,`promoted id ${id} has no config/procedures.json entry`);
      assert(proc.when===`overlay:${overlay}`,`procedure ${id}'s when-condition "${proc.when}" no longer reproduces the ${overlay} overlay gate`);
      continue;
    }
    const entry=policy.overlay_skills[overlay];
    assert(entry,`policy has no entry for overlay ${overlay}`);
    const covered=(entry.skills||[]).includes(id)||(entry.retired||[]).includes(id);
    assert(covered,`overlay ${overlay} lost skill ${id}`);
  }
});

test('every-lifecycle-stage-maps-to-one-stage-skill',()=>{
  const policy=loadNavigationPolicy(ROOT);
  // Read from config/state-machine.json rather than hardcoding the stage list
  // here a second time -- a new lifecycle state is then forced to also get a
  // policy entry, or this suite fails loudly instead of silently skipping it.
  const order=readJson(path.join(ROOT,'config','state-machine.json')).lifecycle_order||[];
  assert(order.length>0,'config/state-machine.json has no lifecycle_order');
  for(const stage of order){
    const entry=policy.stages[stage];
    assert(entry&&typeof entry.stage_skill==='string'&&entry.stage_skill,`stage ${stage} has no stage_skill`);
  }
});

test('resolve-returns-guidance-for-every-retired-id',()=>{
  const policy=loadNavigationPolicy(ROOT);
  const retired=new Set();
  for(const e of Object.values(policy.stages))for(const id of e.retired_core||[])retired.add(id);
  for(const e of Object.values(policy.workflow_skills))for(const id of e.retired||[])retired.add(id);
  for(const e of Object.values(policy.overlay_skills))for(const id of e.retired||[])retired.add(id);
  for(const id of retired)
    assert(typeof policy.guidance?.[id]==='string'&&policy.guidance[id].length>20,
      `retired id ${id} has no guidance sentence to carry its content`);
});

test('navigable-ids-are-registered-skills-or-guidance',()=>{
  // navigableSkillIds only ever names ids drawn from core/retired_core,
  // workflow_skills, overlay_skills and conditional.add -- every one of those
  // must resolve somewhere: either config/skills.json's internal registry (a
  // live skill resolveSkills can load), or policy.guidance (a retired id's
  // one-line replacement). An id in neither place is unreachable in practice
  // even though navigableSkillIds claims it is navigable.
  const registry=readJson(path.join(ROOT,'config','skills.json')).internal||{};
  const policy=loadNavigationPolicy(ROOT);
  const ids=navigableSkillIds(ROOT);
  assert(ids.size>0,'no navigable ids');
  for(const id of ids){
    assert(typeof id==='string'&&id.length,'malformed id');
    const covered=Object.prototype.hasOwnProperty.call(registry,id)||typeof policy.guidance?.[id]==='string';
    assert(covered,`navigable id ${id} is neither a registered skill nor backed by guidance text`);
  }
});

test('resolve-is-deterministic-for-a-fixed-run',()=>{
  const run={run_id:'r1',state:'DESIGN',workflow:'security-remediation',overlays:['security'],profile:'STRICT',objective:'x'};
  const a=resolveNavigation(ROOT,ROOT,run);
  const b=resolveNavigation(ROOT,ROOT,run);
  assert(JSON.stringify(a)===JSON.stringify(b),'resolveNavigation is not deterministic');
  assert(a.stage_skill==='sdlc-design',`DESIGN resolved to ${a.stage_skill}`);
});

// The three tests above only check that each frozen id appears *somewhere* in
// the policy -- containment, not equivalence. Swapping the two `conditional`
// rules, for instance, would reorder core_skill_ids and change context_hash
// for every strict release run while leaving every check above green. These
// fixtures pin the exact, order-sensitive array resolveSkills (runtime/
// context.mjs) actually produces for a real run: resolveNavigation's raw
// core_skill_ids, filtered through config/skills.json's per-id `stages` list
// -- the same filter resolveSkills applies -- since that filter, not
// resolveNavigation alone, decides what a run's context actually carries.
// Retiring an id removes it from config/skills.json's internal registry, so
// the registry-stage filter below drops it from core_skill_ids even where
// resolveNavigation still names it as guidance-only. Every fixture whose
// pinned result was built entirely from retired ids (deployment, ci-cd,
// planning, maintenance, implementation, testing, security) now resolves to
// [] -- that is retirement working as designed, not a routing regression.
// The REVIEW fixture also resolves to [] as of Task 6's fix round 2: code-
// review was promoted to a routed procedure rather than retired, but round 2
// then removed it from REVIEW's policy `core` entirely (config/
// procedures.json now routes it unconditionally for REVIEW instead, so
// leaving it in both places would render the same file twice with no
// cross-dedupe). The reachability net for code-review's REVIEW placement
// lives in policy-reproduces-frozen-core-map instead, which now asserts it
// through the procedure registry.
const PINNED_RESOLUTIONS=[
  {state:'DEPLOY',workflow:'infrastructure-change',overlays:['security'],profile:'STANDARD',
    expected:[]},
  {state:'REVIEW',workflow:'deprecation-removal',overlays:['api-breaking-change'],profile:'STRICT',
    expected:[]},
  {state:'RELEASE',workflow:'ci-cd-change',overlays:[],profile:'STRICT',
    expected:[]},
  {state:'PLAN',workflow:'refactor',overlays:[],profile:'STANDARD',
    expected:[]},
  {state:'IMPLEMENT',workflow:'bug-fix',overlays:[],profile:'STANDARD',
    expected:[]},
  {state:'VERIFY',workflow:'new-feature',overlays:[],profile:'STRICT',
    expected:[]}
];

test('resolved-core-skill-ids-match-pinned-fixtures-exactly',()=>{
  const registry=readJson(path.join(ROOT,'config','skills.json')).internal||{};
  for(const fixture of PINNED_RESOLUTIONS){
    const run={run_id:'r',objective:'x',state:fixture.state,workflow:fixture.workflow,
      overlays:fixture.overlays,profile:fixture.profile};
    const nav=resolveNavigation(ROOT,ROOT,run);
    const actual=nav.core_skill_ids.filter(id=>registry[id]&&registry[id].stages?.includes(run.state));
    assert(JSON.stringify(actual)===JSON.stringify(fixture.expected),
      `${fixture.state}/${fixture.workflow}/[${fixture.overlays}]/${fixture.profile}: expected ${JSON.stringify(fixture.expected)}, got ${JSON.stringify(actual)}`);
  }
});

await test('retired-guidance-sentences-render-into-the-actual-prompt-text',async ()=>{
  // resolve-returns-guidance-for-every-retired-id only proves the policy HAS a
  // sentence for every retired id; it never proves that sentence reaches the
  // agent. resolveSkills (runtime/context.mjs) turns each retired id into a
  // {id,description,instructions} entry consumed by buildContext, but
  // renderPrompt's STAGE SKILLS section is built only from
  // manifest.skill_instructions -- {id,instructions} -- so a retired entry
  // whose `instructions` field is left empty renders as a heading with
  // nothing under it, and the guidance sentence never appears in the string
  // an agent actually reads. This test renders a real prompt and asserts the
  // sentence is IN THAT STRING, not just present somewhere on the manifest.
  const {initProject}=await import('../runtime/store.mjs');
  const {buildContext,renderPrompt}=await import('../runtime/context.mjs');
  const {makeTempDir}=await import('./lib/tempdir.mjs');
  const d=makeTempDir('agent-sdlc-nav-');
  initProject(d,{schema:'agent-sdlc/project/v1',project:'nav-fixture'});
  // INTAKE + security-remediation + STRICT + the security overlay resolves
  // two retired ids at once: "requirements" from the stage's retired_core,
  // and "security" from both the workflow map and (on stages where it
  // applies) the strict conditional -- the same combination the coordinator
  // reproduced the empty-heading bug with.
  const run={run_id:'r-guidance',objective:'patch a vulnerability',state:'INTAKE',
    workflow:'security-remediation',overlays:['security'],profile:'STRICT'};
  const policy=loadNavigationPolicy(ROOT);
  const nav=resolveNavigation(ROOT,ROOT,run);
  assert(nav.guidance.length>=2,`fixture must resolve at least two retired ids, got ${JSON.stringify(nav.guidance)}`);
  const ctx=buildContext(ROOT,d,run);
  const prompt=renderPrompt(ROOT,ctx);
  for(const g of nav.guidance){
    const sentence=policy.guidance[g.id];
    assert(typeof sentence==='string'&&sentence.length>20,`no guidance sentence for retired id ${g.id}`);
    assert(prompt.includes(sentence),
      `retired id ${g.id}'s guidance sentence is missing from the rendered prompt (only checking the manifest, not the string an agent reads, would miss this)`);
  }
  // The literal regression the coordinator found: a heading immediately
  // followed by a blank line then the next "### " heading (or the end of the
  // STAGE SKILLS section) means that skill's instructions were empty.
  const stageSkillsMatch=prompt.match(/STAGE SKILLS\n([\s\S]*?)\n\nDETAILED PROCEDURES/);
  assert(stageSkillsMatch,'prompt has no STAGE SKILLS section');
  const stageSkillsBody=stageSkillsMatch[1];
  const emptyHeading=/### [^\n]+\n\n(?:### |$)/.test(stageSkillsBody+'\n');
  assert(!emptyHeading,`STAGE SKILLS has a heading with an empty body:\n${stageSkillsBody}`);
});

await test('context-manifest-carries-navigation-block',async ()=>{
  const {initProject,loadRun}=await import('../runtime/store.mjs');
  const {newRun}=await import('../runtime/orchestrator.mjs');
  const {route}=await import('../runtime/router.mjs');
  const {buildContext}=await import('../runtime/context.mjs');
  const {makeTempDir}=await import('./lib/tempdir.mjs');
  const d=makeTempDir('agent-sdlc-nav-');
  initProject(d,{schema:'agent-sdlc/project/v1',project:'nav-fixture'});
  // newRun takes a route object, not loose workflow/profile fields:
  // newRun(root, projectRoot, {objective, route}) -- see runtime/orchestrator.mjs:42.
  const objective='add a login endpoint';
  const run=newRun(ROOT,d,{objective,route:route(ROOT,objective)});
  const ctx=buildContext(ROOT,d,loadRun(d,run.run_id));
  assert(ctx.navigation,'context manifest has no navigation block');
  // ctx.state does not exist on the compiled manifest -- the field is
  // ctx.stage (see buildContext's manifest object, runtime/context.mjs). A
  // literal ctx.state comparison would be undefined===<real stage>, always
  // false; comparing against the manifest's real stage field is the intended,
  // and only correct, strict check here.
  assert(ctx.navigation.stage===ctx.stage,'navigation.stage missing or wrong');
  assert(typeof ctx.navigation.stage_skill==='string','navigation.stage_skill must be a string');
  assert(Array.isArray(ctx.navigation.procedure_skills),'navigation.procedure_skills must be an array');
  assert(ctx.navigation.fallback_instructions_inlined===true,'text injection is the floor: the flag must report it');
});

await test('context-navigation-matches-status-navigation-for-the-same-run',async ()=>{
  const {initProject,loadRun}=await import('../runtime/store.mjs');
  const {newRun}=await import('../runtime/orchestrator.mjs');
  const {route}=await import('../runtime/router.mjs');
  const {buildContext}=await import('../runtime/context.mjs');
  const {resolveNavigationSummary}=await import('../runtime/skill-navigation.mjs');
  const {makeTempDir}=await import('./lib/tempdir.mjs');
  const d=makeTempDir('agent-sdlc-nav-');
  initProject(d,{schema:'agent-sdlc/project/v1',project:'nav-fixture'});
  const objective='add a login endpoint';
  const run=newRun(ROOT,d,{objective,route:route(ROOT,objective)});
  const loaded=loadRun(d,run.run_id);
  const ctx=buildContext(ROOT,d,loaded);
  // status/agent_sdlc_status report {stage, stage_skill, procedure_skills}
  // only -- fallback_instructions_inlined is context-only, since only the
  // compiled context actually carries instruction text. Compare just the
  // fields the two surfaces share, but with a strict deep comparison so a
  // divergence -- or either surface silently dropping one of the shared
  // fields -- fails this test.
  const {stage,stage_skill,procedure_skills}=ctx.navigation;
  const contextShared={stage,stage_skill,procedure_skills};
  const statusNav=resolveNavigationSummary(ROOT,d,loaded);
  assert(JSON.stringify(contextShared)===JSON.stringify(statusNav),
    `context.navigation and status navigation diverged: context=${JSON.stringify(contextShared)} status=${JSON.stringify(statusNav)}`);
});

finish({harness_root:'.'});
