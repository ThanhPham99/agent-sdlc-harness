// Predictive Budgeting & Pre-Flight Cost Simulator for Agent SDLC Harness.
import {listTasks} from './store.mjs';
import {taskComplexity,historicalSuccessRate,getGovernancePolicy} from './governor.mjs';

const DEFAULT_PRICING = {
  ECONOMY: { input_per_m: 0.15, output_per_m: 0.60 },
  STANDARD: { input_per_m: 3.00, output_per_m: 15.00 },
  HIGH_REASONING: { input_per_m: 15.00, output_per_m: 60.00 }
};

const BASELINE_TOKENS = {
  LOW: { prompt: 4000, completion: 1000, turns: 1, duration_s: 15 },
  MEDIUM: { prompt: 12000, completion: 3000, turns: 2, duration_s: 45 },
  HIGH: { prompt: 35000, completion: 8000, turns: 4, duration_s: 120 }
};

/**
 * Calculate token and USD estimate for a single task execution attempt.
 */
export function estimateTaskAttempt(complexityLevel, tier = 'STANDARD', pricing = DEFAULT_PRICING) {
  const level = BASELINE_TOKENS[complexityLevel] || BASELINE_TOKENS.MEDIUM;
  const rates = pricing[tier] || pricing.STANDARD;

  const costUsd = (level.prompt / 1_000_000 * rates.input_per_m) +
                  (level.completion / 1_000_000 * rates.output_per_m);

  return {
    prompt_tokens: level.prompt,
    completion_tokens: level.completion,
    total_tokens: level.prompt + level.completion,
    turns: level.turns,
    duration_s: level.duration_s,
    cost_usd: Number(costUsd.toFixed(5))
  };
}

/**
 * Simulate run execution budget across all tasks in DAG.
 */
export function simulateRunBudget(root, projectRoot, run, { tasks = null, pricing = DEFAULT_PRICING } = {}) {
  const taskList = tasks || listTasks(projectRoot, run.run_id);
  const successStats = historicalSuccessRate(projectRoot, run.run_id);
  const successRate = successStats.rate !== null ? successStats.rate : 0.85; // default 85% first-try success

  const retryMultiplier = 1 + (1 - successRate);
  const maxRetries = 3;

  const taskSimulations = [];
  let bestPrompt = 0, bestCompletion = 0, bestCost = 0, bestTurns = 0, bestDuration = 0;
  let expPrompt = 0, expCompletion = 0, expCost = 0, expTurns = 0, expDuration = 0;
  let worstPrompt = 0, worstCompletion = 0, worstCost = 0, worstTurns = 0, worstDuration = 0;

  for (const task of taskList) {
    const comp = taskComplexity(root, task);
    const tier = comp.level === 'HIGH' ? 'HIGH_REASONING' : comp.level === 'MEDIUM' ? 'STANDARD' : 'ECONOMY';
    const single = estimateTaskAttempt(comp.level, tier, pricing);

    // Accumulate best case (1 attempt)
    bestPrompt += single.prompt_tokens;
    bestCompletion += single.completion_tokens;
    bestCost += single.cost_usd;
    bestTurns += single.turns;
    bestDuration += single.duration_s;

    // Accumulate expected case
    const taskExpPrompt = Math.round(single.prompt_tokens * retryMultiplier);
    const taskExpComp = Math.round(single.completion_tokens * retryMultiplier);
    const taskExpCost = single.cost_usd * retryMultiplier;
    const taskExpTurns = Math.ceil(single.turns * retryMultiplier);
    const taskExpDuration = Math.round(single.duration_s * retryMultiplier);

    expPrompt += taskExpPrompt;
    expCompletion += taskExpComp;
    expCost += taskExpCost;
    expTurns += taskExpTurns;
    expDuration += taskExpDuration;

    // Accumulate worst case (max retries)
    worstPrompt += single.prompt_tokens * maxRetries;
    worstCompletion += single.completion_tokens * maxRetries;
    worstCost += single.cost_usd * maxRetries;
    worstTurns += single.turns * maxRetries;
    worstDuration += single.duration_s * maxRetries;

    taskSimulations.push({
      task_id: task.task_id,
      title: task.title,
      complexity: comp.level,
      tier,
      estimate_single: single,
      estimate_expected: {
        total_tokens: taskExpPrompt + taskExpComp,
        cost_usd: Number(taskExpCost.toFixed(5)),
        turns: taskExpTurns,
        duration_s: taskExpDuration
      }
    });
  }

  const warnings = [];
  const maxBudgetUsd = run.budget?.max_usd || 10.0;
  const maxTurns = run.budget?.max_turns || 50;

  if (expCost > maxBudgetUsd) {
    warnings.push(`Expected cost ($${expCost.toFixed(2)}) exceeds configured budget ($${maxBudgetUsd.toFixed(2)})`);
  }
  if (expTurns > maxTurns) {
    warnings.push(`Expected turns (${expTurns}) exceed configured turn limit (${maxTurns})`);
  }

  return {
    schema: 'agent-sdlc/simulation/v1',
    run_id: run.run_id,
    task_count: taskList.length,
    historical_first_try_success_rate: successRate,
    best_case: {
      prompt_tokens: bestPrompt,
      completion_tokens: bestCompletion,
      total_tokens: bestPrompt + bestCompletion,
      cost_usd: Number(bestCost.toFixed(4)),
      turns: bestTurns,
      duration_s: bestDuration
    },
    expected: {
      prompt_tokens: expPrompt,
      completion_tokens: expCompletion,
      total_tokens: expPrompt + expCompletion,
      cost_usd: Number(expCost.toFixed(4)),
      turns: expTurns,
      duration_s: expDuration
    },
    worst_case: {
      prompt_tokens: worstPrompt,
      completion_tokens: worstCompletion,
      total_tokens: worstPrompt + worstCompletion,
      cost_usd: Number(worstCost.toFixed(4)),
      turns: worstTurns,
      duration_s: worstDuration
    },
    budget_guard: {
      configured_budget_usd: maxBudgetUsd,
      configured_max_turns: maxTurns,
      within_budget: warnings.length === 0,
      warnings
    },
    task_breakdown: taskSimulations
  };
}
