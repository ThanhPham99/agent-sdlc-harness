// The task engine.
//
// Handlers are data: each takes the CLI context and prints its own result.
// Extracting them from the dispatcher is what makes them reachable from a test
// without spawning a process. Everything heavy is still imported inside the
// handler that needs it, so a single command loads only its own dependencies.
import path from 'node:path';
import {readJson,gitSha,truthy} from '../util.mjs';

export const commands={
  task:async ctx=>{
    const {args,ROOT,projectRoot,print,needRun}=ctx;
    const sub=args._[1]||'list';
    const {listTasks,loadTask,loadTaskGraph,listTaskEvents,getTaskContextManifest}=await import('../store.mjs');
    const {refreshReadiness,transitionTask,evaluateTransition,taskProgress,requireTask,getTaskStateMachine}=await import('../task-engine.mjs');
    const {scheduleTasks,readySet,scheduleView}=await import('../task-scheduler.mjs');
    const {buildTaskContext,renderTaskPrompt}=await import('../task-context.mjs');
    const {startTask,advanceTask,captureTaskDiff,taskCheckpoint,recordTaskUsage,resumeFromCheckpoint}=await import('../task-runner.mjs');
    const {verifyTask}=await import('../task-verification.mjs');
    const {validateSpecComplianceReview,validateCodeQualityReview,recordTaskReview}=await import('../task-review.mjs');
    const {classifyTaskFailure,planRecovery,getTaskFailurePolicy,FAILURE_CLASSES}=await import('../task-recovery.mjs');
    const {migrateRunToTaskRuntime}=await import('../task-migration.mjs');
    const {listTaskWorkspaces,checkWriterIsolation,cleanupTaskWorkspace}=await import('../workspace.mjs');
    const {reportTaskUsage,reportRunTaskUsage}=await import('../cost.mjs');
    const {taskMetrics}=await import('../telemetry.mjs');
    const {materializeRunTasks,recordImplementationComplete}=await import('../orchestrator.mjs');
    const loadFile=()=>{if(!args.file)throw new Error('--file required');return readJson(path.resolve(args.file));};
    const needTaskId=()=>{if(!args['task-id'])throw new Error('--task-id required');return args['task-id'];};
    if(sub==='list'){const run=await needRun();print(listTasks(projectRoot,run.run_id).map(t=>({task_id:t.task_id,status:t.status,category:t.category,attempt:t.attempt,depends_on:t.depends_on,writer:t.execution?.primary_writer||null})));}
    else if(sub==='show'){const run=await needRun();print(requireTask(projectRoot,run.run_id,needTaskId()));}
    else if(sub==='graph'){
      const run=await needRun();
      if(args.mermaid){
        const tasks=listTasks(projectRoot,run.run_id);
        const lines=['graph TD'];
        for(const t of tasks){
          const safeId=t.task_id.replace(/[^a-zA-Z0-9_]/g,'_');
          lines.push(`  ${safeId}["${t.task_id} [${t.category}]<br/>${t.status}"]`);
          for(const dep of (t.depends_on||[])){
            lines.push(`  ${dep.replace(/[^a-zA-Z0-9_]/g,'_')} --> ${safeId}`);
          }
        }
        print(lines.join('\n'));
      } else {
        print(scheduleView(projectRoot,run.run_id));
      }
    }
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
};
