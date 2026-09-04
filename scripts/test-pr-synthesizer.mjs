#!/usr/bin/env node
// Test suite for Automated Semantic Release & PR Synthesizer.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {generateSemanticReleaseNotes,generatePrBody} from '../runtime/pr-generator.mjs';
import {initProject} from '../runtime/store.mjs';
import {newRun} from '../runtime/orchestrator.mjs';
import {route} from '../runtime/router.mjs';
import {createSuite} from './lib/suite.mjs';
import {makeTempDir} from './lib/tempdir.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const {test,assert,finish}=createSuite('agent-sdlc/pr-synthesizer-validation/v1','PR-SYNTHESIZER-VALIDATION.json');

function fixture(){
  const d=makeTempDir('agent-sdlc-pr-');
  execFileSync('git',['init','-q'],{cwd:d});
  fs.writeFileSync(path.join(d,'README.md'),'fixture\n');
  execFileSync('git',['add','.'],{cwd:d});
  execFileSync('git',['-c','user.email=test@test.local','-c','user.name=Tester','commit','-qm','init'],{cwd:d});
  initProject(d,{
    schema:'agent-sdlc/project/v1',
    project:'pr-fixture',
    commands:{test_full:['node','-e','process.exit(0)']},
    context:{project_invariants:['do not edit generated files']}
  });
  return d;
}

await test('generatePrBody-produces-markdown-summary',()=>{
  const d=fixture();
  const r=route(ROOT,'Add Authentication Feature');
  const run=newRun(ROOT,d,{objective:'Add Authentication Feature',route:r});

  const md=generatePrBody(d,run);
  assert(md.includes('## 🎯 Objective'),'missing objective in PR body');
  assert(md.includes('Add Authentication Feature'),'missing run objective');
  assert(md.includes('## 🧪 Verification & Evidence'),'missing verification section');
});

await test('generateSemanticReleaseNotes-produces-release-package',()=>{
  const d=fixture();
  const r=route(ROOT,'Release Sprint 1');
  const run=newRun(ROOT,d,{objective:'Release Sprint 1',route:r});

  const rel=generateSemanticReleaseNotes(d,run,{
    version:'3.1.0',
    bumpType:'minor'
  });

  assert(rel.schema==='agent-sdlc/semantic-release-notes/v1','schema mismatch');
  assert(rel.version==='3.1.0','version mismatch');
  assert(rel.markdown.includes('# Release v3.1.0 (MINOR)'),'missing release header');
  assert(rel.markdown.includes('Verification & Traceability Matrix'),'missing matrix');
});

finish();