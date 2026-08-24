#!/usr/bin/env node
import fs from 'node:fs';import path from 'node:path';import os from 'node:os';
import {parseArgs,readJson,rootFrom,writeJson,gitSha,appendJsonl} from './util.mjs';
import {detectProject} from './init.mjs';import {initProject,loadRun,saveRun,putArtifact,getArtifact,listArtifacts,emit,stateDir} from './store.mjs';import {route} from './router.mjs';import {newRun,nextState,transition} from './orchestrator.mjs';import {buildContext,renderPrompt} from './context.mjs';import {checkTool} from './policy.mjs';import {invokeTool} from './tools.mjs';import {addUsage,reportUsage} from './cost.mjs';import {probe,capabilities,buildInvocation,runHost} from './provider.mjs';import {routeModel} from './model-router.mjs';import {resolveConfig} from './config.mjs';import {compatCheck,migrateState} from './compat.mjs';import {parallelPlan} from './parallel.mjs';import {metrics} from './telemetry.mjs';import {putHandoff,getHandoff,listHandoffs} from './handoff.mjs';import {exportReplay,validateReplay} from './replay.mjs';import {normalizeInput} from './normalize.mjs';import {activationStatus,getBootstrapInstruction,getActivationPolicy,estimateBootstrapCost,classifyActivationFixture,buildActivationEvent,ACTIVATION_EVENTS} from './activation.mjs';import * as codexBootstrap from './codex-bootstrap.mjs';
const ROOT=rootFrom(import.meta.url);const args=parseArgs(process.argv.slice(2));const cmd=args._[0];const projectRoot=path.resolve(args.project||process.cwd());
const print=x=>console.log(typeof x==='string'?x:JSON.stringify(x,null,2));
function needRun(){if(!args['run-id'])throw new Error('--run-id required');return loadRun(projectRoot,args['run-id']);}
try{
 if(cmd==='init'){const cfg=detectProject(projectRoot);initProject(projectRoot,cfg);print({status:'INITIALIZED',project_root:projectRoot,config:cfg});}
 else if(cmd==='route'){print(route(ROOT,args.objective||args._.slice(1).join(' '),args.workflow||null,args.profile||null));}
 else if(cmd==='start'){const objective=args.objective||args._.slice(1).join(' ');if(!objective)throw new Error('objective required');if(!fs.existsSync(path.join(projectRoot,'.agent-sdlc','project.json')))initProject(projectRoot,detectProject(projectRoot));const r=route(ROOT,objective,args.workflow||null,args.profile||null);const run=newRun(ROOT,projectRoot,{objective,route:r});print(run);}
 else if(cmd==='status'){print(needRun());}
 else if(cmd==='next'){const run=needRun();print({run_id:run.run_id,state:run.state,next:nextState(run)});}
 else if(cmd==='transition'){const run=needRun();const ev=(args.evidence?String(args.evidence).split(',').filter(Boolean):[]);print(transition(ROOT,projectRoot,run,args.to,{evidence:ev,approval:args.approval||null,force:!!args.force}));}
 else if(cmd==='context'){const run=needRun();const refs=args.artifacts?String(args.artifacts).split(',').filter(Boolean):run.artifacts||[];const syms=args.symbols?String(args.symbols).split(',').filter(Boolean):[];const m=buildContext(ROOT,projectRoot,run,{artifactRefs:refs,symbols:syms});if(args.prompt)print(renderPrompt(ROOT,m));else print(m);}
 else if(cmd==='artifact-put'){const content=args.file?fs.readFileSync(path.resolve(args.file),'utf8'):String(args.content||'');const run=args['run-id']?needRun():null;const a=putArtifact(projectRoot,{kind:args.kind||'generic',content,runId:run?.run_id||null,stage:run?.state||null,sourceRevision:gitSha(projectRoot),filename:args.file?path.basename(args.file):null});if(run){run.artifacts=[...new Set([...(run.artifacts||[]),a.artifact_id])];saveRun(projectRoot,run);emit(projectRoot,run,{type:'artifact.created',artifact_refs:[a.artifact_id],payload:{kind:a.kind}});}print(a);}
 else if(cmd==='normalize'){if(!args.file)throw new Error('--file required');const n=normalizeInput(path.resolve(args.file),{maxBytes:Number(args['max-bytes']||20*1024*1024)});let artifact=null;if(args['run-id']&&n.status==='NORMALIZED'){const run=needRun();artifact=putArtifact(projectRoot,{kind:'normalized-requirement',content:n.markdown,runId:run.run_id,stage:run.state,sourceRevision:gitSha(projectRoot),filename:path.basename(args.file)+'.md'});run.artifacts=[...new Set([...(run.artifacts||[]),artifact.artifact_id])];saveRun(projectRoot,run);emit(projectRoot,run,{type:'input.normalized',artifact_refs:[artifact.artifact_id],payload:{source_type:n.source_type,source_sha256:n.source_sha256}});}if(args.output&&n.markdown)fs.writeFileSync(path.resolve(args.output),n.markdown);print({...n,artifact});}
 else if(cmd==='artifact-get'){print(getArtifact(projectRoot,args.ref));}
 else if(cmd==='artifact-list'){print(listArtifacts(projectRoot));}
 else if(cmd==='tool-check'){const run=needRun();print(checkTool(ROOT,run,args.tool));}
 else if(cmd==='tool-run'){const run=needRun();const a=args.args?JSON.parse(args.args):{};print(invokeTool(ROOT,projectRoot,run,args.tool,a));}
 else if(cmd==='usage-add'){const run=needRun();print(addUsage(projectRoot,run,{provider:args.provider,model:args.model,input_tokens:args.input||0,cached_input_tokens:args.cached||0,output_tokens:args.output||0,reasoning_tokens:args.reasoning||0,wall_ms:args['wall-ms']||0,source:args.source}));}
 else if(cmd==='usage-report'){print(reportUsage(projectRoot,args['run-id']));}
 else if(cmd==='config-show'){print(resolveConfig(projectRoot,{...(args.provider?{default_provider:args.provider}:{}),...(args.profile?{risk_profile:args.profile}:{})}));}
 else if(cmd==='compat-check'){print(compatCheck(ROOT,projectRoot));}
 else if(cmd==='migrate'){print(migrateState(ROOT,projectRoot));}
 else if(cmd==='parallel-plan'){const tasks=args.tasks?JSON.parse(args.tasks):(args.file?JSON.parse(fs.readFileSync(path.resolve(args.file),'utf8')):[]);print(parallelPlan(ROOT,tasks));}
 else if(cmd==='metrics'){print(metrics(projectRoot));}
 else if(cmd==='handoff-put'){const run=needRun();const payload=args.file?JSON.parse(fs.readFileSync(path.resolve(args.file),'utf8')):{summary:args.summary||'',verified_facts:args.verified?String(args.verified).split('|').filter(Boolean):[],unknowns:args.unknowns?String(args.unknowns).split('|').filter(Boolean):[],next_action:args.next||null};print(putHandoff(projectRoot,run,payload));}
 else if(cmd==='handoff-get'){print(getHandoff(projectRoot,args.id));}
 else if(cmd==='handoff-list'){print(listHandoffs(projectRoot,args['run-id']||null));}
 else if(cmd==='model-route'){const run=needRun();print(routeModel(ROOT,projectRoot,run,{task:args.task||'stage',provider:args.provider||'auto',requireStructured:!!args.structured}));}
 else if(cmd==='provider-probe'){const hosts=args.host?[args.host]:['claude','codex','antigravity'];print(hosts.map(h=>{const p=probe(h);return capabilities(h,p)}));}
 else if(cmd==='provider-command'){const run=needRun();const m=buildContext(ROOT,projectRoot,run,{artifactRefs:run.artifacts||[]});const prompt=renderPrompt(ROOT,m);print(buildInvocation(args.host,prompt,path.join(ROOT,'protocol','schemas','StageResult.schema.json'),{maxTurns:8,maxWallMs:900000,stage:run.state}));}
 else if(cmd==='provider-run'){const run=needRun();const m=buildContext(ROOT,projectRoot,run,{artifactRefs:run.artifacts||[]});const prompt=renderPrompt(ROOT,m);const started=Date.now();const out=runHost(args.host,prompt,path.join(ROOT,'protocol','schemas','StageResult.schema.json'),{maxTurns:8,maxWallMs:900000,stage:run.state});emit(projectRoot,run,{type:'provider.completed',provider:args.host,payload:{status:out.status,exit_code:out.exit_code??null},usage:{wall_ms:Date.now()-started}});print(out);}
 else if(cmd==='replay-export'){const run=needRun();const b=exportReplay(projectRoot,run);if(args.output)writeJson(path.resolve(args.output),b);print(b);}
 else if(cmd==='replay-validate'){print(validateReplay(readJson(path.resolve(args.file))));}
 else if(cmd==='activation'){
   const sub=args._[1]||'status';
   const version=readJson(path.join(ROOT,'agent-sdlc.manifest.json')).version;
   const cfg=()=>resolveConfig(projectRoot).effective;
   const codexState=host=>host==='codex'?codexBootstrap.status({home:args['codex-home']||null,version}):null;
   const setEnabled=(value)=>{
     const target=args.global?path.join(os.homedir(),'.agent-sdlc','config.json'):path.join(projectRoot,'.agent-sdlc','project.json');
     const current=fs.existsSync(target)?readJson(target):{};
     current.auto_activation={...(current.auto_activation||{}),enabled:value};
     writeJson(target,current);
     return {status:value?'ENABLED':'DISABLED',scope:args.global?'global':'project',config_file:target,note:`environment ${getActivationPolicy().env_override} still overrides this layer`};
   };
   if(sub==='status')print(activationStatus({host:args.host||'unknown',config:cfg(),codexManagedBootstrap:codexState(args.host),version}));
   else if(sub==='print-bootstrap')print(getBootstrapInstruction());
   else if(sub==='policy')print(getActivationPolicy());
   else if(sub==='cost')print({schema:'agent-sdlc/bootstrap-budget/v1',...estimateBootstrapCost(),budget:getActivationPolicy().max_bootstrap_rough_tokens});
   else if(sub==='enable')print(setEnabled(true));
   else if(sub==='disable')print(setEnabled(false));
   else if(sub==='classify')print(classifyActivationFixture({prompt:args.prompt||args._.slice(2).join(' '),repositoryContext:{repository_target:!!args['repository-target']}}));
   else if(sub==='events')print({schema:'agent-sdlc/activation-events/v1',events:ACTIVATION_EVENTS});
   else if(sub==='record'){
     const ev={...buildActivationEvent(args.event||'activation.bootstrap_delivered',{host:args.host||null,delivery_mode:args['delivery-mode']||null,reason:args.reason||null,run_id:args['run-id']||null,fixture_id:args.fixture||null}),timestamp:new Date().toISOString()};
     const p=path.join(projectRoot,'.agent-sdlc','activation.jsonl');
     if(!args['dry-run'])appendJsonl(p,ev);
     print({status:args['dry-run']?'DRY_RUN':'RECORDED',log:p,event:ev});
   }
   else if(sub==='doctor'){
     const hosts=args.host?[args.host]:['claude','codex','antigravity'];
     print({schema:'agent-sdlc/activation-doctor/v1',version,bootstrap:{...estimateBootstrapCost(),text:getBootstrapInstruction()},hosts:hosts.map(h=>({...activationStatus({host:h,config:cfg(),codexManagedBootstrap:codexState(h),version}),...(h==='codex'?{codex_managed_bootstrap:codexBootstrap.status({home:args['codex-home']||null,version})}:{})}))});
   }
   else if(sub==='codex-bootstrap'){
     const action=args._[2]||'status';
     const opts={home:args['codex-home']||null,version,dryRun:!!args['dry-run']};
     if(action==='install')print(codexBootstrap.install(opts));
     else if(action==='uninstall')print(codexBootstrap.uninstall(opts));
     else print(codexBootstrap.status(opts));
   }
   else throw new Error(`unknown activation subcommand ${sub}`);
 }
 else if(cmd==='doctor'){const proj=fs.existsSync(path.join(projectRoot,'.agent-sdlc','project.json'))?'READY':'NOT_INITIALIZED';print({version:readJson(path.join(ROOT,'agent-sdlc.manifest.json')).version,node:process.version,project:proj,providers:['claude','codex','antigravity'].map(h=>capabilities(h,probe(h))),auto_activation:['claude','codex','antigravity'].map(h=>{const s=activationStatus({host:h,config:resolveConfig(projectRoot).effective,codexManagedBootstrap:h==='codex'?codexBootstrap.status({}):null});return {host:h,enabled:s.enabled,delivery_mode:s.delivery_mode,activation_class:s.activation_class,rough_tokens:s.rough_tokens};})});}
 else {print(`agent-sdlc ${readJson(path.join(ROOT,'agent-sdlc.manifest.json')).version}\n\nCommands: init, route, start, status, next, transition, context, normalize, artifact-put/get/list, handoff-put/get/list, tool-check/run, usage-add/report, config-show, compat-check, migrate, parallel-plan, metrics, model-route, provider-probe/command/run, replay-export/validate, activation, doctor\n\nactivation subcommands: status, enable, disable, print-bootstrap, policy, cost, classify, events, record, doctor, codex-bootstrap install|uninstall|status`);process.exit(cmd?2:0);}
}catch(e){console.error(JSON.stringify({status:'ERROR',error:e.message},null,2));process.exit(1);}
