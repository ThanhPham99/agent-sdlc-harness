// Statistical control bands evaluator (Stage 6: Maintain).
//
// Invariants:
// - Detection stays strictly deterministic (pure math, no model in detection path);
// - 1-sigma logs, 2-sigma diagnoses (read-only), 3-sigma proposes action;
// - 3-sigma breach writes an intent proto-spec into .agent-sdlc/intent/ to close the loop.
import fs from 'node:fs';
import path from 'node:path';
import {now} from './util.mjs';

/**
 * Compute sample mean and standard deviation.
 */
export function calculateStats(series = []) {
  const nums = series.map(Number).filter(n => Number.isFinite(n));
  if (!nums.length) return { mean: 0, stddev: 0, count: 0 };
  const mean = nums.reduce((acc, v) => acc + v, 0) / nums.length;
  if (nums.length === 1) return { mean, stddev: 0, count: 1 };
  const variance = nums.reduce((acc, v) => acc + Math.pow(v - mean, 2), 0) / (nums.length - 1);
  return { mean, stddev: Math.sqrt(variance), count: nums.length };
}

/**
 * Evaluate a metric value against baseline and return control band classification.
 */
export function evaluateControlBand({ metric = 'unknown', baseline = [], current = 0 } = {}) {
  const { mean, stddev, count } = calculateStats(baseline);
  const val = Number(current);
  let sigmaScore = 0;
  if (stddev > 0) {
    sigmaScore = (val - mean) / stddev;
  } else if (count > 0 && val !== mean) {
    sigmaScore = val > mean ? 3.5 : -3.5;
  }

  const absZ = Math.abs(sigmaScore);
  let tier = 'NORMAL';
  let action = 'none';

  if (absZ >= 3.0) {
    tier = '3sigma';
    action = 'propose';
  } else if (absZ >= 2.0) {
    tier = '2sigma';
    action = 'diagnose';
  } else if (absZ >= 1.0) {
    tier = '1sigma';
    action = 'log';
  }

  return {
    schema: 'agent-sdlc/control-band-result/v1',
    metric,
    current_value: val,
    baseline_stats: { mean, stddev, count },
    sigma_score: Number(sigmaScore.toFixed(2)),
    tier,
    action,
    breach: absZ >= 3.0,
    evaluated_at: now()
  };
}

/**
 * Format a 3-sigma anomaly breach into an intent.md proto-spec for Stage 1 intake.
 */
export function formatAnomalyIntent({ metric, result, workflow = 'incident' } = {}) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  return `# Intent: Automated Anomaly Remediation for ${metric}
Author: Control-Band Monitor (autonomous-maintain). Status: draft.

## Problem

Metric \`${metric}\` breached statistical control bands at ${result.evaluated_at}.
Current reading: ${result.current_value} (baseline mean: ${result.baseline_stats.mean.toFixed(2)}, stddev: ${result.baseline_stats.stddev.toFixed(2)}, deviation: ${result.sigma_score} sigma).
This exceeds the 3-sigma threshold, indicating an operational anomaly or systematic regression.

## Proposed outcome

- Diagnose root cause of \`${metric}\` anomaly.
- Restore metric to within nominal 1-sigma control band.
- Validate fix with targeted regression evals.

## Affected users and systems

- Affected metric: \`${metric}\`
- Target workflow: \`${workflow}\`
- Severity: ACTIONABLE_BREACH (3-sigma)

## Constraints

- Diagnostic investigation must be non-destructive.
- Fix must not compromise existing security or SLA invariants.

## Open questions

1. Was this anomaly triggered by a recent release or external dependency outage?
2. Does this breach require immediate human on-call escalation?
`;
}

/**
 * Run evaluation and emit intent file if breach is >= 3-sigma.
 */
export function processMetricAnomaly(projectRoot, { metric, baseline, current, workflow = 'incident' } = {}) {
  const result = evaluateControlBand({ metric, baseline, current });
  let intentPath = null;
  if (result.breach) {
    const intentDir = path.join(projectRoot, '.agent-sdlc', 'intent');
    if (!fs.existsSync(intentDir)) fs.mkdirSync(intentDir, { recursive: true });
    const filename = `anomaly-${metric}-${Date.now()}.md`;
    intentPath = path.join(intentDir, filename);
    const content = formatAnomalyIntent({ metric, result, workflow });
    fs.writeFileSync(intentPath, content, 'utf8');
  }
  return { ...result, intent_path: intentPath };
}
