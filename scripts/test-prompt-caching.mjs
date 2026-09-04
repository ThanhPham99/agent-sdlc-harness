#!/usr/bin/env node
// Test prompt caching separation: static prefix, stage prefix, dynamic suffix.
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildContext,renderPrompt,renderCacheablePrompt,condenseLog,projectArtifactsForStage} from '../runtime/context.mjs';
import {buildTaskContext,renderTaskPrompt,renderCacheableTaskPrompt} from '../runtime/task-context.mjs';
import {formatProviderPrompt} from '../runtime/provider.mjs';
import {initProject} from '../runtime/store.mjs';
import {newRun} from '../runtime/orchestrator.mjs';
import {route} from '../runtime/router.mjs';
import {createSuite} from './lib/suite.mjs';
import fs from 'node:fs';
import {makeTempDir} from './lib/tempdir.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const {test,assert,finish}=createSuite('agent-sdlc/prompt-caching-validation/v1','PROMPT-CACHING-VALIDATION.json');

function fixture(){
  const d=makeTempDir('agent-sdlc-prompt-');
  initProject(d,{
    schema:'agent-sdlc/project/v1',
    project:'prompt-fixture',
    commands:{test_full:['npm','test'],test_targeted:['npm','test','--','{selector}']},
    context:{project_invariants:['invariant-rule-1']}
  });
  return d;
}

test('renderCacheablePrompt-returns-consistent-blocks',()=>{
  const d=fixture();
  const r=route(ROOT,'Add payment webhook endpoint');
  const run=newRun(ROOT,d,{objective:'Add payment webhook endpoint',route:r});
  const manifest=buildContext(ROOT,d,run);
  
  const cacheable=renderCacheablePrompt(ROOT,manifest);
  assert(typeof cacheable.static_prefix==='string'&&cacheable.static_prefix.length>0,'missing static_prefix');
  assert(typeof cacheable.stage_prefix==='string'&&cacheable.stage_prefix.length>0,'missing stage_prefix');
  assert(typeof cacheable.dynamic_suffix==='string'&&cacheable.dynamic_suffix.length>0,'missing dynamic_suffix');
  assert(Array.isArray(cacheable.cache_blocks)&&cacheable.cache_blocks.length===3,'cache_blocks count mismatch');
  
  // full_prompt must match renderPrompt
  const regular=renderPrompt(ROOT,manifest);
  assert(cacheable.full_prompt===regular,'full_prompt does not match renderPrompt');
  assert(cacheable.full_prompt.includes(manifest.objective),'prompt missing objective');
  assert(cacheable.static_prefix.includes('ALLOWED TOOLS'),'static_prefix missing allowed tools');
});

test('static-prefix-is-stable-across-different-objectives',()=>{
  const d=fixture();
  const r1=route(ROOT,'Add feature 1');
  const run1=newRun(ROOT,d,{objective:'Add feature 1',route:r1});
  const m1=buildContext(ROOT,d,run1);
  const c1=renderCacheablePrompt(ROOT,m1);

  const r2=route(ROOT,'Fix bug 2');
  const run2=newRun(ROOT,d,{objective:'Fix bug 2',route:r2});
  const m2=buildContext(ROOT,d,run2);
  const c2=renderCacheablePrompt(ROOT,m2);

  // Both runs in INTAKE stage with same tools must produce identical static_prefix
  assert(c1.static_prefix===c2.static_prefix,'static_prefix is not stable across objectives');
});

test('renderCacheableTaskPrompt-returns-consistent-blocks',()=>{
  const d=fixture();
  const r=route(ROOT,'Implement user authentication');
  const run=newRun(ROOT,d,{objective:'Implement user authentication',route:r});
  run.state='IMPLEMENT';
  
  const task1={
    task_id:'TASK-001',
    category:'implementation',
    objective:'Create login handler',
    scope:{write:['src/auth/login.js'],read:['src/config.js'],interfaces:['POST /login']},
    done_conditions:['Handler returns JWT token']
  };

  const manifest1=buildTaskContext(ROOT,d,run,task1);
  const cacheable1=renderCacheableTaskPrompt(ROOT,manifest1);

  assert(typeof cacheable1.static_prefix==='string'&&cacheable1.static_prefix.length>0,'missing static_prefix');
  assert(typeof cacheable1.module_prefix==='string'&&cacheable1.module_prefix.length>0,'missing module_prefix');
  assert(typeof cacheable1.dynamic_suffix==='string'&&cacheable1.dynamic_suffix.length>0,'missing dynamic_suffix');
  assert(Array.isArray(cacheable1.cache_blocks)&&cacheable1.cache_blocks.length===3,'cache_blocks count mismatch');

  const regular1=renderTaskPrompt(ROOT,manifest1);
  assert(cacheable1.full_prompt===regular1,'full_prompt does not match renderTaskPrompt');
  assert(cacheable1.full_prompt.includes(task1.task_id),'prompt missing task_id');
  assert(cacheable1.static_prefix.includes('TASK HARNESS CONTRACT'),'static_prefix missing harness contract');
});

