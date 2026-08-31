#!/usr/bin/env node
// Test suite for MCP Tool Gateway Bridge.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {handleMcpGatewayRequest,GATEWAY_TOOLS} from '../runtime/mcp-gateway.mjs';
import {initProject} from '../runtime/store.mjs';
import {newRun} from '../runtime/orchestrator.mjs';
import {route} from '../runtime/router.mjs';
import {createSuite} from './lib/suite.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const {test,assert,finish}=createSuite('agent-sdlc/mcp-gateway-validation/v1','MCP-GATEWAY-VALIDATION.json');

function fixture(){
  const d=fs.mkdtempSync(path.join(os.tmpdir(),'agent-sdlc-mcpgw-'));
  execFileSync('git',['init','-q'],{cwd:d});
  fs.writeFileSync(path.join(d,'README.md'),'fixture\n');
  execFileSync('git',['add','.'],{cwd:d});
  execFileSync('git',['-c','user.email=test@test.local','-c','user.name=Tester','commit','-qm','init'],{cwd:d});
  initProject(d,{
    schema:'agent-sdlc/project/v1',
    project:'mcpgw-fixture',
    commands:{test_full:['node','-e','process.exit(0)']},
    context:{project_invariants:['do not edit generated files']}
  });
  return d;
}

await test('mcp-gateway-tools-list-returns-declarations',async ()=>{
  const res=await handleMcpGatewayRequest(ROOT,{
    method:'tools/list',
    params:{},
    id:1
  });
  assert(res.result&&Array.isArray(res.result.tools),'should return tools array');
  assert(res.result.tools.some(t=>t.name==='agent_sdlc_dashboard'),'missing agent_sdlc_dashboard');
  assert(res.result.tools.some(t=>t.name==='agent_sdlc_govern'),'missing agent_sdlc_govern');
  assert(res.result.tools.some(t=>t.name==='agent_sdlc_flaky_detect'),'missing agent_sdlc_flaky_detect');
});

await test('mcp-gateway-calls-dashboard-tool',async ()=>{
  const res=await handleMcpGatewayRequest(ROOT,{
    method:'tools/call',
    params:{name:'agent_sdlc_dashboard',arguments:{format:'tui'}},
    id:2
  });
  assert(res.result&&res.result.content[0].text.includes('Agent SDLC Terminal Dashboard'),'dashboard output missing');
});

await test('mcp-gateway-calls-govern-tool',async ()=>{
  const d=fixture();
  const r=route(ROOT,'MCP Govern Test');
  const run=newRun(ROOT,d,{objective:'MCP Govern Test',route:r});

  const res=await handleMcpGatewayRequest(d,{
    method:'tools/call',
    params:{name:'agent_sdlc_govern',arguments:{run_id:run.run_id,max_cost_usd:10}},
    id:3
  });
  assert(res.result&&res.result.content[0].text.includes('agent-sdlc/budget-circuit-breaker/v1'),'govern output missing');
});

await test('mcp-gateway-calls-flaky-detect-tool',async ()=>{
  const res=await handleMcpGatewayRequest(ROOT,{
    method:'tools/call',
    params:{name:'agent_sdlc_flaky_detect',arguments:{command:['node','-e','process.exit(0)'],iterations:2}},
    id:4
  });
  assert(res.result&&res.result.content[0].text.includes('agent-sdlc/flaky-test-report/v1'),'flaky detect output missing');
});

await test('mcp-gateway-calls-memory-lookup-tool',async ()=>{
  const d=fixture();
  const {indexFailurePattern}=await import('../runtime/learning.mjs');
  indexFailurePattern(d,{signature:'timeout in network call',hint:'increase timeout value'});

  const res=await handleMcpGatewayRequest(d,{
    method:'tools/call',
    params:{name:'agent_sdlc_memory_lookup',arguments:{query:'timeout in network call'}},
    id:5
  });
  assert(res.result&&res.result.content[0].text.includes('increase timeout value'),'memory lookup output missing');
});

await test('mcp-gateway-calls-release-notes-tool',async ()=>{
  const d=fixture();
  const r=route(ROOT,'MCP Release Notes Test');
  const run=newRun(ROOT,d,{objective:'MCP Release Notes Test',route:r});

  const res=await handleMcpGatewayRequest(d,{
    method:'tools/call',
    params:{name:'agent_sdlc_release_notes',arguments:{run_id:run.run_id,version:'3.0.0-rc1',bump_type:'minor'}},
    id:6
  });
  assert(res.result&&res.result.content[0].text.includes('agent-sdlc/semantic-release-notes/v1'),'release notes output missing');
});

await test('mcp-gateway-handles-unknown-tool',async ()=>{
  const res=await handleMcpGatewayRequest(ROOT,{
    method:'tools/call',
    params:{name:'non_existent_tool',arguments:{}},
    id:7
  });
  assert(res.error&&res.error.code===-32601,'unknown tool error missing');
});

await test('mcp-gateway-handles-tool-execution-error',async ()=>{
  const res=await handleMcpGatewayRequest(ROOT,{
    method:'tools/call',
    params:{name:'agent_sdlc_release_notes',arguments:{run_id:'invalid-non-existent-run'}},
    id:8
  });
  assert(res.error&&res.error.code===-32000,'execution error catch block missing');
});

await test('mcp-gateway-handles-unsupported-method',async ()=>{
  const res=await handleMcpGatewayRequest(ROOT,{
    method:'notifications/cancelled',
    params:{},
    id:9
  });
  assert(res.error&&res.error.code===-32600,'unsupported method error missing');
});

finish();