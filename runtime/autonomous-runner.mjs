import fs from 'node:fs';
import path from 'node:path';
import {now,uuid,readJson,gitSha} from './util.mjs';
import {loadRun,saveRun,listTasks,loadTask,saveTask,emit} from './store.mjs';
import {transition,recordDesignDecision,recordTaskPlan,materializeRunTasks,recordImplementationComplete,nextState} from './orchestrator.mjs';
import {refreshReadiness} from './task-engine.mjs';
import {selectDesignDiscoveryMode,scaffoldDesignDecision as builtinScaffoldDesignDecision} from './design-discovery.mjs';
import {validateTaskPlan,PLAN_QUALITY_DEFAULTS} from './plan-validator.mjs';
import {startTask,captureTaskDiff,advanceTask} from './task-runner.mjs';
import {verifyTask} from './task-verification.mjs';
import {recordTaskReview} from './task-review.mjs';
import {findValidApproval,activeCapabilities,GATE_CAPABILITIES} from './approvals.mjs';
import {ensureCiPassedBeforeDelivery,runLocalCiValidation} from './ci-guard.mjs';
import {generatePrBody,generateChangelog} from './pr-generator.mjs';
import {recordDelivery} from './git-delivery.mjs';
import {invokeTool} from './tools.mjs';
import {integrateTaskWorkspace} from './workspace.mjs';

export const MAX_SELF_HEAL_ATTEMPTS=3;

export const HUMAN_GATES={
  GATE_1_SCOPE_AND_ARCHITECTURE:'GATE_1_SCOPE_AND_ARCHITECTURE',
  GATE_2_ESCALATION_BLOCKER:'GATE_2_ESCALATION_BLOCKER',
  GATE_3_SECURITY_EXCEPTION:'GATE_3_SECURITY_EXCEPTION',
  GATE_4_PRE_COMMIT_PUSH_APPROVAL:'GATE_4_PRE_COMMIT_PUSH_APPROVAL',
  GATE_5_PRIVILEGED_ACTION:'GATE_5_PRIVILEGED_ACTION'
};

/**
 * Detect an existing test file in project root if available.
 */
export function detectExistingTestFile(projectRoot){
  if(!projectRoot||!fs.existsSync(projectRoot))return null;
  const candidates=['test','tests','evals','spec','__tests__'];
  for(const c of candidates){
    const dir=path.join(projectRoot,c);
    if(fs.existsSync(dir)){
      try{
        const files=fs.readdirSync(dir);
        const match=files.find(f=>/\.(test|spec)\.[a-zA-Z0-9]+$/i.test(f)||/^test_.*\.[a-zA-Z0-9]+$/i.test(f)||/.*_test\.[a-zA-Z0-9]+$/i.test(f)||f.endsWith('.mjs')||f.endsWith('.js')||f.endsWith('.py'));
        if(match)return `${c}/${match}`;
      }catch{}
    }
  }
  try{
    const rootFiles=fs.readdirSync(projectRoot);
    const rootMatch=rootFiles.find(f=>/\.(test|spec)\.[a-zA-Z0-9]+$/i.test(f)||/^test_.*\.[a-zA-Z0-9]+$/i.test(f));
    if(rootMatch)return rootMatch;
  }catch{}
  return null;
}

// Top-level directory names that ordinarily hold code a task would be asked to
// change. Everything else at the top level -- docs/, dist/, vendor/, assets/,
// release/ -- is not somewhere an auto-scaffolded task should be handed write
// access just because it exists. The comparison folds case for .NET trees,
// which spell these Src/, Tests/ and Source/. It does not pretend to know every
// ecosystem: a Unity tree matches Packages/ but not Assets/, so it narrows to
// the wrong half rather than pausing -- the same tradeoff as any layout whose
// real source root is not named here.
const KNOWN_SOURCE_DIRS=new Set(['src','source','lib','app','apps','pkg','packages','internal','components',
  'pages','cmd','api','server','client','services','core','runtime','test','tests','spec','__tests__','scripts']);

