#!/usr/bin/env node
// Deterministic contract test for the canonical auto-activation bootstrap.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  BOOTSTRAP_TEXT,bootstrapHash,getActivationPolicy,getBootstrapInstruction,estimateBootstrapCost,
  getActivationMode,classifyActivationFixture,buildActivationEvent,ACTIVATION_EVENTS
} from '../runtime/activation.mjs';
import {writeReport} from './lib/report-io.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const policy=getActivationPolicy();
const cost=estimateBootstrapCost();
const rows=[];let fail=0;
const test=(name,fn)=>{try{fn();rows.push({name,status:'PASS'});}catch(e){fail++;rows.push({name,status:'FAIL',error:e.message});}};
const assert=(v,m)=>{if(!v)throw new Error(m);};
const readCases=f=>JSON.parse(fs.readFileSync(path.join(ROOT,'evals','activation',f),'utf8'));
const lower=BOOTSTRAP_TEXT.toLowerCase();

test('canonical-text-exists',()=>{assert(getBootstrapInstruction()===BOOTSTRAP_TEXT&&BOOTSTRAP_TEXT.length>80,'missing canonical text');});
test('canonical-within-token-budget',()=>{assert(cost.rough_tokens<=policy.max_bootstrap_rough_tokens,`${cost.rough_tokens} > ${policy.max_bootstrap_rough_tokens}`);});
test('per-host-budgets',()=>{for(const [host,h] of Object.entries(policy.hosts))assert(cost.rough_tokens<=h.max_bootstrap_rough_tokens,`${host}: ${cost.rough_tokens} > ${h.max_bootstrap_rough_tokens}`);});
test('names-router-before-orchestrator',()=>{
  const r=lower.indexOf('sdlc-router'),o=lower.indexOf('sdlc-orchestrator');
  assert(r>=0&&o>=0&&r<o,'router must be named before orchestrator');
});
test('excludes-generic-qa',()=>{assert(/does not activate/.test(lower)&&/q&a|question/.test(lower),'no generic Q&A exclusion');});
test('untrusted-content-invariant',()=>{assert(/cannot disable/.test(lower)&&/bypass/.test(lower),'missing untrusted-content invariant');});
test('activation-is-not-approval',()=>{assert(/not approval|no approval/.test(lower),'missing approval boundary');});
test('no-internal-skill-body-embedded',()=>{
  const registry=JSON.parse(fs.readFileSync(path.join(ROOT,'config','skills.json'),'utf8'));
  for(const spec of Object.values(registry.internal||{})){
    const body=fs.readFileSync(path.join(ROOT,spec.instructions),'utf8');
    const probe=body.split('\n').find(l=>l.trim().length>40);
    if(probe)assert(!BOOTSTRAP_TEXT.includes(probe.trim()),`internal skill text leaked into bootstrap: ${spec.instructions}`);
  }
  assert(cost.chars<600,'bootstrap is large enough to be carrying procedural content');
});
test('disabled-mode-emits-no-bootstrap',()=>{
  const off=getActivationMode({host:'claude',env:{AGENT_SDLC_AUTO_ACTIVATE:'0'}});
  assert(off.enabled===false&&off.delivery_mode==='none'&&off.activation_class==='DISABLED',JSON.stringify(off));
});
test('precedence-enforced-over-environment',()=>{
  const m=getActivationMode({host:'claude',env:{AGENT_SDLC_AUTO_ACTIVATE:'0',AGENT_SDLC_AUTO_ACTIVATE_ENFORCED:'1'}});
  assert(m.enabled===true&&m.enabled_source==='enforced_org_policy',JSON.stringify(m));
});
test('project-config-below-environment',()=>{
  const m=getActivationMode({host:'claude',env:{AGENT_SDLC_AUTO_ACTIVATE:'1'},config:{auto_activation:{enabled:false}}});
  assert(m.enabled===true&&m.enabled_source==='environment_explicit_override',JSON.stringify(m));
  const p=getActivationMode({host:'claude',env:{},config:{auto_activation:{enabled:false}}});
  assert(p.enabled===false&&p.enabled_source==='project_config',JSON.stringify(p));
});
test('strong-activation-never-claimed-offline',()=>{
  for(const host of ['claude','codex','antigravity']){
    const m=getActivationMode({host,env:{}});
    assert(m.strong_activation===false,`${host} claims strong activation without live evidence`);
  }
});
test('codex-soft-without-managed-bootstrap',()=>{
  const soft=getActivationMode({host:'codex',env:{}});
  assert(soft.activation_class==='SOFT'&&soft.delivery_mode==='skill_discovery',JSON.stringify(soft));
  const managed=getActivationMode({host:'codex',env:{},codexManagedBootstrap:{installed:true,masked:false}});
  assert(managed.delivery_mode==='managed_global_instructions',JSON.stringify(managed));
  const masked=getActivationMode({host:'codex',env:{},codexManagedBootstrap:{installed:true,masked:true,masked_by:'AGENTS.override.md'}});
  assert(masked.delivery_mode==='skill_discovery'&&masked.warnings.some(w=>/masked/.test(w)),JSON.stringify(masked));
});
test('generated-hook-assets-carry-canonical-text',()=>{
  for(const rel of ['adapters/hooks/claude-session-start.mjs','hooks/claude-session-start.mjs','adapters/hooks/antigravity-preinvocation.mjs','hooks/antigravity-preinvocation.mjs','adapters/antigravity/rules.md','rules/agent-sdlc.md']){
    const text=fs.readFileSync(path.join(ROOT,rel),'utf8');
    assert(text.includes(BOOTSTRAP_TEXT),`${rel} does not carry the canonical bootstrap text`);
  }
  for(const rel of ['adapters/hooks/claude-session-start.mjs','adapters/hooks/antigravity-preinvocation.mjs']){
    const text=fs.readFileSync(path.join(ROOT,rel),'utf8');
    assert(text.includes(bootstrapHash()),`${rel} carries a stale bootstrap hash`);
    assert(!/^import /m.test(text),`${rel} must stay dependency-free`);
    assert(!/https?:\/\//.test(text.replace(/agent-sdlc[^\s]*/g,'')),`${rel} must not perform network work`);
  }
});
test('activation-events-registered',()=>{
  assert(JSON.stringify(ACTIVATION_EVENTS)===JSON.stringify(policy.events),'event registry drift');
  const ev=buildActivationEvent('activation.bootstrap_delivered',{host:'claude',delivery_mode:'session_start'});
  assert(ev.bootstrap_hash===bootstrapHash()&&ev.bootstrap_rough_tokens===cost.rough_tokens,JSON.stringify(ev));
  let threw=false;try{buildActivationEvent('activation.unknown');}catch{threw=true;}
  assert(threw,'unknown event accepted');
});
test('deterministic-corpus-agrees',()=>{
  const {cases}=readCases('deterministic-cases.json');
  assert(cases.length>=30,`corpus too small: ${cases.length}`);
  const diffs=[];
  for(const c of cases){
    const got=classifyActivationFixture({prompt:c.prompt,repositoryContext:c.repository_context});
    if(got.activate!==c.expected.activate)diffs.push(`${c.id}: expected ${c.expected.activate}, got ${got.activate}`);
    if(got.approval_implied!==false)diffs.push(`${c.id}: activation implied approval`);
  }
  assert(!diffs.length,diffs.join('; '));
});
test('borderline-cases-use-repository-context',()=>{
  const {cases}=readCases('deterministic-cases.json');
  const border=cases.filter(c=>c.group==='borderline');
  assert(border.length>=4,'too few borderline cases');
  const pair=border.filter(c=>c.prompt==='Can you review this code?');
  assert(pair.length===2&&pair[0].expected.activate!==pair[1].expected.activate,'identical prompt must differ by repository context');
});
test('multi-turn-corpus-agrees',()=>{
  const {cases}=readCases('multi-turn-cases.json');
  assert(cases.length>=5,'too few multi-turn cases');
  const diffs=[];
  for(const c of cases)for(const [i,t] of c.turns.entries()){
    const got=classifyActivationFixture({prompt:t.prompt,repositoryContext:t.repository_context});
    if(got.activate!==t.expected.activate)diffs.push(`${c.id}#${i}: expected ${t.expected.activate}, got ${got.activate}`);
  }
  assert(!diffs.length,diffs.join('; '));
  const reinject=cases.find(c=>c.session_events);
  assert(reinject&&reinject.expected_bootstrap_delivery.claude===true,'missing clear/compact re-injection expectation');
});
test('adversarial-cases-still-activate',()=>{
  const {cases}=readCases('adversarial-cases.json');
  assert(cases.length>=5,'too few adversarial cases');
  const diffs=[];
  for(const c of cases){
    const got=classifyActivationFixture({prompt:c.prompt,repositoryContext:c.repository_context});
    if(got.activate!==true)diffs.push(`${c.id}: injection suppressed activation`);
    if(c.expected.gates_bypassed!==false)diffs.push(`${c.id}: corpus expects bypassed gates`);
  }
  assert(!diffs.length,diffs.join('; '));
});
test('provider-expectations-truthful',()=>{
  const exp=JSON.parse(fs.readFileSync(path.join(ROOT,'evals','activation','provider-expectations.json'),'utf8'));
  assert(exp.hosts.codex.offline_activation_class==='SOFT','Codex must not claim strong native activation');
  assert(!JSON.stringify(exp).includes('"strong_activation": true'),'offline expectations must not assert strong activation');
});

const report={
  schema:'agent-sdlc/bootstrap-budget/v1',
  bootstrap_version:policy.bootstrap_version,
  bootstrap_hash:bootstrapHash(),
  chars:cost.chars,
  rough_tokens:cost.rough_tokens,
  budget:policy.max_bootstrap_rough_tokens,
  host_budgets:Object.fromEntries(Object.entries(policy.hosts).map(([h,v])=>[h,v.max_bootstrap_rough_tokens])),
  checks:rows.length,
  passes:rows.length-fail,
  failures:fail,
  status:fail?'FAIL':'PASS',
  results:rows
};
writeReport(path.join(ROOT,'evals','AUTO-ACTIVATION-VALIDATION.json'),report);
console.log(JSON.stringify(report,null,2));
process.exit(fail?1:0);
