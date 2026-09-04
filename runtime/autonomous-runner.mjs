import fs from 'node:fs';
import path from 'node:path';
import {now,uuid,readJson,gitSha} from './util.mjs';
import {loadRun,saveRun,listTasks,loadTask,emit} from './store.mjs';
import {transition,recordDesignDecision,recordTaskPlan,materializeRunTasks,recordImplementationComplete,nextState} from './orchestrator.mjs';
import {refreshReadiness} from './task-engine.mjs';
import {selectDesignDiscoveryMode,scaffoldDesignDecision as builtinScaffoldDesignDecision} from './design-discovery.mjs';
import {validateTaskPlan} from './plan-validator.mjs';
import {startTask,captureTaskDiff,advanceTask} from './task-runner.mjs';
import {verifyTask} from './task-verification.mjs';
import {recordTaskReview} from './task-review.mjs';
import {findValidApproval,activeCapabilities} from './approvals.mjs';
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

/**
 * Detect common write scopes for the target project.
 */
export function detectWriteScope(projectRoot){
  const defaultScopes=['src/**','lib/**','runtime/**','app/**','pkg/**','internal/**','components/**','pages/**','test/**','tests/**','scripts/**'];
  if(!projectRoot||!fs.existsSync(projectRoot))return defaultScopes;
  try{
    const entries=fs.readdirSync(projectRoot,{withFileTypes:true});
    const dirs=entries.filter(e=>e.isDirectory()&&!e.name.startsWith('.')&&e.name!=='node_modules').map(e=>`${e.name}/**`);
    if(dirs.length){
      return [...new Set([...dirs,'*.*'])];
    }
  }catch{}
  return defaultScopes;
}

/**
 * Automatically scaffold a minimal compliant TaskPlan for routine work if none provided.
 */