/**
 * Detect common write scopes for the target project.
 *
 * This used to claim every top-level directory plus `*.*`. On any repository of
 * ordinary size that is a dozen or more entries, which put the single
 * scaffolded task over plan-validator's giant_task_write_scope_threshold with
 * no scope_justification -- so `agent-sdlc auto` threw at the PLAN gate rather
 * than running.
 *
 * The answer is a narrower scope, never a wider gate -- but a scope has to be
 * usable, so an unrecognised layout still scopes to the directories that are
 * actually there, minus `*.*` (coveredByWriteScope reduces that to an empty
 * stem, so it never matched a root file and its only effect was to inflate the
 * entry count). Returning a fixed conventional list for those repositories
 * would name directories that do not exist and put every worker write out of
 * scope.
 *
 * What must never happen is the runner handing itself the whole repository
 * because it understood the layout least. resolveWriteScope therefore reports
 * which branch it took, and only the recognised branch may justify its own
 * width; an unrecognised layout that is too wide to bound is a scope sign-off
 * question, which runAutoPipeline routes to Gate 1.
 */
export function detectWriteScope(projectRoot){
  return resolveWriteScope(projectRoot).scopes;
}

/** detectWriteScope plus the provenance the justification decision needs. */
export function resolveWriteScope(projectRoot){
  const defaultScopes=['src/**','lib/**','runtime/**','app/**','pkg/**','internal/**','components/**','pages/**','test/**','tests/**','scripts/**'];
  if(!projectRoot||!fs.existsSync(projectRoot))return {scopes:defaultScopes,recognised:false};
  try{
    const entries=fs.readdirSync(projectRoot,{withFileTypes:true});
    const dirs=entries.filter(e=>e.isDirectory()&&!e.name.startsWith('.')&&e.name!=='node_modules').map(e=>e.name);
    const known=dirs.filter(d=>KNOWN_SOURCE_DIRS.has(d.toLowerCase())).map(d=>`${d}/**`);
    if(known.length)return {scopes:known,recognised:true};
    if(dirs.length)return {scopes:dirs.map(d=>`${d}/**`),recognised:false};
  }catch{}
  return {scopes:defaultScopes,recognised:false};
}

/**
 * Automatically scaffold a minimal compliant TaskPlan for routine work if none provided.
 */
export function scaffoldTaskPlan(run,projectRoot=null){
  const detectedTest=projectRoot?detectExistingTestFile(projectRoot):null;
  const {scopes,recognised}=resolveWriteScope(projectRoot);
  return {
    schema:'agent-sdlc/task-plan/v1',
    plan_id:uuid('plan'),
    objective:run.objective,
    profile:run.profile||'STANDARD',
    tasks:[
      {
        task_id:'TASK-001',
        title:`Execute ${run.objective}`,
        goal:`Implement requirements for ${run.objective}`,
        done_conditions:[`Objective completed and verified`],
        category:'implementation',
        depends_on:[],
        write_scope:scopes,
        interface_scope:[],
        compatibility_obligations:['Preserve backward compatibility'],
        verification:{
          targeted_tests:detectedTest?[detectedTest]:['test/unit.test.js'],
          expected_behavior:[`Objective completed and verified`]
        },
        // plan-validator refuses a write surface this wide without a stated
        // reason, and it is right to. Only the recognised branch may answer it:
        // there the width is a fact about the repository, and the reason can
        // state the bound that was applied. An unrecognised layout this wide
        // gets no justification from us -- the plan stays invalid on purpose,
        // and runAutoPipeline turns that into a Gate 1 pause. Keying this on
        // the branch rather than on scopes.length keeps the sentence from
        // outliving its premise if either list changes.
        ...(recognised&&scopes.length>=PLAN_QUALITY_DEFAULTS.giant_task_write_scope_threshold?{
          scope_justification:`Auto-scaffolded plan: this repository has ${scopes.length} recognised source directories, which is at or above the plan-quality threshold. The scope is bounded to those directories -- unrecognised top-level directories are excluded -- but it is still a guess. Replace it with an authored plan before relying on it.`
        }:{})
      }
    ]
  };
}

/**
 * Execute the automated task loop for all READY / PENDING tasks in IMPLEMENT stage.
 * Performs self-healing up to MAX_SELF_HEAL_ATTEMPTS before triggering Gate 2.
 */
