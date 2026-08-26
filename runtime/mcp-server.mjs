#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {rootFrom} from './util.mjs';
import {detectProject} from './init.mjs';
import {initProject,loadRun,putArtifact,saveRun,emit,listTasks,listTaskEvents} from './store.mjs';
import {requireTask,taskProgress} from './task-engine.mjs';
import {readySet,scheduleTasks} from './task-scheduler.mjs';
import {buildTaskContext,renderTaskPrompt} from './task-context.mjs';
import {route} from './router.mjs';
import {newRun,transition,nextState} from './orchestrator.mjs';
import {buildContext} from './context.mjs';
import {checkTool} from './policy.mjs';
import {invokeTool} from './tools.mjs';
import {routeModel} from './model-router.mjs';
import {listApprovals} from './approvals.mjs';

const ROOT=rootFrom(import.meta.url);
const MANIFEST_VERSION=JSON.parse(fs.readFileSync(path.join(ROOT,'agent-sdlc.manifest.json'),'utf8')).version;
const CORE_TOOL_NAMES=new Set([
  'agent_sdlc_route',
  'agent_sdlc_start',
  'agent_sdlc_status',
  'agent_sdlc_context',
  'agent_sdlc_transition',
  'agent_sdlc_approval_status',
  'agent_sdlc_tool_check',
  'agent_sdlc_tool_run',
  'agent_sdlc_artifact_put',
  'agent_sdlc_model_route',
  'agent_sdlc_task'
]);

const toolDefs=[
  {name:'agent_sdlc_route',description:'Route a software task into the canonical SDLC workflow without model inference.',annotations:{readOnlyHint:true},inputSchema:{type:'object',required:['objective'],properties:{objective:{type:'string'},workflow:{type:'string'},profile:{type:'string'}}}},
  {name:'agent_sdlc_start',description:'Initialize project state if needed and start an evidence-driven SDLC run.',inputSchema:{type:'object',required:['objective'],properties:{project_root:{type:'string'},objective:{type:'string'},workflow:{type:'string'},profile:{type:'string'}}}},
  {name:'agent_sdlc_status',description:'Read current run state.',annotations:{readOnlyHint:true},inputSchema:{type:'object',required:['run_id'],properties:{project_root:{type:'string'},run_id:{type:'string'}}}},
  {name:'agent_sdlc_context',description:'Compile bounded stage context with on-demand internal skill instructions and evidence requirements.',annotations:{readOnlyHint:true},inputSchema:{type:'object',required:['run_id'],properties:{project_root:{type:'string'},run_id:{type:'string'},artifact_refs:{type:'array',items:{type:'string'}},symbols:{type:'array',items:{type:'string'}}}}},
  {name:'agent_sdlc_transition',description:'Transition a run only when gate evidence is satisfied. There is no force/bypass parameter and none is honoured; a privileged capability is authorized only through a trusted approval recorded outside this tool (see agent_sdlc_approval_status, and `agent-sdlc approval grant` run interactively by a human).',inputSchema:{type:'object',required:['run_id','to'],properties:{project_root:{type:'string'},run_id:{type:'string'},to:{type:'string'},evidence:{type:'array',items:{type:'string'}}}}},
  {name:'agent_sdlc_approval_status',description:'Read the approval records on a run: capability, authority, and whether each is ACTIVE, EXPIRED or REVOKED. Read-only; approvals can only be granted through the interactive, TTY-gated `agent-sdlc approval grant` CLI command, never over MCP.',annotations:{readOnlyHint:true},inputSchema:{type:'object',required:['run_id'],properties:{project_root:{type:'string'},run_id:{type:'string'}}}},
  {name:'agent_sdlc_tool_check',description:'Check canonical stage/tool policy before execution.',annotations:{readOnlyHint:true},inputSchema:{type:'object',required:['run_id','tool'],properties:{project_root:{type:'string'},run_id:{type:'string'},tool:{type:'string'}}}},
  {name:'agent_sdlc_tool_run',description:'Run a deterministic built-in project tool through stage policy and bounded-output handling.',inputSchema:{type:'object',required:['run_id','tool'],properties:{project_root:{type:'string'},run_id:{type:'string'},tool:{type:'string'},args:{type:'object'}}}},
  {name:'agent_sdlc_artifact_put',description:'Store durable external memory as a content-addressed artifact and attach it to a run.',inputSchema:{type:'object',required:['run_id','kind','content'],properties:{project_root:{type:'string'},run_id:{type:'string'},kind:{type:'string'},content:{type:'string'}}}},
  {name:'agent_sdlc_model_route',description:'Choose deterministic vs model execution and the cheapest qualified model tier subject to risk floor.',annotations:{readOnlyHint:true},inputSchema:{type:'object',required:['run_id'],properties:{project_root:{type:'string'},run_id:{type:'string'},task:{type:'string'},provider:{type:'string'},require_structured:{type:'boolean'}}}},
  // Unified task operation for token-aware / compact hosts.
  {name:'agent_sdlc_task',description:'Unified task operations: list, status, ready, schedule, context, or evidence.',annotations:{readOnlyHint:true},inputSchema:{type:'object',required:['run_id','op'],properties:{project_root:{type:'string'},run_id:{type:'string'},op:{type:'string',enum:['list','status','ready','schedule','context','evidence']},task_id:{type:'string'},outer_stage:{type:'string'},remaining_model_calls:{type:'number'},prompt:{type:'boolean'}}}},
  // Granular task runtime tools for full profile and backward compatibility.
  {name:'agent_sdlc_task_list',description:'List the persistent task records for a run with status, category and dependencies.',annotations:{readOnlyHint:true},inputSchema:{type:'object',required:['run_id'],properties:{project_root:{type:'string'},run_id:{type:'string'}}}},
  {name:'agent_sdlc_task_status',description:'Read one task record, or the whole run task progress when task_id is omitted.',annotations:{readOnlyHint:true},inputSchema:{type:'object',required:['run_id'],properties:{project_root:{type:'string'},run_id:{type:'string'},task_id:{type:'string'}}}},
  {name:'agent_sdlc_task_ready',description:'Dependency-satisfied task set for a run, with an explicit reason for every excluded task.',annotations:{readOnlyHint:true},inputSchema:{type:'object',required:['run_id'],properties:{project_root:{type:'string'},run_id:{type:'string'},outer_stage:{type:'string'}}}},
  {name:'agent_sdlc_task_schedule',description:'Compute the bounded dispatch decision: which ready tasks may run now and why the rest may not.',annotations:{readOnlyHint:true},inputSchema:{type:'object',required:['run_id'],properties:{project_root:{type:'string'},run_id:{type:'string'},outer_stage:{type:'string'},remaining_model_calls:{type:'number'}}}},
  {name:'agent_sdlc_task_context',description:'Compile the bounded per-task context package and persist its manifest for replay.',annotations:{readOnlyHint:true},inputSchema:{type:'object',required:['run_id','task_id'],properties:{project_root:{type:'string'},run_id:{type:'string'},task_id:{type:'string'},prompt:{type:'boolean'}}}},
  {name:'agent_sdlc_task_evidence',description:'Read a task verification/review evidence summary: refs, diff binding and current status.',annotations:{readOnlyHint:true},inputSchema:{type:'object',required:['run_id','task_id'],properties:{project_root:{type:'string'},run_id:{type:'string'},task_id:{type:'string'}}}}
];

