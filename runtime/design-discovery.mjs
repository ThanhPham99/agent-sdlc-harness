// Conditional design discovery: deterministic mode selection and DESIGN gate evaluation.
//
// Invariants enforced here:
// - design discovery is an internal orchestrator module, never a third public skill;
// - mode selection is deterministic and explainable (reason codes, not prose);
// - cheap work does not pay brainstorming cost, and hard decisions cannot be silently skipped;
// - a HUMAN-approval design decision cannot reach PLAN on model prose alone.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';

const HERE=path.dirname(fileURLToPath(import.meta.url));
const ROOT=path.resolve(HERE,'..');
export const POLICY_PATH=path.join(ROOT,'policies','design-discovery.json');
export const MODES=['SKIP','COMPACT','FULL'];

const policyCache=new Map();
export function clearDesignDiscoveryPolicyCache(){policyCache.clear();}
export function getDesignDiscoveryPolicy(root=ROOT){
  const r=path.resolve(root||ROOT);
  if(!policyCache.has(r))policyCache.set(r,JSON.parse(fs.readFileSync(path.join(r,'policies','design-discovery.json'),'utf8')));
  return policyCache.get(r);
}

const rank=(mode)=>getDesignDiscoveryPolicy().mode_rank[mode]??0;
const byRank=(a,b)=>rank(a)>=rank(b)?a:b;
const minByRank=(a,b)=>rank(a)<=rank(b)?a:b;
const matches=(text,patterns)=>patterns.some(p=>new RegExp(p,'i').test(text));

// Signals can arrive two ways: declared explicitly by the router/orchestrator
// (authoritative) or inferred from the objective text (diagnostics/eval quality).
// Declared signals win; inference only adds, it never removes.
function collectSignals({objective='',declaredSignals=[]}={}){
  const policy=getDesignDiscoveryPolicy();
  const text=String(objective||'');
  const declared=new Set(declaredSignals||[]);
  const escalations=[];const deescalations=[];
  for(const s of policy.escalation_signals){
    if(declared.has(s.id)||matches(text,s.patterns))escalations.push(s);
  }
  for(const s of policy.deescalation_signals){
    if(declared.has(s.id)||matches(text,s.patterns))deescalations.push(s);
  }
  const unknown=[...declared].filter(id=>
    !policy.escalation_signals.some(s=>s.id===id)&&!policy.deescalation_signals.some(s=>s.id===id));
  return {escalations,deescalations,unknown};
}

/**
 * Deterministically select the design discovery mode for one bounded objective.
 *
 * Precedence: hard (non-deescalatable) escalation > profile floor > soft
 * escalation capped by de-escalation ceiling > profile default > profile bounds.
 */
export function selectDesignDiscoveryMode({profile='STANDARD',objective='',declaredSignals=[],designAlreadyApproved=false}={}){
  const policy=getDesignDiscoveryPolicy();
  const reason_codes=[];
  const {escalations,deescalations,unknown}=collectSignals({objective,declaredSignals});
  for(const id of unknown)reason_codes.push(`UNKNOWN_SIGNAL_IGNORED:${id}`);

  const bounds=policy.profile_bounds[profile]||policy.profile_bounds.STANDARD;
  let mode=policy.profile_defaults[profile]??policy.profile_defaults.STANDARD;
  reason_codes.push(`PROFILE_DEFAULT:${profile}:${mode}`);

  const hard=escalations.filter(s=>s.deescalatable===false);
  const soft=escalations.filter(s=>s.deescalatable!==false);

  let softMode=mode;
  for(const s of soft){softMode=byRank(softMode,s.min_mode);reason_codes.push(`ESCALATE:${s.id}:${s.min_mode}`);}

  // De-escalation is a ceiling on *soft* reasoning only. It can never suppress a
  // contract / security / data-migration decision.
  let ceiling='FULL';
  for(const s of deescalations){ceiling=minByRank(ceiling,s.max_mode);reason_codes.push(`DEESCALATE:${s.id}:${s.max_mode}`);}
  mode=minByRank(softMode,ceiling);

  for(const s of hard){
    const before=mode;
    mode=byRank(mode,s.min_mode);
    reason_codes.push(`ESCALATE_HARD:${s.id}:${s.min_mode}`);
    if(before!==mode&&rank(ceiling)<rank(mode))reason_codes.push(`DEESCALATION_OVERRIDDEN_BY:${s.id}`);
  }

  // Profile bounds are applied last so STRICT can never fall to SKIP.
  const clamped=minByRank(byRank(mode,bounds.floor),bounds.ceiling);
  if(clamped!==mode)reason_codes.push(`PROFILE_BOUND:${profile}:${clamped}`);
  mode=clamped;

  if(designAlreadyApproved&&!hard.length&&mode==='FULL'){
    mode='COMPACT';
    reason_codes.push('DESIGN_ALREADY_APPROVED_COMPACT');
  }

  const approvalSignals=escalations
    .map(s=>s.id)
    .filter(id=>policy.human_approval_required_signals.includes(id));
  const approvalByProfile=mode==='FULL'&&policy.human_approval_required_profiles.includes(profile);
  const human_approval_required=mode==='FULL'&&(approvalSignals.length>0||approvalByProfile);
  if(human_approval_required)reason_codes.push(`HUMAN_APPROVAL_REQUIRED:${approvalSignals.join('|')||`profile:${profile}`}`);

  return {
    schema:'agent-sdlc/design-discovery-decision/v1',
    policy_version:policy.version,
    profile,
    mode,
    reason_codes,
    escalation_signals:escalations.map(s=>s.id),
    deescalation_signals:deescalations.map(s=>s.id),
    human_approval_required,
    required_options:mode==='FULL'?policy.options.min_options_full_mode:0,
    max_options:mode==='FULL'?policy.options.max_options_full_mode:0,
    gate_evidence_required:requiredGateEvidence(mode,human_approval_required),
    // Selecting FULL never grants tool authority; it only selects a module.
    approval_implied:false
  };
}

