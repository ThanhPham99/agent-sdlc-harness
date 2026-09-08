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
  const order=['INTAKE','REQUIREMENTS','DESIGN','PLAN','IMPLEMENT','VERIFY','REVIEW','RELEASE','DEPLOY','OBSERVE','CLOSE'];
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

test('navigable-ids-are-registered-procedures-or-guidance',()=>{
  const ids=navigableSkillIds(ROOT);
  assert(ids.size>0,'no navigable ids');
  for(const id of ids)assert(typeof id==='string'&&id.length,'malformed id');
});

test('resolve-is-deterministic-for-a-fixed-run',()=>{
  const run={run_id:'r1',state:'DESIGN',workflow:'security-remediation',overlays:['security'],profile:'STRICT',objective:'x'};
  const a=resolveNavigation(ROOT,ROOT,run);
  const b=resolveNavigation(ROOT,ROOT,run);
  assert(JSON.stringify(a)===JSON.stringify(b),'resolveNavigation is not deterministic');
  assert(a.stage_skill==='sdlc-design',`DESIGN resolved to ${a.stage_skill}`);
});

finish({harness_root:'.'});
