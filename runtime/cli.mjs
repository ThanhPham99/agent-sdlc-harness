#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {parseArgs,readJson,rootFrom,writeJson,gitSha,appendJsonl,truthy} from './util.mjs';

const ROOT=rootFrom(import.meta.url);
const args=parseArgs(process.argv.slice(2));
const cmd=args._[0];
const projectRoot=path.resolve(args.project||process.cwd());
const print=x=>console.log(typeof x==='string'?x:JSON.stringify(x,null,2));

async function needRun(){
  if(!args['run-id'])throw new Error('--run-id required');
  const {loadRun}=await import('./store.mjs');
  return loadRun(projectRoot,args['run-id']);
}

async function main(){
  try{
    if(cmd==='init'){
      const {detectProject}=await import('./init.mjs');
      const {initProject}=await import('./store.mjs');
      const cfg=detectProject(projectRoot);
      initProject(projectRoot,cfg);
      print({status:'INITIALIZED',project_root:projectRoot,config:cfg});
    }
    else if(cmd==='route'){
      const {route}=await import('./router.mjs');
      print(route(ROOT,args.objective||args._.slice(1).join(' '),args.workflow||null,args.profile||null));
    }
    else if(cmd==='start'){
      const objective=args.objective||args._.slice(1).join(' ');
      if(!objective)throw new Error('objective required');
      const {detectProject}=await import('./init.mjs');
      const {initProject}=await import('./store.mjs');
      const {route}=await import('./router.mjs');
      const {newRun}=await import('./orchestrator.mjs');
      if(!fs.existsSync(path.join(projectRoot,'.agent-sdlc','project.json')))initProject(projectRoot,detectProject(projectRoot));
      const r=route(ROOT,objective,args.workflow||null,args.profile||null);
      const run=newRun(ROOT,projectRoot,{objective,route:r});
      print(run);
    }
    else if(cmd==='status'){
      print(await needRun());
    }
    else if(cmd==='next'){
      const run=await needRun();
      const {nextState}=await import('./orchestrator.mjs');
      print({run_id:run.run_id,state:run.state,next:nextState(run)});
    }
    else if(cmd==='transition'){
      if(args.force!==undefined||args.approval!==undefined){
        throw new Error('FORCE_DISABLED: generic transition bypass is not supported. Use a declared recovery edge (see config/state-machine.json reentry edges), or `agent-sdlc approval grant` for a privileged capability.');
      }
      const run=await needRun();
      const {transition}=await import('./orchestrator.mjs');
      const ev=(args.evidence?String(args.evidence).split(',').filter(Boolean):[]);
      print(transition(ROOT,projectRoot,run,args.to,{evidence:ev}));
    }
    else if(cmd==='approval'){
      const sub=args._[1]||'status';
      const {recordApproval,revokeApproval,listApprovals}=await import('./approvals.mjs');
      if(sub==='status'){
        const run=await needRun();
        print(listApprovals(run));
      }
      else if(sub==='grant'){
        const run=await needRun();
        const capability=args.capability;
        if(!capability)throw new Error('--capability required');
        if(!process.stdin.isTTY)throw new Error('approval grant requires an interactive terminal');
        let expiresAt=args['expires-at']||null;
        if(!expiresAt&&args['expires-in'])expiresAt=new Date(Date.now()+Number(args['expires-in'])*60000).toISOString();
        console.error(`Grant approval for capability "${capability}" on run ${run.run_id} (${projectRoot})`);
        if(args.reason)console.error(`Reason: ${args.reason}`);
        console.error(expiresAt?`Expires: ${expiresAt}`:'Expires: never (only allowed for a non-privileged capability)');
        const readline=await import('node:readline/promises');
        const rl=readline.createInterface({input:process.stdin,output:process.stderr});
        const answer=await rl.question('Type "yes" to confirm: ');
        rl.close();
        if(answer.trim().toLowerCase()!=='yes')throw new Error('approval grant not confirmed');
        print(recordApproval(ROOT,projectRoot,run,{capability,authority:'USER_INTERACTIVE',actor:os.userInfo().username,reason:args.reason||null,expiresAt}));
      }
      else if(sub==='revoke'){
        const run=await needRun();
        const capability=args.capability;
        if(!capability)throw new Error('--capability required');
        print(revokeApproval(ROOT,projectRoot,run,capability,{reason:args.reason||null}));
      }
      else throw new Error(`unknown approval subcommand ${sub}`);
    }
    else if(cmd==='gate'){
      const sub=args._[1]||'status';
      const {evaluateGate}=await import('./gates.mjs');
      const run=await needRun();
      if(sub==='status')print(evaluateGate(ROOT,projectRoot,run,run.state));
      else if(sub==='explain')print(evaluateGate(ROOT,projectRoot,run,args.stage||run.state));
      else throw new Error(`unknown gate subcommand ${sub}`);
    }
    else if(cmd==='context'){
      const run=await needRun();
      const {buildContext,renderPrompt}=await import('./context.mjs');
      const refs=args.artifacts?String(args.artifacts).split(',').filter(Boolean):run.artifacts||[];
      const syms=args.symbols?String(args.symbols).split(',').filter(Boolean):[];
      const m=buildContext(ROOT,projectRoot,run,{artifactRefs:refs,symbols:syms});
      if(args.prompt)print(renderPrompt(ROOT,m));else print(m);
    }
    else if(cmd==='artifact-put'){
      const {putArtifact,saveRun,emit}=await import('./store.mjs');
      const content=args.file?fs.readFileSync(path.resolve(args.file),'utf8'):String(args.content||'');
      const run=args['run-id']?await needRun():null;
      const a=putArtifact(projectRoot,{kind:args.kind||'generic',content,runId:run?.run_id||null,stage:run?.state||null,sourceRevision:gitSha(projectRoot),filename:args.file?path.basename(args.file):null});
      if(run){run.artifacts=[...new Set([...(run.artifacts||[]),a.artifact_id])];saveRun(projectRoot,run);emit(projectRoot,run,{type:'artifact.created',artifact_refs:[a.artifact_id],payload:{kind:a.kind}});}
      print(a);
    }
    else if(cmd==='normalize'){
      if(!args.file)throw new Error('--file required');
      const {normalizeInput}=await import('./normalize.mjs');
      const {putArtifact,saveRun,emit}=await import('./store.mjs');
      const n=normalizeInput(path.resolve(args.file),{maxBytes:Number(args['max-bytes']||20*1024*1024)});
      let artifact=null;
      if(args['run-id']&&n.status==='NORMALIZED'){
        const run=await needRun();
        artifact=putArtifact(projectRoot,{kind:'normalized-requirement',content:n.markdown,runId:run.run_id,stage:run.state,sourceRevision:gitSha(projectRoot),filename:path.basename(args.file)+'.md'});
        run.artifacts=[...new Set([...(run.artifacts||[]),artifact.artifact_id])];
        saveRun(projectRoot,run);
        emit(projectRoot,run,{type:'input.normalized',artifact_refs:[artifact.artifact_id],payload:{source_type:n.source_type,source_sha256:n.source_sha256}});
      }
      if(args.output&&n.markdown)fs.writeFileSync(path.resolve(args.output),n.markdown);
      print({...n,artifact});
    }
    else if(cmd==='artifact-get'){
      const {getArtifact}=await import('./store.mjs');
      print(getArtifact(projectRoot,args.ref));
    }
    else if(cmd==='artifact-list'){
      const {listArtifacts}=await import('./store.mjs');
      print(listArtifacts(projectRoot));
    }
    else if(cmd==='tool-check'){
      const run=await needRun();
      const {checkTool}=await import('./policy.mjs');
      print(checkTool(ROOT,run,args.tool));
    }
    else if(cmd==='tool-run'){
      const run=await needRun();
      const {invokeTool}=await import('./tools.mjs');
      const a=args.args?JSON.parse(args.args):{};
      print(invokeTool(ROOT,projectRoot,run,args.tool,a));
    }
    else if(cmd==='usage-add'){
      const run=await needRun();
      const {addUsage}=await import('./cost.mjs');
      print(addUsage(projectRoot,run,{provider:args.provider,model:args.model,input_tokens:args.input||0,cached_input_tokens:args.cached||0,output_tokens:args.output||0,reasoning_tokens:args.reasoning||0,wall_ms:args['wall-ms']||0,source:args.source}));
    }
    else if(cmd==='usage-report'){
      const {reportUsage}=await import('./cost.mjs');
      print(reportUsage(projectRoot,args['run-id']));
    }
    else if(cmd==='config-show'){
      const {resolveConfig}=await import('./config.mjs');
      print(resolveConfig(projectRoot,{...(args.provider?{default_provider:args.provider}:{}),...(args.profile?{risk_profile:args.profile}:{})}));
    }
    else if(cmd==='compat-check'){
      const {compatCheck}=await import('./compat.mjs');
      print(compatCheck(ROOT,projectRoot));
    }
    else if(cmd==='migrate'){
      const {migrateState}=await import('./compat.mjs');
      print(migrateState(ROOT,projectRoot));
    }
    else if(cmd==='parallel-plan'){
      const {parallelPlan}=await import('./parallel.mjs');
      const tasks=args.tasks?JSON.parse(args.tasks):(args.file?JSON.parse(fs.readFileSync(path.resolve(args.file),'utf8')):[]);
      print(parallelPlan(ROOT,tasks));
    }
    else if(cmd==='metrics'){
      const {metrics}=await import('./telemetry.mjs');
      print(metrics(projectRoot));
    }
    else if(cmd==='handoff-put'){
      const run=await needRun();
      const {putHandoff}=await import('./handoff.mjs');
      const payload=args.file?JSON.parse(fs.readFileSync(path.resolve(args.file),'utf8')):{summary:args.summary||'',verified_facts:args.verified?String(args.verified).split('|').filter(Boolean):[],unknowns:args.unknowns?String(args.unknowns).split('|').filter(Boolean):[],next_action:args.next||null};
      print(putHandoff(projectRoot,run,payload));
    }
    else if(cmd==='handoff-get'){
      const {getHandoff}=await import('./handoff.mjs');
      print(getHandoff(projectRoot,args.id));
    }
    else if(cmd==='handoff-list'){
      const {listHandoffs}=await import('./handoff.mjs');
      print(listHandoffs(projectRoot,args['run-id']||null));
    }
    else if(cmd==='model-route'){
      const run=await needRun();
      const {routeModel}=await import('./model-router.mjs');
      print(routeModel(ROOT,projectRoot,run,{task:args.task||'stage',provider:args.provider||'auto',requireStructured:!!args.structured}));
    }
    else if(cmd==='provider-probe'){
      const {probe,capabilities}=await import('./provider.mjs');
      const hosts=args.host?[args.host]:['claude','codex','antigravity'];
      print(hosts.map(h=>{const p=probe(h);return capabilities(h,p);}));
    }
    else if(cmd==='provider-command'){
      const run=await needRun();
      const {buildContext,renderPrompt}=await import('./context.mjs');
      const {buildInvocation}=await import('./provider.mjs');
      const m=buildContext(ROOT,projectRoot,run,{artifactRefs:run.artifacts||[]});
      const prompt=renderPrompt(ROOT,m);
      print(buildInvocation(args.host,prompt,path.join(ROOT,'protocol','schemas','StageResult.schema.json'),{maxTurns:8,maxWallMs:900000,stage:run.state}));
    }
    else if(cmd==='provider-run'){
      const run=await needRun();
      const {buildContext,renderPrompt}=await import('./context.mjs');
      const {runHost}=await import('./provider.mjs');
      const {emit}=await import('./store.mjs');
      const m=buildContext(ROOT,projectRoot,run,{artifactRefs:run.artifacts||[]});
      const prompt=renderPrompt(ROOT,m);
      const started=Date.now();
      const out=runHost(args.host,prompt,path.join(ROOT,'protocol','schemas','StageResult.schema.json'),{maxTurns:8,maxWallMs:900000,stage:run.state});
      emit(projectRoot,run,{type:'provider.completed',provider:args.host,payload:{status:out.status,exit_code:out.exit_code??null},usage:{wall_ms:Date.now()-started}});
      print(out);
    }
    else if(cmd==='replay-export'){
      const run=await needRun();
      const {exportReplay}=await import('./replay.mjs');
      const b=exportReplay(projectRoot,run);
      if(args.output)writeJson(path.resolve(args.output),b);
      print(b);
    }
    else if(cmd==='replay-validate'){
      const {validateReplay}=await import('./replay.mjs');
      print(validateReplay(readJson(path.resolve(args.file))));
    }
    else if(cmd==='activation'){
      const sub=args._[1]||'status';
      const version=readJson(path.join(ROOT,'agent-sdlc.manifest.json')).version;
      const {resolveConfig}=await import('./config.mjs');
      const {activationStatus,getBootstrapInstruction,getActivationPolicy,estimateBootstrapCost,classifyActivationFixture,buildActivationEvent,ACTIVATION_EVENTS}=await import('./activation.mjs');
      const codexBootstrap=await import('./codex-bootstrap.mjs');
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
    else if(cmd==='design'){
      const sub=args._[1]||'mode';
      const {selectDesignDiscoveryMode,validateDesignDecision,getDesignDiscoveryPolicy}=await import('./design-discovery.mjs');
      const {putArtifact,saveRun}=await import('./store.mjs');
      const {recordDesignDecision}=await import('./orchestrator.mjs');
      const loadFile=()=>{if(!args.file)throw new Error('--file required');return readJson(path.resolve(args.file));};
      if(sub==='mode'){
        const run=args['run-id']?await needRun():null;
        print(selectDesignDiscoveryMode({
          profile:args.profile||run?.profile||'STANDARD',
          objective:args.objective||run?.objective||args._.slice(2).join(' '),
          declaredSignals:args.signals?String(args.signals).split(',').map(s=>s.trim()).filter(Boolean):[],
          designAlreadyApproved:truthy(args.approved)
        }));
      }
      else if(sub==='policy')print(getDesignDiscoveryPolicy());
      else if(sub==='validate')print(validateDesignDecision(loadFile()));
      else if(sub==='record'){
        const run=await needRun();const decision=loadFile();
        let artifact=null;
        if(!args['no-artifact'])artifact=putArtifact(projectRoot,{kind:'design-decision',content:JSON.stringify(decision,null,2)+'\n',runId:run.run_id,stage:run.state,sourceRevision:gitSha(projectRoot),filename:'design-decision.json'});
        const out=recordDesignDecision(ROOT,projectRoot,run,decision,{artifactRef:artifact?.artifact_id||null});
        if(out.recorded&&artifact){run.artifacts=[...new Set([...(run.artifacts||[]),artifact.artifact_id])];saveRun(projectRoot,run);}
        print({...out,artifact});
        if(!out.recorded)process.exitCode=1;
      }
      else throw new Error(`unknown design subcommand ${sub}`);
    }
    else if(cmd==='plan'){
      const sub=args._[1]||'validate';
      const {validateTaskPlan,computeTaskGraph,computeReadySets,computeCoverage,computeScopeConflicts,findCycles}=await import('./plan-validator.mjs');
      const {putArtifact,saveRun}=await import('./store.mjs');
      const {recordTaskPlan}=await import('./orchestrator.mjs');
      const loadFile=()=>{if(!args.file)throw new Error('--file required');return readJson(path.resolve(args.file));};
      if(sub==='validate'){
        const v=validateTaskPlan(loadFile(),{...(args.profile?{profile:args.profile}:{})});
        print(v);if(!v.valid)process.exitCode=1;
      }
      else if(sub==='graph'){
        const plan=loadFile();
        print({...computeTaskGraph(plan),cycles:findCycles(plan),...computeReadySets(plan),coverage:computeCoverage(plan),conflicts:computeScopeConflicts(plan)});
      }
      else if(sub==='record'){
        const run=await needRun();const plan=loadFile();
        let artifact=null;
        if(!args['no-artifact'])artifact=putArtifact(projectRoot,{kind:'task-plan',content:JSON.stringify(plan,null,2)+'\n',runId:run.run_id,stage:run.state,sourceRevision:gitSha(projectRoot),filename:'task-plan.json'});
        const out=recordTaskPlan(ROOT,projectRoot,run,plan,{artifactRef:artifact?.artifact_id||null});
        if(out.recorded&&artifact){run.artifacts=[...new Set([...(run.artifacts||[]),artifact.artifact_id])];saveRun(projectRoot,run);}
        print({...out,artifact});
        if(!out.recorded)process.exitCode=1;
      }
      else throw new Error(`unknown plan subcommand ${sub}`);
    }
    else if(cmd==='task'){
      const sub=args._[1]||'list';
      const {listTasks,loadTask,loadTaskGraph,listTaskEvents,getTaskContextManifest}=await import('./store.mjs');
      const {refreshReadiness,transitionTask,evaluateTransition,taskProgress,requireTask,getTaskStateMachine}=await import('./task-engine.mjs');
      const {scheduleTasks,readySet,scheduleView}=await import('./task-scheduler.mjs');
      const {buildTaskContext,renderTaskPrompt}=await import('./task-context.mjs');
      const {startTask,advanceTask,captureTaskDiff,taskCheckpoint,recordTaskUsage,resumeFromCheckpoint}=await import('./task-runner.mjs');
      const {verifyTask}=await import('./task-verification.mjs');
      const {validateSpecComplianceReview,validateCodeQualityReview,recordTaskReview}=await import('./task-review.mjs');
      const {classifyTaskFailure,planRecovery,getTaskFailurePolicy,FAILURE_CLASSES}=await import('./task-recovery.mjs');
      const {migrateRunToTaskRuntime}=await import('./task-migration.mjs');
      const {listTaskWorkspaces,checkWriterIsolation,cleanupTaskWorkspace}=await import('./workspace.mjs');
      const {reportTaskUsage,reportRunTaskUsage}=await import('./cost.mjs');
      const {taskMetrics}=await import('./telemetry.mjs');
      const {materializeRunTasks,recordImplementationComplete}=await import('./orchestrator.mjs');
      const loadFile=()=>{if(!args.file)throw new Error('--file required');return readJson(path.resolve(args.file));};
      const needTaskId=()=>{if(!args['task-id'])throw new Error('--task-id required');return args['task-id'];};
      if(sub==='list'){const run=await needRun();print(listTasks(projectRoot,run.run_id).map(t=>({task_id:t.task_id,status:t.status,category:t.category,attempt:t.attempt,depends_on:t.depends_on,writer:t.execution?.primary_writer||null})));}
      else if(sub==='show'){const run=await needRun();print(requireTask(projectRoot,run.run_id,needTaskId()));}
      else if(sub==='graph'){const run=await needRun();print(scheduleView(projectRoot,run.run_id));}
      else if(sub==='events'){const run=await needRun();print(listTaskEvents(projectRoot,run.run_id,args['task-id']||null));}
      else if(sub==='progress'){const run=await needRun();print(taskProgress(projectRoot,run.run_id));}
      else if(sub==='state-machine')print(getTaskStateMachine(ROOT));
      else if(sub==='materialize'){
        const run=await needRun();const plan=loadFile();
        const out=materializeRunTasks(ROOT,projectRoot,run,plan,{planArtifactRef:args['plan-ref']||null,sourceRevision:gitSha(projectRoot)});
        print(out);if(!out.materialized)process.exitCode=1;
      }
      else if(sub==='migrate'){const run=await needRun();print(migrateRunToTaskRuntime(ROOT,projectRoot,run,{dryRun:!!args['dry-run']}));}
      else if(sub==='refresh'){const run=await needRun();print(refreshReadiness(ROOT,projectRoot,run.run_id));}
      else if(sub==='ready'){const run=await needRun();print(readySet(projectRoot,run.run_id,{outerStage:args.stage||run.state,root:ROOT}));}
      else if(sub==='schedule'){
        const run=await needRun();
        const budget=args['remaining-model-calls']?{remaining_model_calls:Number(args['remaining-model-calls'])}:null;
        print(scheduleTasks(ROOT,projectRoot,run,{outerStage:args.stage||run.state,budget,maxParallelOverride:args['max-parallel']||null}));
      }
      else if(sub==='transition'){
        const run=await needRun();const task=requireTask(projectRoot,run.run_id,needTaskId());
        const tasks=listTasks(projectRoot,run.run_id);
        const opts={tasks,reason:args.reason||null,force:truthy(args.force),
          newEvidence:!!args['new-evidence'],recoveryDecision:!!args['recovery-decision'],
          upstreamRefreshed:!!args['upstream-refreshed'],upstreamChange:!!args['upstream-change'],
          blockerResolved:!!args['blocker-resolved'],primaryWriter:args.writer||null,
          failureClass:args['failure-class']||null,invalidationSource:args['invalidation-source']||null};
        if(args['dry-run'])print(evaluateTransition(ROOT,task,args.to,opts));
        else print(transitionTask(ROOT,projectRoot,task,args.to,opts));
      }
      else if(sub==='context'){
        const run=await needRun();const task=requireTask(projectRoot,run.run_id,needTaskId());
        const m=buildTaskContext(ROOT,projectRoot,run,task,{persist:!args['no-persist']});
        print(args.prompt?renderTaskPrompt(ROOT,m):m);
      }
      else if(sub==='context-show'){const run=await needRun();print(getTaskContextManifest(projectRoot,run.run_id,needTaskId()));}
      else if(sub==='start'){const run=await needRun();print(startTask(ROOT,projectRoot,run,needTaskId(),{writer:args.writer||null,model:args.model||null}));}
      else if(sub==='capture'){const run=await needRun();const task=requireTask(projectRoot,run.run_id,needTaskId());print(captureTaskDiff(projectRoot,run,task));}
      else if(sub==='verify'){
        const run=await needRun();const task=requireTask(projectRoot,run.run_id,needTaskId());
        const out=verifyTask(ROOT,projectRoot,run,task,{escalate:!!args.escalate,dryRun:!!args['dry-run']});
        print(out);if(out.evidence.status!=='PASS')process.exitCode=1;
      }
      else if(sub==='review'){
        const run=await needRun();const task=requireTask(projectRoot,run.run_id,needTaskId());
        const kind=args.kind||'spec';const review=loadFile();
        const validation=kind==='spec'?validateSpecComplianceReview(review,task):validateCodeQualityReview(review,task);
        if(args['dry-run'])print(validation);
        else print(recordTaskReview(projectRoot,run,task,review,{kind}));
        if(!validation.valid)process.exitCode=1;
      }
      else if(sub==='advance'){
        const run=await needRun();
        const out=advanceTask(ROOT,projectRoot,run,needTaskId(),{
          specReview:args['spec-review']?readJson(path.resolve(args['spec-review'])):null,
          qualityReview:args['quality-review']?readJson(path.resolve(args['quality-review'])):null,
          escalateVerification:!!args.escalate,
          providerError:args['provider-error']||null,
          permissionDenied:!!args['permission-denied'],
          budgetExhausted:!!args['budget-exhausted'],
          designInvalidated:!!args['design-invalidated'],
          requirementAmbiguity:!!args['requirement-ambiguity'],
          recoveryDecision:!!args['recovery-decision'],
          dryRunVerification:!!args['dry-run-verification']
        });
        print(out);
      }
      else if(sub==='checkpoint'){const run=await needRun();const task=requireTask(projectRoot,run.run_id,needTaskId());print(taskCheckpoint(projectRoot,run,task));}
      else if(sub==='usage-add'){const run=await needRun();const task=requireTask(projectRoot,run.run_id,needTaskId());print(recordTaskUsage(projectRoot,run,task,{provider:args.provider,model:args.model,input_tokens:Number(args.input||0),cached_input_tokens:Number(args.cached||0),output_tokens:Number(args.output||0),reasoning_tokens:Number(args.reasoning||0),wall_ms:Number(args['wall-ms']||0),model_calls:Number(args['model-calls']||0),tool_calls:Number(args['tool-calls']||0),review_calls:Number(args['review-calls']||0),context_tokens:Number(args['context-tokens']||0),provider_fallback:!!args['provider-fallback']}));}
      else if(sub==='usage'){const run=await needRun();print(args['task-id']?reportTaskUsage(projectRoot,run.run_id,args['task-id']):reportRunTaskUsage(projectRoot,run.run_id,listTasks(projectRoot,run.run_id)));}
      else if(sub==='metrics'){const run=await needRun();print(taskMetrics(projectRoot,run.run_id));}
      else if(sub==='workspaces'){const run=await needRun();print({workspaces:listTaskWorkspaces(projectRoot,run.run_id),isolation:checkWriterIsolation(projectRoot,run.run_id)});}
      else if(sub==='workspace-clean'){const run=await needRun();const task=requireTask(projectRoot,run.run_id,needTaskId());print(cleanupTaskWorkspace(projectRoot,{run,task,force:truthy(args.force)}));}
      else if(sub==='failure-policy')print({...getTaskFailurePolicy(ROOT),classes_list:FAILURE_CLASSES});
      else if(sub==='classify'){
        const run=await needRun();const task=requireTask(projectRoot,run.run_id,needTaskId());
        const failure=classifyTaskFailure({
          verification:args.verification?readJson(path.resolve(args.verification)):null,
          specReview:args['spec-review']?readJson(path.resolve(args['spec-review'])):null,
          qualityReview:args['quality-review']?readJson(path.resolve(args['quality-review'])):null,
          providerError:args['provider-error']||null,
          permissionDenied:!!args['permission-denied'],budgetExhausted:!!args['budget-exhausted'],
          designInvalidated:!!args['design-invalidated'],requirementAmbiguity:!!args['requirement-ambiguity']
        });
        print({failure,recovery:planRecovery(ROOT,task,failure,{newEvidence:!!args['new-evidence']})});
      }
      else if(sub==='replay'){
        const run=await needRun();const task=requireTask(projectRoot,run.run_id,needTaskId());
        const events=listTaskEvents(projectRoot,run.run_id,task.task_id);
        const cp=taskCheckpoint(projectRoot,run,task);
        print({schema:'agent-sdlc/task-replay/v1',run_id:run.run_id,task_id:task.task_id,status:task.status,base_revision:task.base_revision,diff_hash:task.diff_hash,checkpoint:cp,events});
      }
      else if(sub==='fallback'||sub==='resume'){
        const run=await needRun();
        print(resumeFromCheckpoint(ROOT,projectRoot,run,needTaskId(),{
          originalProvider:args['from-provider']||args.original||null,
          fallbackProvider:args['to-provider']||args.fallback||null,
          failureClass:args['failure-class']||'PROVIDER_FAILURE',
          reason:args.reason||null
        }));
      }
      else if(sub==='implementation-complete'){
        const run=await needRun();const out=recordImplementationComplete(ROOT,projectRoot,run);
        print(out);if(!out.recorded)process.exitCode=1;
      }
      else throw new Error(`unknown task subcommand ${sub}`);
    }
    else if(cmd==='repo'){
      const sub=args._[1]||'status';
      const {openIntelligence,findSymbol,findReferences,findTestsForSymbol,findTestsForFiles,findModuleBoundary,findDependents,findPublicInterfaces,findDataEntities,findEventContracts,findRecentChanges,getMinimalChangeSurface}=await import('./repo-intelligence.mjs');
      const {buildIndex,loadIndex,indexStale,detectCapability}=await import('./repo-index.mjs');
      const intel=()=>openIntelligence(projectRoot,{refresh:!!args.refresh});
      const paths=()=>args.paths?String(args.paths).split(',').map(s=>s.trim()).filter(Boolean):[];
      if(sub==='index'){const idx=buildIndex(projectRoot,{force:truthy(args.force)});print({schema:idx.schema,revision:idx.revision,capability:idx.capability,counts:idx.counts,built_at:idx.built_at});}
      else if(sub==='status'){const idx=loadIndex(projectRoot,{build:false});print({indexed:!!idx,capability:detectCapability(projectRoot),counts:idx?.counts||null,revision:idx?.revision||null,stale:indexStale(projectRoot,idx)});}
      else if(sub==='capability')print(detectCapability(projectRoot));
      else if(sub==='symbol')print(findSymbol(intel(),args.name||args._[2]));
      else if(sub==='references')print(findReferences(intel(),args.name||args._[2]));
      else if(sub==='tests')print(args.name?findTestsForSymbol(intel(),args.name):findTestsForFiles(intel(),paths()));
      else if(sub==='module')print(findModuleBoundary(intel(),args.path||args._[2]));
      else if(sub==='dependents')print(findDependents(intel(),args.path||args._[2],{maxDepth:Number(args.depth||3)}));
      else if(sub==='interfaces')print(findPublicInterfaces(intel(),paths()));
      else if(sub==='entities')print(findDataEntities(intel(),paths()));
      else if(sub==='events')print(findEventContracts(intel(),paths()));
      else if(sub==='recent')print(findRecentChanges(intel(),paths(),{limit:Number(args.limit||50),since:String(args.since||'30')}));
      else if(sub==='surface')print(getMinimalChangeSurface(intel(),args.objective||args._.slice(2).join(' ')));
      else throw new Error(`unknown repo subcommand ${sub}`);
    }
    else if(cmd==='trace'){
      const sub=args._[1]||'show';
      const {buildTraceabilityGraph,loadTraceabilityGraph,validateTraceabilityGraph,computeTraceCoverage,computeInvalidationClosure,applyInvalidation,invalidationHistory,DELTA_CLASSES,NODE_KINDS,EDGE_KINDS}=await import('./traceability.mjs');
      const need=async()=>{const r=await needRun();const g=loadTraceabilityGraph(projectRoot,r.run_id);if(!g)throw new Error('no traceability graph; run `trace build` first');return g;};
      if(sub==='build'){
        const run=await needRun();
        const design=args.design?[readJson(path.resolve(args.design))].flat():[];
        const release=args.release?readJson(path.resolve(args.release)):null;
        const g=buildTraceabilityGraph(projectRoot,run.run_id,{run,revision:gitSha(projectRoot),designDecisions:design,release});
        print({schema:g.schema,run_id:g.run_id,nodes:g.nodes.length,edges:g.edges.length,validation:validateTraceabilityGraph(g)});
      }
      else if(sub==='show')print(await need());
      else if(sub==='kinds')print({node_kinds:NODE_KINDS,edge_kinds:EDGE_KINDS,delta_classes:DELTA_CLASSES});
      else if(sub==='validate'){const v=validateTraceabilityGraph(await need());print(v);if(!v.valid)process.exitCode=1;}
      else if(sub==='coverage')print(computeTraceCoverage(await need()));
      else if(sub==='closure'){
        if(!args.node)throw new Error('--node required (e.g. ACCEPTANCE_CRITERION:AC-001)');
        print(computeInvalidationClosure(await need(),args.node,args.delta||'BEHAVIOR_CHANGE'));
      }
      else if(sub==='invalidate'){
        if(!args.node)throw new Error('--node required');
        const run=await needRun();const g=await need();
        const closure=computeInvalidationClosure(g,args.node,args.delta||'BEHAVIOR_CHANGE');
        if(args['dry-run'])print(closure);
        else print(applyInvalidation(projectRoot,g,closure,{reason:args.reason||'upstream change'}));
      }
      else if(sub==='history'){const r=await needRun();print(invalidationHistory(projectRoot,r.run_id));}
      else throw new Error(`unknown trace subcommand ${sub}`);
    }
    else if(cmd==='delivery'){
      const sub=args._[1]||'status';
      const {recordDelivery,loadDelivery,baseDrift,checkPushTarget,branchFor,groupTaskBranches,DELIVERY_TARGETS}=await import('./git-delivery.mjs');
      const {loadCiEvidence}=await import('./ci-evidence.mjs');
      const {listTasks}=await import('./store.mjs');
      if(sub==='status'){const r=await needRun();print(loadDelivery(projectRoot,r.run_id)||{status:'NO_DELIVERY_RECORD'});}
      else if(sub==='targets')print({targets:DELIVERY_TARGETS,note:'a prepared PR is PR_READY, never MERGED'});
      else if(sub==='branch'){const r=await needRun();print({branch:branchFor(r.run_id,args['task-id']||null)});}
      else if(sub==='push-check'){const r=await needRun();print(checkPushTarget(args.branch||branchFor(r.run_id),{approvals:(r.approvals||[]).map(a=>a.approval)}));}
      else if(sub==='drift')print(baseDrift(projectRoot,{base:args.base||'main',recordedBaseRevision:args.revision||null}));
      else if(sub==='group'){const r=await needRun();print(groupTaskBranches(listTasks(projectRoot,r.run_id),{allowInterfaceGrouping:truthy(args['allow-interface-grouping'])}));}
      else if(sub==='record'){
        const run=await needRun();
        const out=recordDelivery(projectRoot,run,{
          target:args.target||'PR_READY',branch:args.branch||null,base:args.base||'main',
          recordedBaseRevision:args['base-revision']||null,
          taskBranches:args['task-branches']?String(args['task-branches']).split(',').filter(Boolean):[],
          stacked:args.stacked?readJson(path.resolve(args.stacked)):[],
          ciEvidence:loadCiEvidence(projectRoot,run.run_id),
          mergeCommit:args['merge-commit']||null,
          approvals:(run.approvals||[]).map(a=>a.approval)
        });
        print(out);if(out.status!=='READY')process.exitCode=1;
      }
      else throw new Error(`unknown delivery subcommand ${sub}`);
    }
    else if(cmd==='ci'){
      const sub=args._[1]||'status';
      const {recordCiEvidence,loadCiEvidence,ciEvidenceCurrent,ciEvidenceHistory}=await import('./ci-evidence.mjs');
      if(sub==='record'){
        const run=await needRun();const payload=args.file?readJson(path.resolve(args.file)):{};
        print(recordCiEvidence(projectRoot,run,{
          revision:args.revision||payload.revision||null,
          provider:args.provider||payload.provider||'unknown',
          workflow:args.workflow||payload.workflow||null,
          run_url:args.url||payload.run_url||null,
          checks:payload.checks||[],
          logs:args.logs?fs.readFileSync(path.resolve(args.logs),'utf8'):null
        }));
      }
      else if(sub==='status'){const r=await needRun();const c=ciEvidenceCurrent(projectRoot,r.run_id,{revision:args.revision||null});print(c);if(!c.current)process.exitCode=1;}
      else if(sub==='show'){const r=await needRun();print(loadCiEvidence(projectRoot,r.run_id)||{status:'NO_CI_EVIDENCE'});}
      else if(sub==='history'){const r=await needRun();print(ciEvidenceHistory(projectRoot,r.run_id));}
      else throw new Error(`unknown ci subcommand ${sub}`);
    }
    else if(cmd==='govern'){
      const sub=args._[1]||'report';
      const {governTask,governorReport,getGovernancePolicy,taskComplexity}=await import('./governor.mjs');
      const {requireTask}=await import('./task-engine.mjs');
      if(sub==='policy')print(getGovernancePolicy(ROOT));
      else if(sub==='report'){const r=await needRun();print(governorReport(ROOT,projectRoot,r));}
      else if(sub==='complexity'){const r=await needRun();print(taskComplexity(ROOT,requireTask(projectRoot,r.run_id,args['task-id'])));}
      else if(sub==='task'){
        const run=await needRun();const task=requireTask(projectRoot,run.run_id,args['task-id']);
        print(governTask(ROOT,projectRoot,run,task,{
          contextEstimate:args['context-estimate']?Number(args['context-estimate']):null,
          contextBudget:args['context-budget']?Number(args['context-budget']):null,
          remainingModelCalls:args['remaining-model-calls']!==undefined?Number(args['remaining-model-calls']):null,
          cacheAvailable:!!args['cache-available'],deterministicToolAvailable:args['no-deterministic-tool']?false:true
        }));
      }
      else throw new Error(`unknown govern subcommand ${sub}`);
    }
    else if(cmd==='fallback'){
      const run=await needRun();
      const {resumeFromCheckpoint}=await import('./task-runner.mjs');
      print(resumeFromCheckpoint(ROOT,projectRoot,run,args['task-id'],{
        originalProvider:args.from||null,fallbackProvider:args.to||null,
        failureClass:args['failure-class']||'PROVIDER_FAILURE',reason:args.reason||null
      }));
    }
    else if(cmd==='learn'){
      const sub=args._[1]||'sources';
      const {buildRegressionCandidate,validateRegressionCandidate,toEvalCase,LEARNING_SOURCES}=await import('./learning.mjs');
      if(sub==='sources')print({sources:LEARNING_SOURCES,note:'a candidate is proposed for eval validation; nothing here mutates policy'});
      else if(sub==='candidate'){
        const list=k=>args[k]?String(args[k]).split(',').map(s=>s.trim()).filter(Boolean):[];
        const candidate=buildRegressionCandidate({
          source:args.source,title:args.title,observed:args.observed,expected:args.expected,
          failureClass:args['failure-class']||null,runId:args['run-id']||null,taskId:args['task-id']||null,
          paths:list('paths'),evidence:list('evidence'),diagnostic:args.diagnostic||null,
          policyHypothesis:args['policy-hypothesis']||null,projectRoot
        });
        const validation=validateRegressionCandidate(candidate);
        print({candidate,validation,eval_case:toEvalCase(candidate)});
        if(!validation.valid)process.exitCode=1;
      }
      else throw new Error(`unknown learn subcommand ${sub}`);
    }
    else if(cmd==='doctor'){
      const {capabilities,probe}=await import('./provider.mjs');
      const {resolveConfig}=await import('./config.mjs');
      const {activationStatus}=await import('./activation.mjs');
      const codexBootstrap=await import('./codex-bootstrap.mjs');
      const proj=fs.existsSync(path.join(projectRoot,'.agent-sdlc','project.json'))?'READY':'NOT_INITIALIZED';
      print({
        version:readJson(path.join(ROOT,'agent-sdlc.manifest.json')).version,
        node:process.version,
        project:proj,
        providers:['claude','codex','antigravity'].map(h=>capabilities(h,probe(h))),
        auto_activation:['claude','codex','antigravity'].map(h=>{
          const s=activationStatus({host:h,config:resolveConfig(projectRoot).effective,codexManagedBootstrap:h==='codex'?codexBootstrap.status({}):null});
          return {host:h,enabled:s.enabled,delivery_mode:s.delivery_mode,activation_class:s.activation_class,rough_tokens:s.rough_tokens};
        })
      });
    }
    else {
      print(`agent-sdlc ${readJson(path.join(ROOT,'agent-sdlc.manifest.json')).version}\n\nCommands: init, route, start, status, next, transition, approval, gate, context, normalize, artifact-put/get/list, handoff-put/get/list, tool-check/run, usage-add/report, config-show, compat-check, migrate, parallel-plan, metrics, model-route, provider-probe/command/run, replay-export/validate, activation, design, plan, task, repo, trace, delivery, ci, govern, fallback, learn, doctor\n\nactivation subcommands: status, enable, disable, print-bootstrap, policy, cost, classify, events, record, doctor, codex-bootstrap install|uninstall|status\napproval subcommands: status, grant (interactive, TTY-only), revoke\ngate subcommands: status, explain (--stage <name>)\ndesign subcommands: mode, policy, validate, record\nplan subcommands: validate, graph, record\ntask subcommands: list, show, graph, events, progress, state-machine, materialize, migrate, refresh, ready, schedule, transition, context, context-show, start, capture, verify, review, advance, checkpoint, usage-add, usage, metrics, workspaces, workspace-clean, failure-policy, classify, replay, fallback, resume, implementation-complete\nrepo subcommands: index, status, capability, symbol, references, tests, module, dependents, interfaces, entities, events, recent, surface\ntrace subcommands: build, show, kinds, validate, coverage, closure, invalidate, history\ndelivery subcommands: status, targets, branch, push-check, drift, group, record\nci subcommands: record, status, show, history\ngovern subcommands: policy, report, complexity, task\nlearn subcommands: sources, candidate`);
      process.exit(cmd?2:0);
    }
  }catch(e){
    console.error(JSON.stringify({status:'ERROR',error:e.message},null,2));
    process.exit(1);
  }
}

main();