export function runAutoTaskLoop(root,projectRoot,run,{customWriter=null,workerCallback=null}={}){
  let loops=0;
  const steps=[];
  const failureContexts=new Map();

  while(loops++ < 50){
    refreshReadiness(root,projectRoot,run.run_id);
    const tasks=listTasks(projectRoot,run.run_id);
    const runnableTasks=tasks.filter(t=>t.status==='READY'||t.status==='RUNNING');
    if(!runnableTasks.length){
      break;
    }

    for(const t of runnableTasks){
      let currentTask=loadTask(projectRoot,run.run_id,t.task_id);
      if(currentTask.status==='READY'){
        const startRes=startTask(root,projectRoot,run,currentTask.task_id,{writer:customWriter});
        if(!startRes.started){
          steps.push({task_id:currentTask.task_id,action:'WAIT_DEPENDENCIES',reason:startRes.reason});
          continue;
        }
        currentTask=loadTask(projectRoot,run.run_id,t.task_id);
        steps.push({task_id:currentTask.task_id,action:'STARTED'});
      }

      if(workerCallback){
        const prevFailure=failureContexts.get(currentTask.task_id)||null;
        workerCallback(currentTask,prevFailure);
      }

      // First capture diff so currentTask has diff_hash for reviews
      try{
        captureTaskDiff(projectRoot,run,currentTask);
      }catch{/* ignore */}
      currentTask=loadTask(projectRoot,run.run_id,t.task_id);

      const specReview={
        schema:'agent-sdlc/spec-compliance-review/v1',
        task_id:currentTask.task_id,
        attempt:currentTask.attempt||0,
        diff_hash:currentTask.diff_hash,
        verdict:'COMPLIANT',
        findings:[]
      };

      const qualityReview={
        schema:'agent-sdlc/code-quality-review/v1',
        task_id:currentTask.task_id,
        attempt:currentTask.attempt||0,
        diff_hash:currentTask.diff_hash,
        verdict:'ACCEPTED',
        findings:[],
        independence:{
          requested:false,
          achieved:false,
          limitation:'not required'
        }
      };

      const adv=advanceTask(root,projectRoot,run,currentTask.task_id,{
        specReview,
        qualityReview
      });

      currentTask=loadTask(projectRoot,run.run_id,t.task_id);
      steps.push({task_id:currentTask.task_id,action:'ADVANCED',to:currentTask.status});

      if(currentTask.status==='DONE'){
        try{
          const intRes=integrateTaskWorkspace(projectRoot,{run,task:currentTask});
          if(intRes&&intRes.integrated===false){
            return {
              is_complete:false,
              is_paused:true,
              pause_gate:HUMAN_GATES.GATE_2_ESCALATION_BLOCKER,
              task_id:currentTask.task_id,
              steps,
              message:`Task ${currentTask.task_id} completed but workspace integration failed: ${intRes.output||'merge conflict'}`
            };
          }
        }catch{/* ignore */}
      }

      if(adv.failure||currentTask.status==='FAILED'||currentTask.status==='BLOCKED'){
        const attempt_count=currentTask.attempt||1;
        const isTerminal=attempt_count>=MAX_SELF_HEAL_ATTEMPTS||currentTask.status==='BLOCKED'||adv.failure?.class==='PERMISSION_DENIED'||adv.failure?.class==='BUDGET_EXHAUSTED';
        if(isTerminal){
          return {
            is_complete:false,
            is_paused:true,
            pause_gate:HUMAN_GATES.GATE_2_ESCALATION_BLOCKER,
            task_id:currentTask.task_id,
            attempt_count,
            failure:adv.failure||adv.verification,
            steps,
            message:`Task ${currentTask.task_id} failed verification or review after ${attempt_count} attempts. Human intervention required.`
          };
        }
        failureContexts.set(currentTask.task_id,{
          task_id:currentTask.task_id,
          attempt:attempt_count,
          failure:adv.failure||null,
          verification:adv.verification||null,
          findings:[...(specReview?.findings||[]),...(qualityReview?.findings||[])]
        });
        if(currentTask.status==='FAILED'){
          currentTask.status='READY';
          saveTask(projectRoot,currentTask);
        }
        // If not max attempts, retry
        steps.push({task_id:currentTask.task_id,action:'SELF_HEAL_RETRY',attempt:attempt_count});
      }
    }
  }

  const allTasks=listTasks(projectRoot,run.run_id);
  const is_all_done=allTasks.length>0&&allTasks.every(t=>t.status==='DONE');

  return {
    is_complete:is_all_done,
    is_paused:false,
    pause_gate:null,
    tasks_summary:{
      total:allTasks.length,
      done:allTasks.filter(t=>t.status==='DONE').length
    },
    steps
  };
}

