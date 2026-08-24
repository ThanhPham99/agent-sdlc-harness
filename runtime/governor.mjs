// Cost and context governor.
//
// Turns per-task telemetry into explainable execution decisions: run a
// deterministic tool instead of a model, pick a model tier, compact context,
// avoid fan-out, escalate reasoning after repeated failures, or stop and ask.
//
// The one thing it may never do is trade a mandatory security or review
// requirement for cost. Risk raises a floor; budget never lowers one. Every
// decision carries the inputs and reasons that produced it, so an operator can
// argue with it.
import path from 'node:path';
import {now,readJson} from './util.mjs';
import {reportRunTaskUsage} from './cost.mjs';
import {listTasks} from './store.mjs';

const arr=x=>Array.isArray(x)?x:[];
const TIERS=['ECONOMY','STANDARD','HIGH_REASONING'];
const raise=(a,b)=>{
  if(!a)return b;if(!b)return a;
  return TIERS.indexOf(a)>=TIERS.indexOf(b)?a:b;
};

let policyCache=null;
export function getGovernancePolicy(root){
  if(!policyCache)policyCache=readJson(path.join(root,'policies','cost-context-governance.json'));
  return policyCache;
}

/** Deterministic complexity from declared scope, not from prose. */
export function taskComplexity(root,task){
  const p=getGovernancePolicy(root).complexity;
  const score=(value,thresholds)=>value>=thresholds[2]?2:value>=thresholds[1]?1:0;
  const points=
    score(arr(task.scope?.write).length,p.signals.write_scope_entries)+
    score(arr(task.scope?.modules).length,p.signals.module_count)+
    score(Number(task.execution?.estimated_seconds||0),p.signals.estimated_seconds);
  const level=points>=4?'HIGH':points>=2?'MEDIUM':'LOW';
  return {level,points,signals:{
    write_scope:arr(task.scope?.write).length,
    modules:arr(task.scope?.modules).length,
    estimated_seconds:Number(task.execution?.estimated_seconds||0)
  }};
}

/** Historical first-try success for this run, used as a prior, never a gate. */
export function historicalSuccessRate(projectRoot,runId){
  const tasks=listTasks(projectRoot,runId);
  const attempted=tasks.filter(t=>(t.attempt||0)>0);
  if(!attempted.length)return {available:false,rate:null,sample:0};
  const firstTry=attempted.filter(t=>t.status==='DONE'&&(t.attempt||0)===1);
  return {available:true,rate:Number((firstTry.length/attempted.length).toFixed(4)),sample:attempted.length};
}

/**
 * Decide how to execute one task. Returns the decision list, the model floor
 * and the reasons — an explainable record, not a bare verdict.
 */