export function requiredGateEvidence(mode,humanApprovalRequired=false){
  const gate=getDesignDiscoveryPolicy().gate;
  const out=[gate.mode_evidence[mode]];
  if(humanApprovalRequired)out.push(gate.human_approval_evidence);
  return out;
}

/**
 * DESIGN -> PLAN gate check. Returns the derived canonical evidence token so
 * existing stage policy (`design_or_skip_decision`) stays compatible.
 */
export function evaluateDesignGate({mode=null,evidence=[],humanApprovalRequired=false,approvals=[]}={}){
  const gate=getDesignDiscoveryPolicy().gate;
  const have=new Set(evidence||[]);
  const missing=[];
  const accepted=gate.evidence_any_of.filter(e=>have.has(e));
  if(mode){
    const need=gate.mode_evidence[mode];
    if(!have.has(need))missing.push(need);
  }else if(!accepted.length){
    missing.push(`one_of:${gate.evidence_any_of.join('|')}`);
  }
  if(humanApprovalRequired){
    const approved=(approvals||[]).some(a=>a===gate.human_approval_evidence);
    if(!have.has(gate.human_approval_evidence)&&!approved)missing.push(gate.human_approval_evidence);
  }
  return {
    schema:'agent-sdlc/design-gate-result/v1',
    valid:missing.length===0,
    mode,
    accepted_evidence:accepted,
    missing,
    derived_evidence:missing.length===0?[gate.derived_evidence]:[]
  };
}

/**
 * `design mode` emits a mode SELECTION (agent-sdlc/design-discovery-decision/v1);
 * `validateDesignDecision` requires the DECISION content itself
 * (agent-sdlc/design-decision/v1), which no amount of re-shaping the selection
 * can produce -- FULL mode needs real options and tradeoffs no deterministic
 * code can invent. This bridges the gap the other way: given a selection, it
 * emits a correctly-shaped decision draft for that mode, so the artifact the
 * DESIGN gate requires is filled in rather than hand-built from validate's
 * error codes one field at a time. SKIP is genuinely valid immediately (the
 * selection's own reason codes are a real answer to "why skip"); COMPACT
 * needs no content validateDesignDecision checks for; FULL gets a correctly
 * shaped skeleton with TODO placeholders that still need real judgment.
 */
export function scaffoldDesignDecision(selection,{objective='',decisionId=null}={}){
  const draft={
    schema:'agent-sdlc/design-decision/v1',
    decision_id:decisionId||`design_${crypto.randomUUID()}`,
    objective:objective||'TODO: the requirement or objective this decision serves',
    mode:selection.mode,
    requirements:[],design_decisions:[],
    decision:null,options:[],recommended_option:null,rejected_alternatives:[],
    skip_reason:null,
    affected_interfaces:[],affected_data:[],verification_obligations:[],
    flagged_policy_concerns:[],
    external_references:[],
    approval:{required:selection.human_approval_required,status:selection.human_approval_required?'PENDING':'NOT_REQUIRED'}
  };
  if(selection.mode==='SKIP'){
    draft.skip_reason=`Design discovery selected SKIP (${selection.reason_codes.join('; ')})`;
  }else if(selection.mode==='FULL'){
    const n=getDesignDiscoveryPolicy().options.min_options_full_mode;
    draft.decision='TODO: state the chosen approach in one or two sentences';
    draft.options=Array.from({length:n},(_,i)=>({id:`OPTION-${String.fromCharCode(65+i)}`,summary:'TODO',benefits:['TODO'],tradeoffs:['TODO']}));
    draft.recommended_option=draft.options[0].id;
  }
  return draft;
}

