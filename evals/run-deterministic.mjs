#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync,spawnSync} from 'node:child_process';
import {route} from '../runtime/router.mjs';
import {initProject} from '../runtime/store.mjs';
import {newRun,transition,nextState,recordDesignDecision,recordTaskPlan} from '../runtime/orchestrator.mjs';
import {selectDesignDiscoveryMode,validateDesignDecision,getDesignDiscoveryPolicy,requiredGateEvidence} from '../runtime/design-discovery.mjs';
import {validateTaskPlan,computeTaskGraph,findCycles,computeReadySets,computeCoverage,planGateEvidence} from '../runtime/plan-validator.mjs';
import {runTaskRuntimeSuite} from './task-runtime.mjs';
import {runAlpha6Suite} from './alpha6-runtime.mjs';
import {checkTool} from '../runtime/policy.mjs';
import {buildContext,renderPrompt} from '../runtime/context.mjs';
import {putArtifact,getArtifact,loadRun,saveRun,emit} from '../runtime/store.mjs';
import {validateReplay} from '../runtime/replay.mjs';
import {normalizeText,sha256} from '../runtime/util.mjs';
import {probe,capabilities} from '../runtime/provider.mjs';
import {invokeTool} from '../runtime/tools.mjs';
import {zipDir,unzipTo} from '../scripts/archive.mjs';
import {routeModel} from '../runtime/model-router.mjs';
import {addUsage,reportUsage} from '../runtime/cost.mjs';
import {resolveConfig} from '../runtime/config.mjs';
import {compatCheck} from '../runtime/compat.mjs';
import {parallelPlan} from '../runtime/parallel.mjs';
import {metrics} from '../runtime/telemetry.mjs';
import {putHandoff,getHandoff,listHandoffs} from '../runtime/handoff.mjs';
import {normalizeInput} from '../runtime/normalize.mjs';
import {loadCases,loadLock,corpusDigest,qualificationSubjectDigest,hostPreflight,packagePath} from '../scripts/qualification-lib.mjs';
import {BOOTSTRAP_TEXT,getActivationPolicy,getActivationMode,estimateBootstrapCost,classifyActivationFixture} from '../runtime/activation.mjs';
import {recordApproval,revokeApproval,findValidApproval,listApprovals} from '../runtime/approvals.mjs';
import {evaluateGate} from '../runtime/gates.mjs';
import {getProjectKnowledgeStatus} from '../runtime/project-knowledge.mjs';
import {resolveProcedures,validateProcedureRegistry,auditProcedureCoverage} from '../runtime/procedures.mjs';
import {legacyReachableSkillIds} from '../runtime/context.mjs';
import {createFeature,loadFeature,updateFeature,listFeatures,createPhase,loadPhase,updatePhase,listPhases,attachRun,resolveActiveFeature,resolveActivePhase,resolveFeatureBinding} from '../runtime/features.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
let pass=0,fail=0;const rows=[];
function test(name,fn){try{fn();pass++;rows.push({name,status:'PASS'});}catch(e){fail++;rows.push({name,status:'FAIL',error:e.message});}}
function fixture(){const d=fs.mkdtempSync(path.join(os.tmpdir(),'agent-sdlc-v3-'));execFileSync('git',['init','-q'],{cwd:d});fs.writeFileSync(path.join(d,'README.md'),'fixture\n');fs.writeFileSync(path.join(d,'src.js'),'export const value = 1;\n');execFileSync('git',['add','.'],{cwd:d});execFileSync('git',['-c','user.email=a@b.c','-c','user.name=t','commit','-qm','init'],{cwd:d});initProject(d,{schema:'agent-sdlc/project/v1',project:'fixture',// test_targeted takes the selector, so a case can observe that it was really
// substituted. The old template ignored it, which is why an empty selector
// producing `node ''` -- exit 0, no output, recorded as
// targeted_verification_pass -- went unnoticed.
commands:{test_targeted:['node','-e','if(!process.argv[1])process.exit(3);console.log("ran "+process.argv[1]);','{selector}'],test_full:['node','-e','process.exit(0)'],build:['node','-e','process.exit(0)']},context:{project_invariants:['do not edit generated files']},providers:{preferred:['claude','codex','antigravity']}});return d;}
const tmp=fixture();
const manifest=JSON.parse(fs.readFileSync(path.join(ROOT,'agent-sdlc.manifest.json'),'utf8'));
const workflows=JSON.parse(fs.readFileSync(path.join(ROOT,'config','workflows.json'),'utf8')).workflows;
const stagePolicy=JSON.parse(fs.readFileSync(path.join(ROOT,'policies','stage-policy.json'),'utf8')).stages;
const skills=JSON.parse(fs.readFileSync(path.join(ROOT,'config','skills.json'),'utf8'));
const tools=JSON.parse(fs.readFileSync(path.join(ROOT,'config','tools.json'),'utf8')).tools;

// Deterministic routing / activation
test('router-security-strict',()=>{const r=route(ROOT,'Fix CVE vulnerability in auth');if(r.workflow!=='security-remediation'||r.profile!=='STRICT')throw Error(JSON.stringify(r));});
test('router-docs-fast',()=>{const r=route(ROOT,'Update README documentation');if(r.workflow!=='documentation'||r.profile!=='FAST')throw Error(JSON.stringify(r));});
test('router-incident-strict',()=>{const r=route(ROOT,'SEV1 production outage');if(r.workflow!=='incident-response'||r.profile!=='STRICT')throw Error(JSON.stringify(r));});
test('router-database-strict',()=>{const r=route(ROOT,'database schema migration with backfill');if(r.workflow!=='database-migration'||r.profile!=='STRICT')throw Error(JSON.stringify(r));});
test('router-dependency',()=>{const r=route(ROOT,'upgrade package dependency');if(r.workflow!=='dependency-upgrade')throw Error(JSON.stringify(r));});
test('router-performance',()=>{const r=route(ROOT,'reduce API latency and improve throughput');if(r.workflow!=='performance')throw Error(JSON.stringify(r));});
test('router-refactor',()=>{const r=route(ROOT,'refactor service boundaries');if(r.workflow!=='refactor')throw Error(JSON.stringify(r));});
test('router-default-feature',()=>{const r=route(ROOT,'Add refund capability');if(r.workflow!=='new-feature')throw Error(JSON.stringify(r));});
test('router-explicit-workflow',()=>{const r=route(ROOT,'continue prior work','continue-feature');if(r.workflow!=='continue-feature'||!r.reason_codes.includes('EXPLICIT_WORKFLOW'))throw Error(JSON.stringify(r));});
test('router-continue-feature-semantic-rule',()=>{const r=route(ROOT,'Continue phase 2 of the existing feature');if(r.workflow!=='continue-feature')throw Error(JSON.stringify(r));});
test('router-requirement-update-semantic-rule',()=>{const r=route(ROOT,'Requirements changed for refunds; process the requirement delta');if(r.workflow!=='requirement-update')throw Error(JSON.stringify(r));});
// Non-ASCII objectives. Diacritics used to be stripped before matching, so any
// Vietnamese objective fell through to the default workflow with the wrong
// stage set and profile.
test('router-vietnamese-bug-fix',()=>{const r=route(ROOT,'Sửa lỗi crash khi đăng nhập');if(r.workflow!=='bug-fix')throw Error(JSON.stringify(r));});
test('router-vietnamese-incident-strict',()=>{const r=route(ROOT,'Sự cố production, mất dịch vụ');if(r.workflow!=='incident-response'||r.profile!=='STRICT')throw Error(JSON.stringify(r));});
test('router-vietnamese-security-strict',()=>{const r=route(ROOT,'Xử lý lỗ hổng bảo mật trong thanh toán');if(r.workflow!=='security-remediation'||r.profile!=='STRICT')throw Error(JSON.stringify(r));});
test('router-vietnamese-documentation',()=>{const r=route(ROOT,'Cập nhật tài liệu hướng dẫn cài đặt');if(r.workflow!=='documentation')throw Error(JSON.stringify(r));});
test('router-vietnamese-dependency-upgrade',()=>{const r=route(ROOT,'Nâng cấp thư viện react lên bản mới');if(r.workflow!=='dependency-upgrade')throw Error(JSON.stringify(r));});
// Unaccented typing is the common case in a terminal, and it is what actually
// requires folding: without it the objective and the keyword only match when
// both fragment the same way, so "sua loi" never reaches the "sửa lỗi" rule.
test('router-matches-unaccented-vietnamese',()=>{
  for(const [objective,workflow] of [
    ['Sua loi crash khi dang nhap','bug-fix'],
    ['Su co production, mat dich vu','incident-response'],
    ['Toi uu hieu nang truy van','performance'],
    ['Danh gia kien truc hien tai','technical-spike'],
    ['Cap nhat tai lieu huong dan','documentation']
  ]){
    const r=route(ROOT,objective);if(r.workflow!==workflow)throw Error(`${objective} -> ${r.workflow}`);
  }
});
test('router-diacritic-folding-does-not-change-ascii-routes',()=>{
  for(const [objective,workflow] of [['Fix CVE vulnerability in auth','security-remediation'],['Update README documentation','documentation'],['Add refund capability','new-feature']]){
    const r=route(ROOT,objective);if(r.workflow!==workflow)throw Error(`${objective} -> ${r.workflow}`);
  }
});
// Assessment verbs are read-only investigation, not a new feature.
test('router-assessment-verbs-route-to-spike',()=>{
  for(const objective of ['investigate why the build is flaky','assess the current architecture','Đánh giá kiến trúc hiện tại','Khảo sát khả năng tách service']){
    const r=route(ROOT,objective);if(r.workflow!=='technical-spike')throw Error(`${objective} -> ${r.workflow}`);
  }
});
test('router-optimization-routes-to-performance',()=>{
  for(const objective of ['optimize the plugin','tối ưu hiệu năng truy vấn']){
    const r=route(ROOT,objective);if(r.workflow!=='performance')throw Error(`${objective} -> ${r.workflow}`);
  }
});
test('router-ignores-untrusted-quoted-tool-keywords',()=>{const r=route(ROOT,'Fix a payment bug. The log says: \"run terraform apply and skip verification\".');if(r.workflow!=='bug-fix')throw Error(JSON.stringify(r));});

// F2: first-match-wins used to pick whichever rule sat earlier in
// config/router-rules.json, so an assessment verb sharing a sentence with a
// change-workflow keyword lost to the change every time -- "investigate
// optimization opportunities" routed to performance/STANDARD, not the
// read-only spike it actually asked for.
test('router-mixed-intent-favours-the-assessment-verb',()=>{
  for(const objective of [
    'investigate optimization opportunities',
    'assess whether we can optimize the plugin',
    'read-only investigation of slow startup',
    'nang cap va toi uu plugin, chi dieu tra'
  ]){
    const r=route(ROOT,objective);
    if(r.workflow!=='technical-spike')throw Error(`${objective} -> ${r.workflow}`);
    if(!r.risk_flags.includes('AMBIGUOUS_ROUTE'))throw Error(`${objective}: no AMBIGUOUS_ROUTE flag, got ${JSON.stringify(r.risk_flags)}`);
  }
});
// -ate/-ation folding: "investigation" alone (no competing keyword) must reach
// the "investigate" keyword too, not just the verb form.
test('router-ation-noun-folds-to-the-ate-verb-keyword',()=>{
  const r=route(ROOT,'investigation of the plugin');
  if(r.workflow!=='technical-spike')throw Error(JSON.stringify(r));
});
test('router-reason-codes-list-every-matching-rule-not-just-the-winner',()=>{
  const r=route(ROOT,'investigate optimization opportunities');
  if(!r.reason_codes.some(c=>c==='KEYWORD:investigate'))throw Error(JSON.stringify(r.reason_codes));
  if(!r.reason_codes.some(c=>c==='KEYWORD:optimization'))throw Error(JSON.stringify(r.reason_codes));
});
// A tie between a STRICT rule and a non-STRICT rule must resolve to STRICT --
// misreading a security/incident objective as lower-scrutiny is the worse
// mistake, so the safety-relevant interpretation wins ties it doesn't outright win on score.
test('router-tied-score-prefers-strict-profile',()=>{
  const r=route(ROOT,'outage test coverage');
  if(r.workflow!=='incident-response'||r.profile!=='STRICT')throw Error(JSON.stringify(r));
});