test('task-static-and-module-prefix-stable-across-tasks',()=>{
  const d=fixture();
  const r=route(ROOT,'Implement payments');
  const run=newRun(ROOT,d,{objective:'Implement payments',route:r});
  run.state='IMPLEMENT';

  const task1={
    task_id:'TASK-001',
    category:'implementation',
    objective:'Create stripe client',
    scope:{write:['src/stripe.js']}
  };
  const task2={
    task_id:'TASK-002',
    category:'implementation',
    objective:'Create webhook handler',
    scope:{write:['src/webhook.js']}
  };

  const m1=buildTaskContext(ROOT,d,run,task1);
  const c1=renderCacheableTaskPrompt(ROOT,m1);

  const m2=buildTaskContext(ROOT,d,run,task2);
  const c2=renderCacheableTaskPrompt(ROOT,m2);

  assert(c1.static_prefix===c2.static_prefix,'task static_prefix must be stable across tasks');
  assert(c1.module_prefix===c2.module_prefix,'task module_prefix must be stable across same category tasks');
});

test('condenseLog-preserves-error-frames-across-frameworks',()=>{
  // Simulate verbose Vitest / Jest log
  const vitestLog=[
    ...Array(40).fill('  ✓ src/test/pass.spec.ts (10 ms)'),
    'FAIL src/test/auth.spec.ts > login',
    'AssertionError: expected 401 to be 200',
    '  - Expected: 200',
    '  + Received: 401',
    '    at src/test/auth.spec.ts:42:15',
    ...Array(40).fill('  ✓ src/test/other.spec.ts (15 ms)')
  ].join('\n');

  const condensedVitest=condenseLog(vitestLog);
  assert(condensedVitest.includes('AssertionError: expected 401 to be 200'),'condenseLog dropped AssertionError');
  assert(condensedVitest.includes('Expected: 200'),'condenseLog dropped Expected diff');
  assert(condensedVitest.includes('Received: 401'),'condenseLog dropped Received diff');
  assert(condensedVitest.includes('verbose log lines omitted'),'condenseLog failed to omit passing logs');

  // Simulate Pytest log
  const pytestLog=[
    ...Array(30).fill('test_service.py ................. [ 50%]'),
    '=================================== FAILURES ===================================',
    '________________________________ test_refund ___________________________________',
    '    def test_refund():',
    '>       assert refund.status == "SUCCESS"',
    'E       AssertionError: assert "FAILED" == "SUCCESS"',
    'E         - SUCCESS',
    'E         + FAILED',
    'test_service.py:18: AssertionError',
    '=========================== short test summary info ============================',
    'FAILED test_service.py::test_refund - AssertionError: assert "FAILED" == "SUCCESS"',
    ...Array(30).fill('test_service.py ................. [100%]')
  ].join('\n');

  const condensedPytest=condenseLog(pytestLog);
  assert(condensedPytest.includes('FAILURES'),'condenseLog dropped Pytest FAILURES header');
  assert(condensedPytest.includes('AssertionError: assert "FAILED" == "SUCCESS"'),'condenseLog dropped Pytest assert');
  assert(condensedPytest.includes('short test summary info'),'condenseLog dropped Pytest summary');

  // Simulate Go test log
  const goLog=[
    ...Array(30).fill('=== RUN   TestPass'),
    '--- PASS: TestPass (0.00s)',
    '=== RUN   TestFail',
    '--- FAIL: TestFail (0.01s)',
    '    auth_test.go:25: token validation failed: expired',
    'panic: runtime error: invalid memory address or nil pointer dereference',
    '    [signal SIGSEGV: segmentation violation code=0x1 addr=0x0 pc=0x10b240]',
    ...Array(30).fill('=== RUN   TestPass2')
  ].join('\n');

  const condensedGo=condenseLog(goLog);
  assert(condensedGo.includes('--- FAIL: TestFail'),'condenseLog dropped Go FAIL marker');
  assert(condensedGo.includes('token validation failed: expired'),'condenseLog dropped Go error message');
  assert(condensedGo.includes('panic: runtime error'),'condenseLog dropped panic stack trace');
});

