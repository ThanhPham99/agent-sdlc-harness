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

test('policy-reproduces-frozen-core-map',()=>{
  const policy=loadNavigationPolicy(ROOT);
  for(const [stage,id] of Object.entries(FROZEN_CORE)){
    const declared=policy.stages[stage];
    assert(declared,`policy has no entry for stage ${stage}`);
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
  for(const [overlay,id] of Object.entries(FROZEN_OVERLAY)){
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
// [] -- that is retirement working as designed, not a routing regression;
// only the REVIEW fixture still resolves a live id (code-review, which was
// promoted to a routed procedure rather than retired).
const PINNED_RESOLUTIONS=[
  {state:'DEPLOY',workflow:'infrastructure-change',overlays:['security'],profile:'STANDARD',
    expected:[]},
  {state:'REVIEW',workflow:'deprecation-removal',overlays:['api-breaking-change'],profile:'STRICT',
    expected:['code-review']},
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
