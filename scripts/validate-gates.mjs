#!/usr/bin/env node
// Release evidence for the two alpha4 gates: conditional design discovery and
// the deterministic plan quality gate. Offline, no host CLI, no network.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {selectDesignDiscoveryMode,validateDesignDecision,getDesignDiscoveryPolicy,requiredGateEvidence} from '../runtime/design-discovery.mjs';
import {validateTaskPlan,computeTaskGraph,findCycles,computeReadySets,planGateEvidence,PLAN_QUALITY_DEFAULTS} from '../runtime/plan-validator.mjs';
import {writeReport} from './lib/report-io.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const rj=p=>JSON.parse(fs.readFileSync(path.join(ROOT,p),'utf8'));
const VERSION=rj('agent-sdlc.manifest.json').version;
const stagePolicy=rj('policies/stage-policy.json');
const skills=rj('config/skills.json');
const out=(file,obj)=>writeReport(path.join(ROOT,'evals',file),obj);

// --- design discovery -------------------------------------------------------
const ddPolicy=getDesignDiscoveryPolicy();
const ddCases=rj('evals/design-discovery/cases.json').cases;
const ddAdversarial=rj('evals/design-discovery/adversarial-cases.json').cases;

const modeRows=ddCases.map(c=>{
  const got=selectDesignDiscoveryMode({profile:c.profile,objective:c.objective,declaredSignals:c.declared_signals||[]});
  const e=c.expected;
  const problems=[];
  if(e.mode&&got.mode!==e.mode)problems.push(`mode ${got.mode} != ${e.mode}`);
  if(e.mode_in&&!e.mode_in.includes(got.mode))problems.push(`mode ${got.mode} not in ${e.mode_in.join('|')}`);
  if(e.signal&&!got.escalation_signals.includes(e.signal))problems.push(`missing signal ${e.signal}`);
  if(e.human_approval_required!==undefined&&got.human_approval_required!==e.human_approval_required)problems.push(`human_approval_required ${got.human_approval_required}`);
  return {case_id:c.id,profile:c.profile,status:problems.length?'FAIL':'PASS',mode:got.mode,
    human_approval_required:got.human_approval_required,escalation_signals:got.escalation_signals,
    deescalation_signals:got.deescalation_signals,reason_codes:got.reason_codes,problems};
});
const decisionRows=ddAdversarial.map(c=>{
  const v=validateDesignDecision(c.decision);
  const problems=[];
  if(v.valid!==c.expected.valid)problems.push(`valid=${v.valid}`);
  if(c.expected.error&&!v.errors.includes(c.expected.error))problems.push(`missing ${c.expected.error}`);
  return {case_id:c.id,status:problems.length?'FAIL':'PASS',valid:v.valid,errors:v.errors,warnings:v.warnings,problems};
});
const modeDistribution=modeRows.reduce((a,r)=>({...a,[r.mode]:(a[r.mode]||0)+1}),{});
const ddFail=[...modeRows,...decisionRows].filter(r=>r.status!=='PASS').length;

out('DESIGN-DISCOVERY-VALIDATION.json',{
  schema:'agent-sdlc/design-discovery-validation/v1',
  version:VERSION,
  policy_version:ddPolicy.version,
  public_skill_count:skills.public.length,
  design_discovery_is_internal:!!skills.internal['design-discovery']&&!fs.existsSync(path.join(ROOT,'skills','design-discovery')),
  modes:ddPolicy.modes,
  gate:{
    stage:'DESIGN',
    stage_policy_requirements:stagePolicy.stages.DESIGN.gate_requirements,
    accepted_mode_evidence:ddPolicy.gate.evidence_any_of,
    derived_evidence:ddPolicy.gate.derived_evidence,
    human_approval_evidence:ddPolicy.gate.human_approval_evidence,
    evidence_authority:Object.fromEntries(Object.entries(stagePolicy.evidence_authority||{})
      .filter(([k])=>k.startsWith('design')||ddPolicy.gate.evidence_any_of.includes(k))),
    required_evidence_by_mode:Object.fromEntries(ddPolicy.modes.map(m=>[m,requiredGateEvidence(m,false)]))
  },
  mode_selection:{checks:modeRows.length,passes:modeRows.filter(r=>r.status==='PASS').length,
    failures:modeRows.filter(r=>r.status!=='PASS').length,distribution:modeDistribution,results:modeRows},
  decision_contract:{checks:decisionRows.length,passes:decisionRows.filter(r=>r.status==='PASS').length,
    failures:decisionRows.filter(r=>r.status!=='PASS').length,results:decisionRows},
  live_qualification:'PENDING_LIVE_QUALIFICATION',
  status:ddFail?'FAIL':'PASS'
});

