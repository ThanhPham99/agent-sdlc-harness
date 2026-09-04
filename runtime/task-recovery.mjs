// Task failure classification and recovery.
//
// The invariant this module exists to protect:
//
//   No same-task retry without new concrete evidence, changed context, changed
//   plan, changed implementation, or an explicit recovery decision.
//
// A loop that re-runs an identical task against an identical repository is not
// persistence, it is a bug that burns budget. Every recovery here either
// carries new evidence or changes state to something a human or the outer
// orchestrator must act on.
import path from 'node:path';
import {now,readJson,sha256} from './util.mjs';
import {emitTaskEvent} from './store.mjs';
import {transitionTask} from './task-engine.mjs';

export const FAILURE_CLASSES=[
  'IMPLEMENTATION_DEFECT','VERIFICATION_FAILURE','SPEC_MISMATCH','QUALITY_BLOCKER',
  'DEPENDENCY_BLOCKED','DESIGN_INVALIDATED','REQUIREMENT_AMBIGUITY','SCOPE_EXPANSION',
  'INFRA_TRANSIENT','PROVIDER_FAILURE','PERMISSION_DENIED','BUDGET_EXHAUSTED'
];

const policyCache=new Map();
export function clearTaskFailurePolicyCache(){policyCache.clear();}
export function getTaskFailurePolicy(root){
  const r=path.resolve(root||'.');
  if(!policyCache.has(r))policyCache.set(r,readJson(path.join(r,'policies','task-failure-policy.json')));
  return policyCache.get(r);
}

const arr=x=>Array.isArray(x)?x:[];

/**
 * Classify a failure from observable signals rather than prose. Order matters:
 * the most structural cause wins, so a scope violation is never mistaken for a
 * plain implementation defect.
 */
export function classifyTaskFailure({verification=null,specReview=null,qualityReview=null,dependency=null,providerError=null,permissionDenied=false,budgetExhausted=false,designInvalidated=false,requirementAmbiguity=false}={}){
  if(budgetExhausted)return {class:'BUDGET_EXHAUSTED',detail:'stage or task budget exhausted'};
  if(permissionDenied)return {class:'PERMISSION_DENIED',detail:'a required tool or path was denied by policy'};
  if(designInvalidated)return {class:'DESIGN_INVALIDATED',detail:'upstream design decision no longer holds'};
  if(requirementAmbiguity)return {class:'REQUIREMENT_AMBIGUITY',detail:'the task cannot be completed without a product decision'};
  if(dependency&&!dependency.satisfied){
    return {class:'DEPENDENCY_BLOCKED',detail:`dependencies not DONE: ${[...arr(dependency.pending),...arr(dependency.failed),...arr(dependency.missing)].join(',')}`};
  }
  if(verification?.scope&&verification.scope.respected===false){
    return {class:'SCOPE_EXPANSION',detail:`changed outside approved write scope: ${arr(verification.scope.out_of_scope_paths).join(',')}`};
  }
  if(providerError){
    const t=String(providerError).toLowerCase();
    if(/rate limit|too many requests|overloaded|temporarily unavailable|service unavailable|connection reset|timed out|timeout|capacity/.test(t)){
      return {class:'INFRA_TRANSIENT',detail:'transient infrastructure or provider condition'};
    }
    return {class:'PROVIDER_FAILURE',detail:String(providerError).slice(0,200)};
  }
  if(specReview&&specReview.verdict==='NON_COMPLIANT')return {class:'SPEC_MISMATCH',detail:'spec compliance review found a blocking gap'};
  if(qualityReview&&qualityReview.verdict==='CHANGES_REQUIRED')return {class:'QUALITY_BLOCKER',detail:'code quality review found a blocking issue'};
  if(verification&&verification.status==='FAIL'){
    return verification.reason==='NO_CHANGE_CAPTURED'
      ?{class:'IMPLEMENTATION_DEFECT',detail:'no change was captured for a behaviour-changing task'}
      :{class:'VERIFICATION_FAILURE',detail:verification.reason||'verification command failed'};
  }
  if(verification&&verification.status==='BLOCKED'){
    return {class:'PERMISSION_DENIED',detail:verification.reason||'verification could not run'};
  }
  return {class:'IMPLEMENTATION_DEFECT',detail:'unclassified task failure'};
}

/**
 * A retry is only new if something it can act on changed. The fingerprint is
 * the honest test: same diff, same context, same evidence -> no new evidence.
 */
export function evidenceFingerprint({task,verification=null,specReview=null,qualityReview=null}={}){
  return sha256(JSON.stringify({
    diff:task?.diff_hash??null,
    context:task?.context_manifest_ref??null,
    verification:verification?{status:verification.status,reason:verification.reason,commands:arr(verification.commands).map(c=>[c.kind,c.exit_code])}:null,
    spec:specReview?{verdict:specReview.verdict,findings:arr(specReview.findings).map(f=>[f.category,f.summary])}:null,
    quality:qualityReview?{verdict:qualityReview.verdict,findings:arr(qualityReview.findings).map(f=>[f.category,f.summary])}:null
  }));
}
export function hasNewEvidence(task,fingerprint){
  const seen=arr(task?.history).map(h=>h.fingerprint).filter(Boolean);
  return !seen.includes(fingerprint);
}

/**
 * Decide what to do about a classified failure. Pure: it reads policy and task
 * state and returns a plan. `applyRecovery` performs it.
 */
