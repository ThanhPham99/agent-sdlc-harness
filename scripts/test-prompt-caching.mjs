#!/usr/bin/env node
// Test prompt caching separation: static prefix, stage prefix, dynamic suffix.
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildContext,renderPrompt,renderCacheablePrompt} from '../runtime/context.mjs';
import {initProject} from '../runtime/store.mjs';
import {newRun} from '../runtime/orchestrator.mjs';
import {route} from '../runtime/router.mjs';
import {createSuite} from './lib/suite.mjs';
import fs from 'node:fs';
import os from 'node:os';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const {test,assert,finish}=createSuite('agent-sdlc/prompt-caching-validation/v1','PROMPT-CACHING-VALIDATION.json');

function fixture(){
  const d=fs.mkdtempSync(path.join(os.tmpdir(),'agent-sdlc-prompt-'));
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

finish();
