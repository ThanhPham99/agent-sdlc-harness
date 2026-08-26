// Alpha6 evaluation suite: repository intelligence, traceability, graph-driven
// invalidation, revision-bound delivery, provider fallback, governance and
// regression learning.
//
// Shared by `npm test` and `scripts/validate-alpha6.mjs`, so the gate and the
// release evidence describe the same run. Fully offline.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {initProject,listTasks,saveTask,putArtifact,listTaskEvents,loadRun} from '../runtime/store.mjs';
import {sha256} from '../runtime/util.mjs';
import {route} from '../runtime/router.mjs';
import {newRun,transition,recordDesignDecision,recordTaskPlan,materializeRunTasks} from '../runtime/orchestrator.mjs';
import {refreshReadiness,transitionTask,requireTask} from '../runtime/task-engine.mjs';
import {buildIndex,loadIndex,indexStale,detectCapability,moduleOf,isTestPath,languageOf,IMPLEMENTED_TIER} from '../runtime/repo-index.mjs';
import {buildSymbolGraph,dependentClosure,testsForSymbol,testsForFiles,moduleBoundary} from '../runtime/symbol-graph.mjs';
import {openIntelligence,findSymbol,findReferences,findTestsForSymbol,findModuleBoundary,findDependents,findPublicInterfaces,findDataEntities,findEventContracts,getMinimalChangeSurface} from '../runtime/repo-intelligence.mjs';
import {buildTraceabilityGraph,loadTraceabilityGraph,validateTraceabilityGraph,computeTraceCoverage,computeInvalidationClosure,applyInvalidation,invalidationHistory,nodeId,DELTA_CLASSES} from '../runtime/traceability.mjs';
import {recordDelivery,baseDrift,checkPushTarget,branchFor,groupTaskBranches,isProtectedBranch} from '../runtime/git-delivery.mjs';
import {recordCiEvidence,ciEvidenceCurrent,loadCiEvidence} from '../runtime/ci-evidence.mjs';
import {resumeFromCheckpoint,taskCheckpoint,startTask,captureTaskDiff} from '../runtime/task-runner.mjs';
import {governTask,governorReport,taskComplexity,getGovernancePolicy} from '../runtime/governor.mjs';
import {buildRegressionCandidate,validateRegressionCandidate,toEvalCase,sanitizeText,sanitizePath,LEARNING_SOURCES} from '../runtime/learning.mjs';
import {buildTaskContext,renderTaskPrompt,scopeIntelligence} from '../runtime/task-context.mjs';
import {getTaskWorkspace} from '../runtime/workspace.mjs';
import {planRequirementUpdate,loadRequirementUpdatePlan} from '../runtime/requirement-update.mjs';
import {buildContext,renderPrompt} from '../runtime/context.mjs';

const gitq=(cwd,...a)=>execFileSync('git',a,{cwd,stdio:'ignore'});

/** A small but realistic repository: modules, tests, routes, entities, events. */
export function makeRichFixture(){
  const d=fs.mkdtempSync(path.join(os.tmpdir(),'agent-sdlc-a6-'));
  gitq(d,'init','-q');
  const write=(rel,text)=>{
    const p=path.join(d,rel);
    fs.mkdirSync(path.dirname(p),{recursive:true});
    fs.writeFileSync(p,text);
  };
  write('.gitignore','.agent-sdlc/\n');
  write('src/payments/refund-repository.js',
    `export class RefundRepository {\n  find(id){return null;}\n  save(refund){return refund;}\n}\n`);
  write('src/payments/payment-service.js',
    `import {RefundRepository} from './refund-repository.js';\n`+
    `export class PaymentService {\n`+
    `  refund(id){ return new RefundRepository().save({id}); }\n`+
    `}\n`+
    `export const publishRefundCreated=(bus)=>bus.publish('RefundCreated',{});\n`);
  write('src/api/payments-routes.js',
    `import {PaymentService} from '../payments/payment-service.js';\n`+
    `export function registerRoutes(app){\n`+
    `  app.post('/v1/refunds', () => new PaymentService().refund(1));\n`+
    `  app.get('/v1/refunds', () => []);\n`+
    `}\n`);
  write('src/notify/refund-email.js',`export const sendRefundEmail=()=>true;\n`);
  write('migrations/0004-create-refunds.sql',
    `CREATE TABLE payments_refunds (id uuid primary key, amount numeric);\n`);
  write('tests/payments/payment-service.test.js',
    `import {PaymentService} from '../../src/payments/payment-service.js';\n`+
    `test('PaymentService refund is idempotent',()=>{new PaymentService();});\n`);
  write('tests/api/payments-routes.test.js',
    `import {registerRoutes} from '../../src/api/payments-routes.js';\n`+
    `test('routes register',()=>{registerRoutes({post(){},get(){}});});\n`);
  write('docs/payments.md','# Payments\n');
  gitq(d,'add','.');
  execFileSync('git',['-c','user.email=a@b.c','-c','user.name=t','commit','-qm','init'],{cwd:d,stdio:'ignore'});
  initProject(d,{
    schema:'agent-sdlc/project/v1',project:'alpha6-fixture',
    commands:{test_targeted:['node','-e','process.exit(0)'],test_full:['node','-e','process.exit(0)'],build:['node','-e','process.exit(0)']},
    context:{project_invariants:['do not edit generated files']},
    providers:{preferred:['claude','codex','antigravity']}
  });
  return d;
}

const PLAN=()=>({
  schema:'agent-sdlc/task-plan/v1',plan_id:'PLAN-001',objective:'Add refund idempotency',
  profile:'STANDARD',requirements:['AC-001','AC-002'],design_decisions:['DESIGN-001'],
  integration_tasks:['TASK-002'],
  tasks:[
    {task_id:'TASK-001',title:'Idempotent refund',goal:'Make PaymentService.refund idempotent',
      category:'implementation',acceptance_criteria:['AC-001'],design_decisions:['DESIGN-001'],
      modules:['src/payments'],write_scope:['src/payments/payment-service.js'],read_scope:['src/payments/'],
      likely_symbols:['PaymentService','RefundRepository'],
      interface_scope:['POST /v1/refunds'],compatibility_obligations:['keep the v1 refund response shape'],
      verification:{targeted_tests:['tests/payments/payment-service.test.js'],expected_behavior:['a repeated refund is a no-op']},
      done_conditions:['a repeated refund does not double-refund; targeted tests pass'],
      estimated_seconds:300},
    {task_id:'TASK-002',title:'Refund flow integration',goal:'Verify the assembled refund flow',
      category:'integration',depends_on:['TASK-001'],acceptance_criteria:['AC-002'],
      design_decisions:['DESIGN-001'],changes_behavior:false,
      verification:{targeted_tests:['tests/api/payments-routes.test.js'],expected_behavior:['refund endpoint stays compatible']},
      done_conditions:['end-to-end refund flow passes'],estimated_seconds:120}
  ]
});

