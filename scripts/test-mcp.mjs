#!/usr/bin/env node
// MCP server suite.
//
// runtime/mcp-server.mjs is the harness's contract with a host: 16 tools reached
// over newline-delimited JSON-RPC on stdio. It sat at 65% coverage with nothing
// exercising the transport at all -- the tool table was asserted from the module,
// never from a running server -- so the boundary itself was untested. The
// boundary is where a host's loose types arrive.
//
// Every check here speaks to a spawned server the way a host does.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync,spawn} from 'node:child_process';
import {createSuite} from './lib/suite.mjs';
import {makeTempDir} from './lib/tempdir.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const SERVER=path.join(ROOT,'runtime','mcp-server.mjs');
const VERSION=JSON.parse(fs.readFileSync(path.join(ROOT,'agent-sdlc.manifest.json'),'utf8')).version;
const {test,assert,finish}=createSuite('agent-sdlc/mcp-validation/v1','MCP-VALIDATION.json');

function project(){
  const d=makeTempDir('agent-sdlc-mcp-');
  execFileSync('git',['init','-q'],{cwd:d});
  fs.writeFileSync(path.join(d,'README.md'),'fixture\n');
  execFileSync('git',['add','.'],{cwd:d});
  execFileSync('git',['-c','user.email=a@b.c','-c','user.name=t','commit','-qm','init'],{cwd:d});
  return d;
}
const PROJECT=project();

/** A JSON-RPC client over the server's stdio, exactly as a host speaks to it. */
function connect({env={}}={}){
  const proc=spawn(process.execPath,[SERVER],{cwd:PROJECT,stdio:['pipe','pipe','pipe'],env:{...process.env,...env}});
  const pending=new Map();
  const stderr=[];
  let buf='',nextId=0,parseError=null;
  proc.stdout.setEncoding('utf8');
  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data',c=>stderr.push(c));
  proc.stdout.on('data',chunk=>{
    buf+=chunk;
    let i;
    while((i=buf.indexOf('\n'))>=0){
      const line=buf.slice(0,i).trim();buf=buf.slice(i+1);
      if(!line)continue;
      let msg;
      try{msg=JSON.parse(line);}catch(e){parseError=`server wrote a non-JSON line: ${line.slice(0,120)}`;continue;}
      const resolve=pending.get(msg.id);
      if(resolve){pending.delete(msg.id);resolve(msg);}
    }
  });
  const send=(obj)=>proc.stdin.write(JSON.stringify(obj)+'\n');
  const call=(method,params)=>new Promise((res,rej)=>{
    const id=++nextId;
    const timer=setTimeout(()=>rej(new Error(`${method} did not answer within 30s`)),30000);
    pending.set(id,m=>{clearTimeout(timer);res(m);});
    send({jsonrpc:'2.0',id,method,params});
  });
  return {
    call,send,
    notify:(method,params)=>send({jsonrpc:'2.0',method,params}),
    raw:(line)=>proc.stdin.write(line),
    tool:(name,args={})=>call('tools/call',{name,arguments:{project_root:PROJECT,...args}}),
    stderr:()=>stderr.join(''),
    parseError:()=>parseError,
    /**
     * Shut down the way a host does: close stdin and let the server exit. A kill
     * would also lose the child's coverage output, and whether the server exits
     * on EOF at all is worth knowing -- a server that lingers leaks a process
     * per host session.
     */
    close:()=>new Promise((res)=>{
      const timer=setTimeout(()=>{proc.kill();res({clean:false,code:null});},5000);
      proc.on('exit',(code)=>{clearTimeout(timer);res({clean:true,code});});
      proc.stdin.end();
    })
  };
}
const payload=(r)=>r.result?.structuredContent??JSON.parse(r.result?.content?.[0]?.text||'null');
const errorText=(r)=>r.result?.content?.[0]?.text||'';


const c=connect();