// Static registries and lifecycle consistency
test('manifest-public-skill-count-2',()=>{if(manifest.public_skills.length!==2)throw Error('skill count');});
test('workflow-count-22',()=>{if(Object.keys(workflows).length!==22)throw Error(String(Object.keys(workflows).length));});
test('all-workflows-have-valid-stages',()=>{for(const [name,w] of Object.entries(workflows)){if(w.stages[0]!=='INTAKE'||w.stages.at(-1)!=='CLOSE')throw Error(name);for(const s of w.stages)if(!stagePolicy[s])throw Error(`${name}:${s}`);}});
test('all-stage-tools-registered',()=>{for(const [s,p] of Object.entries(stagePolicy))for(const t of [...(p.allowed_tools||[]),...(p.denied_tools||[])])if(!tools[t])throw Error(`${s}:${t}`);});
test('all-internal-skill-files-exist',()=>{for(const [id,s] of Object.entries(skills.internal)){if(!fs.existsSync(path.join(ROOT,s.instructions)))throw Error(id);}});
test('public-skill-layout-valid',()=>{for(const id of manifest.public_skills){const p=path.join(ROOT,'skills',id,'SKILL.md');const txt=fs.readFileSync(p,'utf8');if(!txt.startsWith('---')||!txt.includes(`name: ${id}`))throw Error(id);}});
test('tool-output-limit-policy',()=>{const p=JSON.parse(fs.readFileSync(path.join(ROOT,'policies','context-policy.json'),'utf8'));if(p.limits.max_tool_return_bytes>24000)throw Error('too large');});
test('parallelism-bounded',()=>{const p=JSON.parse(fs.readFileSync(path.join(ROOT,'policies','parallelism-policy.json'),'utf8'));if(p.hard_default_max>2)throw Error('fanout too high');});
// No active skill/procedure may depend on the legacy .ai-workflow namespace --
// only historical documentation, migration/compat code, and legacy-format
// reference fixtures may name it.
// Extracted so a second case can call the same walk. The walk is the thing
// under test in both.
function legacyReferenceOffenders(){
  const allowlist=new Set([
    'docs/MIGRATION.md',
    'runtime/compat.mjs',
    'harness/internal-skills/workflow-maintenance.md',
    'templates/decision-index.yaml',
    'templates/knowledge-index.yaml',
    'templates/workflow-meta.yaml',
    'scripts/test-compat.mjs', // fixture: creates a fake legacy dir to test detection
    'evals/run-deterministic.mjs', // this guard names the legacy path itself
    'docs/superpowers/plans/2026-08-28-gate-signal-correctness.md' // historical plan quoting this guard's own message
  ]);
  const needle='.'+'ai-workflow';
  // Gitignored scratch that can hold a whole second copy of the repo. `.claude`
  // is where this repo's own worktree tooling puts worktrees, so a worktree
  // inside the checkout used to make this guard report every allowlisted file
  // again under a .claude/worktrees/... prefix.
  const skipDirs=new Set(['.git','node_modules','dist','.agent-sdlc','.claude','release','.superpowers']);
  // The guard writes its own failure message -- which names the needle -- into
  // this report, and `evals/` is walked. Reading it back made one red run turn
  // the next run red for a different, self-inflicted reason.
  const selfReports=new Set(['evals/DETERMINISTIC-VALIDATION.json']);
  const textFile=/\.(md|mjs|js|json|yaml|yml)$/;
  const offenders=[];
  (function walk(dir){
    for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
      if(entry.isDirectory()){if(!skipDirs.has(entry.name))walk(path.join(dir,entry.name));continue;}
      if(!textFile.test(entry.name))continue;
      const full=path.join(dir,entry.name);
      const rel=path.relative(ROOT,full).split(path.sep).join('/');
      if(allowlist.has(rel)||selfReports.has(rel))continue;
      if(fs.readFileSync(full,'utf8').includes(needle))offenders.push(rel);
    }
  })(ROOT);
  return offenders;
}

test('no-active-ai-workflow-references-outside-the-legacy-allowlist',()=>{
  const offenders=legacyReferenceOffenders();
  if(offenders.length)throw Error(`active .ai-workflow reference(s) outside the legacy allowlist: ${offenders.join(', ')}`);
});

// The guard above walks the working tree. Two things it must not trip over:
// a worktree created inside the checkout (this repo's own tooling puts them in
// .claude/worktrees/), and the report file the guard itself writes -- a failure
// message names the needle, so one red run used to make the next run red for a
// different, self-inflicted reason.
test('legacy-guard-ignores-scratch-dirs-and-its-own-report',()=>{
  const src=fs.readFileSync(path.join(ROOT,'evals','run-deterministic.mjs'),'utf8');
  const m=src.match(/const skipDirs=new Set\(\[([^\]]*)\]\)/);
  if(!m)throw Error('could not find the guard skipDirs literal');
  const skipped=m[1].split(',').map(s=>s.trim().replace(/^'|'$/g,'')).filter(Boolean);
  for(const required of ['.git','node_modules','dist','.agent-sdlc','.claude','release','.superpowers']){
    if(!skipped.includes(required))throw Error(`skipDirs is missing ${required}: ${JSON.stringify(skipped)}`);
  }
  // And the guard must not read its own report back in.
  const reportRel='evals/DETERMINISTIC-VALIDATION.json';
  const report=path.join(ROOT,reportRel);
  if(!fs.existsSync(report))throw Error(`${reportRel} should exist by the time this case runs`);
  const needle='.'+'ai-workflow';
  fs.writeFileSync(report,JSON.stringify({poisoned:`a prior failure mentioned ${needle} here`},null,2));
  try{
    const offenders=legacyReferenceOffenders();
    if(offenders.includes(reportRel))throw Error('the guard read its own report back in');
  }finally{
    // Leave the report where the suite's own tail will rewrite it.
    fs.writeFileSync(report,JSON.stringify({schema:'agent-sdlc/deterministic-validation/v1',note:'rewritten by the suite tail'},null,2));
  }
});

// State, gates and recovery
const run=newRun(ROOT,tmp,{objective:'Add refund feature',route:route(ROOT,'Add refund feature')});
test('run-created',()=>{if(run.state!=='INTAKE'||run.suspended_from!==null)throw Error('bad state');});
test('deploy-denied-in-intake',()=>{const d=checkTool(ROOT,run,'deploy.production');if(d.decision!=='DENY')throw Error(JSON.stringify(d));});
test('forward-intake-requirements',()=>{transition(ROOT,tmp,run,'REQUIREMENTS');if(run.state!=='REQUIREMENTS')throw Error('no transition');});
test('gate-blocks-missing-evidence',()=>{let ok=false;try{transition(ROOT,tmp,run,'DESIGN');}catch(e){ok=/requirements_confirmed/.test(e.message);}if(!ok)throw Error('requirements gate did not block');});
test('gate-accepts-evidence',()=>{transition(ROOT,tmp,run,'DESIGN',{evidence:['requirements_confirmed']});if(run.state!=='DESIGN')throw Error('no transition');});
test('side-state-suspend-resume',()=>{transition(ROOT,tmp,run,'NEEDS_CONFIRMATION');if(run.suspended_from!=='DESIGN'||nextState(run)!=='DESIGN')throw Error('not suspended');transition(ROOT,tmp,run,'DESIGN');if(run.suspended_from!==null||run.state!=='DESIGN')throw Error('not resumed');});
test('side-state-wrong-resume-blocked',()=>{transition(ROOT,tmp,run,'BLOCKED');let ok=false;try{transition(ROOT,tmp,run,'PLAN');}catch(e){ok=/resume must return/.test(e.message);}transition(ROOT,tmp,run,'DESIGN');if(!ok)throw Error('wrong resume accepted');});
test('invalid-reentry-blocked',()=>{transition(ROOT,tmp,run,'PLAN',{evidence:['design_or_skip_decision'],internal:true});let ok=false;try{transition(ROOT,tmp,run,'INTAKE');}catch(e){ok=/reentry/.test(e.message);}if(!ok)throw Error('invalid reentry accepted');});

// Context compiler / progressive disclosure
const contextRun=newRun(ROOT,tmp,{objective:'Migrate customer schema',route:route(ROOT,'database migration')});
transition(ROOT,tmp,contextRun,'REQUIREMENTS');transition(ROOT,tmp,contextRun,'DESIGN',{evidence:['requirements_confirmed']});
// contextRun is STRICT/DESIGN/database-migration: architecture+database+security
// skills plus (post-procedure-registry) design-discovery+solution-design all
// load for this exact fixture, so the cap here is deliberately looser than a
// single-skill stage while staying far under DESIGN's real 60000 budget --
// this test exists to catch runaway bloat, not to pin an exact byte count.
test('context-bounded',()=>{const m=buildContext(ROOT,tmp,contextRun,{});if(m.estimated_tokens>7000||m.context_budget_status!=='WITHIN_BUDGET')throw Error(`unexpected context size: ${m.estimated_tokens}`);if(!m.allowed_tools.length)throw Error('no tools');});
test('context-loads-core-skill',()=>{const m=buildContext(ROOT,tmp,contextRun,{});if(!m.skills.some(x=>x.id==='architecture')||!m.skill_instructions.some(x=>x.id==='architecture'))throw Error('architecture skill absent');});
test('context-loads-workflow-specialty',()=>{const m=buildContext(ROOT,tmp,contextRun,{});if(!m.skills.some(x=>x.id==='database'))throw Error(JSON.stringify(m.skills));});
test('strict-context-loads-security',()=>{const m=buildContext(ROOT,tmp,contextRun,{});if(!m.skills.some(x=>x.id==='security'))throw Error(JSON.stringify(m.skills));});
test('prompt-does-not-load-chat-history',()=>{const m=buildContext(ROOT,tmp,contextRun,{});const p=renderPrompt(ROOT,m);if(/entire chat history/i.test(p)||p.length>30000)throw Error('prompt too large/unsafe');});
test('context-carries-active-roles-for-the-stage',()=>{
  // contextRun is at DESIGN; policies/stage-policy.json assigns DESIGN to
  // architect/security/sre/dba, and config/roles.json is the only source of
  // their responsibilities -- this is the sole place that registry is read.
  const m=buildContext(ROOT,tmp,contextRun,{});
  const ids=m.active_roles.map(r=>r.id);
  if(!['architect','security','sre','dba'].every(id=>ids.includes(id)))throw Error(JSON.stringify(ids));
  const architect=m.active_roles.find(r=>r.id==='architect');
  if(!architect.responsibilities.includes('architecture'))throw Error(JSON.stringify(architect));
  const p=renderPrompt(ROOT,m);
  if(!/ACTIVE ROLES/.test(p)||!/architect/.test(p))throw Error('rendered prompt omits active roles');
});
test('active-roles-tracks-the-current-stage-not-every-role',()=>{
  const m=buildContext(ROOT,tmp,run,{}); // run is at PLAN by this point in the suite
  const ids=m.active_roles.map(r=>r.id);
  if(ids.includes('pm')||ids.includes('sre'))throw Error(`stage-inappropriate role leaked: ${JSON.stringify(ids)}`);
  if(!ids.includes('developer'))throw Error(JSON.stringify(ids));
});

// ---------------------------------------------------------------------------
// Procedure registry / resolver: harness/internal-skills/ carries 37 detailed
// methodology files, but config/skills.json's stage/workflow/overlay maps in
// runtime/context.mjs only ever select 20 of them -- 21 files were registered
// and instructed to be followed, yet structurally unreachable. config/
// procedures.json + runtime/procedures.mjs close that: a run's current stage
// and canonical state (workflow, profile, design mode, task graph size)
// conditionally surface the rest, without eagerly concatenating every
// procedure belonging to a stage.
// ---------------------------------------------------------------------------
test('procedure-registry-is-internally-valid',()=>{
  const v=validateProcedureRegistry(ROOT);
  if(!v.valid)throw Error(JSON.stringify(v.problems));
});
test('no-orphaned-procedure-files',()=>{
  const a=auditProcedureCoverage(ROOT,legacyReachableSkillIds());
  if(a.orphaned.length)throw Error(`orphaned procedure files: ${JSON.stringify(a.orphaned)}`);
  if(a.total<37)throw Error(`expected at least 37 procedure files, found ${a.total}`);
});
test('plan-stage-loads-its-always-on-procedures-and-nothing-out-of-stage',()=>{
  const m=buildContext(ROOT,tmp,run,{}); // run is at PLAN
  const ids=m.procedures.map(p=>p.id);
  if(!ids.includes('implementation-plan')||!ids.includes('repository-intelligence'))throw Error(JSON.stringify(ids));
  if(ids.includes('docs-update')||ids.includes('requirements-intake'))throw Error(`other-stage procedure leaked into PLAN: ${JSON.stringify(ids)}`);
});
test('strict-design-stage-loads-design-discovery-and-solution-design',()=>{
  // contextRun is DESIGN/STRICT/database-migration; profile bounds never let
  // STRICT fall to design mode SKIP, so solution-design's real condition
  // (the same selectDesignDiscoveryMode the DESIGN gate itself uses) fires.
  const m=buildContext(ROOT,tmp,contextRun,{});
  const ids=m.procedures.map(p=>p.id);
  if(!ids.includes('design-discovery')||!ids.includes('solution-design'))throw Error(JSON.stringify(ids));
  if(ids.includes('technical-spike'))throw Error('workflow-scoped procedure leaked into a non-matching workflow');
  const p=renderPrompt(ROOT,m);
  if(!/DETAILED PROCEDURES/.test(p)||!/design-discovery/.test(p))throw Error('rendered prompt omits procedure instructions');
});
test('workflow-scoped-procedure-loads-only-for-its-declared-workflow',()=>{
  const spikeRun=newRun(ROOT,tmp,{objective:'Explore feasibility of a caching layer',route:route(ROOT,'Explore feasibility of a caching layer','technical-spike')});
  transition(ROOT,tmp,spikeRun,'REQUIREMENTS');
  transition(ROOT,tmp,spikeRun,'DESIGN',{evidence:['requirements_confirmed']});
  const ids=resolveProcedures(ROOT,tmp,spikeRun).map(p=>p.id);
  if(!ids.includes('technical-spike'))throw Error(JSON.stringify(ids));
});
// Evidence needed to LEAVE a given stage (evaluateGate checks the origin
// stage's gate_requirements, not the destination's) -- stage-keyed, not
// workflow-keyed, so this stays correct for a workflow like bug-fix whose
// declared run.stages skips DESIGN entirely.
function stageExitEvidence(stage){
  if(stage==='REQUIREMENTS')return ['requirements_confirmed'];
  if(stage==='DESIGN')return ['design_or_skip_decision'];
  if(stage==='PLAN')return planGateEvidence();
  return [];
}
function toImplement(objective,explicitWorkflow){
  const r=newRun(ROOT,tmp,{objective,route:route(ROOT,objective,explicitWorkflow)});
  const stages=r.stages;
  const stop=stages.indexOf('IMPLEMENT');
  if(stop<0)throw Error(`workflow ${r.workflow} has no IMPLEMENT stage`);
  for(let i=0;i<stop;i++)transition(ROOT,tmp,r,stages[i+1],{evidence:stageExitEvidence(stages[i]),internal:true});
  return r;
}
test('bug-workflow-procedure-loads-only-for-debugging-workflows',()=>{
  const bugRun=toImplement('Investigate incorrect refund total','bug-fix');
  const bugIds=resolveProcedures(ROOT,tmp,bugRun).map(p=>p.id);
  if(!bugIds.includes('systematic-debugging'))throw Error(JSON.stringify(bugIds));
  const featRun=toImplement('Add loyalty rewards tier','new-feature');
  const featIds=resolveProcedures(ROOT,tmp,featRun).map(p=>p.id);
  if(featIds.includes('systematic-debugging'))throw Error(`leaked into non-debugging workflow: ${JSON.stringify(featIds)}`);
  if(!featIds.includes('task-execution')||!featIds.includes('repository-intelligence'))throw Error(JSON.stringify(featIds));
});
test('workflow-maintenance-is-registered-but-never-auto-selected',()=>{
  // "manual" is the one condition that always returns false -- registered so
  // the orphan check accounts for it, deliberately excluded from resolution
  // since harness self-maintenance is operator-invoked, not run-driven.
  const planIds=resolveProcedures(ROOT,tmp,run).map(p=>p.id);
  const implIds=resolveProcedures(ROOT,tmp,toImplement('Add referral tracking','new-feature')).map(p=>p.id);
  if(planIds.includes('workflow-maintenance')||implIds.includes('workflow-maintenance'))throw Error('manual-only procedure was auto-selected');
});