function runToImplement(root,projectRoot,plan=PLAN()){
  const run=newRun(root,projectRoot,{objective:plan.objective,route:route(root,'Add refund idempotency to this repository')});
  transition(root,projectRoot,run,'REQUIREMENTS');
  transition(root,projectRoot,run,'DESIGN',{evidence:['requirements_confirmed']});
  recordDesignDecision(root,projectRoot,run,{
    schema:'agent-sdlc/design-decision/v1',decision_id:'DESIGN-001',objective:plan.objective,mode:'COMPACT',
    requirements:['AC-001','AC-002'],decision:'Key refunds by idempotency key in the existing repository',
    approval:{required:false,status:'NOT_REQUIRED'},
    affected_interfaces:['POST /v1/refunds'],verification_obligations:['contract test for POST /v1/refunds']
  });
  transition(root,projectRoot,run,'PLAN');
  const rec=recordTaskPlan(root,projectRoot,run,plan);
  if(!rec.recorded)throw new Error(`fixture plan invalid: ${JSON.stringify(rec.validation.errors)}`);
  const artifact=putArtifact(projectRoot,{kind:'task-plan',content:JSON.stringify(plan,null,2)+'\n',runId:run.run_id,stage:'PLAN',filename:'task-plan.json'});
  materializeRunTasks(root,projectRoot,run,plan,{planArtifactRef:artifact.artifact_id});
  transition(root,projectRoot,run,'IMPLEMENT');
  refreshReadiness(root,projectRoot,run.run_id);
  return {run,plan,planArtifact:artifact};
}

// ---------------------------------------------------------------------------

