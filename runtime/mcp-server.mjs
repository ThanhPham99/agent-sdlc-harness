#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {rootFrom} from './util.mjs';
import {detectProject} from './init.mjs';
import {initProject,loadRun,putArtifact,saveRun,emit} from './store.mjs';
import {route} from './router.mjs';
import {newRun,transition,nextState} from './orchestrator.mjs';
import {buildContext} from './context.mjs';
import {checkTool} from './policy.mjs';
import {invokeTool} from './tools.mjs';
import {routeModel} from './model-router.mjs';

const ROOT=rootFrom(import.meta.url);
const MANIFEST_VERSION=JSON.parse(fs.readFileSync(path.join(ROOT,'agent-sdlc.manifest.json'),'utf8')).version;
const toolDefs=[
  {name:'agent_sdlc_route',description:'Route a software task into the canonical SDLC workflow without model inference.',inputSchema:{type:'object',required:['objective'],properties:{objective:{type:'string'},workflow:{type:'string'},profile:{type:'string'}}}},
  {name:'agent_sdlc_start',description:'Initialize project state if needed and start an evidence-driven SDLC run.',inputSchema:{type:'object',required:['objective'],properties:{project_root:{type:'string'},objective:{type:'string'},workflow:{type:'string'},profile:{type:'string'}}}},
  {name:'agent_sdlc_status',description:'Read current run state.',inputSchema:{type:'object',required:['run_id'],properties:{project_root:{type:'string'},run_id:{type:'string'}}}},
  {name:'agent_sdlc_context',description:'Compile bounded stage context with on-demand internal skill instructions and evidence requirements.',inputSchema:{type:'object',required:['run_id'],properties:{project_root:{type:'string'},run_id:{type:'string'},artifact_refs:{type:'array',items:{type:'string'}},symbols:{type:'array',items:{type:'string'}}}}},
  {name:'agent_sdlc_transition',description:'Transition a run only when gate evidence is satisfied.',inputSchema:{type:'object',required:['run_id','to'],properties:{project_root:{type:'string'},run_id:{type:'string'},to:{type:'string'},evidence:{type:'array',items:{type:'string'}},approval:{type:'string'},force:{type:'boolean'}}}},
  {name:'agent_sdlc_tool_check',description:'Check canonical stage/tool policy before execution.',inputSchema:{type:'object',required:['run_id','tool'],properties:{project_root:{type:'string'},run_id:{type:'string'},tool:{type:'string'}}}},
  {name:'agent_sdlc_tool_run',description:'Run a deterministic built-in project tool through stage policy and bounded-output handling.',inputSchema:{type:'object',required:['run_id','tool'],properties:{project_root:{type:'string'},run_id:{type:'string'},tool:{type:'string'},args:{type:'object'}}}},
  {name:'agent_sdlc_artifact_put',description:'Store durable external memory as a content-addressed artifact and attach it to a run.',inputSchema:{type:'object',required:['run_id','kind','content'],properties:{project_root:{type:'string'},run_id:{type:'string'},kind:{type:'string'},content:{type:'string'}}}},
  {name:'agent_sdlc_model_route',description:'Choose deterministic vs model execution and the cheapest qualified model tier subject to risk floor.',inputSchema:{type:'object',required:['run_id'],properties:{project_root:{type:'string'},run_id:{type:'string'},task:{type:'string'},provider:{type:'string'},require_structured:{type:'boolean'}}}}
];
function pr(a){return path.resolve(a.project_root||process.cwd());}
function execute(name,a={}){
  const projectRoot=pr(a);
  if(name==='agent_sdlc_route')return route(ROOT,a.objective,a.workflow||null,a.profile||null);
  if(name==='agent_sdlc_start'){
    if(!fs.existsSync(path.join(projectRoot,'.agent-sdlc','project.json')))initProject(projectRoot,detectProject(projectRoot));
    const r=route(ROOT,a.objective,a.workflow||null,a.profile||null);return newRun(ROOT,projectRoot,{objective:a.objective,route:r});
  }
  const run=loadRun(projectRoot,a.run_id);
  if(name==='agent_sdlc_status')return {...run,next:nextState(run)};
  if(name==='agent_sdlc_context')return buildContext(ROOT,projectRoot,run,{artifactRefs:a.artifact_refs||run.artifacts||[],symbols:a.symbols||[]});
  if(name==='agent_sdlc_transition')return transition(ROOT,projectRoot,run,a.to,{evidence:a.evidence||[],approval:a.approval||null,force:!!a.force});
  if(name==='agent_sdlc_tool_check')return checkTool(ROOT,run,a.tool);
  if(name==='agent_sdlc_tool_run')return invokeTool(ROOT,projectRoot,run,a.tool,a.args||{});
  if(name==='agent_sdlc_artifact_put'){
    const art=putArtifact(projectRoot,{kind:a.kind,content:a.content,runId:run.run_id,stage:run.state});run.artifacts=[...new Set([...(run.artifacts||[]),art.artifact_id])];saveRun(projectRoot,run);emit(projectRoot,run,{type:'artifact.created',artifact_refs:[art.artifact_id],payload:{kind:a.kind}});return art;
  }
  if(name==='agent_sdlc_model_route')return routeModel(ROOT,projectRoot,run,{task:a.task||'stage',provider:a.provider||'auto',requireStructured:!!a.require_structured});
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
    if(req.method==='tools/list')return send({jsonrpc:'2.0',id,result:{tools:toolDefs}});
    if(req.method==='tools/call'){
      const result=execute(req.params?.name,req.params?.arguments||{});
      return send({jsonrpc:'2.0',id,result:{content:[{type:'text',text:JSON.stringify(result)}],structuredContent:result,isError:false}});
    }
    if(id!==undefined)send({jsonrpc:'2.0',id,error:{code:-32601,message:`Method not found: ${req.method}`}});
  }catch(e){if(id!==undefined)send({jsonrpc:'2.0',id,result:{content:[{type:'text',text:JSON.stringify({status:'ERROR',error:e.message})}],isError:true}});}
}