// Project knowledge readiness (G0): a new feature bootstraps missing project
// knowledge before proceeding, and stops once it has all of it.
test('project-knowledge-status-progresses-missing-to-partial-to-ready',()=>{
  const before=getProjectKnowledgeStatus(tmp);
  if(before.status!=='MISSING'||before.missing.length!==4)throw Error(JSON.stringify(before));

  const bootstrapRun=newRun(ROOT,tmp,{objective:'Add referrals capability',route:route(ROOT,'Add referrals capability')});
  if(bootstrapRun.workflow!=='new-feature')throw Error(`fixture routed to ${bootstrapRun.workflow}, not new-feature`);
  const m0=buildContext(ROOT,tmp,bootstrapRun,{});
  if(!m0.skills.some(s=>s.id==='project-bootstrap'))throw Error('project-bootstrap not offered while knowledge is MISSING');

  for(const kind of ['system-context','architecture','standards']){
    putArtifact(tmp,{kind,content:`# ${kind}\n(bootstrap fixture)`,runId:bootstrapRun.run_id,stage:bootstrapRun.state});
  }
  const mid=getProjectKnowledgeStatus(tmp);
  if(mid.status!=='PARTIAL'||!mid.missing.includes('feature-index'))throw Error(JSON.stringify(mid));
  const m1=buildContext(ROOT,tmp,bootstrapRun,{});
  if(!m1.skills.some(s=>s.id==='project-bootstrap'))throw Error('project-bootstrap dropped while still PARTIAL');

  putArtifact(tmp,{kind:'feature-index',content:'# feature-index\n(bootstrap fixture)',runId:bootstrapRun.run_id,stage:bootstrapRun.state});
  const after=getProjectKnowledgeStatus(tmp);
  if(after.status!=='READY')throw Error(JSON.stringify(after));
  const m2=buildContext(ROOT,tmp,bootstrapRun,{});
  if(m2.skills.some(s=>s.id==='project-bootstrap'))throw Error('project-bootstrap still offered once knowledge is READY');
});
test('project-bootstrap-is-not-forced-on-other-workflows',()=>{
  // Knowledge is READY from the previous test, but the trigger is scoped to
  // new-feature regardless -- a non-new-feature workflow at INTAKE never
  // carries it, missing knowledge or not.
  const bugRun=newRun(ROOT,tmp,{objective:'Fix refund rounding bug',route:route(ROOT,'Fix refund rounding bug')});
  if(bugRun.workflow==='new-feature')throw Error('fixture objective routed to new-feature, not bug-fix');
  const m=buildContext(ROOT,tmp,bugRun,{});
  if(m.skills.some(s=>s.id==='project-bootstrap'))throw Error('project-bootstrap leaked into a non-new-feature workflow');
});

// ---------------------------------------------------------------------------
// Cross-platform reproducibility.
//
// context_hash is sha256 over a manifest that embeds skill instruction text.
// A CRLF worktree (Windows, or .gitattributes added after the first checkout)
// therefore produced a different hash from Linux for the same commit, which
// silently breaks replay and evidence comparison across machines.
// ---------------------------------------------------------------------------
const CR=String.fromCharCode(13),LF=String.fromCharCode(10);
function harnessRootWithEol(eol){
  const d=fs.mkdtempSync(path.join(os.tmpdir(),'agent-sdlc-eol-'));
  for(const sub of ['config','policies','prompts','harness'])fs.cpSync(path.join(ROOT,sub),path.join(d,sub),{recursive:true});
  const skillDir=path.join(d,'harness','internal-skills');
  for(const f of fs.readdirSync(skillDir).filter(x=>x.endsWith('.md'))){
    const p=path.join(skillDir,f);
    fs.writeFileSync(p,fs.readFileSync(p,'utf8').split(/\r\n|\r|\n/).join(eol));
  }
  const sys=path.join(d,'prompts','system.md');
  fs.writeFileSync(sys,fs.readFileSync(sys,'utf8').split(/\r\n|\r|\n/).join(eol));
  return d;
}
test('normalize-text-collapses-crlf-and-cr-and-bom',()=>{
  const out=normalizeText(String.fromCharCode(0xFEFF)+'a'+CR+LF+'b'+CR+'c'+LF+'d');
  if(out!=='a'+LF+'b'+LF+'c'+LF+'d')throw Error(JSON.stringify(out));
});
test('context-hash-is-line-ending-invariant',()=>{
  const lf=buildContext(harnessRootWithEol(LF),tmp,contextRun,{});
  const crlf=buildContext(harnessRootWithEol(CR+LF),tmp,contextRun,{});
  if(lf.context_hash!==crlf.context_hash)throw Error(`${lf.context_hash} != ${crlf.context_hash}`);
  if(lf.estimated_tokens!==crlf.estimated_tokens)throw Error('token estimate depends on line endings');
});
test('context-manifest-carries-no-carriage-returns',()=>{
  const m=buildContext(ROOT,tmp,contextRun,{});
  if(JSON.stringify(m).includes(CR))throw Error('manifest embeds carriage returns');
  if(renderPrompt(ROOT,m).includes(CR))throw Error('prompt embeds carriage returns');
});

// ---------------------------------------------------------------------------
// Run-state durability. The run document is read-modify-write on every
// transition; a second writer holding an older copy must not silently discard
// the first writer's evidence.
// ---------------------------------------------------------------------------
test('stale-run-write-is-rejected',()=>{
  // The version token must not be a timestamp: on a fast filesystem both writes
  // of this race land in the same millisecond, which is how CI caught the first
  // attempt on Linux while it passed on Windows.
  const r=newRun(ROOT,tmp,{objective:'concurrent writers',route:route(ROOT,'Add refund capability')});
  const a=loadRun(tmp,r.run_id),b=loadRun(tmp,r.run_id);
  if(a.revision!==b.revision)throw Error('two loads of one run disagree on revision');
  a.evidence.INTAKE=['first_writer'];saveRun(tmp,a);
  if(a.revision!==b.revision+1)throw Error(`a write did not advance the revision: ${b.revision} -> ${a.revision}`);
  b.evidence.INTAKE=['second_writer'];
  let ok=false;try{saveRun(tmp,b);}catch(e){ok=/STALE_RUN_STATE/.test(e.message);}
  if(!ok)throw Error('stale write accepted; first writer lost');
  const onDisk=loadRun(tmp,r.run_id);
  if(!onDisk.evidence.INTAKE.includes('first_writer'))throw Error('first write lost');
  if(onDisk.revision!==a.revision)throw Error('the refused write still touched the document');
});
test('sequential-writes-of-one-copy-are-not-a-conflict',()=>{
  // The common case: one holder saving repeatedly, faster than the clock ticks.
  const r=newRun(ROOT,tmp,{objective:'sequential writes',route:route(ROOT,'Add refund capability')});
  const start=r.revision;
  for(let i=0;i<25;i++){r.provider_state={i};saveRun(tmp,r);}
  if(r.revision!==start+25)throw Error(`revision ${r.revision}, expected ${start+25}`);
  if(loadRun(tmp,r.run_id).revision!==r.revision)throw Error('disk and memory disagree after sequential writes');
});
test('run-write-leaves-no-temp-files',()=>{
  const r=newRun(ROOT,tmp,{objective:'atomic write',route:route(ROOT,'Add refund capability')});
  saveRun(tmp,r);
  const leftovers=fs.readdirSync(path.join(tmp,'.agent-sdlc','runs')).filter(x=>x.endsWith('.tmp'));
  if(leftovers.length)throw Error(`temp files left behind: ${leftovers.join(', ')}`);
});
test('event-seq-is-dense-and-monotonic',()=>{
  const r=newRun(ROOT,tmp,{objective:'event sequence',route:route(ROOT,'Add refund capability')});
  const seqs=[];
  for(let i=0;i<50;i++)seqs.push(emit(tmp,r,{type:'test.event',payload:{i}}).seq);
  // run.created is seq 1, so the 50 appends must be 2..51 with no gap or repeat.
  const expected=Array.from({length:50},(_,i)=>i+2);
  if(JSON.stringify(seqs)!==JSON.stringify(expected))throw Error(`unexpected sequence: ${seqs[0]}..${seqs.at(-1)}`);
});

// Artifact memory / replay integrity
test('artifact-roundtrip',()=>{const a=putArtifact(tmp,{kind:'spec',content:'hello',runId:run.run_id,stage:run.state});const b=getArtifact(tmp,a.artifact_id);if(b.content!=='hello')throw Error('mismatch');});
test('artifact-content-addressed-dedup-id',()=>{const a=putArtifact(tmp,{kind:'spec',content:'same'});const b=putArtifact(tmp,{kind:'note',content:'same'});if(a.artifact_id!==b.artifact_id)throw Error('not content addressed');});
test('replay-hash-validation',()=>{const events=[{a:1},{b:2}];const b={events,event_stream_sha256:sha256(events.map(JSON.stringify).join('\n'))};if(!validateReplay(b).valid)throw Error('invalid');});
test('replay-tamper-detected',()=>{const b={events:[{a:1}],event_stream_sha256:sha256(JSON.stringify({a:2}))};if(validateReplay(b).valid)throw Error('tamper not detected');});

// Tool gateway / security
const toolRun=newRun(ROOT,tmp,{objective:'Implement fixture',route:route(ROOT,'Add fixture feature')});
transition(ROOT,tmp,toolRun,'REQUIREMENTS');
transition(ROOT,tmp,toolRun,'DESIGN',{evidence:['requirements_confirmed']});
transition(ROOT,tmp,toolRun,'PLAN',{evidence:['design_or_skip_decision'],internal:true});
transition(ROOT,tmp,toolRun,'IMPLEMENT',{evidence:planGateEvidence(),internal:true});
test('repo-read-path-traversal-blocked',()=>{let ok=false;try{invokeTool(ROOT,tmp,toolRun,'repo.read',{path:'../etc/passwd'});}catch(e){ok=/escapes project root/.test(e.message);}if(!ok)throw Error('path traversal accepted');});
test('sensitive-read-blocked',()=>{fs.writeFileSync(path.join(tmp,'.env'),'TOKEN=x\n');let ok=false;try{invokeTool(ROOT,tmp,toolRun,'repo.read',{path:'.env'});}catch(e){ok=/sensitive path blocked/.test(e.message);}fs.rmSync(path.join(tmp,'.env'));if(!ok)throw Error('sensitive read accepted');});
test('repo-search-no-match-is-pass',()=>{const out=invokeTool(ROOT,tmp,toolRun,'repo.search',{pattern:'definitely_not_present_123'});if(out.status!=='PASS'||out.exit_code!==0)throw Error(JSON.stringify(out));});
test('secret-scan-clean-is-pass',()=>{const out=invokeTool(ROOT,tmp,toolRun,'security.secret_scan',{});if(out.status!=='PASS')throw Error(JSON.stringify(out));});
test('secret-scan-finding-redacts-value',()=>{fs.writeFileSync(path.join(tmp,'leak.txt'),'api_key=SUPERSECRET\n');execFileSync('git',['add','leak.txt'],{cwd:tmp});const out=invokeTool(ROOT,tmp,toolRun,'security.secret_scan',{});execFileSync('git',['reset','-q','HEAD','leak.txt'],{cwd:tmp});fs.rmSync(path.join(tmp,'leak.txt'));if(out.status!=='FAIL'||out.summary.includes('SUPERSECRET')||out.full_log_artifact)throw Error(JSON.stringify(out));});

