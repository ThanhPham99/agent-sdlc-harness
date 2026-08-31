#!/usr/bin/env node
// Test suite for Predictive Budgeting & Pre-Flight Cost Simulator.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {
  estimateTaskAttempt,
  simulateDAGConcurrency,
  calculatePromptCacheSavings,
  generateOptimizationRecommendations,
  simulateRunBudget
} from '../runtime/simulator.mjs';
import {initProject, saveRun, saveTask} from '../runtime/store.mjs';
import {createSuite} from './lib/suite.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const {test, assert, finish} = createSuite('agent-sdlc/simulator-validation/v1', 'SIMULATOR-VALIDATION.json');

await test('estimate-task-attempt-pricing-tiers', () => {
  const low = estimateTaskAttempt('LOW', 'ECONOMY');
  assert(low.prompt_tokens === 4000, 'low prompt tokens mismatch');
  assert(low.cost_usd > 0 && low.cost_usd < 0.01, 'economy cost should be very low');

  const high = estimateTaskAttempt('HIGH', 'HIGH_REASONING');
  assert(high.prompt_tokens === 35000, 'high prompt tokens mismatch');
  assert(high.cost_usd > low.cost_usd * 50, 'high reasoning cost should be significantly higher');
});

await test('simulate-dag-concurrency-waves-and-speedup', () => {
  const tasks = [
    { task_id: 't1', title: 'Init', duration_s: 20, depends_on: [] },
    { task_id: 't2', title: 'Build A', duration_s: 30, depends_on: ['t1'] },
    { task_id: 't3', title: 'Build B', duration_s: 40, depends_on: ['t1'] },
    { task_id: 't4', title: 'Integrate', duration_s: 20, depends_on: ['t2', 't3'] }
  ];

  const res = simulateDAGConcurrency(tasks, { maxConcurrency: 2 });
  assert(res.sequential_duration_s === 110, 'sequential duration should be 20+30+40+20=110');
  assert(res.concurrent_duration_s === 80, 'concurrent duration should be 20+max(30,40)+20=80');
  assert(res.speedup_factor > 1.3, 'speedup factor should be > 1.3x');
  assert(res.wave_count === 3, 'should have 3 waves');
});

await test('calculate-prompt-cache-savings', () => {
  const stats = { prompt_tokens: 100_000 };
  const savings = calculatePromptCacheSavings(stats, {
    cacheHitRatio: 0.80,
    cacheDiscountRatio: 0.50,
    pricingTier: 'STANDARD'
  });

  assert(savings.enabled === true, 'cache savings should be enabled');
  assert(savings.cached_prompt_tokens === 80_000, 'cached prompt tokens should be 80k');
  assert(savings.estimated_savings_usd > 0, 'savings USD should be positive');
  assert(savings.savings_percentage > 30, 'savings percentage should be > 30%');
});

await test('simulate-run-budget-end-to-end', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-sdlc-sim-'));
  initProject(d, { schema: 'agent-sdlc/project/v1', project: 'sim-test' });

  execFileSync('git', ['init', '-q'], { cwd: d });
  execFileSync('git', ['add', '.'], { cwd: d });
  execFileSync('git', ['-c', 'user.email=test@test.local', '-c', 'user.name=Tester', 'commit', '-qm', 'init'], { cwd: d });

  const run = {
    schema: 'agent-sdlc/run/v1',
    run_id: 'run-sim-test-1',
    objective: 'Refactor and test authentication',
    budget: { max_usd: 5.0, max_turns: 20 }
  };
  saveRun(d, run);

  saveTask(d, {
    schema: 'agent-sdlc/task/v1',
    run_id: run.run_id,
    task_id: 'TASK-001',
    title: 'Update schema',
    prompt: 'Short prompt'
  });

  saveTask(d, {
    schema: 'agent-sdlc/task/v1',
    run_id: run.run_id,
    task_id: 'TASK-002',
    title: 'Migrate DB',
    prompt: 'Long prompt with dependencies',
    depends_on: ['TASK-001']
  });

  const sim = simulateRunBudget(ROOT, d, run, { maxConcurrency: 2 });
  assert(sim.run_id === run.run_id, 'run_id mismatch');
  assert(sim.task_count === 2, 'task count mismatch');
  assert(sim.expected.cost_usd > 0, 'expected cost should be positive');
  assert(sim.budget_guard.within_budget === true, 'should be within budget');
  assert(sim.concurrency_analysis.wave_count === 2, 'should have 2 waves for sequential deps');
  assert(sim.prompt_cache_savings.estimated_savings_usd >= 0, 'cache savings should be present');
});

finish();

