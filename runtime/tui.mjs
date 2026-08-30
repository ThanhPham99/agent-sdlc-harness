// Interactive Terminal User Interface (TUI) Dashboard for Agent SDLC Harness.
// Zero-dependency ANSI renderer for terminal environments.

const ESC = '\x1b[';
const C = {
  reset: `${ESC}0m`,
  bold: `${ESC}1m`,
  dim: `${ESC}2m`,
  red: `${ESC}31m`,
  green: `${ESC}32m`,
  yellow: `${ESC}33m`,
  blue: `${ESC}34m`,
  magenta: `${ESC}35m`,
  cyan: `${ESC}36m`,
  white: `${ESC}37m`,
  gray: `${ESC}90m`,
  bgBlue: `${ESC}44m`,
  bgGreen: `${ESC}42m`
};

export function renderTuiDashboard({ project = {}, state = {}, runs = [], tasks = [], metrics = null, version = '3.0.0' } = {}) {
  const lines = [];
  const width = 76;
  const hr = '─'.repeat(width);

  // Header
  lines.push(`${C.cyan}┌${hr}┐${C.reset}`);
  const title = ` Agent SDLC Terminal Dashboard v${version}`;
  const projInfo = `Project: ${project?.project || 'agent-sdlc'}`;
  const headerLine = `│ ${C.bold}${C.white}${title.padEnd(width - 2)}${C.reset}│`;
  lines.push(headerLine);
  lines.push(`│ ${C.gray}${projInfo.padEnd(width - 2)}${C.reset}│`);
  lines.push(`${C.cyan}├${hr}┤${C.reset}`);

  // Stage Pipeline
  const activeRun = runs[0] || null;
  const currentStage = activeRun?.state || state?.stage || 'IDLE';
  const STAGES = ['INTAKE', 'REQUIREMENTS', 'DESIGN', 'PLAN', 'IMPLEMENT', 'VERIFY', 'REVIEW', 'RELEASE', 'DEPLOY', 'CLOSE'];
  const stageIdx = STAGES.indexOf(currentStage);

  const stageParts = STAGES.map((s, i) => {
    if (s === currentStage) {
      return `${C.bold}${C.yellow}[*${s}*]${C.reset}`;
    }
    if (stageIdx !== -1 && i < stageIdx) {
      return `${C.green}✓${s}${C.reset}`;
    }
    return `${C.gray}${s}${C.reset}`;
  });

  lines.push(`│ ${C.bold}Pipeline:${C.reset} ${stageParts.slice(0, 5).join(' ➔ ')}`.padEnd(width + 20) + `│`);
  lines.push(`│           ${stageParts.slice(5).join(' ➔ ')}`.padEnd(width + 20) + `│`);
  lines.push(`${C.cyan}├${hr}┤${C.reset}`);

  // Stats Grid
  const totalTokens = metrics?.tasks?.total_tokens ?? 0;
  const totalCost = metrics?.tasks?.total_cost_usd ?? 0;
  const doneTasks = tasks.filter(t => t.status === 'DONE').length;
  const activeTasks = tasks.filter(t => t.status === 'RUNNING' || t.status === 'ACTIVE').length;

  const statsText = `Runs: ${C.bold}${runs.length}${C.reset} | Tasks: ${C.bold}${tasks.length}${C.reset} (${C.green}${doneTasks} Done${C.reset}, ${C.yellow}${activeTasks} Active${C.reset}) | Tokens: ${C.cyan}${totalTokens.toLocaleString()}${C.reset} | Cost: ${C.yellow}$${Number(totalCost).toFixed(4)}${C.reset}`;
  lines.push(`│ ${statsText}`.padEnd(width + 30) + `│`);
  lines.push(`${C.cyan}├${hr}┤${C.reset}`);

  // Task Matrix
  lines.push(`│ ${C.bold}Recent Task Execution Matrix:${C.reset}`.padEnd(width + 10) + `│`);
  if (tasks.length === 0) {
    lines.push(`│ ${C.gray}(No tasks materialized yet)${C.reset}`.padEnd(width + 10) + `│`);
  } else {
    for (const t of tasks.slice(0, 6)) {
      const statusColor = t.status === 'DONE' ? C.green : t.status === 'RUNNING' ? C.yellow : t.status === 'FAILED' ? C.red : C.blue;
      const statusBadge = `${statusColor}[${t.status}]${C.reset}`;
      const taskLabel = `${C.bold}${t.task_id}${C.reset} ${statusBadge}: ${(t.title || t.goal || t.description || '').slice(0, 38)}`;
      lines.push(`│   • ${taskLabel}`.padEnd(width + 20) + `│`);
    }
  }

  lines.push(`${C.cyan}└${hr}┘${C.reset}`);
  return lines.join('\n');
}