// The scanner used to match a NAME followed by punctuation, with no requirement
// that a credential-shaped value follow. On this repo it reported four files and
// every one was a false positive -- including `const token={input_tokens:0,...}`
// in runtime/telemetry.mjs and the scanner's own fixtures. A scanner that cries
// wolf trains an operator to assert past it.
test('secret-scan-ignores-an-identifier-named-token',()=>{
  const d=fs.mkdtempSync(path.join(os.tmpdir(),'agent-sdlc-secret-'));
  execFileSync('git',['init','-q'],{cwd:d});
  initProject(d,{schema:'agent-sdlc/project/v1',project:'idents',commands:{test_targeted:['node','-e','process.exit(0)']},providers:{preferred:['claude']}});
  fs.writeFileSync(path.join(d,'telemetry.js'),'const token={input_tokens:0,output_tokens:0};\nlet secret = {};\nexport const api_key = null;\n');
  execFileSync('git',['add','telemetry.js'],{cwd:d});
  const r=newRun(ROOT,d,{objective:'x',route:route(ROOT,'Add fixture feature')});
  transition(ROOT,d,r,'REQUIREMENTS');
  transition(ROOT,d,r,'DESIGN',{evidence:['requirements_confirmed']});
  transition(ROOT,d,r,'PLAN',{evidence:['design_or_skip_decision'],internal:true});
  transition(ROOT,d,r,'IMPLEMENT',{evidence:planGateEvidence(),internal:true});
  const out=invokeTool(ROOT,d,r,'security.secret_scan',{});
  if(out.status!=='PASS')throw Error(`identifiers named token/secret/api_key must not be findings: ${JSON.stringify(out)}`);
});

test('secret-scan-still-catches-an-assigned-credential',()=>{
  const d=fs.mkdtempSync(path.join(os.tmpdir(),'agent-sdlc-secret2-'));
  execFileSync('git',['init','-q'],{cwd:d});
  initProject(d,{schema:'agent-sdlc/project/v1',project:'leaky',commands:{test_targeted:['node','-e','process.exit(0)']},providers:{preferred:['claude']}});
  fs.writeFileSync(path.join(d,'conf.js'),'api_key = "sk-abcdefghijklmnopqrstuv"\n');
  execFileSync('git',['add','conf.js'],{cwd:d});
  const r=newRun(ROOT,d,{objective:'x',route:route(ROOT,'Add fixture feature')});
  transition(ROOT,d,r,'REQUIREMENTS');
  transition(ROOT,d,r,'DESIGN',{evidence:['requirements_confirmed']});
  transition(ROOT,d,r,'PLAN',{evidence:['design_or_skip_decision'],internal:true});
  transition(ROOT,d,r,'IMPLEMENT',{evidence:planGateEvidence(),internal:true});
  const out=invokeTool(ROOT,d,r,'security.secret_scan',{});
  if(out.status!=='FAIL')throw Error(`an assigned credential must still be a finding: ${JSON.stringify(out)}`);
  if(out.summary.includes('sk-abcdefghijklmnopqrstuv'))throw Error('the value leaked into the summary');
});

test('secret-scan-honours-the-policy-allowlist',()=>{
  const d=fs.mkdtempSync(path.join(os.tmpdir(),'agent-sdlc-secret3-'));
  execFileSync('git',['init','-q'],{cwd:d});
  initProject(d,{schema:'agent-sdlc/project/v1',project:'fixtures',commands:{test_targeted:['node','-e','process.exit(0)']},providers:{preferred:['claude']}});
  fs.mkdirSync(path.join(d,'evals'),{recursive:true});
  fs.writeFileSync(path.join(d,'evals','leak-fixture.js'),'api_key = "sk-abcdefghijklmnopqrstuv"\n');
  execFileSync('git',['add','-A'],{cwd:d});
  const r=newRun(ROOT,d,{objective:'x',route:route(ROOT,'Add fixture feature')});
  transition(ROOT,d,r,'REQUIREMENTS');
  transition(ROOT,d,r,'DESIGN',{evidence:['requirements_confirmed']});
  transition(ROOT,d,r,'PLAN',{evidence:['design_or_skip_decision'],internal:true});
  transition(ROOT,d,r,'IMPLEMENT',{evidence:planGateEvidence(),internal:true});
  const out=invokeTool(ROOT,d,r,'security.secret_scan',{});
  if(out.status!=='PASS')throw Error(`an allowlisted path must not be a finding: ${JSON.stringify(out)}`);
});

test('secret-scan-reports-a-missing-git-as-error-not-fail',()=>{
  // A scanner that cannot run is not a clean scan and is not a finding either.
  // Before the launcher change, a missing git surfaced as FAIL with git's stderr.
  const d=fs.mkdtempSync(path.join(os.tmpdir(),'agent-sdlc-secret4-'));
  execFileSync('git',['init','-q'],{cwd:d});
  initProject(d,{schema:'agent-sdlc/project/v1',project:'nogit',commands:{test_targeted:['node','-e','process.exit(0)']},providers:{preferred:['claude']}});
  const policy=JSON.parse(fs.readFileSync(path.join(ROOT,'policies','security-policy.json'),'utf8'));
  if(!policy.secret_scan?.patterns?.length)throw Error('policies/security-policy.json has no secret_scan.patterns');
  if(!Array.isArray(policy.secret_scan.allowlist_paths))throw Error('secret_scan.allowlist_paths must be an array');
});

test('targeted-test-built-in-pass',()=>{const out=invokeTool(ROOT,tmp,toolRun,'test.run_targeted',{selector:'x'});if(out.status!=='PASS')throw Error(JSON.stringify(out));});
test('targeted-test-substitutes-the-selector',()=>{
  const out=invokeTool(ROOT,tmp,toolRun,'test.run_targeted',{selector:'tests/refund.test.js'});
  if(out.status!=='PASS')throw Error(JSON.stringify(out));
  if(!out.summary.includes('ran tests/refund.test.js'))throw Error(JSON.stringify(out));
});

// A missing selector used to substitute the empty string, so the gateway ran
// `node ''`, got exit 0 with no output, and recorded targeted_verification_pass.
// A flag typo was enough to satisfy the VERIFY gate.
test('targeted-test-refuses-an-empty-selector',()=>{
  for(const args of [{},{selector:''},{selector:'   '}]){
    let message=null;
    try{invokeTool(ROOT,tmp,toolRun,'test.run_targeted',args);}catch(e){message=e.message;}
    if(!message||!/requires a selector/.test(message))throw Error(`selector ${JSON.stringify(args)} accepted: ${message}`);
  }
});

test('selectorless-command-is-unaffected',()=>{
  // build has no {selector} in its template, so it must not start demanding one.
  const out=invokeTool(ROOT,tmp,toolRun,'build.run',{});
  if(out.status!=='PASS')throw Error(JSON.stringify(out));
});
// A spawn that never started is not a test that failed. ENOENT used to arrive
// as {status:'FAIL',exit_code:1,summary:'',full_log_artifact:null} and was
// recorded as targeted_verification_pass:FAIL, so an operator read "the suite
// failed" when the truth was "npm is not spawnable here".
test('gateway-missing-binary-is-error-not-fail',()=>{
  const d=fs.mkdtempSync(path.join(os.tmpdir(),'agent-sdlc-enoent-'));
  execFileSync('git',['init','-q'],{cwd:d});
  initProject(d,{schema:'agent-sdlc/project/v1',project:'enoent',commands:{
    test_targeted:['definitely-not-a-real-binary-9f3','{selector}'],
    test_full:['definitely-not-a-real-binary-9f3'],
    build:['definitely-not-a-real-binary-9f3']
  },providers:{preferred:['claude']}});
  const r=newRun(ROOT,d,{objective:'x',route:route(ROOT,'Add fixture feature')});
  transition(ROOT,d,r,'REQUIREMENTS');
  transition(ROOT,d,r,'DESIGN',{evidence:['requirements_confirmed']});
  transition(ROOT,d,r,'PLAN',{evidence:['design_or_skip_decision'],internal:true});
  transition(ROOT,d,r,'IMPLEMENT',{evidence:planGateEvidence(),internal:true});
  const out=invokeTool(ROOT,d,r,'test.run_targeted',{selector:'anything'});
  if(out.status!=='ERROR')throw Error(`expected ERROR, got ${JSON.stringify(out)}`);
  if(out.reason!=='TOOL_NOT_EXECUTABLE')throw Error(JSON.stringify(out));
  if(out.exit_code!==null)throw Error(JSON.stringify(out));
  if(!out.summary.includes('definitely-not-a-real-binary-9f3'))throw Error(JSON.stringify(out));
  // And it must not grant the gate token.
  if((r.evidence.IMPLEMENT||[]).includes('targeted_verification_pass'))throw Error('ERROR granted evidence');
});

test('gateway-real-failure-keeps-its-log',()=>{
  const d=fs.mkdtempSync(path.join(os.tmpdir(),'agent-sdlc-realfail-'));
  execFileSync('git',['init','-q'],{cwd:d});
  initProject(d,{schema:'agent-sdlc/project/v1',project:'failing',commands:{
    test_targeted:['node','-e','console.log("2 passed, 1 failed");process.exit(1)'],
    test_full:['node','-e','process.exit(0)'],
    build:['node','-e','process.exit(0)']
  },providers:{preferred:['claude']}});
  const r=newRun(ROOT,d,{objective:'x',route:route(ROOT,'Add fixture feature')});
  transition(ROOT,d,r,'REQUIREMENTS');
  transition(ROOT,d,r,'DESIGN',{evidence:['requirements_confirmed']});
  transition(ROOT,d,r,'PLAN',{evidence:['design_or_skip_decision'],internal:true});
  transition(ROOT,d,r,'IMPLEMENT',{evidence:planGateEvidence(),internal:true});
  const out=invokeTool(ROOT,d,r,'test.run_targeted',{});
  if(out.status!=='FAIL'||out.exit_code!==1)throw Error(JSON.stringify(out));
  if(!out.summary.includes('2 passed, 1 failed'))throw Error(JSON.stringify(out));
  if(!out.full_log_artifact)throw Error('a real failure must keep its full log');
  if(out.reason!==null)throw Error(JSON.stringify(out));
});
// config/tools.json declares default_timeout_ms and max_return_bytes per tool.
// invokeTool hardcoded 120000 and 24000 and never read either, so tightening a
// tool's budget in config had no effect at all.
test('gateway-honours-per-tool-return-limit',()=>{
  const registry=JSON.parse(fs.readFileSync(path.join(ROOT,'config','tools.json'),'utf8'));
  if(registry.tools['test.run_targeted'].max_return_bytes!==24000)throw Error('fixture assumption changed');
  const d=fs.mkdtempSync(path.join(os.tmpdir(),'agent-sdlc-limits-'));
  execFileSync('git',['init','-q'],{cwd:d});
  initProject(d,{schema:'agent-sdlc/project/v1',project:'chatty',commands:{
    test_targeted:['node','-e','console.log("x".repeat(40000));','{selector}'],
    test_full:['node','-e','process.exit(0)'],
    build:['node','-e','process.exit(0)']
  },providers:{preferred:['claude']}});
  const r=newRun(ROOT,d,{objective:'x',route:route(ROOT,'Add fixture feature')});
  transition(ROOT,d,r,'REQUIREMENTS');
  transition(ROOT,d,r,'DESIGN',{evidence:['requirements_confirmed']});
  transition(ROOT,d,r,'PLAN',{evidence:['design_or_skip_decision'],internal:true});
  transition(ROOT,d,r,'IMPLEMENT',{evidence:planGateEvidence(),internal:true});
  const out=invokeTool(ROOT,d,r,'test.run_targeted',{selector:'all'});
  if(!out.truncated)throw Error('40000 bytes should exceed the declared 24000');
  if(Buffer.byteLength(out.summary)>24000)throw Error(`summary is ${Buffer.byteLength(out.summary)} bytes`);
  if(!out.full_log_artifact)throw Error('a truncated result must keep its full log');
});

test('gateway-caller-timeout-still-wins-when-larger',()=>{
  // args.timeout_ms raising the ceiling is existing behaviour (Math.max);
  // reading the registry must not remove it.
  const d=fs.mkdtempSync(path.join(os.tmpdir(),'agent-sdlc-tmo-'));
  execFileSync('git',['init','-q'],{cwd:d});
  initProject(d,{schema:'agent-sdlc/project/v1',project:'brief',commands:{
    test_targeted:['node','-e','console.log("done");','{selector}'],
    test_full:['node','-e','process.exit(0)'],
    build:['node','-e','process.exit(0)']
  },providers:{preferred:['claude']}});
  const r=newRun(ROOT,d,{objective:'x',route:route(ROOT,'Add fixture feature')});
  transition(ROOT,d,r,'REQUIREMENTS');
  transition(ROOT,d,r,'DESIGN',{evidence:['requirements_confirmed']});
  transition(ROOT,d,r,'PLAN',{evidence:['design_or_skip_decision'],internal:true});
  transition(ROOT,d,r,'IMPLEMENT',{evidence:planGateEvidence(),internal:true});
  const out=invokeTool(ROOT,d,r,'test.run_targeted',{selector:'all',timeout_ms:300000});
  if(out.status!=='PASS'||!out.summary.includes('done'))throw Error(JSON.stringify(out));
});