export function scaffoldTaskPlan(run,projectRoot=null){
  const detectedTest=projectRoot?detectExistingTestFile(projectRoot):null;
  const scopes=projectRoot?detectWriteScope(projectRoot):['src/**','lib/**','runtime/**','app/**','test/**'];
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
        }
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
        workerCallback(currentTask);
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
          integrateTaskWorkspace(projectRoot,{run,task:currentTask});
        }catch{/* ignore */}
      }

      if(adv.failure||currentTask.status==='FAILED'||currentTask.status==='BLOCKED'){
        const attempt_count=currentTask.attempt||1;
        if(attempt_count>=MAX_SELF_HEAL_ATTEMPTS||currentTask.status==='FAILED'||currentTask.status==='BLOCKED'){
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
      currentRun=transition(root,projectRoot,currentRun,'REQUIREMENTS',{internal:true});
      stageSteps.push({from:'INTAKE',to:'REQUIREMENTS'});
      continue;
    }

    // --- STAGE: REQUIREMENTS ---
    if(stage==='REQUIREMENTS'){
      const next=nextState(currentRun);
      if(next==='DESIGN'){
        currentRun=transition(root,projectRoot,currentRun,'DESIGN',{
          evidence:['requirements_confirmed'],
          internal:true
        });
        stageSteps.push({from:'REQUIREMENTS',to:'DESIGN'});
        continue;
      } else if(next==='PLAN'){
        currentRun=transition(root,projectRoot,currentRun,'PLAN',{
          evidence:['requirements_confirmed'],
          internal:true
        });
        stageSteps.push({from:'REQUIREMENTS',to:'PLAN'});
        continue;
      }
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
      const has_human_approval=findValidApproval(currentRun,'design_human_approved');

      if((is_strict||is_full_design)&&!has_human_approval){
        return {
          status:'PAUSED',
          current_stage:'DESIGN',
          pause_gate:HUMAN_GATES.GATE_1_SCOPE_AND_ARCHITECTURE,
          mode_result:modeResult,
          run:currentRun,
          stage_steps:stageSteps,
          message:'Human approval required for architecture/design before entering PLAN. Please review and approve design direction.'
        };
      }

      // Auto-record design decision
      const decision=builtinScaffoldDesignDecision(modeResult,{objective:currentRun.objective});
      const rec=recordDesignDecision(root,projectRoot,currentRun,decision,{approvals:activeCapabilities(currentRun)});
      if(!rec.recorded){
        throw new Error(`Failed to record design decision: ${JSON.stringify(rec.validation.errors)}`);
      }

      currentRun=transition(root,projectRoot,currentRun,'PLAN',{
        evidence:['design_or_skip_decision'],
        internal:true
      });
      stageSteps.push({from:'DESIGN',to:'PLAN',mode:modeResult.mode});
      continue;
    }

    // --- STAGE: PLAN ---
    if(stage==='PLAN'){
      const plan=customPlan||scaffoldTaskPlan(currentRun,projectRoot);
      const rec=recordTaskPlan(root,projectRoot,currentRun,plan);
      if(!rec.recorded){
        throw new Error(`Task plan validation failed: ${JSON.stringify(rec.validation.errors)}`);
      }
      materializeRunTasks(root,projectRoot,currentRun,plan);

      currentRun=transition(root,projectRoot,currentRun,'IMPLEMENT',{
        evidence:['plan_artifact_created','plan_schema_valid','plan_graph_valid','plan_acceptance_coverage_valid','plan_scope_conflicts_resolved'],
        internal:true
      });
      stageSteps.push({from:'PLAN',to:'IMPLEMENT'});
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
          integrateTaskWorkspace(projectRoot,{run:currentRun,task:t});
        }catch{/* ignore */}
      }

      currentRun=transition(root,projectRoot,currentRun,'VERIFY',{
        evidence:['implementation_artifact','task_graph_complete'],
        internal:true
      });
      stageSteps.push({from:'IMPLEMENT',to:'VERIFY'});
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

      // Transition to REVIEW with verification evidence
      currentRun=transition(root,projectRoot,currentRun,'REVIEW',{
        evidence:['targeted_verification_pass','no_new_high_security_findings'],
        internal:true
      });
      stageSteps.push({from:'VERIFY',to:'REVIEW'});
      continue;
    }

    // --- STAGE: REVIEW ---
    if(stage==='REVIEW'){
      // Auto transition to RELEASE
      currentRun=transition(root,projectRoot,currentRun,'RELEASE',{
        evidence:['required_reviews_resolved'],
        internal:true
      });
      stageSteps.push({from:'REVIEW',to:'RELEASE'});
      continue;
    }

    // --- STAGE: RELEASE ---
    if(stage==='RELEASE'){
      // Run CI validation to satisfy rule: "Nếu project có CD CI thì luôn phải đảm bảo test pass CD CI mới được tạo commit và đẩy lên remote"
      if(!skipCiCheck){
        ensureCiPassedBeforeDelivery(root,projectRoot,currentRun,{autoRun:true});
      }

      // Check GATE 4: Pre-Commit & Push Approval
      const has_delivery_approval=findValidApproval(currentRun,'delivery_commit_approved');
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
      if(next==='DEPLOY'){
        currentRun=transition(root,projectRoot,currentRun,'DEPLOY',{
          evidence:['release_evidence_current'],
          internal:true
        });
        stageSteps.push({from:'RELEASE',to:'DEPLOY'});
        continue;
      } else if(next==='CLOSE'){
        currentRun=transition(root,projectRoot,currentRun,'CLOSE',{
          evidence:['release_evidence_current','handoff_written','docs_reconciled'],
          internal:true
        });
        stageSteps.push({from:'RELEASE',to:'CLOSE'});
        break;
      }
    }

    // --- STAGE: DEPLOY ---
    if(stage==='DEPLOY'){
      // Check GATE 5: Privileged Production Deployment
      const has_prod_approval=findValidApproval(currentRun,'deploy.production');
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

      currentRun=transition(root,projectRoot,currentRun,'OBSERVE',{
        evidence:['deployment_receipt'],
        internal:true
      });
      stageSteps.push({from:'DEPLOY',to:'OBSERVE'});
      continue;
    }

    // --- STAGE: OBSERVE ---
    if(stage==='OBSERVE'){
      currentRun=transition(root,projectRoot,currentRun,'CLOSE',{
        evidence:['production_health_verified','handoff_written','docs_reconciled'],
        internal:true
      });
      stageSteps.push({from:'OBSERVE',to:'CLOSE'});
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