test('cache-breakpoints-and-estimated-hit-rate-are-computed',()=>{
  const d=fixture();
  const r=route(ROOT,'Build microservice authentication');
  const run=newRun(ROOT,d,{objective:'Build microservice authentication',route:r});
  const manifest=buildContext(ROOT,d,run);
  const cacheable=renderCacheablePrompt(ROOT,manifest);

  assert(Array.isArray(cacheable.cache_breakpoints)&&cacheable.cache_breakpoints.length===2,'missing stage cache_breakpoints');
  assert(typeof cacheable.estimated_cache_hit_rate==='number'&&cacheable.estimated_cache_hit_rate>0,'invalid estimated_cache_hit_rate');

  const task={
    task_id:'TASK-AUTH',
    category:'implementation',
    objective:'JWT verification middleware',
    scope:{write:['src/jwt.js']}
  };
  const taskManifest=buildTaskContext(ROOT,d,run,task);
  const taskCacheable=renderCacheableTaskPrompt(ROOT,taskManifest);

  assert(Array.isArray(taskCacheable.cache_breakpoints)&&taskCacheable.cache_breakpoints.length===2,'missing task cache_breakpoints');
  assert(typeof taskCacheable.estimated_cache_hit_rate==='number'&&taskCacheable.estimated_cache_hit_rate>0,'invalid task estimated_cache_hit_rate');
});

test('formatProviderPrompt-adapts-to-host-capabilities',()=>{
  const d=fixture();
  const r=route(ROOT,'Test caching prompt formatter');
  const run=newRun(ROOT,d,{objective:'Test caching prompt formatter',route:r});
  const manifest=buildContext(ROOT,d,run);
  const cacheable=renderCacheablePrompt(ROOT,manifest);

  // Claude / Anthropic format
  const claudeFormatted=formatProviderPrompt('claude',cacheable);
  assert(claudeFormatted.cache_enabled===true,'claude cache_enabled mismatch');
  assert(claudeFormatted.provider==='anthropic','claude provider mismatch');
  assert(claudeFormatted.cache_control?.type==='ephemeral','claude cache_control mismatch');
  assert(Array.isArray(claudeFormatted.blocks)&&claudeFormatted.blocks.length===3,'claude blocks count mismatch');

  // Antigravity format
  const agyFormatted=formatProviderPrompt('antigravity',cacheable);
  assert(agyFormatted.cache_enabled===true,'agy cache_enabled mismatch');
  assert(agyFormatted.provider==='google-antigravity','agy provider mismatch');
  assert(agyFormatted.cache_control?.type==='context_cache','agy cache_control mismatch');

  // Codex / generic fallback
  const codexFormatted=formatProviderPrompt('codex',cacheable);
  assert(codexFormatted.cache_enabled===false,'codex cache_enabled mismatch');
  // Bare string fallback
  const rawFormatted=formatProviderPrompt('claude','hello world');
  assert(rawFormatted.prompt==='hello world'&&rawFormatted.cache_enabled===false,'raw string formatting failed');
});

test('projectArtifactsForStage-compacts-non-primary-artifacts-for-stage',()=>{
  const artifacts=[
    {ref:'art_intake',kind:'intake',summary:'Intake notes '.repeat(30),sha256:'111111111111'},
    {ref:'art_plan',kind:'plan',summary:'Plan items '.repeat(30),sha256:'222222222222'}
  ];
  const projected=projectArtifactsForStage('VERIFY',artifacts);
  assert(projected[0].summary.includes('compacted for VERIFY stage relevance'),'intake artifact was not projected/compacted in VERIFY');
  assert(!projected[1].summary.includes('compacted for VERIFY stage relevance'),'plan artifact was prematurely compacted in VERIFY');
});

test('full_prompt-matches-prefix-cacheable-layout',()=>{
  const d=fixture();
  const r=route(ROOT,'Test prefix cache layout');
  const run=newRun(ROOT,d,{objective:'Test prefix cache layout',route:r});
  const manifest=buildContext(ROOT,d,run);
  const cacheable=renderCacheablePrompt(ROOT,manifest);
  const expected=`${cacheable.static_prefix}\n\n${cacheable.stage_prefix}\n\n${cacheable.dynamic_suffix}`;
  assert(cacheable.full_prompt===expected,'full_prompt does not match static + stage + dynamic layout');
});

finish();
