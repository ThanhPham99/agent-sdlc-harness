#!/usr/bin/env node
// Release evidence for the alpha5 task runtime. Runs the same suite `npm test`
// asserts on, then writes one evidence file per subsystem. Offline: no host
// CLI, no network, no model.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {runTaskRuntimeSuite} from '../evals/task-runtime.mjs';
import {TASK_STATUSES,getTaskStateMachine} from '../runtime/task-engine.mjs';
import {FAILURE_CLASSES,getTaskFailurePolicy} from '../runtime/task-recovery.mjs';
import {WORKSPACE_MODES} from '../runtime/workspace.mjs';
import {EXCLUDED_BY_DEFAULT} from '../runtime/task-context.mjs';
import {writeReport} from './lib/report-io.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const rj=p=>JSON.parse(fs.readFileSync(path.join(ROOT,p),'utf8'));
const VERSION=rj('agent-sdlc.manifest.json').version;
const out=(file,obj)=>writeReport(path.join(ROOT,'evals',file),obj);

const suite=runTaskRuntimeSuite(ROOT);
const byGroup=Object.fromEntries(suite.groups.map(g=>[g.group,g]));
const sm=getTaskStateMachine(ROOT);
const stagePolicy=rj('policies/stage-policy.json');
const scheduling=rj('policies/task-scheduling.json');
const failurePolicy=getTaskFailurePolicy(ROOT);

const block=(group)=>{
  const g=byGroup[group]||{checks:0,passes:0,failures:0,results:[]};
  return {checks:g.checks,passes:g.passes,failures:g.failures,results:g.results,
    status:g.failures?'FAIL':'PASS'};
};
/**
 * Counters covering every group a report file contains.
 *
 * TASK-ENGINE-VALIDATION.json spreads one group at the top level and nests
 * another under `migration`, so its top-level summary described only the first:
 * a failing migration case left the file reading `failures: 0, status: PASS`
 * while the process exited 1. The exit code was right and the artifact CI
 * uploads was not, which is the wrong way round for the one that gets read.
 */
const rollup=(...groups)=>{
  const gs=groups.map(n=>byGroup[n]||{checks:0,passes:0,failures:0});
  const sum=k=>gs.reduce((a,g)=>a+(g[k]||0),0);
  const failures=sum('failures');
  return {checks:sum('checks'),passes:sum('passes'),failures,status:failures?'FAIL':'PASS'};
};

out('TASK-ENGINE-VALIDATION.json',{
  schema:'agent-sdlc/task-engine-validation/v1',
  version:VERSION,
  state_machine:{
    version:sm.version,
    statuses:TASK_STATUSES,
    terminal:sm.terminal,
    edge_count:sm.edges.length,
    conditions:Object.keys(sm.conditions),
    forbidden:sm.forbidden
  },
  schemas:['agent-sdlc/task/v1','agent-sdlc/task-graph/v1','agent-sdlc/task-event/v1','agent-sdlc/task-context-manifest/v1'],
  storage:{
    root:'.agent-sdlc',
    directories:['tasks/<run_id>/','task-events/','task-evidence/','task-context/','workspaces/'],
    atomic_writes:true,
    large_evidence:'content-addressed artifact store; task records hold refs'
  },
  outer_gate:{
    stage:'IMPLEMENT',
    requirements:stagePolicy.stages.IMPLEMENT.gate_requirements,
    evidence_authority:Object.fromEntries(Object.entries(stagePolicy.evidence_authority||{})
      .filter(([k])=>['implementation_artifact','task_graph_complete'].includes(k))),
    caller_assertable:false
  },
  ...block('state_machine'),
  migration:block('migration_telemetry'),
  // Overwrites the spread counters above so they cover both groups in this file.
  ...rollup('state_machine','migration_telemetry'),
  results:block('state_machine').results,
  live_qualification:'PENDING_LIVE_QUALIFICATION'
});