// --- protocol --------------------------------------------------------------
await test('initialize-answers-with-server-identity',async()=>{
  const r=await c.call('initialize',{protocolVersion:'2025-06-18'});
  assert(r.result.serverInfo.name==='agent-sdlc-harness',JSON.stringify(r.result.serverInfo));
  assert(r.result.serverInfo.version===VERSION,r.result.serverInfo.version);
  assert(r.result.capabilities?.tools,'tools capability not declared');
});
await test('ping-and-the-initialized-notification-are-handled',async()=>{
  c.notify('notifications/initialized');
  const r=await c.call('ping',{});
  assert(JSON.stringify(r.result)==='{}',JSON.stringify(r.result));
});
await test('an-unknown-method-is-a-protocol-error',async()=>{
  const r=await c.call('custom/unknown_method',{});
  assert(r.error?.code===-32601,JSON.stringify(r));
  assert(/Method not found/.test(r.error.message),r.error.message);
});
await test('resources-and-prompts-are-advertised-and-readable',async()=>{
  const resList=await c.call('resources/list',{});
  assert(Array.isArray(resList.result?.resources)&&resList.result.resources.length>=2,JSON.stringify(resList));
  const resRead=await c.call('resources/read',{uri:'sdlc://project/status'});
  assert(resRead.result?.contents?.[0]?.text,JSON.stringify(resRead));

  const promptList=await c.call('prompts/list',{});
  assert(Array.isArray(promptList.result?.prompts)&&promptList.result.prompts.length>=3,JSON.stringify(promptList));
  const promptGet=await c.call('prompts/get',{name:'sdlc_feature_kickoff',arguments:{objective:'Add refund processing'}});
  assert(promptGet.result?.messages?.[0]?.content?.text?.includes('Add refund processing'),JSON.stringify(promptGet));
});
await test('garbage-input-does-not-kill-the-server',async()=>{
  c.raw('this is not json\n');
  c.raw('\n');
  c.raw('{"jsonrpc":"2.0"');           // a split frame
  c.raw(',"id":9999,"method":"ping"}\n');
  const r=await c.call('ping',{});
  assert(JSON.stringify(r.result)==='{}','server stopped answering after malformed input');
});
await test('every-advertised-tool-declares-a-schema',async()=>{
  const tools=(await c.call('tools/list')).result.tools;
  assert(tools.length===18,`expected 18 tools, got ${tools.length}`);
  for(const t of tools){
    assert(t.name.startsWith('agent_sdlc_'),t.name);
    assert(t.description&&t.description.length>20,`${t.name} has no usable description`);
    assert(t.inputSchema?.type==='object',`${t.name} has no object input schema`);
    assert(Array.isArray(t.inputSchema.required),`${t.name} declares no required fields`);
    for(const req of t.inputSchema.required)assert(t.inputSchema.properties?.[req],`${t.name} requires ${req} but does not declare it`);
  }
});

// --- the run loop over the transport ---------------------------------------
let runId=null;
await test('route-then-start-produces-a-run',async()=>{
  const routed=payload(await c.tool('agent_sdlc_route',{objective:'database schema migration with backfill'}));
  assert(routed.workflow==='database-migration'&&routed.profile==='STRICT',JSON.stringify(routed));
  const run=payload(await c.tool('agent_sdlc_start',{objective:'Fix incorrect refund rounding',workflow:'bug-fix'}));
  assert(run.run_id&&run.state==='INTAKE',JSON.stringify(run));
  runId=run.run_id;
});
await test('status-carries-the-next-stage',async()=>{
  const s=payload(await c.tool('agent_sdlc_status',{run_id:runId}));
  assert(s.state==='INTAKE'&&s.next==='REQUIREMENTS',JSON.stringify({state:s.state,next:s.next}));
});
await test('context-is-bounded-and-hashed',async()=>{
  const m=payload(await c.tool('agent_sdlc_context',{run_id:runId}));
  assert(m.context_budget_status==='WITHIN_BUDGET',m.context_budget_status);
  assert(m.context_hash?.length===64,'no context hash');
  assert(m.allowed_tools?.length,'no stage tool policy');
});
await test('artifact_put-attaches-the-artifact-to-the-run',async()=>{
  const art=payload(await c.tool('agent_sdlc_artifact_put',{run_id:runId,kind:'requirement',content:'round half to even'}));
  assert(art.artifact_id?.startsWith('artifact://sha256/'),JSON.stringify(art));
  const s=payload(await c.tool('agent_sdlc_status',{run_id:runId}));
  assert(s.artifacts.includes(art.artifact_id),'artifact not attached');
});
await test('tool_check-enforces-the-stage-policy',async()=>{
  const d=payload(await c.tool('agent_sdlc_tool_check',{run_id:runId,tool:'deploy.production'}));
  assert(d.decision==='DENY',JSON.stringify(d));
});
await test('a-gate-without-evidence-is-refused-over-the-transport',async()=>{
  await c.tool('agent_sdlc_transition',{run_id:runId,to:'REQUIREMENTS'});
  const blocked=await c.tool('agent_sdlc_transition',{run_id:runId,to:'PLAN'});
  assert(blocked.result.isError===true,'a gate was crossed without evidence');
  assert(/gate blocked|missing evidence/.test(errorText(blocked)),errorText(blocked));
  const s=payload(await c.tool('agent_sdlc_status',{run_id:runId}));
  assert(s.state==='REQUIREMENTS','the run moved on a refused transition');
});
await test('a-gate-with-evidence-advances',async()=>{
  const out=payload(await c.tool('agent_sdlc_transition',{run_id:runId,to:'PLAN',evidence:['requirements_confirmed']}));
  assert(out.state==='PLAN',JSON.stringify(out.state));
});
await test('task-tools-answer-before-a-graph-exists',async()=>{
  const list=payload(await c.tool('agent_sdlc_task_list',{run_id:runId}));
  assert(Array.isArray(list)&&list.length===0,JSON.stringify(list));
  const progress=payload(await c.tool('agent_sdlc_task',{run_id:runId,op:'status'}));
  assert(progress.graph_present===false,JSON.stringify(progress));
});
await test('the-unified-task-tool-matches-its-granular-twin',async()=>{
  const viaOp=payload(await c.tool('agent_sdlc_task',{run_id:runId,op:'list'}));
  const direct=payload(await c.tool('agent_sdlc_task_list',{run_id:runId}));
  assert(JSON.stringify(viaOp)===JSON.stringify(direct),'op:list and task_list disagree');
});
await test('model-route-and-tool-run-over-transport',async()=>{
  const routed=payload(await c.tool('agent_sdlc_model_route',{run_id:runId,task:'code',provider:'auto'}));
  assert(routed.mode,JSON.stringify(routed));
  const toolRes=payload(await c.tool('agent_sdlc_tool_run',{run_id:runId,tool:'git.status'}));
  assert(toolRes,JSON.stringify(toolRes));
});