export function runAlpha6Suite(root){
  const groups={};
  const group=name=>{groups[name]=groups[name]||[];return (title,fn)=>{
    try{fn();groups[name].push({name:title,status:'PASS'});}
    catch(e){groups[name].push({name:title,status:'FAIL',error:e.message});}
  };};
  const fail=m=>{throw new Error(m);};

  // ==================== repository intelligence ============================
  {
    const t=group('repo_intelligence');
    const projectRoot=makeRichFixture();
    const intel=openIntelligence(projectRoot);

    t('index-is-built-and-classifies-files',()=>{
      const idx=loadIndex(projectRoot);
      if(!idx.counts.files)fail('index found no files');
      if(!idx.revision)fail('index is not revision-bound');
      if(idx.counts.tests!==2)fail(`expected 2 test files, got ${idx.counts.tests}`);
      if(idx.counts.migrations!==1)fail(`expected 1 migration, got ${idx.counts.migrations}`);
      if(languageOf('a.mjs')!=='javascript'||languageOf('a.py')!=='python')fail('language detection');
      if(!isTestPath('tests/payments/payment-service.test.js'))fail('test path detection');
      if(moduleOf('src/payments/payment-service.js')!=='src/payments')fail(moduleOf('src/payments/payment-service.js'));
    });

    t('capability-tier-is-reported-honestly',()=>{
      const cap=detectCapability(projectRoot);
      if(cap.tier!==IMPLEMENTED_TIER)fail(cap.tier);
      if(cap.lsp_available!==false||cap.language_parser_available!==false)fail('claimed an unavailable tier');
      if(cap.llm_inference_used!==false)fail('claimed LLM inference');
      if(!cap.tiers.includes('LSP_OR_COMPILER'))fail('tier hierarchy missing');
      // Every query result carries the tier that produced it.
      if(findSymbol(intel,'PaymentService').capability_tier!==IMPLEMENTED_TIER)fail('query did not report its tier');
    });

    t('index-is-incremental-and-detects-staleness',()=>{
      const first=buildIndex(projectRoot,{force:true});
      if(!first.files[0]?.blob_sha)fail('blob_sha missing in indexed file records');
      const second=buildIndex(projectRoot);
      if(second.counts.reused===0)fail('second pass re-parsed everything');
      if(second.counts.parsed>0)fail(`clean tree still parsed ${second.counts.parsed} files`);
      if(first.counts.files!==second.counts.files)fail('file count changed on a clean tree');
      const stale=indexStale(projectRoot,second);
      if(stale.stale)fail(JSON.stringify(stale));
      if(indexStale(projectRoot,{...second,revision:'0'.repeat(40)}).reason!=='REVISION_CHANGED')fail('revision staleness not detected');

      // Dirty staleness check: modifying a tracked file without committing must make index stale
      const target=path.join(projectRoot,'src/notify/refund-email.js');
      const original=fs.readFileSync(target,'utf8');
      try{
        fs.writeFileSync(target,original+'\n// dirty change\n');
        const dirtyStale=indexStale(projectRoot,second);
        if(!dirtyStale.stale||dirtyStale.reason!=='DIRTY_WORKING_TREE')fail(`expected DIRTY_WORKING_TREE, got: ${JSON.stringify(dirtyStale)}`);
        if(!dirtyStale.dirty_files.some(f=>f.includes('refund-email.js')))fail(`dirty_files missing modified target: ${JSON.stringify(dirtyStale.dirty_files)}`);
      }finally{
        fs.writeFileSync(target,original);
      }
      const restoredStale=indexStale(projectRoot,second);
      if(restoredStale.stale)fail(`restored working tree should be clean, got: ${JSON.stringify(restoredStale)}`);
    });

    t('index-records-truncation-for-oversized-files',()=>{
      const bigRel='src/big-data.js';
      const bigPath=path.join(projectRoot,bigRel);
      try{
        fs.writeFileSync(bigPath,'// big file\n'+'x'.repeat(600*1024));
        gitq(projectRoot,'add',bigRel);
        const idx=buildIndex(projectRoot,{force:true});
        const bigEntry=idx.files.find(f=>f.path===bigRel);
        if(!bigEntry)fail('oversized file not present in index');
        if(!bigEntry.truncated||!bigEntry.is_truncated)fail(`oversized file missing truncated flag: ${JSON.stringify(bigEntry)}`);
        if(idx.counts.truncated<1)fail(`counts.truncated expected >=1, got ${idx.counts.truncated}`);
      }finally{
        try{gitq(projectRoot,'rm','-f',bigRel);}catch{}
        try{fs.rmSync(bigPath,{force:true});}catch{}
        buildIndex(projectRoot,{force:true});
      }
    });

    t('regex-extracts-ruby-rust-csharp-php-kotlin',()=>{
      const multiDir=fs.mkdtempSync(path.join(os.tmpdir(),'agent-sdlc-multilang-'));
      try{
        gitq(multiDir,'init','-q');
        const write=(rel,text)=>{
          const p=path.join(multiDir,rel);
          fs.mkdirSync(path.dirname(p),{recursive:true});
          fs.writeFileSync(p,text);
        };
        write('service.rb','require "json"\nmodule Billing\n  class Invoice\n    def process\n    end\n  end\nend\n');
        write('service.rs','use std::collections::HashMap;\npub struct Payment;\npub fn execute_payment() {}\n');
        write('Service.cs','using System;\nnamespace Core {\n  public class OrderManager {\n    public async Task ProcessOrder() {}\n  }\n}\n');
        write('service.php','<?php\nnamespace App;\nuse App\\Util;\nclass UserManager {\n  public function findUser() {}\n}\n');
        write('service.kt','import com.example.util.*\nclass ItemRepository {\n  fun getItem(): String = ""\n}\n');
        gitq(multiDir,'add','.');
        execFileSync('git',['-c','user.email=a@b.c','-c','user.name=t','commit','-qm','init'],{cwd:multiDir,stdio:'ignore'});
        const idx=buildIndex(multiDir,{force:true});
        const byPath=new Map(idx.files.map(f=>[f.path,f]));
        const rb=byPath.get('service.rb');
        if(!rb?.symbols.includes('Invoice')||!rb?.symbols.includes('process')||!rb?.imports.includes('json'))fail(`Ruby extraction failed: ${JSON.stringify(rb)}`);
        const rs=byPath.get('service.rs');
        if(!rs?.symbols.includes('Payment')||!rs?.symbols.includes('execute_payment')||!rs?.imports.includes('std::collections::HashMap'))fail(`Rust extraction failed: ${JSON.stringify(rs)}`);
        const cs=byPath.get('Service.cs');
        if(!cs?.symbols.includes('OrderManager')||!cs?.symbols.includes('ProcessOrder')||!cs?.imports.includes('System'))fail(`C# extraction failed: ${JSON.stringify(cs)}`);
        const php=byPath.get('service.php');
        if(!php?.symbols.includes('UserManager')||!php?.symbols.includes('findUser')||!php?.imports.includes('App\\Util'))fail(`PHP extraction failed: ${JSON.stringify(php)}`);
        const kt=byPath.get('service.kt');
        if(!kt?.symbols.includes('ItemRepository')||!kt?.symbols.includes('getItem')||!kt?.imports.includes('com.example.util.*'))fail(`Kotlin extraction failed: ${JSON.stringify(kt)}`);
      }finally{
        try{fs.rmSync(multiDir,{recursive:true,force:true});}catch{}
      }
    });

    t('symbol-resolution-finds-definitions',()=>{
      const s=findSymbol(intel,'PaymentService');
      if(!s.locations.some(l=>l.path==='src/payments/payment-service.js'&&l.exported))fail(JSON.stringify(s.locations));
      if(findSymbol(intel,'NoSuchSymbol').locations.length)fail('a missing symbol resolved');
    });

    t('dependency-mapping-is-structural',()=>{
      const g=buildSymbolGraph(projectRoot,{index:loadIndex(projectRoot)});
      const deps=g.dependencies.get('src/payments/payment-service.js');
      if(!deps||!deps.has('src/payments/refund-repository.js'))fail(JSON.stringify([...(deps||[])]));
      const dependents=findDependents(intel,'src/payments/refund-repository.js',{maxDepth:3}).dependents.map(x=>x.path);
      if(!dependents.includes('src/payments/payment-service.js'))fail(JSON.stringify(dependents));
      if(!dependents.includes('src/api/payments-routes.js'))fail(`transitive dependent missing: ${JSON.stringify(dependents)}`);
      const refs=findReferences(intel,'RefundRepository');
      if(refs.confidence!=='STRUCTURAL')fail(`confidence ${refs.confidence}`);
    });

    t('test-mapping-links-tests-to-the-code-they-import',()=>{
      const tests=findTestsForSymbol(intel,'PaymentService').tests;
      const hit=tests.find(x=>x.path==='tests/payments/payment-service.test.js');
      if(!hit)fail(JSON.stringify(tests));
      if(hit.strength!=='STRONG')fail(`strength ${hit.strength} reasons ${hit.reasons.join(',')}`);
      const byFile=testsForFiles(buildSymbolGraph(projectRoot,{index:loadIndex(projectRoot)}),['src/payments/refund-repository.js']);
      if(!byFile.some(x=>x.path==='tests/payments/payment-service.test.js'))fail(JSON.stringify(byFile));
    });

    t('module-boundary-reports-its-public-surface',()=>{
      const b=findModuleBoundary(intel,'src/payments/payment-service.js');
      if(b.module!=='src/payments')fail(b.module);
      if(!b.files.includes('src/payments/refund-repository.js'))fail(JSON.stringify(b.files));
      if(!b.inbound_dependents.includes('src/api/payments-routes.js'))fail(JSON.stringify(b.inbound_dependents));
      if(!b.public_symbols.includes('PaymentService'))fail(JSON.stringify(b.public_symbols));
    });

    t('public-interfaces-data-entities-and-events-are-extracted',()=>{
      const i=findPublicInterfaces(intel,['src/api/payments-routes.js']);
      if(!i.routes.includes('POST /v1/refunds'))fail(JSON.stringify(i.routes));
      const e=findDataEntities(intel,['migrations/0004-create-refunds.sql']);
      if(!e.entities.some(x=>x.entity==='payments_refunds'&&x.migrations.length))fail(JSON.stringify(e.entities));
      const ev=findEventContracts(intel,['src/payments/payment-service.js']);
      if(!ev.events.some(x=>x.event==='RefundCreated'))fail(JSON.stringify(ev.events));
    });

    t('minimal-change-surface-is-bounded-and-relevant',()=>{
      const s=getMinimalChangeSurface(intel,'add refund idempotency');
      if(!s.bounded)fail('surface not marked bounded');
      if(!s.files.includes('src/payments/refund-repository.js'))fail(JSON.stringify(s.files));
      if(!s.symbols.some(x=>x.symbol==='RefundRepository'))fail(JSON.stringify(s.symbols));
      if(s.files.includes('src/notify/refund-email.js')&&s.files.length>6)fail('surface expanded beyond the refund path');
      if(s.files.length>15)fail(`surface returned ${s.files.length} files`);
      if(!s.tests.length)fail('no covering tests identified');
    });

    t('no-deterministic-match-says-so-instead-of-returning-everything',()=>{
      const s=getMinimalChangeSurface(intel,'kubernetes ingress annotation for grafana');
      if(s.files.length)fail(`unrelated objective returned ${JSON.stringify(s.files)}`);
      if(s.empty_reason!=='NO_DETERMINISTIC_MATCH_BROADER_SEARCH_REQUIRED')fail(String(s.empty_reason));
    });

    t('external-and-unresolved-imports-are-separated-not-guessed',()=>{
      const g=buildSymbolGraph(projectRoot,{index:loadIndex(projectRoot)});
      if(!Array.isArray(g.unresolved_imports))fail('unresolved imports not reported');
      if(!Array.isArray(g.external_dependencies))fail('external dependencies not reported');
      for(const e of g.edges)if(!g.files.has(e.to))fail(`edge points outside the index: ${JSON.stringify(e)}`);
    });

    t('task-context-uses-scope-intelligence-before-broad-search',()=>{
      const {run}=runToImplement(root,projectRoot);
      const task=requireTask(projectRoot,run.run_id,'TASK-001');
      const s=scopeIntelligence(projectRoot,task);
      if(!s.available)fail(JSON.stringify(s));
      if(!s.symbols.includes('PaymentService'))fail(JSON.stringify(s.symbols));
      if(!s.tests.includes('tests/payments/payment-service.test.js'))fail(JSON.stringify(s.tests));
      if(!s.dependents.includes('src/api/payments-routes.js'))fail(JSON.stringify(s.dependents));
      const m=buildTaskContext(root,projectRoot,run,task);
      if(m.intelligence?.capability_tier!==IMPLEMENTED_TIER)fail(JSON.stringify(m.intelligence));
      if(!renderTaskPrompt(root,m).includes('REPOSITORY FACTS'))fail('prompt omits repository facts');
      // Bounded: an unrelated module must not appear via intelligence.
      if(JSON.stringify(m.intelligence).includes('refund-email.js'))fail('unrelated module reached the task context');
    });
  }

  // ========================= traceability ==================================
  {
    const t=group('traceability');
    const projectRoot=makeRichFixture();
    const {run}=runToImplement(root,projectRoot);
    // Complete TASK-001 so coverage has evidence to find.
    let one=requireTask(projectRoot,run.run_id,'TASK-001');
    one.evidence_refs=[putArtifact(projectRoot,{kind:'task-verification',content:'{"status":"PASS"}',runId:run.run_id,stage:'IMPLEMENT',filename:'TASK-001-verification.json'}).artifact_id];
    one.review_refs=[putArtifact(projectRoot,{kind:'spec-compliance-review',content:'{"verdict":"COMPLIANT"}',runId:run.run_id,stage:'IMPLEMENT',filename:'TASK-001-spec.json'}).artifact_id];
    one.status='DONE';one.diff_hash='deadbeef';saveTask(projectRoot,one);
    const graph=buildTraceabilityGraph(projectRoot,run.run_id,{run,designDecisions:[{
      decision_id:'DESIGN-001',objective:'refund idempotency',requirements:['AC-001','AC-002'],
      approval:{required:false,status:'NOT_REQUIRED'}}]});

    t('graph-connects-requirements-through-to-evidence',()=>{
      const kinds=new Set(graph.nodes.map(n=>n.kind));
      for(const k of ['REQUIREMENT','ACCEPTANCE_CRITERION','DESIGN_DECISION','TASK','TEST','EVIDENCE','INTERFACE'])
        if(!kinds.has(k))fail(`missing node kind ${k}`);
      const edgeKinds=new Set(graph.edges.map(e=>e.kind));
      for(const k of ['decomposes_to','addressed_by','implemented_by','verified_by','supports','affects'])
        if(!edgeKinds.has(k))fail(`missing edge kind ${k}`);
    });

    t('graph-is-consistent-and-has-no-dangling-refs',()=>{
      const v=validateTraceabilityGraph(graph);
      if(!v.valid)fail(JSON.stringify(v.errors));
      if(!v.node_count||!v.edge_count)fail(JSON.stringify(v));
    });

    t('dangling-refs-and-unknown-kinds-are-rejected',()=>{
      const broken={...graph,edges:[...graph.edges,{from:'TASK:TASK-999',to:'TEST:nope',kind:'verified_by'}]};
      const v=validateTraceabilityGraph(broken);
      if(v.valid)fail('a dangling edge was accepted');
      if(!v.errors.some(e=>e.code==='DANGLING_EDGE_FROM'))fail(JSON.stringify(v.errors));
      const badKind={...graph,nodes:[...graph.nodes,{id:'WIDGET:x',kind:'WIDGET',valid:true}]};
      if(validateTraceabilityGraph(badKind).valid)fail('an unknown node kind was accepted');
    });

    t('acceptance-criteria-coverage-comes-from-edges-not-claims',()=>{
      const cov=computeTraceCoverage(graph);
      if(cov.ac_coverage!==1)fail(`ac_coverage ${cov.ac_coverage} uncovered=${cov.uncovered.join(',')}`);
      if(cov.verification_coverage!==1)fail(`verification_coverage ${cov.verification_coverage}`);
      const ac1=cov.criteria.find(c=>c.acceptance_criterion==='AC-001');
      if(!ac1.implemented_by.includes('TASK:TASK-001'))fail(JSON.stringify(ac1));
      if(!ac1.evidence.length)fail('AC-001 has no supporting evidence');
    });

    t('a-claim-without-an-edge-is-reported-as-uncovered',()=>{
      const extra={...graph,nodes:[...graph.nodes,{id:nodeId('ACCEPTANCE_CRITERION','AC-099'),kind:'ACCEPTANCE_CRITERION',label:'AC-099',valid:true}]};
      const cov=computeTraceCoverage(extra);
      if(!cov.uncovered.includes('AC-099'))fail(JSON.stringify(cov.uncovered));
      if(cov.ac_coverage===1)fail('coverage still reported as complete');
    });

    t('interfaces-map-to-compatibility-verification',()=>{
      const cov=computeTraceCoverage(graph);
      const iface=cov.interfaces.find(i=>i.interface==='POST /v1/refunds');
      if(!iface)fail(JSON.stringify(cov.interfaces));
      if(!iface.affected_by.includes('TASK:TASK-001'))fail(JSON.stringify(iface));
      if(!iface.verified)fail('interface change has no compatibility verification');
    });

    t('graph-stores-refs-and-hashes-not-content',()=>{
      const serialized=JSON.stringify(graph);
      if(serialized.includes('CREATE TABLE'))fail('file content leaked into the graph');
      if(serialized.includes('"verdict":"COMPLIANT"'))fail('artifact content leaked into the graph');
      for(const n of graph.nodes)if(n.ref&&!(String(n.ref).startsWith('artifact://')||/[\w./-]+/.test(n.ref)))fail(`unexpected ref ${n.ref}`);
    });
  }

  // ========================= invalidation =================================
  {
    const t=group('invalidation');
    const projectRoot=makeRichFixture();
    const {run}=runToImplement(root,projectRoot);
    let one=requireTask(projectRoot,run.run_id,'TASK-001');
    one.evidence_refs=['artifact://sha256/'+'a'.repeat(64)];
    one.status='DONE';saveTask(projectRoot,one);
    let two=requireTask(projectRoot,run.run_id,'TASK-002');
    two.status='DONE';saveTask(projectRoot,two);
    const fresh=()=>buildTraceabilityGraph(projectRoot,run.run_id,{run,designDecisions:[{
      decision_id:'DESIGN-001',objective:'refund idempotency',requirements:['AC-001','AC-002'],
      approval:{required:false,status:'NOT_REQUIRED'}}]});

    t('wording-only-change-preserves-implementation',()=>{
      const g=fresh();
      const c=computeInvalidationClosure(g,nodeId('ACCEPTANCE_CRITERION','AC-001'),'WORDING_ONLY');
      if(c.affected_count!==0)fail(JSON.stringify(c.affected));
      if(c.earliest_outer_gate!==null)fail(String(c.earliest_outer_gate));
      if(!c.preserved_count)fail('nothing recorded as preserved');
      if(!c.rule_note)fail('no explanation for a zero-propagation class');
    });

    t('documentation-only-change-does-not-touch-tasks',()=>{
      const g=fresh();
      const c=computeInvalidationClosure(g,nodeId('ACCEPTANCE_CRITERION','AC-001'),'DOCUMENTATION_ONLY');
      if(c.affected_tasks.length)fail(JSON.stringify(c.affected_tasks));
    });

    t('behavior-change-invalidates-the-exact-closure',()=>{
      const g=fresh();
      const c=computeInvalidationClosure(g,nodeId('ACCEPTANCE_CRITERION','AC-001'),'BEHAVIOR_CHANGE');
      if(!c.affected_tasks.includes('TASK-001'))fail(JSON.stringify(c.affected_tasks));
      if(!c.affected_tests.length)fail('linked tests were not invalidated');
      if(!c.invalidated_evidence.length)fail('supporting evidence was not invalidated');
      // Every inclusion must be justified by a real path, and the requirement
      // root must never be dragged in by a downstream behaviour change.
      for(const a of c.affected)if(!a.path?.length)fail(`no justifying path for ${a.id}`);
      if(c.affected.some(a=>a.kind==='REQUIREMENT'))fail('invalidation propagated upwards to the requirement');
      if(c.preserved.some(p=>p.kind==='TASK'&&c.affected_tasks.includes(p.id.replace('TASK:',''))))fail('a task is both affected and preserved');
    });

    t('design-change-invalidates-dependent-tasks',()=>{
      const g=fresh();
      const c=computeInvalidationClosure(g,nodeId('DESIGN_DECISION','DESIGN-001'),'DESIGN_CHANGE');
      if(!c.affected_tasks.includes('TASK-001'))fail(JSON.stringify(c.affected_tasks));
      if(c.earliest_outer_gate!=='DESIGN')fail(String(c.earliest_outer_gate));
    });

    t('interface-change-invalidates-consumers-and-compatibility-tests',()=>{
      const g=fresh();
      const c=computeInvalidationClosure(g,nodeId('INTERFACE','POST /v1/refunds'),'INTERFACE_CHANGE');
      if(!c.affected_tasks.includes('TASK-001'))fail(JSON.stringify(c.affected_tasks));
      if(!c.affected_tests.length)fail('compatibility tests survived an interface change');
      if(!/compiles/.test(String(c.rule_note)))fail('interface rule does not state the compiles-anyway case');
    });

    t('unrelated-nodes-remain-valid-after-invalidation',()=>{
      const g=fresh();
      const closure=computeInvalidationClosure(g,nodeId('ACCEPTANCE_CRITERION','AC-001'),'BEHAVIOR_CHANGE');
      const record=applyInvalidation(projectRoot,g,closure,{reason:'AC-001 behaviour redefined'});
      const affected=new Set(closure.affected.map(a=>a.id));
      const docNodes=g.nodes.filter(n=>n.kind==='REQUIREMENT');
      for(const n of docNodes)if(n.valid===false)fail(`${n.id} was invalidated without a path`);
      for(const n of g.nodes){
        if(affected.has(n.id)&&n.valid!==false)fail(`${n.id} should be invalid`);
        if(!affected.has(n.id)&&n.valid===false)fail(`${n.id} invalidated but not in the closure`);
      }
      if(!record.affected.every(a=>a.path?.length))fail('record lacks graph paths');
    });

    t('invalidation-reason-and-path-are-replayable',()=>{
      const history=invalidationHistory(projectRoot,run.run_id);
      if(!history.length)fail('no invalidation history recorded');
      const last=history.at(-1);
      if(last.delta_class!=='BEHAVIOR_CHANGE')fail(last.delta_class);
      if(!last.reason||!last.graph_sha256)fail(JSON.stringify(last));
      if(!last.affected.every(a=>Array.isArray(a.path)&&a.path.length))fail('history lacks justifying paths');
    });

    t('every-delta-class-is-declared-and-bounded',()=>{
      const g=fresh();
      for(const cls of DELTA_CLASSES){
        const c=computeInvalidationClosure(g,nodeId('ACCEPTANCE_CRITERION','AC-001'),cls);
        if(c.affected_count>g.nodes.length)fail(`${cls} exceeded the graph`);
        if(!Array.isArray(c.propagates_through))fail(`${cls} has no declared propagation`);
      }
      let rejected=false;
      try{computeInvalidationClosure(g,nodeId('ACCEPTANCE_CRITERION','AC-001'),'MADE_UP');}
      catch(e){rejected=/unknown delta class/.test(e.message);}
      if(!rejected)fail('an unknown delta class was accepted');
    });
  }

  // ===================== requirement update ================================
  // The invalidation engine above already computes a correct, deterministic
  // closure -- nothing before this round ever called it across two different
  // runs. This group proves the missing wire: a NEW run can point at a PRIOR
  // run's traceability graph, get a real invalidation applied to that prior
  // graph (never deleted, per J6), and inherit exactly the artifact refs the
  // closure proves are still valid.
  {
    const t=group('requirement_update');
    const priorProjectRoot=makeRichFixture();
    const {run:priorRun}=runToImplement(root,priorProjectRoot);
    let one=requireTask(priorProjectRoot,priorRun.run_id,'TASK-001');
    const verification=putArtifact(priorProjectRoot,{kind:'task-verification',content:'{"status":"PASS"}',runId:priorRun.run_id,stage:'IMPLEMENT',filename:'TASK-001-verification.json'});
    one.evidence_refs=[verification.artifact_id];
    one.status='DONE';one.diff_hash='deadbeef';saveTask(priorProjectRoot,one);
    buildTraceabilityGraph(priorProjectRoot,priorRun.run_id,{run:priorRun,designDecisions:[{
      decision_id:'DESIGN-001',objective:priorRun.objective,requirements:['AC-001','AC-002'],
      approval:{required:false,status:'NOT_REQUIRED'}}]});
    const newUpdateRun=()=>newRun(root,priorProjectRoot,{objective:'Refund idempotency key must also cover partial captures',
      route:route(root,'x','requirement-update')});

    t('missing-continues-run-is-refused',()=>{
      const r=newUpdateRun();
      let threw=false;
      try{planRequirementUpdate(priorProjectRoot,r,{nodeId:nodeId('ACCEPTANCE_CRITERION','AC-001'),deltaClass:'BEHAVIOR_CHANGE'});}
      catch(e){threw=/--continues/.test(e.message);}
      if(!threw)fail('a plan with no continues run was accepted');
    });

    t('a-prior-run-with-no-traceability-graph-is-refused',()=>{
      const bareRoot=makeRichFixture();
      const {run:bareRun}=runToImplement(root,bareRoot);
      const r=newUpdateRun();
      let threw=false;
      try{planRequirementUpdate(bareRoot,r,{continuesRunId:bareRun.run_id,nodeId:nodeId('ACCEPTANCE_CRITERION','AC-001'),deltaClass:'BEHAVIOR_CHANGE'});}
      catch(e){threw=/trace build/.test(e.message);}
      if(!threw)fail('a prior run with no graph was accepted');
    });

    t('wording-only-update-preserves-and-carries-forward-the-prior-evidence',()=>{
      const r=newUpdateRun();
      const plan=planRequirementUpdate(priorProjectRoot,r,{continuesRunId:priorRun.run_id,
        nodeId:nodeId('ACCEPTANCE_CRITERION','AC-001'),deltaClass:'WORDING_ONLY'});
      if(plan.affected_count!==0)fail(JSON.stringify(plan));
      if(plan.earliest_outer_gate!==null)fail(String(plan.earliest_outer_gate));
      if(!plan.preserved_artifact_refs.includes(verification.artifact_id))fail(JSON.stringify(plan.preserved_artifact_refs));
      const reloaded=loadRun(priorProjectRoot,r.run_id);
      if(!reloaded.artifacts.includes(verification.artifact_id))fail('preserved artifact was not attached to the new run');
      if(loadRequirementUpdatePlan(priorProjectRoot,r.run_id)?.changed!==plan.changed)fail('plan was not persisted for later reads');
    });

    t('behavior-change-invalidates-the-prior-graph-and-excludes-its-evidence',()=>{
      const r=newUpdateRun();
      const plan=planRequirementUpdate(priorProjectRoot,r,{continuesRunId:priorRun.run_id,
        nodeId:nodeId('ACCEPTANCE_CRITERION','AC-001'),deltaClass:'BEHAVIOR_CHANGE',reason:'idempotency key must cover partial captures too'});
      if(plan.affected_count===0)fail('behavior change invalidated nothing');
      if(plan.earliest_outer_gate!=='REQUIREMENTS')fail(String(plan.earliest_outer_gate));
      if(plan.preserved_artifact_refs.includes(verification.artifact_id))fail('invalidated evidence was still carried forward as preserved');
      const g=loadTraceabilityGraph(priorProjectRoot,priorRun.run_id);
      const t1=g.nodes.find(n=>n.id==='TASK:TASK-001');
      if(t1.valid!==false)fail('the prior graph itself was not updated');
      if(!t1.invalidated_by)fail('invalidated node carries no reason');
      const history=invalidationHistory(priorProjectRoot,priorRun.run_id);
      if(!history.some(h=>/partial captures/.test(h.reason)))fail('invalidation history missing the new reason (J6: history must be preserved, not overwritten)');
    });

    t('dry-run-computes-without-mutating-anything',()=>{
      const before=loadTraceabilityGraph(priorProjectRoot,priorRun.run_id);
      const beforeSha=sha256(JSON.stringify(before.nodes.map(n=>[n.id,n.valid])));
      const r=newUpdateRun();
      const plan=planRequirementUpdate(priorProjectRoot,r,{continuesRunId:priorRun.run_id,
        nodeId:nodeId('INTERFACE','POST /v1/refunds'),deltaClass:'INTERFACE_CHANGE',dryRun:true});
      if(!plan.dry_run)fail('dry_run flag not set on the result');
      const after=loadTraceabilityGraph(priorProjectRoot,priorRun.run_id);
      const afterSha=sha256(JSON.stringify(after.nodes.map(n=>[n.id,n.valid])));
      if(beforeSha!==afterSha)fail('dry-run mutated the prior graph');
      if(loadRun(priorProjectRoot,r.run_id).artifacts?.length)fail('dry-run attached artifacts to the new run');
      if(loadRequirementUpdatePlan(priorProjectRoot,r.run_id))fail('dry-run persisted a plan record');
    });

    t('context-manifest-surfaces-the-plan-for-a-requirement-update-run',()=>{
      const r=newUpdateRun();
      planRequirementUpdate(priorProjectRoot,r,{continuesRunId:priorRun.run_id,
        nodeId:nodeId('ACCEPTANCE_CRITERION','AC-002'),deltaClass:'WORDING_ONLY'});
      const m=buildContext(root,priorProjectRoot,r,{});
      if(m.requirement_update?.continues_run_id!==priorRun.run_id)fail(JSON.stringify(m.requirement_update));
      const p=renderPrompt(root,m);
      if(!/REQUIREMENT UPDATE/.test(p)||!p.includes(priorRun.run_id))fail('rendered prompt omits the requirement-update plan');
    });

    t('an-unrelated-workflow-never-surfaces-a-requirement-update-plan',()=>{
      const other=newRun(root,priorProjectRoot,{objective:'Add loyalty tiers',route:route(root,'Add loyalty tiers','new-feature')});
      const m=buildContext(root,priorProjectRoot,other,{});
      if(m.requirement_update!==null)fail(JSON.stringify(m.requirement_update));
    });
  }

  // =========================== delivery ====================================
  {
    const t=group('delivery');
    const projectRoot=makeRichFixture();
    const {run}=runToImplement(root,projectRoot);
    const head=()=>execFileSync('git',['rev-parse','HEAD'],{cwd:projectRoot,encoding:'utf8'}).trim();

    t('protected-branch-push-is-denied-by-default',()=>{
      for(const b of ['main','master','release/1.2','production','develop'])
        if(!isProtectedBranch(b))fail(`${b} not treated as protected`);
      const denied=checkPushTarget('main',{approvals:[]});
      if(denied.decision!=='DENY')fail(JSON.stringify(denied));
      const approved=checkPushTarget('main',{approvals:['git.push_protected']});
      if(approved.decision!=='APPROVAL_RECORDED')fail(JSON.stringify(approved));
      const feature=checkPushTarget(branchFor(run.run_id,'TASK-001'));
      if(feature.decision!=='ALLOW')fail(JSON.stringify(feature));
    });

    t('ci-evidence-is-revision-bound',()=>{
      const rec=recordCiEvidence(projectRoot,run,{revision:head(),provider:'github',workflow:'ci',
        checks:[{name:'unit',status:'PASS'},{name:'lint',status:'PASS',required:false}]});
      if(rec.status!=='PASS')fail(rec.status);
      if(rec.revision!==head())fail('evidence not bound to the revision');
      const current=ciEvidenceCurrent(projectRoot,run.run_id);
      if(!current.current)fail(JSON.stringify(current));
      const stale=ciEvidenceCurrent(projectRoot,run.run_id,{revision:'0'.repeat(40)});
      if(stale.current)fail('stale evidence reported as current');
      if(stale.reason!=='REVISION_CHANGED')fail(stale.reason);
      if(stale.action!=='RERUN_CI_ON_CURRENT_REVISION')fail(String(stale.action));
    });

    t('a-failing-required-check-fails-the-record',()=>{
      const rec=recordCiEvidence(projectRoot,run,{revision:head(),provider:'github',
        checks:[{name:'unit',status:'FAIL'},{name:'lint',status:'PASS'}]});
      if(rec.status!=='FAIL')fail(rec.status);
      const optionalOnly=recordCiEvidence(projectRoot,run,{revision:head(),provider:'github',
        checks:[{name:'unit',status:'PASS'},{name:'flaky',status:'FAIL',required:false}]});
      if(optionalOnly.status!=='PASS')fail(`optional failure changed the verdict: ${optionalOnly.status}`);
    });

    t('pr-ready-is-not-merged',()=>{
      recordCiEvidence(projectRoot,run,{revision:head(),provider:'github',checks:[{name:'unit',status:'PASS'}]});
      const prReady=recordDelivery(projectRoot,run,{target:'PR_READY',base:'master',recordedBaseRevision:head()});
      if(prReady.achieved_target!=='PR_READY')fail(JSON.stringify(prReady.problems));
      const merged=recordDelivery(projectRoot,run,{target:'MERGED',base:'master',recordedBaseRevision:head()});
      if(merged.achieved_target)fail('MERGED claimed without a merge commit');
      if(!merged.problems.includes('MERGED_CLAIMED_WITHOUT_MERGE_COMMIT'))fail(JSON.stringify(merged.problems));
    });

    t('base-drift-blocks-delivery-and-asks-for-re-verification',()=>{
      recordCiEvidence(projectRoot,run,{revision:head(),provider:'github',checks:[{name:'unit',status:'PASS'}]});
      const drifted=recordDelivery(projectRoot,run,{target:'PR_READY',base:'master',recordedBaseRevision:'0'.repeat(40)});
      if(drifted.status!=='BLOCKED')fail(JSON.stringify(drifted));
      if(!drifted.problems.includes('TARGET_BASE_DRIFTED'))fail(JSON.stringify(drifted.problems));
      if(drifted.base_drift.action!=='RE_IMPACT_AND_REVERIFY')fail(JSON.stringify(drifted.base_drift));
    });

    t('ci-evidence-on-another-revision-does-not-vouch-for-this-one',()=>{
      recordCiEvidence(projectRoot,run,{revision:'1'.repeat(40),provider:'github',checks:[{name:'unit',status:'PASS'}]});
      const out=recordDelivery(projectRoot,run,{target:'PR_READY',base:'master',recordedBaseRevision:head()});
      if(out.status!=='BLOCKED')fail(JSON.stringify(out));
      if(!out.problems.includes('CI_EVIDENCE_REVISION_MISMATCH'))fail(JSON.stringify(out.problems));
    });

    t('missing-ci-evidence-blocks-delivery',()=>{
      const freshRoot=makeRichFixture();
      const other=runToImplement(root,freshRoot);
      const out=recordDelivery(freshRoot,other.run,{target:'PR_READY',base:'master'});
      if(out.status!=='BLOCKED')fail(JSON.stringify(out));
      if(!out.problems.includes('NO_CI_EVIDENCE'))fail(JSON.stringify(out.problems));
      if(out.achieved_target)fail('a target was claimed with no CI evidence');
    });

    t('stacked-dependency-order-must-be-explicit',()=>{
      recordCiEvidence(projectRoot,run,{revision:head(),provider:'github',checks:[{name:'unit',status:'PASS'}]});
      const implicit=recordDelivery(projectRoot,run,{target:'PR_READY',base:'master',recordedBaseRevision:head(),
        stacked:[{branch:'a'},{branch:'b'}]});
      if(!implicit.problems.includes('STACKED_DEPENDENCY_ORDER_NOT_EXPLICIT'))fail(JSON.stringify(implicit.problems));
      const explicit=recordDelivery(projectRoot,run,{target:'PR_READY',base:'master',recordedBaseRevision:head(),
        stacked:[{branch:'a'},{branch:'b',depends_on:'a'}]});
      if(explicit.status!=='READY')fail(JSON.stringify(explicit.problems));
      if(explicit.stacked[1].position!==2)fail(JSON.stringify(explicit.stacked));
    });

    t('interface-changing-and-migration-work-get-their-own-branch',()=>{
      const tasks=listTasks(projectRoot,run.run_id);
      const g=groupTaskBranches([...tasks,
        {task_id:'TASK-009',category:'migration',scope:{modules:['src/payments']},risk:{destructive_data_change:true},depends_on:[]}]);
      if(!g.single_branches.includes('TASK-009'))fail(JSON.stringify(g));
      if(!g.single_branches.includes('TASK-001'))fail(`interface task was grouped: ${JSON.stringify(g)}`);
    });
  }

  // =========================== fallback ====================================
  {
    const t=group('fallback');
    const projectRoot=makeRichFixture();
    const {run}=runToImplement(root,projectRoot);
    startTask(root,projectRoot,run,'TASK-001',{writer:'writer-a'});
    const ws=getTaskWorkspace(projectRoot,run.run_id,'TASK-001');
    fs.writeFileSync(path.join(ws.root,'src','payments','payment-service.js'),
      `import {RefundRepository} from './refund-repository.js';\nexport class PaymentService{ refund(id){return id;} }\n`);
    captureTaskDiff(projectRoot,run,requireTask(projectRoot,run.run_id,'TASK-001'));

    t('checkpoint-carries-structured-state-only',()=>{
      const cp=taskCheckpoint(projectRoot,run,requireTask(projectRoot,run.run_id,'TASK-001'));
      if(!cp.base_revision||!cp.diff_hash||!cp.context_manifest_ref)fail(JSON.stringify(cp));
      for(const k of ['provider_conversation_history','hidden_chain_of_thought','worker_scratch_reasoning'])
        if(!cp.excludes.includes(k))fail(`checkpoint does not exclude ${k}`);
    });

    t('provider-timeout-continues-from-the-checkpoint',()=>{
      const out=resumeFromCheckpoint(root,projectRoot,run,'TASK-001',{
        originalProvider:'claude',fallbackProvider:'codex',failureClass:'INFRA_TRANSIENT',reason:'model timeout'});
      if(!out.resumed)fail(JSON.stringify(out));
      if(out.fallback_provider!=='codex'||out.original_provider!=='claude')fail(JSON.stringify(out));
      if(!out.base_revision||!out.diff_hash)fail('checkpoint state not carried');
      if(out.resumed_from_status!=='RUNNING')fail(out.resumed_from_status);
    });

    t('provider-unavailable-without-a-fallback-does-not-pretend',()=>{
      const out=resumeFromCheckpoint(root,projectRoot,run,'TASK-001',{originalProvider:'claude',fallbackProvider:null});
      if(out.resumed)fail('resumed with no fallback provider');
      if(out.reason!=='NO_FALLBACK_PROVIDER')fail(out.reason);
    });

    t('context-hash-is-preserved-or-the-delta-is-reported',()=>{
      const out=resumeFromCheckpoint(root,projectRoot,run,'TASK-001',{originalProvider:'claude',fallbackProvider:'antigravity'});
      if(!out.context_delta)fail('no context delta reported');
      if(out.context_delta.changed===false&&!out.context_delta.hash)fail(JSON.stringify(out.context_delta));
      if(out.context_delta.changed===true&&!(out.context_delta.from&&out.context_delta.to))fail(JSON.stringify(out.context_delta));
    });

    t('no-hidden-reasoning-is-transferred',()=>{
      const out=resumeFromCheckpoint(root,projectRoot,run,'TASK-001',{originalProvider:'claude',fallbackProvider:'codex'});
      for(const k of ['provider_conversation_history','hidden_chain_of_thought','worker_scratch_reasoning'])
        if(!out.not_transferred.includes(k))fail(`${k} not listed as withheld`);
      if(out.transferred.some(x=>/reasoning|conversation|history/i.test(x)))fail(JSON.stringify(out.transferred));
    });

    t('security-critical-fallback-does-not-weaken-risk-policy',()=>{
      const task=requireTask(projectRoot,run.run_id,'TASK-001');
      task.risk={profile:'STRICT',security:'HIGH',data:'LOW',destructive_data_change:false};
      task.execution.independent_review=true;
      saveTask(projectRoot,task);
      const out=resumeFromCheckpoint(root,projectRoot,run,'TASK-001',{originalProvider:'claude',fallbackProvider:'codex'});
      if(out.risk_policy_preserved.profile!=='STRICT')fail(JSON.stringify(out.risk_policy_preserved));
      if(out.risk_policy_preserved.security!=='HIGH')fail(JSON.stringify(out.risk_policy_preserved));
      if(out.risk_policy_preserved.independent_review!==true)fail('independent review requirement dropped on fallback');
    });

    t('fallback-is-recorded-as-an-event',()=>{
      const events=listTaskEvents(projectRoot,run.run_id,'TASK-001').filter(e=>e.type==='task.provider_fallback');
      if(!events.length)fail('no provider fallback event recorded');
      if(!events.at(-1).payload.diff_hash)fail(JSON.stringify(events.at(-1).payload));
    });
  }

  // =========================== governor ====================================
  {
    const t=group('governor');
    const projectRoot=makeRichFixture();
    const {run}=runToImplement(root,projectRoot);
    const policy=getGovernancePolicy(root);

    t('complexity-is-derived-from-declared-scope',()=>{
      const low=taskComplexity(root,{scope:{write:['a.js'],modules:['m']},execution:{estimated_seconds:10}});
      if(low.level!=='LOW')fail(JSON.stringify(low));
      const high=taskComplexity(root,{scope:{write:Array.from({length:12},(_,i)=>`f${i}.js`),modules:['a','b','c']},execution:{estimated_seconds:1000}});
      if(high.level!=='HIGH')fail(JSON.stringify(high));
    });

    t('risk-raises-the-model-floor-and-budget-never-lowers-it',()=>{
      const task=requireTask(projectRoot,run.run_id,'TASK-001');
      task.risk={profile:'STRICT',security:'HIGH',data:'LOW',destructive_data_change:false};
      saveTask(projectRoot,task);
      const d=governTask(root,projectRoot,run,task,{remainingModelCalls:1});
      if(d.model_floor!=='HIGH_REASONING')fail(d.model_floor);
      if(d.model_tier!=='HIGH_REASONING')fail(`budget pressure lowered the tier to ${d.model_tier}`);
      if(!d.decisions.includes('STOP_AND_REQUEST_CONFIRMATION'))fail(JSON.stringify(d.decisions));
      if(d.security_or_review_downgraded!==false)fail('governor reported a security downgrade');
    });

    t('mandatory-independent-review-is-never-traded-for-cost',()=>{
      const task=requireTask(projectRoot,run.run_id,'TASK-001');
      task.risk={profile:'STRICT',security:'HIGH',data:'HIGH',destructive_data_change:true};
      saveTask(projectRoot,task);
      const d=governTask(root,projectRoot,run,task,{remainingModelCalls:0});
      if(!d.decisions.includes('SPAWN_INDEPENDENT_REVIEWER'))fail(JSON.stringify(d.decisions));
      if(!d.reasons.some(r=>/cannot be traded for cost/.test(r)))fail(JSON.stringify(d.reasons));
    });

    t('deterministic-tools-come-before-inference',()=>{
      const task=requireTask(projectRoot,run.run_id,'TASK-001');
      const d=governTask(root,projectRoot,run,task,{});
      if(!d.decisions.includes('USE_DETERMINISTIC_TOOL_FIRST'))fail(JSON.stringify(d.decisions));
    });

    t('context-pressure-compacts-then-stops',()=>{
      const task=requireTask(projectRoot,run.run_id,'TASK-002');
      const compact=governTask(root,projectRoot,run,task,{contextEstimate:900,contextBudget:1000});
      if(!compact.decisions.includes('COMPACT_CONTEXT'))fail(JSON.stringify(compact.decisions));
      if(compact.decisions.includes('STOP_AND_REQUEST_CONFIRMATION'))fail('compaction escalated to a stop too early');
      const stop=governTask(root,projectRoot,run,task,{contextEstimate:1400,contextBudget:1000});
      if(!stop.decisions.includes('STOP_AND_REQUEST_CONFIRMATION'))fail(JSON.stringify(stop.decisions));
    });

    t('repeated-attempts-escalate-reasoning-and-stop-fan-out',()=>{
      const task=requireTask(projectRoot,run.run_id,'TASK-002');
      task.attempt=2;saveTask(projectRoot,task);
      const d=governTask(root,projectRoot,run,task,{});
      if(!d.decisions.includes('ESCALATE_HIGH_REASONING'))fail(JSON.stringify(d.decisions));
      if(!d.decisions.includes('AVOID_PARALLEL_FAN_OUT'))fail(JSON.stringify(d.decisions));
      task.attempt=3;saveTask(projectRoot,task);
      if(!governTask(root,projectRoot,run,task,{}).decisions.includes('STOP_AND_REQUEST_CONFIRMATION'))fail('no stop after exhausting retries');
    });

    t('every-decision-is-explainable',()=>{
      const task=requireTask(projectRoot,run.run_id,'TASK-001');
      const d=governTask(root,projectRoot,run,task,{contextEstimate:500,contextBudget:1000,remainingModelCalls:20});
      if(!d.reasons.length)fail('no reasons recorded');
      if(!d.inputs.complexity||!d.inputs.historical_success_rate)fail(JSON.stringify(d.inputs));
      for(const dec of d.decisions)if(!policy.decisions.includes(dec))fail(`undeclared decision ${dec}`);
      const report=governorReport(root,projectRoot,run);
      if(report.objective!==policy.objective)fail(report.objective);
      if(!report.hard_rule)fail('report omits the hard rule');
    });
  }

  // =========================== learning ====================================
  {
    const t=group('learning');

    t('secrets-and-environment-identifiers-are-removed',()=>{
      const dirty=[
        'AKIA0123456789ABCDEF',
        'ghp_abcdefghijklmnopqrstuvwxyz012345',
        'api_key = "sk-abcdefghijklmnopqrstuv"',
        'contact dev@example.com at 10.1.2.3',
        'C:\\Users\\alice\\secret\\repo',
        '/home/alice/project',
        'https://internal.corp.example/build/42'
      ].join('\n');
      const clean=sanitizeText(dirty);
      for(const leak of ['AKIA0123456789ABCDEF','ghp_abcdefghij','sk-abcdefghij','dev@example.com','10.1.2.3','alice'])
        if(clean.includes(leak))fail(`leak survived: ${leak}`);
      if(!clean.includes('[REDACTED'))fail('nothing was redacted');
      if(sanitizePath('/repo/src/a.js',{projectRoot:'/repo'})!=='src/a.js')fail(sanitizePath('/repo/src/a.js',{projectRoot:'/repo'}));
    });

    t('candidate-generation-is-sanitized-and-deterministic',()=>{
      const args={source:'VERIFICATION_FAILURE',title:'refund double-charge escaped targeted tests',
        observed:'targeted tests passed while the endpoint double-charged; token=ghp_abcdefghijklmnopqrstuvwxyz012345',
        expected:'a repeated refund must be a no-op',
        failureClass:'VERIFICATION_FAILURE',runId:'run_x',taskId:'TASK-001',
        paths:['/repo/src/payments/payment-service.js'],projectRoot:'/repo',
        evidence:['artifact://sha256/'+'b'.repeat(64)]};
      const a=buildRegressionCandidate(args);
      const b=buildRegressionCandidate(args);
      if(a.candidate_id!==b.candidate_id)fail('candidate id is not deterministic');
      if(JSON.stringify(a.facts)!==JSON.stringify(b.facts))fail('facts are not deterministic');
      if(JSON.stringify(a).includes('ghp_abcdefghij'))fail('a secret reached the candidate');
      if(a.facts.paths[0]!=='src/payments/payment-service.js')fail(JSON.stringify(a.facts.paths));
      const v=validateRegressionCandidate(a);
      if(!v.valid)fail(JSON.stringify(v.errors));
      if(v.leaks.length)fail(JSON.stringify(v.leaks));
    });

    t('an-unsanitized-candidate-is-rejected',()=>{
      const good=buildRegressionCandidate({source:'REVIEW_FINDING',title:'t',observed:'o',expected:'e'});
      const tampered={...good,facts:{...good.facts,observed:'token AKIA0123456789ABCDEF leaked'}};
      const v=validateRegressionCandidate(tampered);
      if(v.valid)fail('an unsanitized candidate was accepted');
      if(!v.errors.some(e=>String(e).startsWith('UNSANITIZED_CONTENT')))fail(JSON.stringify(v.errors));
      const absolute={...good,facts:{...good.facts,paths:['C:\\Users\\bob\\x.js']}};
      if(validateRegressionCandidate(absolute).valid)fail('an absolute path leak was accepted');
    });

    t('learning-never-mutates-policy-automatically',()=>{
      const c=buildRegressionCandidate({source:'INCORRECT_GATE_DECISION',title:'gate let an uncovered AC through',
        observed:'PLAN gate opened with AC-003 uncovered',expected:'the plan validator should have failed',
        policyHypothesis:'tighten the coverage invariant for STANDARD plans'});
      if(c.auto_applied!==false)fail('candidate marked auto-applied');
      if(c.status!=='CANDIDATE')fail(c.status);
      if(c.policy_change.status!=='PROPOSED_NOT_APPLIED')fail(c.policy_change.status);
      if(!c.adoption_requires.includes('deterministic_eval_pass')||!c.adoption_requires.includes('human_review'))fail(JSON.stringify(c.adoption_requires));
      const tampered={...c,policy_change:{...c.policy_change,status:'APPLIED'}};
      if(validateRegressionCandidate(tampered).valid)fail('an applied policy change was accepted');
    });

    t('every-source-routes-to-a-runnable-suite',()=>{
      for(const source of LEARNING_SOURCES){
        const c=buildRegressionCandidate({source,title:`t-${source}`,observed:'o',expected:'e'});
        if(!c.suite||!c.suite.startsWith('evals/'))fail(`${source} -> ${c.suite}`);
        const ec=toEvalCase(c);
        if(!ec.id||!ec.when||!ec.expect||ec.status!=='CANDIDATE_PENDING_VALIDATION')fail(JSON.stringify(ec));
      }
      let rejected=false;
      try{buildRegressionCandidate({source:'MADE_UP',title:'t',observed:'o',expected:'e'});}
      catch(e){rejected=/unknown learning source/.test(e.message);}
      if(!rejected)fail('an unknown learning source was accepted');
    });
  }

  const results=Object.entries(groups).map(([group,rows])=>({
    group,checks:rows.length,
    passes:rows.filter(r=>r.status==='PASS').length,
    failures:rows.filter(r=>r.status!=='PASS').length,
    results:rows
  }));
  return {
    schema:'agent-sdlc/alpha6-suite/v1',
    groups:results,
    checks:results.reduce((a,g)=>a+g.checks,0),
    passes:results.reduce((a,g)=>a+g.passes,0),
    failures:results.reduce((a,g)=>a+g.failures,0)
  };
}