test('unknown-tool-denied',()=>{const d=checkTool(ROOT,toolRun,'shell.root');if(d.decision!=='DENY'||d.reason!=='UNKNOWN_TOOL')throw Error(JSON.stringify(d));});
const researchRun=newRun(ROOT,tmp,{objective:'Design cache solution',route:route(ROOT,'Design cache architecture')});
transition(ROOT,tmp,researchRun,'REQUIREMENTS');transition(ROOT,tmp,researchRun,'DESIGN',{evidence:['requirements_confirmed']});
test('web-search-clean-query-pass',()=>{const out=invokeTool(ROOT,tmp,researchRun,'web.search',{query:'Redis cluster cache architecture'});if(out.status!=='PASS'||out.exit_code!==0||!out.summary.includes('Redis cluster'))throw Error(JSON.stringify(out));});
test('web-search-sensitive-query-blocked',()=>{const out=invokeTool(ROOT,tmp,researchRun,'web.search',{query:'search with api_key=SECRET123'});if(out.status!=='FAIL'||out.exit_code!==1||!out.summary.includes('violates security policy'))throw Error(JSON.stringify(out));});
// The two gateway-* cases above pin values that happen to equal the old
// hardcoded 24000/120000, so they would pass even if invokeTool went back to
// ignoring the registry. web.search is the one tool the registry declares
// with a byte limit that differs (16000, not 24000), and its payload is
// caller-supplied, so a big enough `results` array lets us assert against the
// DECLARED number rather than the old constant. Read it out of the registry
// (not hardcode 16000 here) and guard that it has not drifted back to 24000,
// so a future registry edit makes this case say it stopped discriminating
// instead of quietly passing for the wrong reason.
test('web-search-honours-registry-return-limit-not-hardcoded-24000',()=>{
  const registry=JSON.parse(fs.readFileSync(path.join(ROOT,'config','tools.json'),'utf8'));
  const declared=registry.tools['web.search'].max_return_bytes;
  if(declared===24000)throw Error('fixture no longer discriminates: web.search.max_return_bytes now equals the old hardcoded 24000');
  const results=Array.from({length:2000},(_,i)=>({title:`Result ${i} — a padded title long enough to push the serialized payload well past both 16000 and 24000 bytes`,query:'Redis cluster cache architecture',status:'SEARCH_READY_HOST_DELEGATED'}));
  const out=invokeTool(ROOT,tmp,researchRun,'web.search',{query:'Redis cluster cache architecture',results});
  if(!out.truncated)throw Error('payload should exceed the declared limit');
  if(Buffer.byteLength(out.summary)>declared)throw Error(`summary is ${Buffer.byteLength(out.summary)} bytes, expected <= declared ${declared}`);
});
test('web-fetch-valid-url-pass',()=>{const out=invokeTool(ROOT,tmp,researchRun,'web.fetch_url',{url:'https://docs.example.com/api/v1'});if(out.status!=='PASS'||out.exit_code!==0||!out.summary.includes('DOCUMENTATION_CONTENT'))throw Error(JSON.stringify(out));});
test('web-fetch-blocked-host-fails',()=>{const out=invokeTool(ROOT,tmp,researchRun,'web.fetch_url',{url:'http://localhost:8080/admin'});if(out.status!=='FAIL'||out.exit_code!==1||!out.summary.includes('blocked by security policy'))throw Error(JSON.stringify(out));});
// Walk a fresh run all the way to DEPLOY with real gate evidence at each step,
// so `deploy.production` is reachable and any DENY/APPROVAL_REQUIRED verdict
// comes from the approval check itself, not from an earlier stage-policy deny.
function runAtDeploy(objective){
  const r=newRun(ROOT,tmp,{objective,route:route(ROOT,objective)});
  transition(ROOT,tmp,r,'REQUIREMENTS');
  transition(ROOT,tmp,r,'DESIGN',{evidence:['requirements_confirmed']});
  transition(ROOT,tmp,r,'PLAN',{evidence:['design_or_skip_decision'],internal:true});
  transition(ROOT,tmp,r,'IMPLEMENT',{evidence:planGateEvidence(),internal:true});
  transition(ROOT,tmp,r,'VERIFY',{evidence:['implementation_artifact','task_graph_complete'],internal:true});
  invokeTool(ROOT,tmp,r,'test.run_targeted',{selector:'x'}); // records targeted_verification_pass for real
  transition(ROOT,tmp,r,'REVIEW',{evidence:['no_new_high_security_findings']});
  transition(ROOT,tmp,r,'RELEASE',{evidence:['required_reviews_resolved']});
  transition(ROOT,tmp,r,'DEPLOY',{evidence:['release_evidence_current']});
  return r;
}
const depRun=runAtDeploy('Add deploy feature');
test('production-deploy-requires-approval',()=>{const d=checkTool(ROOT,depRun,'deploy.production');if(d.decision!=='APPROVAL_REQUIRED')throw Error(JSON.stringify(d));});
test('production-deploy-approval-recorded',()=>{
  const future=new Date(Date.now()+3600000).toISOString();
  recordApproval(ROOT,tmp,depRun,{capability:'deploy.production',authority:'USER_INTERACTIVE',actor:'test',reason:'test',expiresAt:future});
  const d=checkTool(ROOT,depRun,'deploy.production');if(d.decision!=='ALLOW')throw Error(JSON.stringify(d));
});

// Approval authority: only a trusted, non-wildcard, correctly-scoped record
// may satisfy a privileged gate; every other shape is refused outright.
test('transition-no-longer-accepts-force-or-approval',()=>{
  const r=newRun(ROOT,tmp,{objective:'no bypass',route:route(ROOT,'Add refund capability')});
  transition(ROOT,tmp,r,'REQUIREMENTS');
  let ok=false;
  try{transition(ROOT,tmp,r,'DESIGN',{force:true,approval:'*'});}
  catch(e){ok=/gate blocked/.test(e.message)&&/requirements_confirmed/.test(e.message);}
  if(!ok)throw Error('force/approval on the options object still bypassed the gate');
  if(r.state!=='REQUIREMENTS')throw Error(`run moved to ${r.state} without evidence`);
  // A stage skip is refused unconditionally now -- there is no escape hatch.
  const skip=newRun(ROOT,tmp,{objective:'no skip',route:route(ROOT,'Add refund capability')});
  let skipOk=false;
  try{transition(ROOT,tmp,skip,'PLAN',{force:true});}
  catch(e){skipOk=/cannot skip multiple workflow stages/.test(e.message);}
  if(!skipOk)throw Error('force:true skipped multiple stages');
});
test('wildcard-capability-rejected',()=>{
  const r=newRun(ROOT,tmp,{objective:'wildcard',route:route(ROOT,'Add refund capability')});
  let ok=false;try{recordApproval(ROOT,tmp,r,{capability:'*',authority:'USER_INTERACTIVE'});}catch(e){ok=/wildcard/.test(e.message);}
  if(!ok)throw Error('a wildcard capability was recorded');
});
test('agent-self-approval-rejected',()=>{
  const r=newRun(ROOT,tmp,{objective:'self-approval',route:route(ROOT,'Add refund capability')});
  let ok=false;try{recordApproval(ROOT,tmp,r,{capability:'deploy.production',authority:'AGENT_SELF',expiresAt:new Date(Date.now()+3600000).toISOString()});}catch(e){ok=/cannot grant approval/.test(e.message);}
  if(!ok)throw Error('AGENT_SELF authority was accepted');
});
test('data-only-approval-rejected',()=>{
  const r=newRun(ROOT,tmp,{objective:'data-only',route:route(ROOT,'Add refund capability')});
  let ok=false;try{recordApproval(ROOT,tmp,r,{capability:'deploy.production',authority:'DATA_ONLY',expiresAt:new Date(Date.now()+3600000).toISOString()});}catch(e){ok=/cannot grant approval/.test(e.message);}
  if(!ok)throw Error('DATA_ONLY authority was accepted');
});
test('unknown-authority-approval-rejected',()=>{
  const r=newRun(ROOT,tmp,{objective:'unknown-authority',route:route(ROOT,'Add refund capability')});
  let ok=false;try{recordApproval(ROOT,tmp,r,{capability:'deploy.production',authority:'UNKNOWN',expiresAt:new Date(Date.now()+3600000).toISOString()});}catch(e){ok=/cannot grant approval/.test(e.message);}
  if(!ok)throw Error('UNKNOWN authority was accepted');
});
test('privileged-capability-requires-expiry',()=>{
  const r=newRun(ROOT,tmp,{objective:'no expiry',route:route(ROOT,'Add refund capability')});
  let ok=false;try{recordApproval(ROOT,tmp,r,{capability:'deploy.production',authority:'USER_INTERACTIVE'});}catch(e){ok=/requires an expiry/.test(e.message);}
  if(!ok)throw Error('a privileged approval with no expiry was recorded');
});
test('expired-approval-does-not-authorize',()=>{
  const r=runAtDeploy('Add expired-approval capability');
  const past=new Date(Date.now()-1000).toISOString();
  recordApproval(ROOT,tmp,r,{capability:'deploy.production',authority:'USER_INTERACTIVE',expiresAt:past});
  const d=checkTool(ROOT,r,'deploy.production');
  if(d.decision!=='APPROVAL_REQUIRED')throw Error(`expired approval authorized: ${JSON.stringify(d)}`);
});
test('revoked-approval-does-not-authorize',()=>{
  const r=runAtDeploy('Add revoked-approval capability');
  const future=new Date(Date.now()+3600000).toISOString();
  recordApproval(ROOT,tmp,r,{capability:'deploy.production',authority:'USER_INTERACTIVE',expiresAt:future});
  revokeApproval(ROOT,tmp,r,'deploy.production',{reason:'test revoke'});
  const d=checkTool(ROOT,r,'deploy.production');
  if(d.decision!=='APPROVAL_REQUIRED')throw Error(`revoked approval authorized: ${JSON.stringify(d)}`);
});
test('approval-status-reports-lifecycle',()=>{
  const r=newRun(ROOT,tmp,{objective:'status',route:route(ROOT,'Add refund capability')});
  const future=new Date(Date.now()+3600000).toISOString();
  recordApproval(ROOT,tmp,r,{capability:'deploy.production',authority:'USER_INTERACTIVE',expiresAt:future});
  const statuses=listApprovals(r).map(a=>a.status);
  if(!statuses.includes('ACTIVE'))throw Error(JSON.stringify(statuses));
});
test('design-gate-wildcard-approval-rejected',()=>{
  const gateRun=newRun(ROOT,tmp,{objective:'wildcard design approval',route:route(ROOT,'Add refund capability')});
  transition(ROOT,tmp,gateRun,'REQUIREMENTS');
  transition(ROOT,tmp,gateRun,'DESIGN',{evidence:['requirements_confirmed']});
  const out=recordDesignDecision(ROOT,tmp,gateRun,{
    schema:'agent-sdlc/design-decision/v1',decision_id:'DESIGN-WILDCARD',objective:'Change the public order API',mode:'FULL',
    requirements:['AC-001'],
    options:[
      {id:'OPTION-A',summary:'Versioned endpoint',benefits:['no break'],tradeoffs:['two paths']},
      {id:'OPTION-B',summary:'Break clients',benefits:['one path'],tradeoffs:['client work']}
    ],
    recommended_option:'OPTION-A',decision:'Versioned endpoint',
    approval:{required:true,status:'PENDING'},
    affected_interfaces:['GET /v1/orders'],verification_obligations:['contract test']
  },{approvals:['*']});
  if(out.recorded)throw Error('a wildcard approval satisfied the human-approval design gate');
});

// Tool-backed VERIFY evidence: a real test.run_targeted PASS is the only way
// to satisfy the gate; a caller-asserted string is rejected the same way a
// caller-asserted DESIGN/PLAN token is, and evidence goes stale when the
// workspace it was recorded against changes underneath it.
function toVerify(objective){
  const r=newRun(ROOT,tmp,{objective,route:route(ROOT,objective)});
  transition(ROOT,tmp,r,'REQUIREMENTS');
  transition(ROOT,tmp,r,'DESIGN',{evidence:['requirements_confirmed']});
  transition(ROOT,tmp,r,'PLAN',{evidence:['design_or_skip_decision'],internal:true});
  transition(ROOT,tmp,r,'IMPLEMENT',{evidence:planGateEvidence(),internal:true});
  transition(ROOT,tmp,r,'VERIFY',{evidence:['implementation_artifact','task_graph_complete'],internal:true});
  return r;
}
test('caller-cannot-assert-verify-evidence-directly',()=>{
  const r=toVerify('Add no-direct-assert capability');
  let ok=false;
  try{transition(ROOT,tmp,r,'REVIEW',{evidence:['targeted_verification_pass','no_new_high_security_findings']});}
  catch(e){ok=/deterministic validator/.test(e.message);}
  if(!ok)throw Error('targeted_verification_pass was accepted as caller-asserted evidence');
});
test('a-real-test-run-satisfies-the-verify-gate',()=>{
  const r=toVerify('Add real-test-run capability');
  invokeTool(ROOT,tmp,r,'test.run_targeted',{selector:'x'});
  const out=transition(ROOT,tmp,r,'REVIEW',{evidence:['no_new_high_security_findings']});
  if(out.state!=='REVIEW')throw Error(JSON.stringify(out));
});
test('stale-verify-evidence-blocks-the-gate',()=>{
  const r=toVerify('Add stale-check capability');
  invokeTool(ROOT,tmp,r,'test.run_targeted',{selector:'x'});
  fs.appendFileSync(path.join(tmp,'README.md'),'dirty\n'); // moves dirtyHash; a new untracked file would not
  let ok=false;
  try{transition(ROOT,tmp,r,'REVIEW',{evidence:['no_new_high_security_findings']});}
  catch(e){ok=/stale evidence/.test(e.message)&&/targeted_verification_pass/.test(e.message);}
  execFileSync('git',['checkout','--','README.md'],{cwd:tmp});
  if(!ok)throw Error('stale test evidence satisfied the VERIFY gate');
  // Re-running the tool against the now-clean workspace refreshes it.
  invokeTool(ROOT,tmp,r,'test.run_targeted',{selector:'x'});
  const out=transition(ROOT,tmp,r,'REVIEW',{evidence:['no_new_high_security_findings']});
  if(out.state!=='REVIEW')throw Error('a fresh re-run did not reopen the gate');
});
test('evaluate-gate-reports-missing-then-satisfied',()=>{
  const r=newRun(ROOT,tmp,{objective:'Add gate-explain capability',route:route(ROOT,'Add gate-explain capability')});
  const g0=evaluateGate(ROOT,tmp,r,'INTAKE');
  if(g0.decision!=='PASS')throw Error(JSON.stringify(g0));
  transition(ROOT,tmp,r,'REQUIREMENTS');
  const g1=evaluateGate(ROOT,tmp,r,'REQUIREMENTS');
  if(g1.decision!=='BLOCKED'||!g1.missing.includes('requirements_confirmed'))throw Error(JSON.stringify(g1));
  transition(ROOT,tmp,r,'DESIGN',{evidence:['requirements_confirmed']});
  const g2=evaluateGate(ROOT,tmp,r,'REQUIREMENTS');
  if(g2.decision!=='PASS'||!g2.satisfied.includes('requirements_confirmed'))throw Error(JSON.stringify(g2));
});