await test('task-granular-tools-sweep',async()=>{
  const ready=payload(await c.tool('agent_sdlc_task_ready',{run_id:runId}));
  assert(ready!==undefined,JSON.stringify(ready));
  const schedule=payload(await c.tool('agent_sdlc_task_schedule',{run_id:runId}));
  assert(schedule!==undefined,JSON.stringify(schedule));
  const status=payload(await c.tool('agent_sdlc_task_status',{run_id:runId}));
  assert(status!==undefined,JSON.stringify(status));
  const rReady=payload(await c.tool('agent_sdlc_task',{run_id:runId,op:'ready'}));
  assert(rReady!==undefined,JSON.stringify(rReady));
  const rSched=payload(await c.tool('agent_sdlc_task',{run_id:runId,op:'schedule'}));
  assert(rSched!==undefined,JSON.stringify(rSched));
});

await test('an-unknown-task-op-is-named-in-the-error',async()=>{
  const r=await c.tool('agent_sdlc_task',{run_id:runId,op:'nonsense'});
  assert(r.result.isError===true,'an unknown op succeeded');
  // errorText is a JSON string, so the quoting around the op is escaped in it.
  assert(/unknown op/.test(errorText(r))&&errorText(r).includes('nonsense'),errorText(r));
});

// --- untrusted argument types ---------------------------------------------
await test('force-and-approval-are-rejected-outright',async()=>{
  // force/approval used to bypass the gate machinery entirely; a single call
  // could jump straight to DEPLOY and self-grant a wildcard approval. Neither
  // parameter exists in the tool's contract any more -- any value, including a
  // real force:true, is a named error, not a silently-ignored field.
  const run=payload(await c.tool('agent_sdlc_start',{objective:'Add refund capability'}));
  for(const force of ['false','0','no','',true]){
    const r=await c.tool('agent_sdlc_transition',{run_id:run.run_id,to:'DESIGN',force});
    assert(r.result.isError===true,`force:${JSON.stringify(force)} crossed the gate`);
    assert(/FORCE_DISABLED/.test(errorText(r)),errorText(r));
    const s=payload(await c.tool('agent_sdlc_status',{run_id:run.run_id}));
    assert(s.state==='INTAKE',`force:${JSON.stringify(force)} moved the run to ${s.state}`);
  }
  const withApproval=await c.tool('agent_sdlc_transition',{run_id:run.run_id,to:'DEPLOY',approval:'*'});
  assert(withApproval.result.isError===true,'a wildcard approval crossed the gate');
  assert(/FORCE_DISABLED/.test(errorText(withApproval)),errorText(withApproval));
  const s=payload(await c.tool('agent_sdlc_status',{run_id:run.run_id}));
  assert(s.state==='INTAKE',`approval:'*' moved the run to ${s.state}`);
});
await test('approval-status-is-read-only-and-starts-empty',async()=>{
  const run=payload(await c.tool('agent_sdlc_start',{objective:'Add wishlist capability'}));
  const status=payload(await c.tool('agent_sdlc_approval_status',{run_id:run.run_id}));
  assert(Array.isArray(status)&&status.length===0,JSON.stringify(status));
});
await test('gate-status-reports-the-current-stage-gate',async()=>{
  const run=payload(await c.tool('agent_sdlc_start',{objective:'Add gate-status capability'}));
  const g0=payload(await c.tool('agent_sdlc_gate_status',{run_id:run.run_id}));
  assert(g0.decision==='PASS',JSON.stringify(g0)); // INTAKE has no requirements
  await c.tool('agent_sdlc_transition',{run_id:run.run_id,to:'REQUIREMENTS'});
  const g1=payload(await c.tool('agent_sdlc_gate_status',{run_id:run.run_id}));
  assert(g1.decision==='BLOCKED'&&g1.missing.includes('requirements_confirmed'),JSON.stringify(g1));
});
await test('a-string-where-an-array-is-declared-is-reported',async()=>{
  const run=payload(await c.tool('agent_sdlc_start',{objective:'Add wishlist capability'}));
  await c.tool('agent_sdlc_transition',{run_id:run.run_id,to:'REQUIREMENTS'});
  const r=await c.tool('agent_sdlc_transition',{run_id:run.run_id,to:'DESIGN',evidence:'requirements_confirmed'});
  assert(r.result.isError===true,'a string evidence value was accepted');
  assert(/evidence must be an array/.test(errorText(r)),errorText(r));
  // The run must not carry character-by-character evidence.
  const s=payload(await c.tool('agent_sdlc_status',{run_id:run.run_id}));
  const recorded=Object.values(s.evidence||{}).flat();
  assert(!recorded.some(t=>t.length===1),`single-character evidence recorded: ${JSON.stringify(recorded)}`);
});
await test('a-missing-run-is-an-error-result-not-a-crash',async()=>{
  const r=await c.tool('agent_sdlc_status',{run_id:'run_does-not-exist'});
  assert(r.result.isError===true,'a missing run reported success');
  assert(!/ {4}at /.test(errorText(r)),`stack trace leaked: ${errorText(r).slice(0,120)}`);
  const ping=await c.call('ping',{});
  assert(JSON.stringify(ping.result)==='{}','server died on a missing run');
});
await test('an-unknown-tool-is-an-error-result',async()=>{
  const r=await c.tool('agent_sdlc_not_a_tool',{});
  assert(r.result.isError===true,'an unknown tool succeeded');
});
await test('the-server-never-writes-non-json-to-stdout',async()=>{
  assert(c.parseError()===null,c.parseError()||'');
  // stdio transport: diagnostics belong on stderr, never in the frame stream.
  assert(!/\{"jsonrpc"/.test(c.stderr()),'protocol frames were written to stderr');
});
await test('the-server-exits-when-the-host-closes-stdin',async()=>{
  const shutdown=await c.close();
  assert(shutdown.clean===true,'the server had to be killed; it does not exit on stdin EOF');
  assert(shutdown.code===0,`the server exited with code ${shutdown.code}`);
});

// --- profile enforcement ---------------------------------------------------
const core=connect({env:{AGENT_SDLC_MCP_PROFILE:'core'}});
await test('the-core-profile-advertises-a-narrower-surface',async()=>{
  const tools=(await core.call('tools/list')).result.tools.map(t=>t.name);
  assert(tools.length===12,`core advertised ${tools.length} tools`);
  assert(tools.includes('agent_sdlc_approval_status'),'approval status is missing from core');
  assert(tools.includes('agent_sdlc_gate_status'),'gate status is missing from core');
  assert(tools.includes('agent_sdlc_task'),'the unified task tool is missing from core');
  assert(!tools.includes('agent_sdlc_task_list'),'core still advertises the granular task tools');
});
await test('a-tool-hidden-by-the-profile-cannot-be-called',async()=>{
  // Regression: the profile shrank the advertised surface but not the reachable
  // one, so a narrowed surface was advisory only.
  const r=await core.tool('agent_sdlc_task_list',{run_id:runId});
  assert(r.result.isError===true,'an unadvertised tool answered normally');
  assert(/not available in the core MCP profile/.test(errorText(r)),errorText(r));
});
await test('the-unified-task-tool-still-reaches-the-hidden-work',async()=>{
  const list=payload(await core.tool('agent_sdlc_task',{run_id:runId,op:'list'}));
  assert(Array.isArray(list),'op:list is unusable in the core profile');
});
await core.close();

finish({harness_version:VERSION});
