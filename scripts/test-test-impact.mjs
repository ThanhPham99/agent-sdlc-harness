#!/usr/bin/env node
// Test suite for Intelligent Test Impact Analysis (TIA).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {analyzeTestImpact} from '../runtime/test-impact.mjs';
import {createSuite} from './lib/suite.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const {test,assert,finish}=createSuite('agent-sdlc/test-impact-validation/v1','TEST-IMPACT-VALIDATION.json');

function fixture(){
  const d=fs.mkdtempSync(path.join(os.tmpdir(),'agent-sdlc-tia-'));
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

finish();