export function governTask(root,projectRoot,run,task,{
  contextEstimate=null,contextBudget=null,remainingModelCalls=null,
  cacheAvailable=false,providerCapabilities=null,deterministicToolAvailable=true
}={}){
  const policy=getGovernancePolicy(root);
  const decisions=[];const reasons=[];
  const profile=task.risk?.profile||run.profile||'STANDARD';
  const complexity=taskComplexity(root,task);
  const history=historicalSuccessRate(projectRoot,run.run_id);
  const attempts=task.attempt||0;

  // --- model floor: risk raises it, budget never lowers it -----------------
  let floor=policy.model_floor.risk_profile[profile]||'STANDARD';
  floor=raise(floor,policy.model_floor.security_risk[task.risk?.security||'LOW']);
  floor=raise(floor,policy.model_floor.data_risk[task.risk?.data||'LOW']);
  reasons.push(`model floor ${floor} from profile=${profile} security=${task.risk?.security||'LOW'} data=${task.risk?.data||'LOW'}`);

  let tier=floor;
  if(complexity.level==='LOW'&&floor==='ECONOMY'){
    decisions.push('USE_ECONOMY_MODEL');
    reasons.push('low complexity at an economy floor');
  }else if(complexity.level==='HIGH'){
    tier=raise(tier,'HIGH_REASONING');
    decisions.push('ESCALATE_HIGH_REASONING');
    reasons.push('high declared complexity');
  }
  if(attempts>=policy.retry.escalate_reasoning_after_attempts&&tier!=='HIGH_REASONING'){
    tier='HIGH_REASONING';
    decisions.push('ESCALATE_HIGH_REASONING');
    reasons.push(`attempt ${attempts} >= ${policy.retry.escalate_reasoning_after_attempts}`);
  }
  if(!decisions.some(d=>d.startsWith('USE_')||d==='ESCALATE_HIGH_REASONING')){
    decisions.push(tier==='HIGH_REASONING'?'ESCALATE_HIGH_REASONING':tier==='ECONOMY'?'USE_ECONOMY_MODEL':'USE_STANDARD_MODEL');
  }

  // --- deterministic first --------------------------------------------------
  if(deterministicToolAvailable&&arr(task.verification?.targeted_tests).length){
    decisions.push('USE_DETERMINISTIC_TOOL_FIRST');
    reasons.push('targeted verification commands exist; run them before inference');
  }

  // --- mandatory independent review ---------------------------------------
  const m=policy.mandatory_independent_review;
  const reviewRequired=
    arr(m.risk_profiles).includes(profile)||
    arr(m.security_risk).includes(task.risk?.security)||
    (m.destructive_data_change&&task.risk?.destructive_data_change===true)||
    (m.interface_scope_present&&arr(task.scope?.interfaces).length>0);
  if(reviewRequired){
    decisions.push('SPAWN_INDEPENDENT_REVIEWER');
    reasons.push('independent review is mandatory for this risk profile and cannot be traded for cost');
  }

  // --- context --------------------------------------------------------------
  let contextRatio=null;
  if(contextEstimate&&contextBudget){
    contextRatio=Number((contextEstimate/contextBudget).toFixed(4));
    if(contextRatio>=policy.context.hard_stop_over_ratio){
      decisions.push('STOP_AND_REQUEST_CONFIRMATION');
      reasons.push(`context ${contextRatio}x budget exceeds the hard stop ${policy.context.hard_stop_over_ratio}x`);
    }else if(contextRatio>=policy.context.compact_when_over_ratio){
      decisions.push('COMPACT_CONTEXT');
      reasons.push(`context ${contextRatio}x budget is at or above the compaction threshold`);
    }
  }

  // --- parallelism ----------------------------------------------------------
  if(attempts>=policy.retry.avoid_parallel_after_attempts){
    decisions.push('AVOID_PARALLEL_FAN_OUT');
    reasons.push(`a task on attempt ${attempts} needs attention, not fan-out`);
  }
  if(history.available&&history.rate!==null&&history.rate<0.5&&history.sample>=3){
    if(!decisions.includes('AVOID_PARALLEL_FAN_OUT')){
      decisions.push('AVOID_PARALLEL_FAN_OUT');
      reasons.push(`first-try success ${history.rate} over ${history.sample} tasks is too low to widen fan-out`);
    }
  }

  // --- budget ---------------------------------------------------------------
  if(remainingModelCalls!==null&&Number.isFinite(remainingModelCalls)){
    if(remainingModelCalls<policy.budget.stop_and_confirm_below_remaining_model_calls){
      decisions.push('STOP_AND_REQUEST_CONFIRMATION');
      reasons.push(`only ${remainingModelCalls} model calls remain`);
    }
  }
  if(attempts>=policy.retry.stop_and_confirm_after_attempts&&!decisions.includes('STOP_AND_REQUEST_CONFIRMATION')){
    decisions.push('STOP_AND_REQUEST_CONFIRMATION');
    reasons.push(`attempt ${attempts} has exhausted useful autonomous retries`);
  }

  return {
    schema:'agent-sdlc/governor-decision/v1',
    run_id:run.run_id,
    task_id:task.task_id,
    objective:policy.objective,
    inputs:{
      stage:run.state,risk_profile:profile,
      security_risk:task.risk?.security||'LOW',data_risk:task.risk?.data||'LOW',
      complexity,attempts,
      context_estimate:contextEstimate,context_budget:contextBudget,context_ratio:contextRatio,
      remaining_model_calls:remainingModelCalls,
      cache_available:!!cacheAvailable,
      provider_capabilities:providerCapabilities??null,
      historical_success_rate:history
    },
    model_floor:floor,
    model_tier:tier,
    decisions:[...new Set(decisions)],
    reasons,
    // Explicit so a reader never has to infer it from absence.
    security_or_review_downgraded:false,
    time:now()
  };
}

/** Run-level efficiency view against the governance objective. */
export function governorReport(root,projectRoot,run){
  const tasks=listTasks(projectRoot,run.run_id);
  const cost=reportRunTaskUsage(projectRoot,run.run_id,tasks);
  const policy=getGovernancePolicy(root);
  return {
    schema:'agent-sdlc/governor-report/v1',
    run_id:run.run_id,
    objective:policy.objective,
    verified_done_tasks:cost.verified_done_tasks,
    per_verified_done_task:cost.per_verified_done_task,
    efficiency:cost.efficiency,
    decisions_available:policy.decisions,
    hard_rule:policy.hard_rule,
    time:now()
  };
}