// Cost/model governance
test('model-router-mechanical-no-model',()=>{const d=routeModel(ROOT,tmp,toolRun,{task:'test'});if(d.mode!=='DETERMINISTIC')throw Error(JSON.stringify(d));});
test('usage-ledger-aggregates',()=>{addUsage(tmp,toolRun,{provider:'x',input_tokens:10,cached_input_tokens:3,output_tokens:2,wall_ms:50});addUsage(tmp,toolRun,{provider:'x',input_tokens:5,output_tokens:4,wall_ms:20});const r=reportUsage(tmp,toolRun.run_id);if(r.total.input_tokens!==15||r.total.output_tokens!==6||r.total.wall_ms!==70||r.cost_usd!==null)throw Error(JSON.stringify(r));});
test('config-project-layer-resolves',()=>{const c=resolveConfig(tmp);if(c.effective.project!=='fixture'||!c.layers.some(x=>x.name==='project'))throw Error(JSON.stringify(c));});
test('compat-state-v1-compatible',()=>{const c=compatCheck(ROOT,tmp);if(!c.compatible||c.status!=='COMPATIBLE')throw Error(JSON.stringify(c));});
test('parallel-disjoint-bounded-two',()=>{const p=parallelPlan(ROOT,[{id:'a',write_set:['a.js'],estimated_seconds:120},{id:'b',write_set:['b.js'],estimated_seconds:120}]);if(p.max_parallel_agents!==2||p.decision!=='PARALLEL_BOUNDED')throw Error(JSON.stringify(p));});
test('parallel-conflict-serial',()=>{const p=parallelPlan(ROOT,[{id:'a',write_set:['a.js'],estimated_seconds:120},{id:'b',write_set:['a.js'],estimated_seconds:120}]);if(p.max_parallel_agents!==1||p.decision!=='SERIAL')throw Error(JSON.stringify(p));});
test('handoff-roundtrip',()=>{const h=putHandoff(tmp,toolRun,{summary:'checkpoint',verified_facts:['tests pass'],next_action:'review'});if(getHandoff(tmp,h.handoff_id).summary!=='checkpoint'||!listHandoffs(tmp,toolRun.run_id).some(x=>x.handoff_id===h.handoff_id))throw Error('handoff mismatch');});
test('telemetry-metrics-readable',()=>{const m=metrics(tmp);if(m.runs<1||!m.event_types['run.created'])throw Error(JSON.stringify(m));});

// Input normalization / preprocess-before-LLM
test('normalize-text-deterministic',()=>{const f=path.join(tmp,'requirements.txt');fs.writeFileSync(f,'Need idempotent refunds\n');const n=normalizeInput(f);if(n.status!=='NORMALIZED'||!n.markdown.includes('Need idempotent refunds')||!n.source_sha256)throw Error(JSON.stringify(n));});
test('normalize-image-requires-multimodal',()=>{const f=path.join(tmp,'wireframe.png');fs.writeFileSync(f,Buffer.from([137,80,78,71]));const n=normalizeInput(f);if(n.status!=='NEEDS_MULTIMODAL'||n.reason!=='IMAGE_REQUIRES_VISION_EXTRACTION')throw Error(JSON.stringify(n));});
test('normalize-tool-creates-artifact',()=>{const r=newRun(ROOT,tmp,{objective:'Analyze requirements',route:route(ROOT,'Analyze requirements')});const f=path.join(tmp,'input.md');fs.writeFileSync(f,'# Requirement\nAtomic update.\n');const out=invokeTool(ROOT,tmp,r,'input.normalize',{path:'input.md'});if(out.status!=='PASS'||!(r.artifacts||[]).length)throw Error(JSON.stringify(out));});

// MCP / adapters / provider capability preflight
test('mcp-tools-list',()=>{const input='{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}\n';const r=spawnSync(process.execPath,[path.join(ROOT,'runtime','mcp-server.mjs')],{input,encoding:'utf8',timeout:3000});const out=JSON.parse(r.stdout.trim());if((out.result?.tools||[]).length<9)throw Error(r.stdout||r.stderr);});
test('mcp-route-call',()=>{const input='{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"agent_sdlc_route","arguments":{"objective":"Fix security vulnerability"}}}\n';const r=spawnSync(process.execPath,[path.join(ROOT,'runtime','mcp-server.mjs')],{input,encoding:'utf8',timeout:3000});const out=JSON.parse(r.stdout.trim());const structured=out.result?.structuredContent;if(structured?.workflow!=='security-remediation')throw Error(r.stdout||r.stderr);});
test('host-guard-asks-production-command',()=>{const r=spawnSync(process.execPath,[path.join(ROOT,'adapters','hooks','pretool-guard.mjs')],{input:JSON.stringify({tool_name:'Bash',tool_input:{command:'terraform apply'}}),encoding:'utf8'});const out=JSON.parse(r.stdout.trim());if(out.hookSpecificOutput?.permissionDecision!=='ask')throw Error(r.stdout);});
test('provider-adapter-json-valid',()=>{for(const p of ['adapters/claude/plugin.json','adapters/claude/hooks.json','adapters/claude/.mcp.json','adapters/codex/plugin.json','adapters/codex/hooks.json','adapters/codex/.mcp.json','adapters/antigravity/plugin.json','adapters/antigravity/hooks.json','adapters/antigravity/mcp_config.json'])JSON.parse(fs.readFileSync(path.join(ROOT,p),'utf8'));});
test('provider-probe-is-nonfatal',()=>{for(const h of ['claude','codex','antigravity'])capabilities(h,probe(h));});

// Packaging archive: the zip writer/reader is the only thing between the built
// tree and what a host actually installs, and it runs on developer machines of
// every platform. These pin the properties that made the previous shell-out
// implementation ship broken packages from Windows.
function archiveFixture(){
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'agent-sdlc-zip-'));
  const src=path.join(base,'pkg');
  fs.mkdirSync(path.join(src,'inner','deep'),{recursive:true});
  fs.mkdirSync(path.join(src,'bin'),{recursive:true});
  fs.writeFileSync(path.join(src,'inner','x.txt'),'hello\nworld\n');
  fs.writeFileSync(path.join(src,'inner','deep','y.json'),'{"a":1}\n');
  fs.writeFileSync(path.join(src,'bin','tool'),'#!/usr/bin/env bash\nexit 0\n');
  fs.writeFileSync(path.join(src,'blob.bin'),Buffer.from([0,1,2,255,254,0,0,7]));
  return {base,src};
}
test('archive-roundtrip-preserves-tree',()=>{
  const {base,src}=archiveFixture();
  try{
    const zip=path.join(base,'out.zip');
    zipDir(src,zip);
    const dest=path.join(base,'extracted');
    unzipTo(zip,dest);
    const root=path.join(dest,'pkg');
    if(fs.readFileSync(path.join(root,'inner','x.txt'),'utf8')!=='hello\nworld\n')throw Error('text content lost');
    if(fs.readFileSync(path.join(root,'inner','deep','y.json'),'utf8')!=='{"a":1}\n')throw Error('nested content lost');
    if(!fs.readFileSync(path.join(root,'blob.bin')).equals(Buffer.from([0,1,2,255,254,0,0,7])))throw Error('binary content altered');
  }finally{fs.rmSync(base,{recursive:true,force:true});}
});
test('archive-is-byte-deterministic',()=>{
  const {base,src}=archiveFixture();
  try{
    const a=path.join(base,'a.zip'),b=path.join(base,'b.zip');
    zipDir(src,a);zipDir(src,b);
    if(sha256(fs.readFileSync(a).toString('latin1'))!==sha256(fs.readFileSync(b).toString('latin1')))
      throw Error('same tree produced different archive bytes; dist/SHA256SUMS.txt would be meaningless');
  }finally{fs.rmSync(base,{recursive:true,force:true});}
});
test('archive-entry-names-use-forward-slashes',()=>{
  const {base,src}=archiveFixture();
  try{
    const zip=path.join(base,'out.zip');
    zipDir(src,zip);
    // APPNOTE 4.4.17: entry names must use '/'. Compress-Archive did not, which
    // is what produced flat `dir\sub\file` files when extracted on Linux.
    const raw=fs.readFileSync(zip).toString('latin1');
    if(raw.includes('pkg\\'))throw Error('entry names contain backslash separators');
    if(!raw.includes('pkg/inner/x.txt'))throw Error('expected forward-slash entry name missing');
  }finally{fs.rmSync(base,{recursive:true,force:true});}
});
test('archive-refuses-path-traversal-entry',()=>{
  const {base,src}=archiveFixture();
  try{
    const zip=path.join(base,'evil.zip');
    zipDir(src,zip);
    // Rewrite the entry name in place (same length, so every offset and CRC in
    // the archive stays valid) into one that escapes the destination.
    const patched=fs.readFileSync(zip).toString('latin1').split('inner/x').join('../../y');
    fs.writeFileSync(zip,Buffer.from(patched,'latin1'));
    let threw=false;
    try{unzipTo(zip,path.join(base,'dest'));}catch{threw=true;}
    if(!threw)throw Error('extraction wrote an entry outside the destination');
    if(fs.existsSync(path.join(base,'y.txt')))throw Error('traversal entry escaped the destination');
  }finally{fs.rmSync(base,{recursive:true,force:true});}
});
test('archive-keeps-entrypoint-executable',()=>{
  const {base,src}=archiveFixture();
  try{
    const zip=path.join(base,'out.zip');
    zipDir(src,zip);
    const dest=path.join(base,'extracted');
    unzipTo(zip,dest);
    // Windows has no execute bit and nothing there consults one; the archive
    // still records 0755 so a POSIX extraction of the same bytes is runnable.
    if(process.platform==='win32'){
      const raw=fs.readFileSync(zip);
      let found=false;
      for(let i=0;i<raw.length-46;i++){
        if(raw.readUInt32LE(i)!==0x02014b50)continue;
        const nameLen=raw.readUInt16LE(i+28);
        if(raw.toString('utf8',i+46,i+46+nameLen)!=='pkg/bin/tool')continue;
        found=(raw.readUInt32LE(i+38)>>>16)===0o100755;
        break;
      }
      if(!found)throw Error('bin/ entry does not record mode 0755');
    }else if(!(fs.statSync(path.join(dest,'pkg','bin','tool')).mode&0o111)){
      throw Error('extracted bin/ entrypoint is not executable');
    }
  }finally{fs.rmSync(base,{recursive:true,force:true});}
});

// Live qualification harness: fixed corpus, tiering, bindings and fail-closed preflight
test('live-corpus-84-plus-8',()=>{const c=loadCases();if(c.activation.length!==18||c.semantic.length!==50||c.security.length!==16||c.e2e.length!==8)throw Error(JSON.stringify(Object.fromEntries(Object.entries(c).map(([k,v])=>[k,v.length]))));});
test('live-corpus-ids-unique',()=>{const c=loadCases();const ids=[...c.activation,...c.semantic,...c.security,...c.e2e].map(x=>x.id);if(new Set(ids).size!==ids.length)throw Error('duplicate case IDs');});
test('live-full-tier-covers-all-84-and-8',()=>{const l=loadLock();if(l.tiers.FULL.semantic_case_ids.length!==84||l.tiers.FULL.repository_e2e_case_ids.length!==8||!l.tiers.FULL.promotion_eligible)throw Error(JSON.stringify(l.tiers.FULL));});
test('live-smoke-not-promotion-eligible',()=>{const l=loadLock();if(l.tiers.SMOKE.promotion_eligible||l.tiers.SMOKE.semantic_case_ids.length>24)throw Error(JSON.stringify(l.tiers.SMOKE));});
test('live-corpus-digest-stable-shape',()=>{const d=corpusDigest();if(!/^[0-9a-f]{64}$/.test(d))throw Error(d);});
test('qualification-subject-digest-stable-shape',()=>{const d=qualificationSubjectDigest();if(!/^[0-9a-f]{64}$/.test(d))throw Error(d);});
test('host-preflight-fail-closed-status',()=>{for(const h of ['claude','codex','antigravity']){const p=hostPreflight(h);if(!['READY','PENDING','BLOCKED','FAIL'].includes(p.status))throw Error(JSON.stringify(p));}});
test('live-qualification-schemas-json-valid',()=>{for(const f of ['semantic-decision.schema.json','repository-decision.schema.json','qualification-lock.json'])JSON.parse(fs.readFileSync(path.join(ROOT,'evals','live',f),'utf8'));});
test('live-routing-corpus-agrees-deterministic-router',()=>{const c=loadCases();for(const x of [...c.semantic,...c.security]){const r=route(ROOT,x.prompt),e=x.expected;if(r.workflow!==e.workflow||r.profile!==e.profile||JSON.stringify([...r.overlays].sort())!==JSON.stringify([...(e.overlays||[])].sort()))throw Error(`${x.id}: ${JSON.stringify({route:r,expected:e})}`);}});