/**
 * Structural validation of a DesignDecision artifact. Deterministic: it checks
 * the contract the internal module promised, not the quality of the prose.
 */
export function validateDesignDecision(decision,{policy=getDesignDiscoveryPolicy()}={}){
  const errors=[];const warnings=[];
  const d=decision||{};
  if(d.schema!=='agent-sdlc/design-decision/v1')errors.push('SCHEMA_MISMATCH');
  if(!d.decision_id)errors.push('MISSING_DECISION_ID');
  if(!d.objective)errors.push('MISSING_OBJECTIVE');
  if(!MODES.includes(d.mode))errors.push('INVALID_MODE');
  const options=Array.isArray(d.options)?d.options:[];
  if(d.mode==='FULL'){
    if(!options.length)errors.push('FULL_MODE_WITHOUT_OPTIONS');
    else if(options.length<policy.options.min_options_full_mode){
      // A single legitimate solution is allowed, but only with recorded rejection evidence.
      if(policy.options.single_option_requires_rejection_evidence&&!(d.rejected_alternatives||[]).length){
        errors.push('SINGLE_OPTION_WITHOUT_REJECTION_EVIDENCE');
      }else warnings.push('SINGLE_OPTION_WITH_RECORDED_REJECTIONS');
    }
    if(options.length>policy.options.max_options_full_mode)warnings.push('MORE_OPTIONS_THAN_POLICY_MAX');
    if(!d.recommended_option)errors.push('MISSING_RECOMMENDED_OPTION');
    else if(options.length&&!options.some(o=>o.id===d.recommended_option))errors.push('RECOMMENDED_OPTION_NOT_IN_OPTIONS');
    if(!d.decision)errors.push('MISSING_DECISION_STATEMENT');
    for(const o of options){
      if(!o.id)errors.push('OPTION_MISSING_ID');
      if(!o.summary)errors.push(`OPTION_MISSING_SUMMARY:${o.id||'?'}`);
      if(!(o.benefits||[]).length)errors.push(`OPTION_MISSING_BENEFITS:${o.id||'?'}`);
      if(!(o.tradeoffs||[]).length)errors.push(`OPTION_MISSING_TRADEOFFS:${o.id||'?'}`);
    }
  }
  if(d.mode==='SKIP'&&!(d.skip_reason||d.decision))errors.push('SKIP_WITHOUT_REASON');
  if(d.approval?.required===true&&d.approval?.status!=='APPROVED')errors.push('APPROVAL_REQUIRED_NOT_APPROVED');
  if((d.affected_interfaces||[]).length&&!(d.verification_obligations||[]).length){
    errors.push('INTERFACE_CHANGE_WITHOUT_VERIFICATION_OBLIGATION');
  }
  if((d.affected_data||[]).length&&!(d.verification_obligations||[]).length){
    errors.push('DATA_CHANGE_WITHOUT_VERIFICATION_OBLIGATION');
  }
  const concerns=Array.isArray(d.flagged_policy_concerns)?d.flagged_policy_concerns:[];
  for(const c of concerns){
    if(!c.policy)errors.push('FLAGGED_CONCERN_MISSING_POLICY');
    if(!c.concern)errors.push(`FLAGGED_CONCERN_MISSING_DESCRIPTION:${c.policy||'?'}`);
    if(c.severity==='BLOCKING'&&d.approval?.required!==true){
      errors.push(`BLOCKING_POLICY_CONCERN_REQUIRES_HUMAN_APPROVAL:${c.policy}`);
    }
  }
  if(!(d.requirements||[]).length)warnings.push('NO_LINKED_REQUIREMENTS');
  return {
    schema:'agent-sdlc/design-decision-validation/v1',
    valid:errors.length===0,
    mode:d.mode??null,
    option_count:options.length,
    errors,
    warnings,
    gate_evidence:errors.length===0?requiredGateEvidence(d.mode,d.approval?.required===true):[]
  };
}