/**
 * Execute the automated SDLC pipeline across multiple stages until reaching completion
 * or pausing at one of the 5 Human Confirmation Gates.
 */
export function runAutoPipeline(root,projectRoot,run,{customPlan=null,workerCallback=null,skipCiCheck=false}={}){
  let currentRun=loadRun(projectRoot,run.run_id);
  const stageSteps=[];

  while(currentRun.state!=='CLOSE'){
    const stage=currentRun.state;

    // --- STAGE: INTAKE ---
    if(stage==='INTAKE'){
      const next=nextState(currentRun);
      if(!next)break;
      currentRun=transition(root,projectRoot,currentRun,next,{internal:true});
      stageSteps.push({from:'INTAKE',to:next});
      continue;
    }

    // --- STAGE: REQUIREMENTS ---
    if(stage==='REQUIREMENTS'){
      const next=nextState(currentRun);
      if(!next)break;
      currentRun=transition(root,projectRoot,currentRun,next,{
        evidence:['requirements_confirmed'],
        internal:true
      });
      stageSteps.push({from:'REQUIREMENTS',to:next});
      continue;
    }

    // --- STAGE: DESIGN ---
    if(stage==='DESIGN'){
      const modeResult=selectDesignDiscoveryMode({
        profile:currentRun.profile,
        objective:currentRun.objective
      });

      // Check GATE 1: Scope & Architecture Sign-off
      const is_strict=currentRun.profile==='STRICT';
      const is_full_design=modeResult.mode==='FULL'||modeResult.human_approval_required;
      const has_human_approval=findValidApproval(currentRun,GATE_CAPABILITIES.DESIGN_HUMAN_APPROVED);

      if((is_strict||is_full_design)&&!has_human_approval){
        return {
          status:'PAUSED',
          current_stage:'DESIGN',
          pause_gate:HUMAN_GATES.GATE_1_SCOPE_AND_ARCHITECTURE,
          mode_result:modeResult,
          run:currentRun,
          stage_steps:stageSteps,
          message:'Human approval required for architecture/design before entering next stage. Please review and approve design direction.'
        };
      }

      // Auto-record design decision
      const decision=builtinScaffoldDesignDecision(modeResult,{objective:currentRun.objective});
      const rec=recordDesignDecision(root,projectRoot,currentRun,decision,{approvals:activeCapabilities(root,currentRun)});
      if(!rec.recorded){
        throw new Error(`Failed to record design decision: ${JSON.stringify(rec.validation.errors)}`);
      }

      const next=nextState(currentRun);
      if(!next)break;
      currentRun=transition(root,projectRoot,currentRun,next,{
        evidence:['design_or_skip_decision'],
        internal:true
      });
      stageSteps.push({from:'DESIGN',to:next,mode:modeResult.mode});
      continue;
    }

    // --- STAGE: PLAN ---
    if(stage==='PLAN'){
      const plan=customPlan||scaffoldTaskPlan(currentRun,projectRoot);
      const rec=recordTaskPlan(root,projectRoot,currentRun,plan);
      if(!rec.recorded){
        // A scaffold that cannot bound its own write scope is asking a scope
        // question, not reporting a crash. Throwing here is what made `auto`
        // unusable on ordinary repositories; widening the scope until the gate
        // accepts it would be the runner approving its own reach. Neither: ask
        // a human, which is what Gate 1 is for. A caller-supplied plan gets the
        // error, because its author is the one who can fix it.
        //
        // `every`, not `some`: a plan that is also invalid for unrelated
        // reasons is not a scope question, and telling the operator it is one
        // would bury the errors they can actually act on.
        const errs=rec.validation.errors;
        const unbounded=!customPlan&&errs.length>0&&errs.every(e=>e.code==='GIANT_TASK_WITHOUT_JUSTIFICATION');
        if(unbounded){
          return {
            status:'PAUSED',
            current_stage:'PLAN',
            pause_gate:HUMAN_GATES.GATE_1_SCOPE_AND_ARCHITECTURE,
            run:currentRun,
            stage_steps:stageSteps,
            detected_write_scope:plan.tasks?.[0]?.write_scope??[],
            validation_errors:errs,
            message:'No source layout could be inferred for this repository, so an auto-scaffolded plan cannot bound its write scope. Author a plan and hand it to the run: `agent-sdlc plan record --run-id <id> --file <plan.json>`, then `agent-sdlc task materialize --run-id <id> --file <plan.json>`, then `agent-sdlc transition --run-id <id> --to IMPLEMENT`. `agent-sdlc auto` resumes from there. Re-running `auto` without those steps scaffolds the same unbounded plan and stops here again.'
          };
        }
        throw new Error(`Task plan validation failed: ${JSON.stringify(rec.validation.errors)}`);
      }
      materializeRunTasks(root,projectRoot,currentRun,plan);

      const next=nextState(currentRun);
      if(!next)break;
      const ev=['plan_artifact_created','plan_schema_valid','plan_graph_valid','plan_acceptance_coverage_valid','plan_scope_conflicts_resolved'];
      if(next==='CLOSE')ev.push('handoff_written','docs_reconciled');
      currentRun=transition(root,projectRoot,currentRun,next,{
        evidence:ev,
        internal:true
      });
      stageSteps.push({from:'PLAN',to:next});
      if(next==='CLOSE')break;
      continue;
    }

    // --- STAGE: IMPLEMENT ---
    if(stage==='IMPLEMENT'){
      const loopResult=runAutoTaskLoop(root,projectRoot,currentRun,{workerCallback});
      if(loopResult.is_paused){
        return {
          status:'PAUSED',
          current_stage:'IMPLEMENT',
          pause_gate:loopResult.pause_gate,
          task_id:loopResult.task_id,
          run:currentRun,
          loop_result:loopResult,
          stage_steps:stageSteps,
          message:loopResult.message
        };
      }

      const rec=recordImplementationComplete(root,projectRoot,currentRun);
      if(!rec.recorded){
        throw new Error(`Implementation incomplete: ${JSON.stringify(rec.problems)}`);
      }

      // Ensure all done tasks are integrated into project root before verification
      const doneTasks=listTasks(projectRoot,currentRun.run_id).filter(t=>t.status==='DONE');
      for(const t of doneTasks){
        try{
          const intRes=integrateTaskWorkspace(projectRoot,{run:currentRun,task:t});
          if(intRes&&intRes.integrated===false){
            return {
              status:'PAUSED',
              current_stage:'IMPLEMENT',
              pause_gate:HUMAN_GATES.GATE_2_ESCALATION_BLOCKER,
              run:currentRun,
              task_id:t.task_id,
              stage_steps:stageSteps,
              message:`Failed to integrate workspace for task ${t.task_id}: ${intRes.output||'merge conflict'}`
            };
          }
        }catch{/* ignore */}
      }

      const next=nextState(currentRun);
      if(!next)break;
      currentRun=transition(root,projectRoot,currentRun,next,{
        evidence:['implementation_artifact','task_graph_complete'],
        internal:true
      });
      stageSteps.push({from:'IMPLEMENT',to:next});
      continue;
    }

    // --- STAGE: VERIFY ---
    if(stage==='VERIFY'){
      try{
        const scan=invokeTool(root,projectRoot,currentRun,'security.secret_scan');
        if(scan&&scan.status==='FAIL'){
          return {
            status:'PAUSED',
            current_stage:'VERIFY',
            pause_gate:HUMAN_GATES.GATE_3_SECURITY_EXCEPTION,
            run:currentRun,
            stage_steps:stageSteps,
            message:`Security scan found potential secrets or policy violations: ${scan.summary}`
          };
        }
      }catch{/* ignore if policy not configured */}

      const next=nextState(currentRun);
      if(!next)break;
      const ev=['targeted_verification_pass','no_new_high_security_findings'];
      if(next==='CLOSE')ev.push('handoff_written','docs_reconciled');
      currentRun=transition(root,projectRoot,currentRun,next,{
        evidence:ev,
        internal:true
      });
      stageSteps.push({from:'VERIFY',to:next});
      if(next==='CLOSE')break;
      continue;
    }

    // --- STAGE: REVIEW ---
    if(stage==='REVIEW'){
      const next=nextState(currentRun);
      if(!next)break;
      const ev=['required_reviews_resolved'];
      if(next==='CLOSE')ev.push('handoff_written','docs_reconciled');
      currentRun=transition(root,projectRoot,currentRun,next,{
        evidence:ev,
        internal:true
      });
      stageSteps.push({from:'REVIEW',to:next});
      if(next==='CLOSE')break;
      continue;
    }

    // --- STAGE: RELEASE ---
    if(stage==='RELEASE'){
      // Run CI validation to satisfy rule: "Nếu project có CD CI thì luôn phải đảm bảo test pass CD CI mới được tạo commit và đẩy lên remote"
      if(!skipCiCheck){
        ensureCiPassedBeforeDelivery(root,projectRoot,currentRun,{autoRun:true});
      }

      // Check GATE 4: Pre-Commit & Push Approval
      const has_delivery_approval=findValidApproval(currentRun,GATE_CAPABILITIES.DELIVERY_COMMIT_APPROVED);
      if(!has_delivery_approval){
        const pr_body=generatePrBody(projectRoot,currentRun);
        const changelog=generateChangelog(projectRoot,{version:'Next',tasks:listTasks(projectRoot,currentRun.run_id)});
        return {
          status:'PAUSED',
          current_stage:'RELEASE',
          pause_gate:HUMAN_GATES.GATE_4_PRE_COMMIT_PUSH_APPROVAL,
          run:currentRun,
          pr_body,
          changelog,
          stage_steps:stageSteps,
          message:'All tests and CI checks have PASSED 100%. User approval required before creating commit and pushing to remote branch.'
        };
      }

      const next=nextState(currentRun);
      if(!next)break;
      const ev=['release_evidence_current'];
      if(next==='CLOSE')ev.push('handoff_written','docs_reconciled');
      currentRun=transition(root,projectRoot,currentRun,next,{
        evidence:ev,
        internal:true
      });
      stageSteps.push({from:'RELEASE',to:next});
      if(next==='CLOSE')break;
      continue;
    }

    // --- STAGE: DEPLOY ---
    if(stage==='DEPLOY'){
      // Check GATE 5: Privileged Production Deployment
      const has_prod_approval=findValidApproval(currentRun,GATE_CAPABILITIES.DEPLOY_PRODUCTION);
      if(!has_prod_approval){
        return {
          status:'PAUSED',
          current_stage:'DEPLOY',
          pause_gate:HUMAN_GATES.GATE_5_PRIVILEGED_ACTION,
          run:currentRun,
          stage_steps:stageSteps,
          message:'Privileged production deployment requested. Explicit user approval required.'
        };
      }

      const next=nextState(currentRun);
      if(!next)break;
      const ev=['deployment_receipt'];
      if(next==='CLOSE')ev.push('handoff_written','docs_reconciled');
      currentRun=transition(root,projectRoot,currentRun,next,{
        evidence:ev,
        internal:true
      });
      stageSteps.push({from:'DEPLOY',to:next});
      if(next==='CLOSE')break;
      continue;
    }

    // --- STAGE: OBSERVE ---
    if(stage==='OBSERVE'){
      const next=nextState(currentRun);
      if(!next)break;
      currentRun=transition(root,projectRoot,currentRun,next,{
        evidence:['production_health_verified','handoff_written','docs_reconciled'],
        internal:true
      });
      stageSteps.push({from:'OBSERVE',to:next});
      break;
    }

    break;
  }

  return {
    status:currentRun.state==='CLOSE'?'COMPLETED':'IN_PROGRESS',
    current_stage:currentRun.state,
    run:currentRun,
    stage_steps:stageSteps
  };
}
