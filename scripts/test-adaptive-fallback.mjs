#!/usr/bin/env node
// Test suite for Adaptive Multi-Model Dynamic Failover.
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {executeWithAdaptiveFailover,resetProbeCache} from '../runtime/provider.mjs';
import {createSuite} from './lib/suite.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const {test,assert,finish}=createSuite('agent-sdlc/adaptive-fallback-validation/v1','ADAPTIVE-FALLBACK-VALIDATION.json');
const fakeLaunch=argv=>({status:'OK',bin:argv[0],args:argv.slice(1),spawnOptions:{}});

await test('failover-first-candidate-succeeds',()=>{
  resetProbeCache();
  const fakeSpawn=(bin,args)=>{
    if(args.includes('--version'))return {status:0,stdout:'claude 1.0\n',stderr:''};
    if(args.includes('--help'))return {status:0,stdout:'help info\n',stderr:''};
    return {status:0,stdout:'{"ok":true}',stderr:''};
  };

  const res=executeWithAdaptiveFailover('hello',null,{},{
    candidates:['claude','codex'],
    spawn:fakeSpawn,
    launch:fakeLaunch
  });
  assert(res.status==='PASS','expected PASS');
  assert(res.host==='claude','expected claude');
  assert(res.failover_occurred===false,'failover should not occur');
});

await test('failover-switches-to-secondary-on-failure',()=>{
  resetProbeCache();
  const fakeSpawn=(bin,args)=>{
    if(args.includes('--version'))return {status:0,stdout:'host 1.0\n',stderr:''};
    if(args.includes('--help'))return {status:0,stdout:'help info\n',stderr:''};
    // Claude execution fails, codex succeeds
    if(args.includes('-p'))return {status:1,stdout:'',stderr:'Rate limit exceeded'};
    return {status:0,stdout:'{"result":"success"}',stderr:''};
  };

  const res=executeWithAdaptiveFailover('hello',null,{},{
    candidates:['claude','codex'],
    spawn:fakeSpawn,
    launch:fakeLaunch
  });
  assert(res.status==='PASS','expected PASS');
  assert(res.host==='codex','expected codex');
  assert(res.failover_occurred===true,'failover should occur');
  assert(res.attempts.length===2,'expected 2 attempts');
  assert(res.attempts[0].host==='claude'&&res.attempts[0].status==='FAIL','claude should have failed');
});

await test('failover-reports-failure-when-all-fail',()=>{
  resetProbeCache();
  const fakeSpawn=(bin,args)=>{
    if(args.includes('--version'))return {status:0,stdout:'host 1.0\n',stderr:''};
    if(args.includes('--help'))return {status:0,stdout:'help info\n',stderr:''};
    return {status:1,stdout:'',stderr:'Fatal error'};
  };

  const res=executeWithAdaptiveFailover('hello',null,{},{
    candidates:['claude','codex'],
    spawn:fakeSpawn,
    launch:fakeLaunch
  });
  assert(res.status==='FAIL','expected FAIL');
  assert(res.reason==='ALL_CANDIDATES_FAILED','expected ALL_CANDIDATES_FAILED');
  assert(res.attempts.length===2,'expected 2 attempts');
});

finish();