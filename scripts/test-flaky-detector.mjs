#!/usr/bin/env node
// Test suite for Flaky Test Detector and Diagnostics.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {detectFlakyTests} from '../runtime/flaky-detector.mjs';
import {createSuite} from './lib/suite.mjs';
import {makeTempDir} from './lib/tempdir.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const {test,assert,finish}=createSuite('agent-sdlc/flaky-detector-validation/v1','FLAKY-DETECTOR-VALIDATION.json');

await test('detectFlakyTests-deterministic-pass',async ()=>{
  const res=await detectFlakyTests(ROOT,{
    command:[process.execPath,'-e','process.exit(0)'],
    iterations:3,
    jitterMs:5
  });
  assert(res.status==='DETERMINISTIC_PASS','expected DETERMINISTIC_PASS');
  assert(res.is_flaky===false,'should not be flaky');
  assert(res.pass_rate===1.0,'expected 100% pass rate');
});

await test('detectFlakyTests-deterministic-fail',async ()=>{
  const res=await detectFlakyTests(ROOT,{
    command:[process.execPath,'-e','process.exit(1)'],
    iterations:3,
    jitterMs:5
  });
  assert(res.status==='DETERMINISTIC_FAIL','expected DETERMINISTIC_FAIL');
  assert(res.is_flaky===false,'should not be flaky');
  assert(res.pass_rate===0,'expected 0% pass rate');
});

await test('detectFlakyTests-detects-flaky-command',async ()=>{
  const d=makeTempDir('agent-sdlc-flaky-');
  const counterFile=path.join(d,'counter.txt');
  fs.writeFileSync(counterFile,'0\n','utf8');

  // Script that fails on run 1, passes on run 2, fails on run 3
  const scriptContent=`
const fs = require('fs');
const p = ${JSON.stringify(counterFile)};
const c = parseInt(fs.readFileSync(p, 'utf8') || '0', 10);
fs.writeFileSync(p, String(c + 1), 'utf8');
if (c % 2 === 0) process.exit(1);
process.exit(0);
`;
  const scriptFile=path.join(d,'flaky.js');
  fs.writeFileSync(scriptFile,scriptContent,'utf8');

  const res=await detectFlakyTests(d,{
    command:[process.execPath,scriptFile],
    iterations:3,
    jitterMs:5
  });

  assert(res.is_flaky===true,'should detect flaky test');
  assert(res.status==='FLAKY','expected status FLAKY');
  assert(res.passed_count>0&&res.failed_count>0,'should have both pass and fail runs');
});

finish();