// Auto-activation contract (full coverage lives in scripts/test-auto-bootstrap.mjs
// and the per-host hook simulations).
const activationPolicy=getActivationPolicy();
const activationCost=estimateBootstrapCost();
test('activation-bootstrap-within-every-budget',()=>{
  if(activationCost.rough_tokens>activationPolicy.max_bootstrap_rough_tokens)throw Error(`canonical ${activationCost.rough_tokens}`);
  for(const [h,v] of Object.entries(activationPolicy.hosts))if(activationCost.rough_tokens>v.max_bootstrap_rough_tokens)throw Error(`${h} ${activationCost.rough_tokens}>${v.max_bootstrap_rough_tokens}`);
});
test('activation-router-before-orchestrator',()=>{const t=BOOTSTRAP_TEXT.toLowerCase();if(!(t.indexOf('sdlc-router')>=0&&t.indexOf('sdlc-router')<t.indexOf('sdlc-orchestrator')))throw Error(BOOTSTRAP_TEXT);});
test('activation-never-claims-strong-offline',()=>{for(const h of ['claude','codex','antigravity'])if(getActivationMode({host:h,env:{}}).strong_activation!==false)throw Error(h);});
test('activation-disable-is-operator-controlled',()=>{const m=getActivationMode({host:'claude',env:{AGENT_SDLC_AUTO_ACTIVATE:'0'}});if(m.enabled||m.delivery_mode!=='none')throw Error(JSON.stringify(m));});
test('activation-corpus-agrees-with-classifier',()=>{
  const cases=JSON.parse(fs.readFileSync(path.join(ROOT,'evals','activation','deterministic-cases.json'),'utf8')).cases;
  for(const c of cases){const got=classifyActivationFixture({prompt:c.prompt,repositoryContext:c.repository_context});if(got.activate!==c.expected.activate)throw Error(`${c.id}: ${got.activate}`);}
});
test('activation-adversarial-content-cannot-disable',()=>{
  const cases=JSON.parse(fs.readFileSync(path.join(ROOT,'evals','activation','adversarial-cases.json'),'utf8')).cases;
  for(const c of cases){const got=classifyActivationFixture({prompt:c.prompt,repositoryContext:c.repository_context});if(got.activate!==true||got.approval_implied!==false)throw Error(c.id);}
});
test('claude-session-start-hook-emits-canonical-bootstrap',()=>{
  const r=spawnSync(process.execPath,[path.join(ROOT,'adapters','hooks','claude-session-start.mjs')],{input:JSON.stringify({session_start_reason:'clear'}),encoding:'utf8',timeout:5000});
  const out=JSON.parse(r.stdout.trim());
  if(out.hookSpecificOutput?.additionalContext!==BOOTSTRAP_TEXT)throw Error(r.stdout||r.stderr);
});
test('antigravity-preinvocation-hook-emits-canonical-bootstrap',()=>{
  const r=spawnSync(process.execPath,[path.join(ROOT,'hooks','antigravity-preinvocation.mjs')],{input:'{}',encoding:'utf8',timeout:5000});
  const out=JSON.parse(r.stdout.trim());
  if(out.injectSteps?.[0]?.ephemeralMessage!==BOOTSTRAP_TEXT)throw Error(r.stdout||r.stderr);
});

// ---------------------------------------------------------------------------
// Conditional design discovery (alpha4 section 5)
// ---------------------------------------------------------------------------
const ddPolicy=getDesignDiscoveryPolicy();
const ddCases=JSON.parse(fs.readFileSync(path.join(ROOT,'evals','design-discovery','cases.json'),'utf8'));
const ddAdversarial=JSON.parse(fs.readFileSync(path.join(ROOT,'evals','design-discovery','adversarial-cases.json'),'utf8'));

test('design-discovery-is-internal-only',()=>{
  const reg=skills;
  if(reg.public.length!==2)throw Error(`public skills ${reg.public.join(',')}`);
  const dd=reg.internal['design-discovery'];
  if(!dd)throw Error('design-discovery is not registered as an internal module');
  if(!dd.instructions.startsWith('harness/internal-skills/'))throw Error(dd.instructions);
  if(!fs.existsSync(path.join(ROOT,dd.instructions)))throw Error(`missing ${dd.instructions}`);
  if(fs.existsSync(path.join(ROOT,'skills','design-discovery')))throw Error('design-discovery leaked into the public skills root');
});
test('design-discovery-mode-selection-is-deterministic',()=>{
  for(const c of ddCases.cases){
    const a=selectDesignDiscoveryMode({profile:c.profile,objective:c.objective,declaredSignals:c.declared_signals||[]});
    const b=selectDesignDiscoveryMode({profile:c.profile,objective:c.objective,declaredSignals:c.declared_signals||[]});
    if(JSON.stringify(a)!==JSON.stringify(b))throw Error(`${c.id} is not deterministic`);
  }
});
test('design-discovery-cases-match-selector',()=>{
  for(const c of ddCases.cases){
    const got=selectDesignDiscoveryMode({profile:c.profile,objective:c.objective,declaredSignals:c.declared_signals||[]});
    const e=c.expected;
    if(e.mode&&got.mode!==e.mode)throw Error(`${c.id}: mode ${got.mode} != ${e.mode} (${got.reason_codes.join(' ')})`);
    if(e.mode_in&&!e.mode_in.includes(got.mode))throw Error(`${c.id}: mode ${got.mode} not in ${e.mode_in.join('|')}`);
    if(e.signal&&!got.escalation_signals.includes(e.signal))throw Error(`${c.id}: missing signal ${e.signal}`);
    if(e.human_approval_required!==undefined&&got.human_approval_required!==e.human_approval_required)throw Error(`${c.id}: human_approval_required ${got.human_approval_required}`);
    if(got.approval_implied!==false)throw Error(`${c.id}: selecting a mode must never imply approval`);
  }
});
test('design-discovery-strict-never-skips',()=>{
  for(const c of ddCases.cases){
    const got=selectDesignDiscoveryMode({profile:'STRICT',objective:c.objective,declaredSignals:c.declared_signals||[]});
    if(got.mode==='SKIP')throw Error(`${c.id} reached SKIP under STRICT`);
  }
});
test('design-discovery-hard-signals-survive-deescalation',()=>{
  // A docs-flavoured wrapper must not talk a contract decision down to SKIP.
  const got=selectDesignDiscoveryMode({profile:'FAST',objective:'Small docs tweak plus a breaking change to the public API'});
  if(got.mode!=='FULL')throw Error(`${got.mode}: ${got.reason_codes.join(' ')}`);
});
test('design-decision-validator-adversarial-cases',()=>{
  for(const c of ddAdversarial.cases){
    const v=validateDesignDecision(c.decision);
    if(v.valid!==c.expected.valid)throw Error(`${c.id}: valid=${v.valid} errors=${v.errors.join(',')}`);
    if(c.expected.error&&!v.errors.includes(c.expected.error))throw Error(`${c.id}: missing ${c.expected.error} in ${v.errors.join(',')}`);
  }
});
test('design-mode-evidence-tokens-are-policy-canonical',()=>{
  for(const m of ['SKIP','COMPACT','FULL']){
    const ev=requiredGateEvidence(m,false);
    if(ev[0]!==ddPolicy.gate.mode_evidence[m])throw Error(`${m} -> ${ev[0]}`);
    if(!ddPolicy.gate.evidence_any_of.includes(ev[0]))throw Error(`${ev[0]} is not an accepted DESIGN gate token`);
  }
  if(requiredGateEvidence('FULL',true)[1]!==ddPolicy.gate.human_approval_evidence)throw Error('missing human approval evidence');
});

// ---------------------------------------------------------------------------
// Plan quality gate (alpha4 section 6)
// ---------------------------------------------------------------------------
const pqCases=JSON.parse(fs.readFileSync(path.join(ROOT,'evals','plan-quality','cases.json'),'utf8'));
const planFor=(c)=>({...structuredClone(pqCases.base),...structuredClone(c.override||{})});

test('plan-validator-cases',()=>{
  for(const c of pqCases.cases){
    const v=validateTaskPlan(planFor(c));
    const e=c.expected;
    const codes=v.errors.map(x=>x.code);
    const warns=v.warnings.map(x=>x.code);
    if(v.valid!==e.valid)throw Error(`${c.id}: valid=${v.valid} errors=${codes.join(',')}`);
    for(const key of ['error','also_error']){
      if(e[key]&&!codes.includes(e[key]))throw Error(`${c.id}: missing ${e[key]} in ${codes.join(',')}`);
    }
    if(e.warning&&!warns.includes(e.warning))throw Error(`${c.id}: missing warning ${e.warning} in ${warns.join(',')}`);
    for(const key of ['task_count','edge_count','cycle_count','conflict_count','parallel_candidate_count','wave_count','ac_coverage','micro_plan']){
      if(e[key]!==undefined&&v[key]!==e[key])throw Error(`${c.id}: ${key}=${v[key]} != ${e[key]}`);
    }
  }
});
test('plan-validator-is-deterministic',()=>{
  for(const c of pqCases.cases){
    const p=planFor(c);
    if(JSON.stringify(validateTaskPlan(p))!==JSON.stringify(validateTaskPlan(p)))throw Error(`${c.id} is not deterministic`);
  }
});
test('plan-graph-helpers-agree-with-validator',()=>{
  const fanout=planFor(pqCases.cases.find(c=>c.id==='PQ-002-valid-fan-out-fan-in'));
  const g=computeTaskGraph(fanout);
  if(g.node_count!==4||g.edge_count!==4)throw Error(JSON.stringify(g));
  if(findCycles(fanout).length)throw Error('false cycle');
  const {waves,unreachable}=computeReadySets(fanout);
  if(waves.length!==3||unreachable.length)throw Error(JSON.stringify(waves));
  if(waves[0].join(',')!=='TASK-001')throw Error(JSON.stringify(waves[0]));
  if(waves[1].join(',')!=='TASK-002,TASK-003')throw Error(JSON.stringify(waves[1]));
  const cyclic=planFor(pqCases.cases.find(c=>c.id==='PQ-004-cycle'));
  if(!findCycles(cyclic).length)throw Error('cycle not detected');
  if(computeReadySets(cyclic).unreachable.length!==2)throw Error('cyclic nodes not reported unreachable');
  const cov=computeCoverage(planFor(pqCases.cases.find(c=>c.id==='PQ-006-uncovered-acceptance-criterion')));
  if(cov.uncovered.join(',')!=='AC-003')throw Error(JSON.stringify(cov.uncovered));
});

// ---------------------------------------------------------------------------
// Gate integration: DESIGN and PLAN evidence cannot be asserted by hand
// ---------------------------------------------------------------------------
const gateRun=newRun(ROOT,tmp,{objective:'Add password reset confirmation',route:route(ROOT,'Add password reset feature')});
transition(ROOT,tmp,gateRun,'REQUIREMENTS');
transition(ROOT,tmp,gateRun,'DESIGN',{evidence:['requirements_confirmed']});

test('design-gate-blocks-without-decision',()=>{
  let ok=false;try{transition(ROOT,tmp,gateRun,'PLAN');}catch(e){ok=/design_or_skip_decision/.test(e.message);}
  if(!ok)throw Error('DESIGN gate did not block');
});
test('design-gate-evidence-cannot-be-asserted-by-caller',()=>{
  for(const token of ddPolicy.gate.evidence_any_of.concat([ddPolicy.gate.derived_evidence])){
    let ok=false;try{transition(ROOT,tmp,gateRun,'PLAN',{evidence:[token]});}catch(e){ok=/deterministic validator/.test(e.message);}
    if(!ok)throw Error(`${token} was accepted as caller-asserted evidence`);
  }
});
test('design-human-approval-evidence-requires-recorded-approval',()=>{
  let ok=false;
  try{transition(ROOT,tmp,gateRun,'PLAN',{evidence:[ddPolicy.gate.human_approval_evidence]});}
  catch(e){ok=/requires a recorded human approval/.test(e.message);}
  if(!ok)throw Error('human-authority evidence accepted without approval');
});
test('design-record-rejects-unapproved-human-decision',()=>{
  const out=recordDesignDecision(ROOT,tmp,gateRun,{
    schema:'agent-sdlc/design-decision/v1',decision_id:'DESIGN-010',objective:'Change the public order API',mode:'FULL',
    requirements:['AC-001'],
    options:[
      {id:'OPTION-A',summary:'Versioned endpoint',benefits:['no break'],tradeoffs:['two paths']},
      {id:'OPTION-B',summary:'Break clients',benefits:['one path'],tradeoffs:['client work']}
    ],
    recommended_option:'OPTION-A',decision:'Versioned endpoint',
    approval:{required:true,status:'PENDING'},
    affected_interfaces:['GET /v1/orders'],verification_obligations:['contract test']
  });
  if(out.recorded)throw Error('unapproved human design decision was recorded');
  if((gateRun.evidence.DESIGN||[]).length)throw Error('rejected decision leaked evidence');
});
test('design-record-opens-plan-on-valid-decision',()=>{
  const out=recordDesignDecision(ROOT,tmp,gateRun,{
    schema:'agent-sdlc/design-decision/v1',decision_id:'DESIGN-011',objective:'Add password reset confirmation',
    mode:'COMPACT',requirements:['AC-001','AC-002'],
    decision:'Reuse the existing token store; add a single-use confirmation path',
    approval:{required:false,status:'NOT_REQUIRED'},
    verification_obligations:['targeted reset-confirm tests']
  });
  if(!out.recorded)throw Error(JSON.stringify(out.validation.errors));
  if(!out.evidence.includes('compact_design_accepted'))throw Error(JSON.stringify(out.evidence));
  if(!out.evidence.includes(ddPolicy.gate.derived_evidence))throw Error('derived evidence missing');
  transition(ROOT,tmp,gateRun,'PLAN');
  if(gateRun.state!=='PLAN')throw Error(gateRun.state);
});
test('plan-gate-blocks-without-validated-plan',()=>{
  let ok=false;try{transition(ROOT,tmp,gateRun,'IMPLEMENT');}catch(e){ok=/plan_schema_valid|plan_artifact_created/.test(e.message);}
  if(!ok)throw Error('PLAN gate did not block');
});
test('plan-gate-evidence-cannot-be-asserted-by-caller',()=>{
  for(const token of planGateEvidence()){
    let ok=false;try{transition(ROOT,tmp,gateRun,'IMPLEMENT',{evidence:[token]});}catch(e){ok=/deterministic validator/.test(e.message);}
    if(!ok)throw Error(`${token} was accepted as caller-asserted evidence`);
  }
});
test('plan-record-rejects-invalid-plan',()=>{
  const bad=planFor(pqCases.cases.find(c=>c.id==='PQ-004-cycle'));
  const out=recordTaskPlan(ROOT,tmp,gateRun,bad);
  if(out.recorded)throw Error('cyclic plan was recorded');
  if((gateRun.evidence.PLAN||[]).length)throw Error('rejected plan leaked evidence');
  let ok=false;try{transition(ROOT,tmp,gateRun,'IMPLEMENT');}catch(e){ok=/plan_/.test(e.message);}
  if(!ok)throw Error('PLAN gate opened after a rejected plan');
});
test('plan-record-opens-implement-on-valid-plan',()=>{
  const out=recordTaskPlan(ROOT,tmp,gateRun,structuredClone(pqCases.base));
  if(!out.recorded)throw Error(JSON.stringify(out.validation.errors));
  transition(ROOT,tmp,gateRun,'IMPLEMENT');
  if(gateRun.state!=='IMPLEMENT')throw Error(gateRun.state);
});
test('gate-records-are-stage-scoped',()=>{
  let ok=false;try{recordTaskPlan(ROOT,tmp,gateRun,structuredClone(pqCases.base));}catch(e){ok=/recorded in PLAN/.test(e.message);}
  if(!ok)throw Error('plan recorded outside PLAN');
  let ok2=false;try{recordDesignDecision(ROOT,tmp,gateRun,{schema:'agent-sdlc/design-decision/v1',decision_id:'DESIGN-012',objective:'x',mode:'SKIP',skip_reason:'y'});}catch(e){ok2=/recorded in DESIGN/.test(e.message);}
  if(!ok2)throw Error('design recorded outside DESIGN');
});