export function planRecovery(root,task,failure,{infrastructureAttempts=0,newEvidence=true}={}){
  const policy=getTaskFailurePolicy(root);
  const spec=policy.classes[failure.class];
  if(!spec)return {action:'BLOCK',to:'BLOCKED',reason:`unknown failure class ${failure.class}`,retryable:false};
  const maxRetries=task.execution?.max_retries??policy.default_max_retries;
  const attemptsUsed=Math.max(0,(task.attempt||0)-1);

  if(spec.action==='RETRY_INFRASTRUCTURE'){
    if(infrastructureAttempts>=policy.infrastructure_max_retries){
      return {action:'BLOCK',to:'BLOCKED',reason:`infrastructure retries exhausted (${policy.infrastructure_max_retries})`,retryable:false,failure_class:failure.class};
    }
    return {action:spec.action,to:spec.to,reason:failure.detail,retryable:true,requires_new_evidence:false,failure_class:failure.class};
  }
  if(spec.action==='RETRY_TASK'){
    if(spec.requires_new_evidence&&!newEvidence){
      return {action:'BLOCK',to:'BLOCKED',reason:'retry refused: no new evidence since the previous identical attempt',retryable:false,failure_class:failure.class};
    }
    if(attemptsUsed>=maxRetries){
      const escalation=spec.escalate_when_budget_exhausted;
      if(escalation==='INVALIDATE_UPSTREAM'){
        return {action:'INVALIDATE',to:'INVALIDATED',reason:`retry budget exhausted (${attemptsUsed}/${maxRetries}); upstream design or plan must change`,retryable:false,failure_class:failure.class,outer_reentry:'DESIGN'};
      }
      return {action:'FAIL',to:'FAILED',reason:`retry budget exhausted (${attemptsUsed}/${maxRetries})`,retryable:false,failure_class:failure.class};
    }
    return {action:spec.action,to:spec.to,reason:failure.detail,retryable:true,requires_new_evidence:true,failure_class:failure.class};
  }
  return {
    action:spec.action,to:spec.to,reason:failure.detail,retryable:false,failure_class:failure.class,
    outer_state:spec.outer_state??null,outer_reentry:spec.outer_reentry??null,
    requires_approval_or_alternative:!!spec.requires_approval_or_alternative,
    escalate:!!spec.escalate
  };
}

/** Perform the planned recovery transition and record why. */
export function applyRecovery(root,projectRoot,task,plan,{tasks=[],fingerprint=null,recoveryDecision=false,upstreamRefreshed=false}={}){
  const opts={
    tasks,reason:plan.reason,failureClass:plan.failure_class,failureDetail:plan.reason,
    newEvidence:plan.requires_new_evidence?true:false,
    recoveryDecision,upstreamRefreshed,
    invalidationSource:plan.failure_class
  };
  // BLOCKED and FAILED are reachable from any in-flight status; RUNNING re-entry
  // is a declared retry edge, so the engine re-checks the retry budget itself.
  const updated=transitionTask(root,projectRoot,task,plan.to,opts);
  if(fingerprint&&updated.history?.length)updated.history[updated.history.length-1].fingerprint=fingerprint;
  emitTaskEvent(projectRoot,updated,{
    type:'task.recovered',
    payload:{action:plan.action,to:plan.to,failure_class:plan.failure_class,reason:plan.reason,
      outer_state:plan.outer_state??null,outer_reentry:plan.outer_reentry??null,time:now()}
  });
  return updated;
}

/**
 * What the outer orchestrator must do about this task failure, if anything.
 * The task engine never mutates outer run state itself.
 */
export function outerEscalation(plan){
  if(plan.outer_state)return {required:true,kind:'SUSPEND',outer_state:plan.outer_state,reason:plan.reason};
  if(plan.outer_reentry)return {required:true,kind:'REENTRY',outer_state:plan.outer_reentry,reason:plan.reason};
  if(plan.escalate)return {required:true,kind:'ESCALATE',outer_state:'BLOCKED',reason:plan.reason};
  return {required:false};
}

/**
 * Parse raw test/build stdout/stderr to extract structured diagnostics
 * (syntax error, assertion failure, missing import, type error)
 * and generate targeted remediation hints for self-healing loops.
 */
export function parseFailureDiagnostics(output){
  const text=String(output||'');
  if(!text.trim())return {error_type:'UNKNOWN',summary:'empty output',remediation_hint:null};

  let errorType='RUNTIME_ERROR';
  let summary='command failed with runtime error';
  let file=null;
  let line=null;

  if(/SyntaxError|Unexpected token|Unexpected identifier|missing \)|missing ;/i.test(text)){
    errorType='SYNTAX_ERROR';
    summary='Code syntax or parsing error';
  }else if(/TypeError|is not a function|Cannot read propert|cannot read property|undefined is not an object/i.test(text)){
    errorType='TYPE_ERROR';
    summary='Type mismatch or undefined property access';
  }else if(/Cannot find module|MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND|import error|No module named/i.test(text)){
    errorType='IMPORT_ERROR';
    summary='Missing or unresolved module dependency/import';
  }else if(/AssertionError|assert|Expected:.*Received:|expected.*to equal|fail\(/i.test(text)){
    errorType='ASSERTION_FAILURE';
    summary='Test assertion failed';
  }

  const match=text.match(/(?:at\s+.*?\()?([A-Za-z0-9_\-./\\]+\.[a-zA-Z0-9]+):(\d+):?(\d+)?\)?/);
  if(match){
    file=match[1].replace(/\\/g,'/');
    line=Number(match[2]);
  }

  const hint=`${errorType}: ${summary}${file?` at ${file}${line?`:${line}`:''}`:''}. Focus remediation on resolving the exact error before re-running tests.`;

  return {
    error_type:errorType,
    summary,
    failing_file:file,
    failing_line:line,
    remediation_hint:hint
  };
}