export function getActiveTools(){
  const profile=(process.env.AGENT_SDLC_MCP_PROFILE||'full').toLowerCase();
  if(profile==='core')return toolDefs.filter(t=>CORE_TOOL_NAMES.has(t.name));
  return toolDefs;
}

function pr(a){return path.resolve(a.project_root||process.cwd());}
/**
 * An argument the schema declares as an array. A bare string would otherwise be
 * spread character by character downstream, so a single evidence token became
 * twenty-two one-letter ones; say what was wrong instead.
 */
function arrayArg(v,name){
  if(v===undefined||v===null)return [];
  if(Array.isArray(v))return v;
  throw new Error(`${name} must be an array of strings, received ${typeof v}`);
}
function execute(name,a={}){
  const projectRoot=pr(a);
  if(name==='agent_sdlc_route')return route(ROOT,a.objective,a.workflow||null,a.profile||null);
  if(name==='agent_sdlc_start'){
    if(!fs.existsSync(path.join(projectRoot,'.agent-sdlc','project.json')))initProject(projectRoot,detectProject(projectRoot));
    const r=route(ROOT,a.objective,a.workflow||null,a.profile||null);return newRun(ROOT,projectRoot,{objective:a.objective,route:r});
  }
  const run=loadRun(projectRoot,a.run_id);
  if(name==='agent_sdlc_status')return {...run,next:nextState(run)};
  if(name==='agent_sdlc_context')return buildContext(ROOT,projectRoot,run,{artifactRefs:a.artifact_refs===undefined?(run.artifacts||[]):arrayArg(a.artifact_refs,'artifact_refs'),symbols:arrayArg(a.symbols,'symbols')});
  if(name==='agent_sdlc_transition'){
    // force/approval are not part of this tool's contract; a caller that still
    // sends them gets a named error, not a silently ignored field that leaves
    // it believing the run moved.
    if(a.force!==undefined||a.approval!==undefined){
      throw new Error('FORCE_DISABLED: force/approval are not supported over MCP. Use a declared recovery edge, or have a human run `agent-sdlc approval grant` interactively.');
    }
    return transition(ROOT,projectRoot,run,a.to,{evidence:arrayArg(a.evidence,'evidence')});
  }
  if(name==='agent_sdlc_approval_status')return listApprovals(run);
  if(name==='agent_sdlc_tool_check')return checkTool(ROOT,run,a.tool);
  if(name==='agent_sdlc_tool_run')return invokeTool(ROOT,projectRoot,run,a.tool,a.args||{});
  if(name==='agent_sdlc_artifact_put'){
    const art=putArtifact(projectRoot,{kind:a.kind,content:a.content,runId:run.run_id,stage:run.state});run.artifacts=[...new Set([...(run.artifacts||[]),art.artifact_id])];saveRun(projectRoot,run);emit(projectRoot,run,{type:'artifact.created',artifact_refs:[art.artifact_id],payload:{kind:a.kind}});return art;
  }
  if(name==='agent_sdlc_model_route')return routeModel(ROOT,projectRoot,run,{task:a.task||'stage',provider:a.provider||'auto',requireStructured:!!a.require_structured});
  if(name==='agent_sdlc_task'){
    if(a.op==='list')return execute('agent_sdlc_task_list',a);
    if(a.op==='status')return execute('agent_sdlc_task_status',a);
    if(a.op==='ready')return execute('agent_sdlc_task_ready',a);
    if(a.op==='schedule')return execute('agent_sdlc_task_schedule',a);
    if(a.op==='context')return execute('agent_sdlc_task_context',a);
    if(a.op==='evidence')return execute('agent_sdlc_task_evidence',a);
    throw new Error(`unknown op "${a.op}" for agent_sdlc_task`);
  }
  if(name==='agent_sdlc_task_list')return listTasks(projectRoot,run.run_id).map(t=>({task_id:t.task_id,status:t.status,category:t.category,attempt:t.attempt,depends_on:t.depends_on,parallel_candidate:t.execution?.parallel_candidate===true}));
  if(name==='agent_sdlc_task_status')return a.task_id?requireTask(projectRoot,run.run_id,a.task_id):taskProgress(projectRoot,run.run_id);
  if(name==='agent_sdlc_task_ready')return readySet(projectRoot,run.run_id,{outerStage:a.outer_stage||run.state,root:ROOT});
  if(name==='agent_sdlc_task_schedule')return scheduleTasks(ROOT,projectRoot,run,{
    outerStage:a.outer_stage||run.state,
    budget:a.remaining_model_calls!==undefined?{remaining_model_calls:Number(a.remaining_model_calls)}:null
  });
  if(name==='agent_sdlc_task_context'){
    const task=requireTask(projectRoot,run.run_id,a.task_id);
    const m=buildTaskContext(ROOT,projectRoot,run,task);
    return a.prompt?{context_hash:m.context_hash,prompt:renderTaskPrompt(ROOT,m)}:m;
  }
  if(name==='agent_sdlc_task_evidence'){
    const task=requireTask(projectRoot,run.run_id,a.task_id);
    return {
      schema:'agent-sdlc/task-evidence-summary/v1',
      run_id:run.run_id,task_id:task.task_id,status:task.status,attempt:task.attempt,
      base_revision:task.base_revision,diff_hash:task.diff_hash,
      context_manifest_ref:task.context_manifest_ref,
      evidence_refs:task.evidence_refs||[],review_refs:task.review_refs||[],
      failure:task.failure||null,blocker:task.blocker||null,invalidation:task.invalidation||null,
      events:listTaskEvents(projectRoot,run.run_id,task.task_id).map(e=>({seq:e.seq,type:e.type,time:e.time}))
    };
  }
  throw new Error(`unknown MCP tool ${name}`);
}
function send(obj){process.stdout.write(JSON.stringify(obj)+'\n');}
let buffer='';
process.stdin.setEncoding('utf8');
process.stdin.on('data',chunk=>{buffer+=chunk;let i;while((i=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,i).trim();buffer=buffer.slice(i+1);if(line)handle(line);}});
function handle(line){let req;try{req=JSON.parse(line);}catch{return;}const id=req.id;
  try{
    if(req.method==='initialize')return send({jsonrpc:'2.0',id,result:{protocolVersion:req.params?.protocolVersion||'2025-06-18',capabilities:{tools:{listChanged:false}},serverInfo:{name:'agent-sdlc-harness',version:MANIFEST_VERSION}}});
    if(req.method==='notifications/initialized')return;
    if(req.method==='ping')return send({jsonrpc:'2.0',id,result:{}});
    if(req.method==='tools/list')return send({jsonrpc:'2.0',id,result:{tools:getActiveTools()}});
    if(req.method==='tools/call'){
      // The profile shrinks the advertised surface; it must shrink the reachable
      // one too. `core` hid the granular task tools while still answering calls
      // to them, so a narrowed surface was advisory only.
      const requested=req.params?.name;
      if(!getActiveTools().some(t=>t.name===requested)){
        throw new Error(`tool ${requested??'(none)'} is not available in the ${(process.env.AGENT_SDLC_MCP_PROFILE||'full').toLowerCase()} MCP profile`);
      }
      const result=execute(requested,req.params?.arguments||{});
      return send({jsonrpc:'2.0',id,result:{content:[{type:'text',text:JSON.stringify(result)}],structuredContent:result,isError:false}});
    }
    if(id!==undefined)send({jsonrpc:'2.0',id,error:{code:-32601,message:`Method not found: ${req.method}`}});
  }catch(e){if(id!==undefined)send({jsonrpc:'2.0',id,result:{content:[{type:'text',text:JSON.stringify({status:'ERROR',error:e.message})}],isError:true}});}
}