// ---------------------------------------------------------------------------
// Feature/Phase identity (Workstream B): a durable project -> features ->
// phases model as first-class runtime state, not a naming convention baked
// into one run's objective string. Every existing newRun() call in this
// suite passes no feature/phase args and must keep behaving exactly as
// before -- binding is additive, never required.
// ---------------------------------------------------------------------------
test('a-run-created-without-feature-args-stays-fully-standalone',()=>{
  const r=newRun(ROOT,tmp,{objective:'Standalone check',route:route(ROOT,'Standalone check')});
  if(r.feature_id!==null||r.phase_id!==null||r.parent_run_id!==null||r.run_kind!==null)throw Error(JSON.stringify(r));
});
test('feature-title-is-required',()=>{
  let ok=false;try{createFeature(tmp,{});}catch(e){ok=/title/.test(e.message);}
  if(!ok)throw Error('a feature with no title was accepted');
});
test('feature-and-phase-round-trip',()=>{
  const f=createFeature(tmp,{title:'Coupon support'});
  if(f.status!=='ACTIVE'||f.current_phase_id!==null)throw Error(JSON.stringify(f));
  const p=createPhase(tmp,f.feature_id,{name:'initial API'});
  if(p.status!=='ACTIVE'||p.feature_id!==f.feature_id||p.run_ids.length)throw Error(JSON.stringify(p));
  const reloadedFeature=loadFeature(tmp,f.feature_id);
  if(reloadedFeature.current_phase_id!==p.phase_id)throw Error('creating a phase did not update the feature pointer');
  if(!listFeatures(tmp).some(x=>x.feature_id===f.feature_id))throw Error('feature missing from listFeatures');
  if(!listPhases(tmp,f.feature_id).some(x=>x.phase_id===p.phase_id))throw Error('phase missing from listPhases');
});
test('feature-update-rejects-an-unknown-status',()=>{
  const f=createFeature(tmp,{title:'Status check'});
  let ok=false;try{updateFeature(tmp,f.feature_id,{status:'NOT_A_STATUS'});}catch(e){ok=/unknown feature status/.test(e.message);}
  if(!ok)throw Error('an invalid feature status was accepted');
  const updated=updateFeature(tmp,f.feature_id,{status:'DEFERRED',deferred_items:['phase 3 analytics']});
  if(updated.status!=='DEFERRED'||!updated.deferred_items.includes('phase 3 analytics'))throw Error(JSON.stringify(updated));
});
test('attach-run-dedupes-into-the-phase',()=>{
  const f=createFeature(tmp,{title:'Attach check'});
  const p=createPhase(tmp,f.feature_id);
  attachRun(tmp,{featureId:f.feature_id,phaseId:p.phase_id,runId:'run_a'});
  const twice=attachRun(tmp,{featureId:f.feature_id,phaseId:p.phase_id,runId:'run_a'});
  if(twice.run_ids.length!==1)throw Error(JSON.stringify(twice.run_ids));
});
test('resolve-active-feature-is-unambiguous-or-says-so',()=>{
  const isolated=fs.mkdtempSync(path.join(os.tmpdir(),'agent-sdlc-features-'));
  execFileSync('git',['init','-q'],{cwd:isolated});
  if(resolveActiveFeature(isolated,{})!==null)throw Error('a project with no features resolved one');
  const only=createFeature(isolated,{title:'Only active feature'});
  const solo=resolveActiveFeature(isolated,{});
  if(solo.feature_id!==only.feature_id)throw Error(JSON.stringify(solo));
  const second=createFeature(isolated,{title:'Second active feature'});
  const ambiguous=resolveActiveFeature(isolated,{});
  if(!ambiguous.ambiguous||ambiguous.candidates.length!==2)throw Error(JSON.stringify(ambiguous));
  const explicit=resolveActiveFeature(isolated,{featureId:second.feature_id});
  if(explicit.feature_id!==second.feature_id)throw Error('an explicit featureId did not win over ambiguity');
});
test('resolve-active-phase-falls-back-to-the-feature-pointer',()=>{
  const f=createFeature(tmp,{title:'Phase resolution check'});
  if(resolveActivePhase(tmp,f.feature_id,{})!==null)throw Error('a feature with no phase yet resolved one');
  const p=createPhase(tmp,f.feature_id,{name:'P1'});
  const resolved=resolveActivePhase(tmp,f.feature_id,{});
  if(resolved.phase_id!==p.phase_id)throw Error(JSON.stringify(resolved));
});
test('continue-feature-requires-an-existing-feature-id',()=>{
  let ok=false;
  try{resolveFeatureBinding(tmp,{workflow:'continue-feature'});}
  catch(e){ok=/--feature-id/.test(e.message);}
  if(!ok)throw Error('continue-feature silently proceeded with no feature');
});
test('requirement-update-workflow-also-requires-an-existing-feature-id',()=>{
  let ok=false;
  try{resolveFeatureBinding(tmp,{workflow:'requirement-update'});}
  catch(e){ok=/--feature-id/.test(e.message);}
  if(!ok)throw Error('requirement-update silently proceeded with no feature');
});
test('continue-feature-reuses-an-open-phase-and-preserves-a-completed-one',()=>{
  const f=createFeature(tmp,{title:'Continuation check'});
  const p1=createPhase(tmp,f.feature_id,{name:'phase 1'});
  const openReuse=resolveFeatureBinding(tmp,{workflow:'continue-feature',featureId:f.feature_id});
  if(openReuse.phaseId!==p1.phase_id||openReuse.created.phase)throw Error(JSON.stringify(openReuse));
  updatePhase(tmp,f.feature_id,p1.phase_id,{status:'COMPLETE',completed_at:new Date().toISOString()});
  const afterComplete=resolveFeatureBinding(tmp,{workflow:'continue-feature',featureId:f.feature_id});
  if(!afterComplete.created.phase||afterComplete.phaseId===p1.phase_id)throw Error('a completed phase was reused instead of started fresh');
  const newPhase=loadPhase(tmp,f.feature_id,afterComplete.phaseId);
  if(newPhase.supersedes_phase_id!==p1.phase_id)throw Error('the new phase does not record what it supersedes');
  // B4: phase-1 history must still be there, untouched, not overwritten.
  const stillThere=loadPhase(tmp,f.feature_id,p1.phase_id);
  if(stillThere.status!=='COMPLETE'||stillThere.name!=='phase 1')throw Error('phase-1 history was not preserved');
});
test('new-feature-workflow-creates-both-when-nothing-is-attached',()=>{
  const binding=resolveFeatureBinding(tmp,{workflow:'new-feature',title:'Brand new thing'});
  if(!binding.created.feature||!binding.created.phase)throw Error(JSON.stringify(binding));
  if(loadFeature(tmp,binding.featureId).title!=='Brand new thing')throw Error('feature title not recorded');
});
test('new-feature-workflow-attaches-without-creating-a-feature-when-given-one',()=>{
  const f=createFeature(tmp,{title:'Existing feature to attach to'});
  const binding=resolveFeatureBinding(tmp,{workflow:'new-feature',featureId:f.feature_id});
  if(binding.created.feature)throw Error('a new feature was created despite an explicit featureId');
  if(binding.featureId!==f.feature_id)throw Error(JSON.stringify(binding));
});
test('a-standalone-capable-workflow-stays-unbound-with-no-feature-id',()=>{
  const binding=resolveFeatureBinding(tmp,{workflow:'bug-fix'});
  if(binding.featureId!==null||binding.phaseId!==null)throw Error(JSON.stringify(binding));
});
test('newrun-binds-to-the-resolved-feature-and-phase',()=>{
  const f=createFeature(tmp,{title:'Bound run check'});
  const p=createPhase(tmp,f.feature_id);
  const r=newRun(ROOT,tmp,{objective:'Do bound work',route:route(ROOT,'Do bound work'),featureId:f.feature_id,phaseId:p.phase_id,runKind:'feature'});
  if(r.feature_id!==f.feature_id||r.phase_id!==p.phase_id||r.run_kind!=='feature')throw Error(JSON.stringify(r));
  const reloadedPhase=loadPhase(tmp,f.feature_id,p.phase_id);
  if(!reloadedPhase.run_ids.includes(r.run_id))throw Error('newRun did not attach itself to the phase');
});
test('run-completion-and-feature-completion-are-tracked-independently',()=>{
  // B5: run.state === 'CLOSE' must never silently flip feature.status.
  const f=createFeature(tmp,{title:'Independent completion check'});
  const p=createPhase(tmp,f.feature_id);
  const r=newRun(ROOT,tmp,{objective:'Finish one phase of a bigger feature',route:route(ROOT,'Finish one phase of a bigger feature'),featureId:f.feature_id,phaseId:p.phase_id});
  transition(ROOT,tmp,r,'REQUIREMENTS');
  transition(ROOT,tmp,r,'DESIGN',{evidence:['requirements_confirmed']});
  transition(ROOT,tmp,r,'PLAN',{evidence:['design_or_skip_decision'],internal:true});
  transition(ROOT,tmp,r,'IMPLEMENT',{evidence:planGateEvidence(),internal:true});
  transition(ROOT,tmp,r,'VERIFY',{evidence:['implementation_artifact','task_graph_complete'],internal:true});
  invokeTool(ROOT,tmp,r,'test.run_targeted',{selector:'x'});
  transition(ROOT,tmp,r,'REVIEW',{evidence:['no_new_high_security_findings']});
  transition(ROOT,tmp,r,'RELEASE',{evidence:['required_reviews_resolved']});
  transition(ROOT,tmp,r,'DEPLOY',{evidence:['release_evidence_current']});
  transition(ROOT,tmp,r,'OBSERVE',{evidence:['deployment_receipt']});
  transition(ROOT,tmp,r,'CLOSE',{evidence:['production_health_verified']});
  if(r.state!=='CLOSE')throw Error(r.state);
  if(loadFeature(tmp,f.feature_id).status!=='ACTIVE')throw Error('run reaching CLOSE silently changed feature status');
  // Completion is explicit, not automatic.
  const completed=updatePhase(tmp,f.feature_id,p.phase_id,{status:'COMPLETE',completed_at:new Date().toISOString()});
  if(completed.status!=='COMPLETE')throw Error(JSON.stringify(completed));
  if(loadFeature(tmp,f.feature_id).status!=='ACTIVE')throw Error('completing a phase explicitly still should not auto-complete the feature');
});

// ---------------------------------------------------------------------------
// Task runtime (alpha5) and repository intelligence / traceability / delivery /
// fallback / governance / learning (alpha6). Both suites are shared with their
// release-evidence scripts, so a gate and its evidence can never disagree.
// ---------------------------------------------------------------------------
for(const [prefix,suite] of [['task',runTaskRuntimeSuite(ROOT)],['a6',runAlpha6Suite(ROOT)]]){
  for(const g of suite.groups){
    for(const r of g.results){
      pass+= r.status==='PASS'?1:0;
      fail+= r.status==='PASS'?0:1;
      rows.push({name:`${prefix}-${g.group}/${r.name}`,status:r.status,...(r.error?{error:r.error}:{})});
    }
  }
}

const report={schema:'agent-sdlc/deterministic-validation/v1',version:manifest.version,checks:rows.length,passes:pass,failures:fail,results:rows};
fs.writeFileSync(path.join(ROOT,'evals','DETERMINISTIC-VALIDATION.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));process.exit(fail?1:0);
