// Predictive Budgeting & Pre-Flight Cost Simulator for Agent SDLC Harness.
import {listTasks} from './store.mjs';
import {taskComplexity,historicalSuccessRate,getGovernancePolicy} from './governor.mjs';

const DEFAULT_PRICING = {
  ECONOMY: { input_per_m: 0.15, output_per_m: 0.60, cache_read_per_m: 0.075 },
  STANDARD: { input_per_m: 3.00, output_per_m: 15.00, cache_read_per_m: 1.50 },
  HIGH_REASONING: { input_per_m: 15.00, output_per_m: 60.00, cache_read_per_m: 7.50 }
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
 * Simulate DAG concurrency, critical path, and wall-clock execution time.
 */
export function simulateDAGConcurrency(tasks, { maxConcurrency = 4 } = {}) {
  if (!Array.isArray(tasks) || tasks.length === 0) {
    return {
      sequential_duration_s: 0,
      concurrent_duration_s: 0,
      speedup_factor: 1.0,
      concurrency_limit: maxConcurrency,
      critical_path: [],
      waves: []
    };
  }

  const taskMap = new Map(tasks.map(t => [t.task_id, t]));
  const inDegree = new Map();
  const adj = new Map();

  for (const t of tasks) {
    inDegree.set(t.task_id, 0);
    adj.set(t.task_id, []);
  }

  for (const t of tasks) {
    const deps = Array.isArray(t.depends_on) ? t.depends_on : [];
    for (const d of deps) {
      if (adj.has(d)) {
        adj.get(d).push(t.task_id);
        inDegree.set(t.task_id, (inDegree.get(t.task_id) || 0) + 1);
      }
    }
  }

  // Group tasks into parallel execution waves
  const waves = [];
  const remainingInDegree = new Map(inDegree);
  let available = tasks.filter(t => (remainingInDegree.get(t.task_id) || 0) === 0).map(t => t.task_id);

  let seqDuration = 0;
  for (const t of tasks) {
    const dur = t.duration_s || 30;
    seqDuration += dur;
  }

  let concurrentDuration = 0;
  while (available.length > 0) {
    const currentWave = available.slice(0, maxConcurrency);
    waves.push(currentWave);

    const waveMaxDur = Math.max(...currentWave.map(id => taskMap.get(id)?.duration_s || 30));
    concurrentDuration += waveMaxDur;

    const nextAvailable = available.slice(maxConcurrency);
    for (const taskId of currentWave) {
      for (const nextId of adj.get(taskId) || []) {
        const deg = (remainingInDegree.get(nextId) || 1) - 1;
        remainingInDegree.set(nextId, deg);
        if (deg === 0) {
          nextAvailable.push(nextId);
        }
      }
    }
    available = nextAvailable;
  }

  const speedup = concurrentDuration > 0
    ? Number((seqDuration / concurrentDuration).toFixed(2))
    : 1.0;

  return {
    sequential_duration_s: seqDuration,
    concurrent_duration_s: concurrentDuration,
    speedup_factor: speedup,
    concurrency_limit: maxConcurrency,
    wave_count: waves.length,
    waves
  };
}

/**
 * Calculate potential token and cost savings from prompt caching.
 */
export function calculatePromptCacheSavings(expectedStats, {
  cacheHitRatio = 0.70,
  cacheDiscountRatio = 0.50,
  pricingTier = 'STANDARD',
  pricing = DEFAULT_PRICING
} = {}) {
  const rates = pricing[pricingTier] || pricing.STANDARD;
  const promptTokens = expectedStats.prompt_tokens || 0;

  const cachedPromptTokens = Math.round(promptTokens * cacheHitRatio);
  const uncachedPromptTokens = promptTokens - cachedPromptTokens;

  const standardPromptCost = (promptTokens / 1_000_000) * rates.input_per_m;
  const discountedPromptCost = ((uncachedPromptTokens / 1_000_000) * rates.input_per_m) +
                               ((cachedPromptTokens / 1_000_000) * (rates.cache_read_per_m || (rates.input_per_m * (1 - cacheDiscountRatio))));

  const savingsUsd = Math.max(0, standardPromptCost - discountedPromptCost);

  return {
    enabled: true,
    cache_hit_ratio: cacheHitRatio,
    cached_prompt_tokens: cachedPromptTokens,
    uncached_prompt_tokens: uncachedPromptTokens,
    standard_prompt_cost_usd: Number(standardPromptCost.toFixed(4)),
    optimized_prompt_cost_usd: Number(discountedPromptCost.toFixed(4)),
    estimated_savings_usd: Number(savingsUsd.toFixed(4)),
    savings_percentage: standardPromptCost > 0 ? Number(((savingsUsd / standardPromptCost) * 100).toFixed(1)) : 0
  };
}

/**
 * Generate cost and performance optimization recommendations.
 */
export function generateOptimizationRecommendations({
  expCost,
  maxBudgetUsd,
  concurrency,
  tasksWithTiers = []
} = {}) {
  const recommendations = [];

  if (expCost > maxBudgetUsd) {
    recommendations.push({
      type: 'BUDGET_DEFICIT',
      priority: 'HIGH',
      message: `Projected cost ($${expCost.toFixed(2)}) exceeds budget ($${maxBudgetUsd.toFixed(2)}). Consider downgrading model tiers or limiting task scopes.`
    });
  }

  const highReasoningCount = tasksWithTiers.filter(t => t.tier === 'HIGH_REASONING').length;
  if (highReasoningCount > 2) {
    recommendations.push({
      type: 'MODEL_TIER_OPTIMIZATION',
      priority: 'MEDIUM',
      message: `${highReasoningCount} tasks are using HIGH_REASONING. Inspect if sub-tasks can use STANDARD tier to reduce token costs by ~70%.`
    });
  }

  if (concurrency && concurrency.speedup_factor > 1.5) {
    recommendations.push({
      type: 'CONCURRENCY_OPPORTUNITY',
      priority: 'LOW',
      message: `Enabling parallel execution (limit=${concurrency.concurrency_limit}) yields ${concurrency.speedup_factor}x wall-clock speedup.`
    });
  }

  return recommendations;
}

/**
 * Simulate run execution budget across all tasks in DAG.
 */
export function simulateRunBudget(root, projectRoot, run, {
  tasks = null,
  pricing = DEFAULT_PRICING,
  maxConcurrency = 4,
  cacheHitRatio = 0.70
} = {}) {
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
      duration_s: taskExpDuration,
      depends_on: task.depends_on || [],
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

  // Concurrency & Prompt Cache simulations
  const concurrency = simulateDAGConcurrency(taskSimulations, { maxConcurrency });
  const cacheSavings = calculatePromptCacheSavings({ prompt_tokens: expPrompt }, { cacheHitRatio, pricing });
  const recommendations = generateOptimizationRecommendations({
    expCost,
    maxBudgetUsd,
    concurrency,
    tasksWithTiers: taskSimulations
  });

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
    concurrency_analysis: concurrency,
    prompt_cache_savings: cacheSavings,
    recommendations,
    budget_guard: {
      configured_budget_usd: maxBudgetUsd,
      configured_max_turns: maxTurns,
      within_budget: warnings.length === 0,
      warnings
    },
    task_breakdown: taskSimulations
  };
}
