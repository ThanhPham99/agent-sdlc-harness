#!/usr/bin/env node
// Test suite for Deterministic Static Security Linter.
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {lintSecurityRisks} from '../runtime/security-linter.mjs';
import {createSuite} from './lib/suite.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const {test,assert,finish}=createSuite('agent-sdlc/security-linter-validation/v1','SECURITY-LINTER-VALIDATION.json');

await test('security-linter-detects-eval',()=>{
  const code='function run(code) { return eval(code); }';
  const res=lintSecurityRisks(code,{filename:'exec.js'});
  assert(res.clean===false,'should detect eval');
  assert(res.risk_level==='HIGH','should be HIGH risk');
  assert(res.findings.some(f=>f.rule_id==='EVAL_EXECUTION'),'missing EVAL_EXECUTION');
});

await test('security-linter-detects-inner-html-xss',()=>{
  const code='element.innerHTML = "<div>" + userContent + "</div>";';
  const res=lintSecurityRisks(code,{filename:'render.js'});
  assert(res.clean===false,'should detect innerHTML');
  assert(res.findings.some(f=>f.rule_id==='UNSAFE_HTML_INJECTION'),'missing UNSAFE_HTML_INJECTION');
});

await test('security-linter-detects-command-injection',()=>{
  const code='child_process.exec("rm -rf " + targetPath);';
  const res=lintSecurityRisks(code,{filename:'cleanup.js'});
  assert(res.clean===false,'should detect command injection');
  assert(res.findings.some(f=>f.rule_id==='COMMAND_INJECTION_RISK'),'missing COMMAND_INJECTION_RISK');
});

await test('security-linter-detects-prototype-pollution',()=>{
  const code='obj["__proto__"]["admin"] = true;';
  const res=lintSecurityRisks(code,{filename:'merge.js'});
  assert(res.clean===false,'should detect prototype pollution');
  assert(res.findings.some(f=>f.rule_id==='PROTOTYPE_POLLUTION'),'missing PROTOTYPE_POLLUTION');
});

await test('security-linter-passes-clean-code',()=>{
  const code='export function add(a, b) { return Number(a) + Number(b); }';
  const res=lintSecurityRisks(code,{filename:'math.js'});
  assert(res.clean===true,'should be clean');
  assert(res.risk_level==='LOW','should be LOW risk');
  assert(res.findings_count===0,'should have 0 findings');
});

finish();