#!/usr/bin/env node
// Test suite for Intelligent Test Impact Analysis (TIA).
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {initProject} from '../runtime/store.mjs';
import {buildIndex} from '../runtime/repo-index.mjs';
import {analyzeTestImpact} from '../runtime/test-impact.mjs';
import {openIntelligence,calculateGraphCentrality,getBlastRadiusAnalysis} from '../runtime/repo-intelligence.mjs';
import {git} from '../runtime/util.mjs';
import {createSuite} from './lib/suite.mjs';
import {makeTempDir} from './lib/tempdir.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const {test,assert,finish}=createSuite('agent-sdlc/test-impact-validation/v1','TEST-IMPACT-VALIDATION.json');

function fixture(){
  const d=makeTempDir('agent-sdlc-tia-');
  git(['init'], d);
  git(['config', 'user.name', 'test'], d);
  git(['config', 'user.email', 'test@example.com'], d);
  initProject(d,{schema:'agent-sdlc/project/v1',project:'tia-fixture',commands:{test_full:['npm','test']}});
  const srcDir=path.join(d,'src');
  const testDir=path.join(d,'tests');
  fs.mkdirSync(srcDir,{recursive:true});
  fs.mkdirSync(testDir,{recursive:true});

  fs.writeFileSync(path.join(srcDir,'auth.js'),'export function login() {}\n');
  fs.writeFileSync(path.join(srcDir,'user.js'),'export function getUser() {}\n');
  fs.writeFileSync(path.join(srcDir,'payment.js'),'export function pay() {}\n');

  fs.writeFileSync(path.join(testDir,'auth.test.js'),'import {login} from "../src/auth.js";\n');
  fs.writeFileSync(path.join(testDir,'user.test.js'),'import {getUser} from "../src/user.js";\n');
  fs.writeFileSync(path.join(testDir,'payment.test.js'),'import {pay} from "../src/payment.js";\n');

  git(['add', '.'], d);
  git(['commit', '-m', 'initial commit'], d);
  buildIndex(d,{force:true});
  return d;
}

await test('analyzeTestImpact-detects-single-modified-file',()=>{
  const d=fixture();
  const res=analyzeTestImpact(d,{
    modifiedFiles:['src/auth.js']
  });

  assert(res.impacted_test_count===1,'should match exactly 1 test file');
  assert(res.impacted_tests.some(t=>t.includes('auth.test.js')),'should include auth.test.js');
  assert(res.coverage_savings_ratio>0.5,'should calculate positive savings ratio');
});

await test('analyzeTestImpact-detects-multiple-modified-files',()=>{
  const d=fixture();
  const res=analyzeTestImpact(d,{
    modifiedFiles:['src/auth.js','src/payment.js']
  });

  assert(res.impacted_test_count===2,'should match 2 test files');
  assert(res.impacted_tests.some(t=>t.includes('auth.test.js')),'should include auth.test.js');
  assert(res.impacted_tests.some(t=>t.includes('payment.test.js')),'should include payment.test.js');
});

await test('analyzeTestImpact-returns-empty-when-no-tests-impacted',()=>{
  const d=fixture();
  const res=analyzeTestImpact(d,{
    modifiedFiles:['docs/architecture.md']
  });

  assert(res.impacted_test_count===0,'should match 0 test files');
});

await test('calculateGraphCentrality-computes-pagerank-and-core-files',()=>{
  const d=fixture();
  const intel=openIntelligence(d,{refresh:true});
  const centrality=calculateGraphCentrality(intel);

  assert(centrality.total_files>0,'should index project files');
  assert(Array.isArray(centrality.centrality_ranking)&&centrality.centrality_ranking.length>0,'missing centrality ranking');
  assert(typeof centrality.centrality_ranking[0].pagerank_score==='number','missing pagerank score');
  assert(typeof centrality.critical_core_count==='number','missing critical core count');
});

await test('getBlastRadiusAnalysis-evaluates-risk-levels',()=>{
  const d=fixture();
  const intel=openIntelligence(d,{refresh:true});
  const blast=getBlastRadiusAnalysis(intel,{paths:['src/auth.js']});

  assert(Array.isArray(blast.seeds)&&blast.seeds.includes('src/auth.js'),'missing seed file in blast radius');
  assert(['LOW','MEDIUM','HIGH','CRITICAL'].includes(blast.risk_level),'invalid risk_level');
  assert(typeof blast.total_affected_count==='number','missing total_affected_count');
});

finish();