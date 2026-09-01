#!/usr/bin/env node
// Test suite for Semantic Memory & Failure Pattern Indexer.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {indexFailurePattern,lookupFailurePattern} from '../runtime/learning.mjs';
import {initProject} from '../runtime/store.mjs';
import {createSuite} from './lib/suite.mjs';
import {makeTempDir} from './lib/tempdir.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const {test,assert,finish}=createSuite('agent-sdlc/failure-memory-validation/v1','FAILURE-MEMORY-VALIDATION.json');

function fixture(){
  const d=makeTempDir('agent-sdlc-mem-');
  execFileSync('git',['init','-q'],{cwd:d});
  fs.writeFileSync(path.join(d,'README.md'),'fixture\n');
  execFileSync('git',['add','.'],{cwd:d});
  execFileSync('git',['-c','user.email=test@test.local','-c','user.name=Tester','commit','-qm','init'],{cwd:d});
  initProject(d,{
    schema:'agent-sdlc/project/v1',
    project:'memory-fixture',
    commands:{test_full:['node','-e','process.exit(0)']},
    context:{project_invariants:['do not edit generated files']}
  });
  return d;
}

await test('indexFailurePattern-sanitizes-and-stores',()=>{
  const d=fixture();
  const entry=indexFailurePattern(d,{
    signature:'SyntaxError: Cannot find module "token-store.js"',
    hint:'Make sure to use explicit .mjs or .js extension in import statement',
    resolution:'Changed import from ./token-store to ./token-store.mjs'
  });

  assert(entry.signature.includes('SyntaxError'),'signature should be indexed');
  assert(entry.hint.includes('import statement'),'hint should be indexed');

  const p=path.join(d,'.agent-sdlc','memory','failure-index.json');
  assert(fs.existsSync(p),'failure-index.json should be created');
});

await test('lookupFailurePattern-matches-query',()=>{
  const d=fixture();
  indexFailurePattern(d,{
    signature:'TypeError: Cannot read properties of undefined (reading "diff_hash")',
    hint:'Ensure workspace object is initialized before computing diff',
    resolution:'Added null check on ws before calling workspaceDiff'
  });

  const matches=lookupFailurePattern(d,'diff_hash');
  assert(matches.length===1,'should match 1 pattern');
  assert(matches[0].hint.includes('workspace object is initialized'),'hint content mismatch');
});

await test('lookupFailurePattern-returns-empty-on-miss',()=>{
  const d=fixture();
  const matches=lookupFailurePattern(d,'nonexistent error query');
  assert(Array.isArray(matches)&&matches.length===0,'should return empty array');
});

finish();