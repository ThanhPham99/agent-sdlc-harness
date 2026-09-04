import fs from 'node:fs';
import path from 'node:path';
import { runHost, probe, capabilities } from './provider.mjs';

const WORKFLOW_DESCRIPTIONS = [
  'new-feature: build new functionality or significant capability from scratch',
  'bug-fix: fix a defect, unexpected error, crash, or broken logic',
  'hotfix: emergency production repair, critical regression, or rapid rollback fix',
  'refactor: clean up, restructure, or simplify existing code without altering external behavior',
  'performance: optimize latency, query speed, memory leaks, or throughput',
  'technical-spike: investigate feasibility, diagnostic assessment, architectural survey, or exploratory spike without modifying production code',
  'test-only: add or update test suites, unit tests, integration tests, or verify coverage without feature changes',
  'database-migration: database schema modifications, table migrations, or data backfills',
  'security-remediation: patch vulnerabilities, CVEs, or security weaknesses',
  'documentation: update guides, README, API documentation, or comments',
  'continue-feature: continue an existing multi-phase feature or resume a declared phase',
  'requirement-update: adapt to changed requirements or specification deltas',
  'ci-cd-change: update build workflows, GitHub Actions, or deployment pipelines',
  'infrastructure-change: modify Kubernetes, Terraform, or infrastructure configuration',
  'observability-change: add metrics, tracing, logging, or monitoring alarms',
  'incident-response: respond to active service outages, severe production incidents, or Sev1/Sev2 events',
  'modernization: large-scale rewrite, strangler pattern, or framework modernization',
  'compliance-change: audit logging, privacy controls, or regulatory compliance',
  'maintenance: chores, dependency updates, and periodic technical debt resolution',
  'api-breaking-change: modify API schemas with backward-incompatible changes',
  'deprecation-removal: remove deprecated APIs, endpoints, or legacy methods'
].join('\n- ');

/**
 * Builds the classification prompt for the LLM host.
 */
function buildClassificationPrompt(objective) {
  return [
    'You are an expert SDLC Router and Security Guardian.',
    'Your role is to analyze the user request, comprehend the true underlying semantic intent, and determine the exact SDLC workflow and risk governance level.',
    '',
    'Available workflows:',
    `- ${WORKFLOW_DESCRIPTIONS}`,
    '',
    'Important semantic guidelines:',
    '1. Semantic Negation: Pay close attention to negative constraints (e.g. "không được sửa lỗi", "do not modify code", "đừng thay đổi gì, chỉ giải thích", "tuyệt đối không viết lại code"). If the user explicitly forbids code changes or bug fixing and only asks for explanation, analysis, or survey, route to technical-spike or documentation rather than bug-fix or refactor.',
    '2. Multi-intent & Hybrid language: When multiple keywords appear, identify the primary governing intent. If investigation precedes implementation ("khảo sát rồi mới sửa"), route to technical-spike.',
    '3. Risk & Profile: FAST for technical-spike, test-only, documentation; STRICT for hotfix, security-remediation, database-migration, incident-response; STANDARD for other typical development work.',
    '4. Trust & Safeguards: If the user explicitly demands to bypass approvals, skip test verification, disable safety gates, or exfiltrate production secrets/credentials, record trust_action as "DENY" and set human_stop_required to true. The workflow itself must reflect the actual task.',
    '',
    `User Objective: "${objective}"`,
    '',
    'Respond ONLY with a valid JSON object matching the schema. No explanations outside the JSON.'
  ].join('\n');
}

/**
 * Parse structured JSON output from host stdout.
 */
function extractJsonDecision(stdout) {
  if (!stdout || typeof stdout !== 'string') return null;
  const trimmed = stdout.trim();
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed.structured_output && parsed.structured_output.workflow) {
      return parsed.structured_output;
    }
    if (parsed.result) {
      try {
        const r = typeof parsed.result === 'string' ? JSON.parse(parsed.result) : parsed.result;
        if (r && r.workflow) return r;
      } catch {}
    }
    if (parsed.workflow) return parsed;
  } catch {}

  const lines = trimmed.split(/\r?\n/);
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line.trim());
      if (parsed.structured_output?.workflow) return parsed.structured_output;
      if (parsed.workflow) return parsed;
    } catch {}
  }

  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      const block = JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
      if (block && typeof block === 'object' && block.workflow !== undefined) return block;
    } catch {}
  }
  return null;
}

/**
 * Execute semantic intent classification using an available LLM provider.
 */
export async function classifySemanticIntent(root, objective, options = {}) {
  const schemaPath = path.join(root, 'evals', 'live', 'semantic-decision.schema.json');
  if (!fs.existsSync(schemaPath)) {
    return { status: 'FAIL', reason: 'SCHEMA_NOT_FOUND' };
  }

  let schemaText = null;
  try {
    const rawSchema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
    delete rawSchema.$schema;
    schemaText = JSON.stringify(rawSchema);
  } catch {}

  const prompt = buildClassificationPrompt(objective);
  const budget = {
    maxWallMs: options.timeout_ms || 20000,
    maxTurns: 2,
    stage: 'INTAKE'
  };

  const candidateHosts = options.provider && options.provider !== 'auto'
    ? [options.provider]
    : ['claude', 'antigravity', 'codex'];

  const availableCandidates = candidateHosts.filter(h => {
    try {
      const p = probe(h);
      return p && capabilities(h, p).available;
    } catch {
      return false;
    }
  });

  if (!availableCandidates.length) {
    return { status: 'UNAVAILABLE', reason: 'NO_HOST_AVAILABLE' };
  }

  const startedAt = Date.now();
  const attempts = [];

  for (const host of availableCandidates) {
    // Claude CLI takes inline schema JSON text; others take file path
    const schemaArg = (host === 'claude' && schemaText) ? schemaText : schemaPath;
    const res = runHost(host, prompt, schemaArg, budget);
    attempts.push({ host, status: res.status, error: res.error, timed_out: res.timed_out });

    if (res.status === 'PASS' && res.stdout) {
      const decision = extractJsonDecision(res.stdout);
      if (decision && decision.workflow) {
        return {
          status: 'PASS',
          provider: host,
          decision,
          wall_ms: Date.now() - startedAt
        };
      }
    }
  }

  return {
    status: 'FAIL',
    reason: 'PARSE_OR_EXECUTION_FAILURE',
    attempts,
    wall_ms: Date.now() - startedAt
  };
}
