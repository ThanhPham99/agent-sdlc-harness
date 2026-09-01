#!/usr/bin/env node
// Test suite for Live Dashboard Server, SSE streaming, and API endpoints.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {startServer,broadcastSseEvent} from '../runtime/server.mjs';
import {commands} from '../runtime/commands/dashboard.mjs';
import {initProject} from '../runtime/store.mjs';
import {newRun} from '../runtime/orchestrator.mjs';
import {route} from '../runtime/router.mjs';
import {createSuite} from './lib/suite.mjs';
import {makeTempDir} from './lib/tempdir.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const {test,assert,finish}=createSuite('agent-sdlc/live-dashboard-validation/v1','LIVE-DASHBOARD-VALIDATION.json');

function fixture(){
  const d=makeTempDir('agent-sdlc-dash-');
  execFileSync('git',['init','-q'],{cwd:d});
  fs.writeFileSync(path.join(d,'README.md'),'fixture\n');
  execFileSync('git',['add','.'],{cwd:d});
  execFileSync('git',['-c','user.email=test@test.local','-c','user.name=Tester','commit','-qm','init'],{cwd:d});
  initProject(d,{
    schema:'agent-sdlc/project/v1',
    project:'dashboard-fixture',
    commands:{test_full:['node','-e','process.exit(0)']},
    context:{project_invariants:['do not edit generated files']}
  });
  return d;
}

function fetch(url,options={}){
  return new Promise((resolve,reject)=>{
    const req=http.request(url,options,res=>{
      let body='';
      res.on('data',chunk=>body+=chunk);
      res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body}));
    });
    req.on('error',reject);
    if(options.body)req.write(options.body);
    req.end();
  });
}

await test('server-start-and-health',async ()=>{
  const d=fixture();
  const srv=await startServer(d,{port:0,host:'127.0.0.1'});
  try{
    const res=await fetch(`${srv.url}/api/health`);
    assert(res.status===200,`expected status 200, got ${res.status}`);
    const json=JSON.parse(res.body);
    assert(json.status==='HEALTHY','expected status HEALTHY');
  }finally{
    await srv.close();
  }
});

await test('server-dashboard-html-with-sse',async ()=>{
  const d=fixture();
  const r=route(ROOT,'Implement dashboard live');
  const run=newRun(ROOT,d,{objective:'Implement dashboard live',route:r});
  run.state='IMPLEMENT';
  
  const srv=await startServer(d,{port:0,host:'127.0.0.1'});
  try{
    const res=await fetch(`${srv.url}/`);
    assert(res.status===200,`expected status 200, got ${res.status}`);
    assert(res.body.includes('Agent SDLC Dashboard'),'HTML missing title');
    assert(res.body.includes('SDLC Stage Pipeline'),'HTML missing pipeline');
    assert(res.body.includes('EventSource'),'HTML missing SSE script');
    assert(res.body.includes(run.run_id),'HTML missing active run_id');
  }finally{
    await srv.close();
  }
});

await test('server-status-api',async ()=>{
  const d=fixture();
  const srv=await startServer(d,{port:0,host:'127.0.0.1'});
  try{
    const res=await fetch(`${srv.url}/api/status`);
    assert(res.status===200,`expected status 200, got ${res.status}`);
    const json=JSON.parse(res.body);
    assert(json.schema==='agent-sdlc/server-status/v1','schema mismatch');
    assert(typeof json.runs_count==='number','runs_count must be number');
  }finally{
    await srv.close();
  }
});

await test('server-run-api',async ()=>{
  const d=fixture();
  const r=route(ROOT,'Run API test');
  const run=newRun(ROOT,d,{objective:'Run API test',route:r});

  const srv=await startServer(d,{port:0,host:'127.0.0.1'});
  try{
    const res=await fetch(`${srv.url}/api/run?run_id=${run.run_id}`);
    assert(res.status===200,`expected status 200, got ${res.status}`);
    const json=JSON.parse(res.body);
    assert(json.run&&json.run.run_id===run.run_id,'run object mismatch');
    assert(Array.isArray(json.tasks),'tasks must be array');
  }finally{
    await srv.close();
  }
});

await test('dashboard-command-serve-flag',async ()=>{
  const d=fixture();
  let printed=null;
  const ctx={
    ROOT,
    projectRoot:d,
    args:{serve:true,port:0,'close-after-init':true},
    print:msg=>{printed=msg;}
  };
  await commands.dashboard(ctx);
  assert(printed&&printed.status==='DASHBOARD_SERVER_STARTED','command serve flag failed');
  assert(typeof printed.port==='number'&&printed.port>0,'missing valid port');
});

finish();