out('TASK-SCHEDULER-VALIDATION.json',{
  schema:'agent-sdlc/task-scheduler-validation/v1',
  version:VERSION,
  policy:{
    version:scheduling.version,
    writers:scheduling.writers,
    read_only:scheduling.read_only,
    profile_max_writers:scheduling.profile_max_writers,
    parallel_requires:scheduling.parallel_requires,
    serialize_on:scheduling.serialize_on,
    benefit_threshold:scheduling.benefit_threshold,
    stage_categories:scheduling.stage_categories
  },
  shared_primitives:'runtime/parallel.mjs and runtime/task-scheduler.mjs share scopeConflicts/benefit predicates; there is one policy model',
  decision_artifact:'agent-sdlc/task-schedule-decision/v1',
  no_silent_caps:'every non-dispatched ready task is reported in `deferred` or `excluded` with a reason',
  ...block('scheduler'),
  live_qualification:'PENDING_LIVE_QUALIFICATION'
});

out('TASK-CONTEXT-VALIDATION.json',{
  schema:'agent-sdlc/task-context-validation/v1',
  version:VERSION,
  invariant:'one bounded task -> one bounded context package -> one primary writer',
  manifest_schema:'agent-sdlc/task-context-manifest/v1',
  excluded_by_default:EXCLUDED_BY_DEFAULT,
  workspace:{
    modes:WORKSPACE_MODES,
    one_writer_per_task:true,
    evidence_binding:'base revision + workspace diff hash',
    cleanup_refuses_unpersisted_evidence:true,
    production_credentials_stripped:true
  },
  budget:'derived from the active stage budget in policies/stage-policy.json, narrowed to the task',
  replayability:'context_hash excludes created_at, so identical inputs produce an identical hash',
  ...block('context'),
  live_qualification:'PENDING_LIVE_QUALIFICATION'
});

out('TASK-REVIEW-VALIDATION.json',{
  schema:'agent-sdlc/task-review-validation/v1',
  version:VERSION,
  contracts:['agent-sdlc/task-verification/v1','agent-sdlc/spec-compliance-review/v1','agent-sdlc/code-quality-review/v1'],
  verification:{
    ladder:['TARGETED','AFFECTED_INTEGRATION','BROAD_SUITE'],
    required_before_done:true,
    bound_to:['base_revision','diff_hash','attempt'],
    worker_self_claim_accepted:false
  },
  reviews:{
    two_distinct_contracts:true,
    order:['SPEC_REVIEW','QUALITY_REVIEW'],
    blocking_finding_blocks_done:true,
    independence:'recorded truthfully; an achieved claim contradicting its mode is rejected, and an unachieved claim requires a recorded limitation'
  },
  ...block('verification_review'),
  live_qualification:'PENDING_LIVE_QUALIFICATION'
});

out('TASK-RECOVERY-VALIDATION.json',{
  schema:'agent-sdlc/task-recovery-validation/v1',
  version:VERSION,
  retry_invariant:failurePolicy.retry_invariant,
  failure_classes:FAILURE_CLASSES,
  policy:{
    default_max_retries:failurePolicy.default_max_retries,
    profile_max_retries:failurePolicy.profile_max_retries,
    infrastructure_max_retries:failurePolicy.infrastructure_max_retries,
    actions:Object.fromEntries(Object.entries(failurePolicy.classes).map(([k,v])=>[k,{action:v.action,to:v.to,requires_new_evidence:!!v.requires_new_evidence}]))
  },
  outer_boundary:'the task engine never mutates outer run state; it reports the required escalation and the orchestrator performs it',
  provider_fallback:{
    checkpoint_schema:'agent-sdlc/task-checkpoint/v1',
    transfers:['context manifest ref','base revision','diff hash','artifact refs','evidence refs','review refs','failure class'],
    never_transfers:['provider_conversation_history','hidden_chain_of_thought','worker_scratch_reasoning']
  },
  ...block('recovery'),
  live_qualification:'PENDING_LIVE_QUALIFICATION'
});

const summary={
  schema:'agent-sdlc/task-runtime-validation-summary/v1',
  version:VERSION,
  groups:suite.groups.map(g=>({group:g.group,checks:g.checks,passes:g.passes,failures:g.failures})),
  checks:suite.checks,passes:suite.passes,failures:suite.failures,
  evidence:[
    'evals/TASK-ENGINE-VALIDATION.json',
    'evals/TASK-SCHEDULER-VALIDATION.json',
    'evals/TASK-CONTEXT-VALIDATION.json',
    'evals/TASK-REVIEW-VALIDATION.json',
    'evals/TASK-RECOVERY-VALIDATION.json'
  ],
  status:suite.failures?'FAIL':'PASS'
};
console.log(JSON.stringify(summary,null,2));
process.exit(suite.failures?1:0);
