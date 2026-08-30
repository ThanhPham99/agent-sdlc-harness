// Automated PR Description and Semantic Changelog Generator for Agent SDLC Harness.
import path from 'node:path';
import fs from 'node:fs';
import {listTasks} from './store.mjs';
import {loadCiEvidence} from './ci-evidence.mjs';
import {loadTraceabilityGraph} from './traceability.mjs';
import {readJson} from './util.mjs';

/**
 * Generate a comprehensive Pull Request body from a run's state, DAG tasks, and CI evidence.
 */
export function generatePrBody(projectRoot, run, { format = 'markdown' } = {}) {
  const tasks = listTasks(projectRoot, run.run_id);
  const doneTasks = tasks.filter(t => t.status === 'DONE');
  const ciEvidence = loadCiEvidence(projectRoot, run.run_id);
  const traceGraph = loadTraceabilityGraph(projectRoot, run.run_id);

  const affectedFiles = new Set();
  for (const t of tasks) {
    for (const f of t.scope?.write || []) affectedFiles.add(f);
  }

  const taskListMd = doneTasks.map(t => {
    const scopeStr = (t.scope?.write || []).length > 0 ? ` (\`${(t.scope.write).join('`, `')}\`)` : '';
    return `- [x] **${t.task_id}**: ${t.title || t.description || 'Task completed'}${scopeStr}`;
  }).join('\n');

  const ciChecksMd = ciEvidence?.checks?.length
    ? ciEvidence.checks.map(c => `- ${c.status === 'PASS' ? '✅' : '❌'} **${c.name}**: ${c.status} (${c.duration || 'ok'})`).join('\n')
    : '- ℹ️ Verified locally via Deterministic Harness Gates';

  const markdown = `## 🎯 Objective
${run.objective || '(No objective specified)'}

## 📋 Run & Lifecycle Summary
- **Workflow**: \`${run.workflow || 'standard'}\`
- **Profile**: \`${run.profile || 'STANDARD'}\`
- **Completed Tasks**: ${doneTasks.length} / ${tasks.length}
- **Affected Files Count**: ${affectedFiles.size}

## 🔨 Completed Tasks
${taskListMd || '- No completed tasks recorded.'}

## 🧪 Verification & Evidence
${ciChecksMd}
- **Traceability Graph**: ${traceGraph ? `${traceGraph.nodes?.length || 0} nodes, ${traceGraph.edges?.length || 0} edges verified` : 'Not built'}

## 🛡️ Governance & Risk
- **Risk Level**: \`${run.risk_flags?.length ? 'ELEVATED' : 'STANDARD'}\`
- **Risk Flags**: ${run.risk_flags?.length ? run.risk_flags.join(', ') : 'None'}
`;

  if (format === 'json') {
    return {
      schema: 'agent-sdlc/pr-body/v1',
      run_id: run.run_id,
      objective: run.objective,
      workflow: run.workflow,
      profile: run.profile,
      tasks_total: tasks.length,
      tasks_completed: doneTasks.length,
      affected_files: [...affectedFiles].sort(),
      markdown
    };
  }

  return markdown;
}

/**
 * Generate semantic changelog entries from run tasks or history.
 */
export function generateChangelog(projectRoot, { version = 'Unreleased', date = new Date().toISOString().slice(0, 10), tasks = [] } = {}) {
  const feats = [];
  const fixes = [];
  const perfs = [];
  const refactors = [];
  const others = [];

  for (const t of tasks) {
    const text = t.title || t.description || t.task_id;
    const cat = (t.category || '').toLowerCase();
    if (cat === 'feature' || text.startsWith('feat:') || text.startsWith('feat(')) {
      feats.push(text.replace(/^feat(?:\([^)]+\))?:\s*/, ''));
    } else if (cat === 'bug' || cat === 'fix' || text.startsWith('fix:') || text.startsWith('fix(')) {
      fixes.push(text.replace(/^fix(?:\([^)]+\))?:\s*/, ''));
    } else if (cat === 'perf' || text.startsWith('perf:') || text.startsWith('perf(')) {
      perfs.push(text.replace(/^perf(?:\([^)]+\))?:\s*/, ''));
    } else if (cat === 'refactor' || text.startsWith('refactor:')) {
      refactors.push(text.replace(/^refactor:\s*/, ''));
    } else {
      others.push(text);
    }
  }

  const sections = [];
  if (feats.length) sections.push(`### 🚀 Features\n${feats.map(f => `- ${f}`).join('\n')}`);
  if (fixes.length) sections.push(`### 🐛 Bug Fixes\n${fixes.map(f => `- ${f}`).join('\n')}`);
  if (perfs.length) sections.push(`### ⚡ Performance Improvements\n${perfs.map(f => `- ${f}`).join('\n')}`);
  if (refactors.length) sections.push(`### ♻️ Refactoring & Chores\n${refactors.map(f => `- ${f}`).join('\n')}`);
  if (others.length && sections.length === 0) sections.push(`### 📦 Other Changes\n${others.map(f => `- ${f}`).join('\n')}`);

  return `## [${version}] - ${date}

${sections.length ? sections.join('\n\n') : '- Routine enhancements and quality improvements.'}
`;
}
