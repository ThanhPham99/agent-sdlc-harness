#!/usr/bin/env node
// Test suite for Budget Circuit Breaker and Cost Governor.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {evaluateBudgetCircuitBreaker} from '../runtime/governor.mjs';
import {initProject} from '../runtime/store.mjs';
import {newRun} from '../runtime/orchestrator.mjs';
import {route} from '../runtime/router.mjs';
import {addUsage} from '../runtime/cost.mjs';
import {createSuite} from './lib/suite.mjs';
import {makeTempDir} from './lib/tempdir.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const {test,assert,finish}=createSuite('agent-sdlc/budget-governor-validation/v1','BUDGET-GOVERNOR-VALIDATION.json');

function fixture(){
  const d=makeTempDir('agent-sdlc-budget-');
  execFileSync('git',['init','-q'],{cwd:d});
  fs.writeFileSync(path.join(d,'README.md'),'fixture\n');
  execFileSync('git',['add','.'],{cwd:d});
  execFileSync('git',['-c','user.email=test@test.local','-c','user.name=Tester','commit','-qm','init'],{cwd:d});
  initProject(d,{
    schema:'agent-sdlc/project/v1',
    project:'budget-fixture',
    commands:{test_full:['node','-e','process.exit(0)']},
    context:{project_invariants:['do not edit generated files']}
  });
  return d;
}

await test('budget-status-ok-when-below-limits',()=>{
  const d=fixture();
  const r=route(ROOT,'Budget normal');
  const run=newRun(ROOT,d,{objective:'Budget normal',route:r});

  const res=evaluateBudgetCircuitBreaker(d,run.run_id,{
    budgetLimits:{max_cost_usd:10.0,max_tokens:100000}
  });
  assert(res.tripped===false,'circuit breaker should not trip');
  assert(res.status==='BUDGET_OK','status should be BUDGET_OK');
});

await test('budget-trips-when-cost-exceeds-limit',()=>{
  const d=fixture();
  const r=route(ROOT,'Budget cost trip');
  const run=newRun(ROOT,d,{objective:'Budget cost trip',route:r});

  // Record 200,000 output tokens (~$3.00 estimated)
  addUsage(d,run,{
    task_id:'TASK-001',
    input_tokens:100000,
    output_tokens:200000
  });

  const res=evaluateBudgetCircuitBreaker(d,run.run_id,{
    budgetLimits:{max_cost_usd:1.00,max_tokens:10000000}
  });
  assert(res.tripped===true,'circuit breaker should trip on cost');
  assert(res.status==='CIRCUIT_BREAKER_TRIPPED','status should be CIRCUIT_BREAKER_TRIPPED');
  assert(res.reasons.some(r=>r.includes('exceeds max budget $1')),'missing cost reason');
});

await test('budget-trips-when-tokens-exceed-limit',()=>{
  const d=fixture();
  const r=route(ROOT,'Budget token trip');
  const run=newRun(ROOT,d,{objective:'Budget token trip',route:r});

  // Record usage with 50,000 tokens
  addUsage(d,run,{
    task_id:'TASK-002',
    input_tokens:30000,
    output_tokens:20000
  });

  const res=evaluateBudgetCircuitBreaker(d,run.run_id,{
    budgetLimits:{max_cost_usd:50.0,max_tokens:25000}
  });
  assert(res.tripped===true,'circuit breaker should trip on tokens');
  assert(res.reasons.some(r=>r.includes('exceeds max budget 25,000')),'missing token reason');
});

finish();