// --- plan quality -----------------------------------------------------------
const pq=rj('evals/plan-quality/cases.json');
const planFor=c=>({...structuredClone(pq.base),...structuredClone(c.override||{})});
const planRows=pq.cases.map(c=>{
  const plan=planFor(c);
  const v=validateTaskPlan(plan);
  const codes=v.errors.map(x=>x.code);
  const warns=v.warnings.map(x=>x.code);
  const e=c.expected;
  const problems=[];
  if(v.valid!==e.valid)problems.push(`valid=${v.valid} errors=${codes.join(',')}`);
  for(const key of ['error','also_error'])if(e[key]&&!codes.includes(e[key]))problems.push(`missing ${e[key]}`);
  if(e.warning&&!warns.includes(e.warning))problems.push(`missing warning ${e.warning}`);
  for(const key of ['task_count','edge_count','cycle_count','conflict_count','parallel_candidate_count','wave_count','ac_coverage','micro_plan'])
    if(e[key]!==undefined&&v[key]!==e[key])problems.push(`${key}=${v[key]} != ${e[key]}`);
  // Determinism: the same plan must validate identically twice.
  if(JSON.stringify(validateTaskPlan(plan))!==JSON.stringify(v))problems.push('non-deterministic');
  return {case_id:c.id,status:problems.length?'FAIL':'PASS',valid:v.valid,micro_plan:v.micro_plan,
    metrics:{task_count:v.task_count,edge_count:v.edge_count,ac_coverage:v.ac_coverage,
      verification_coverage:v.verification_coverage,cycle_count:v.cycle_count,
      parallel_candidate_count:v.parallel_candidate_count,conflict_count:v.conflict_count,wave_count:v.wave_count},
    errors:codes,warnings:warns,problems};
});
const covered=new Set(planRows.flatMap(r=>r.errors));
const pqFail=planRows.filter(r=>r.status!=='PASS').length;

out('PLAN-QUALITY-VALIDATION.json',{
  schema:'agent-sdlc/plan-quality-validation/v1',
  version:VERSION,
  schemas:['agent-sdlc/task-plan/v1','agent-sdlc/planned-task/v1'],
  thresholds:PLAN_QUALITY_DEFAULTS,
  gate:{
    stage:'PLAN',
    stage_policy_requirements:stagePolicy.stages.PLAN.gate_requirements,
    recorded_evidence:planGateEvidence(),
    evidence_authority:Object.fromEntries(Object.entries(stagePolicy.evidence_authority||{}).filter(([k])=>k.startsWith('plan'))),
    caller_assertable:false
  },
  invariants_exercised:[...covered].sort(),
  graph_helpers:(()=>{
    const fanout=planFor(pq.cases.find(c=>c.id==='PQ-002-valid-fan-out-fan-in'));
    const cyclic=planFor(pq.cases.find(c=>c.id==='PQ-004-cycle'));
    return {
      fan_out_graph:computeTaskGraph(fanout),
      fan_out_waves:computeReadySets(fanout).waves,
      cyclic_cycles:findCycles(cyclic),
      cyclic_unreachable:computeReadySets(cyclic).unreachable
    };
  })(),
  checks:planRows.length,
  passes:planRows.filter(r=>r.status==='PASS').length,
  failures:pqFail,
  results:planRows,
  status:pqFail?'FAIL':'PASS'
});

const report={
  schema:'agent-sdlc/gate-validation-summary/v1',
  version:VERSION,
  design_discovery:{checks:modeRows.length+decisionRows.length,failures:ddFail},
  plan_quality:{checks:planRows.length,failures:pqFail},
  evidence:['evals/DESIGN-DISCOVERY-VALIDATION.json','evals/PLAN-QUALITY-VALIDATION.json'],
  status:(ddFail||pqFail)?'FAIL':'PASS'
};
console.log(JSON.stringify(report,null,2));
process.exit((ddFail||pqFail)?1:0);
