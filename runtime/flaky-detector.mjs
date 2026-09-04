// Flaky Test Detector & Diagnostic Engine for Agent SDLC Harness.
import {execFileSync} from 'node:child_process';
import {now} from './util.mjs';

/**
 * Execute a test command multiple times with jitter to detect flaky / non-deterministic results.
 */
export async function detectFlakyTests(projectRoot, { command, iterations = 3, jitterMs = 20, cwd = null } = {}) {
  const targetCwd = cwd || projectRoot;
  const runs = [];
  const cmd = Array.isArray(command) ? command : [command];

  for (let i = 0; i < iterations; i++) {
    if (jitterMs > 0 && i > 0) {
      await new Promise(res => setTimeout(res, jitterMs));
    }
    const start = Date.now();
    let exitCode = 0;
    let stdout = '';
    let stderr = '';
    try {
      stdout = execFileSync(cmd[0], cmd.slice(1), {
        cwd: targetCwd,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe']
      });
      exitCode = 0;
    } catch (err) {
      exitCode = typeof err.status === 'number' ? err.status : 1;
      stdout = err.stdout ? String(err.stdout) : '';
      stderr = err.stderr ? String(err.stderr) : String(err.message);
    }
    runs.push({
      run_index: i + 1,
      exit_code: exitCode,
      passed: exitCode === 0,
      duration_ms: Date.now() - start,
      stdout: stdout.slice(0, 500),
      stderr: stderr.slice(0, 500)
    });
  }

  const passedCount = runs.filter(r => r.passed).length;
  const passRate = Number((passedCount / iterations).toFixed(4));
  const isFlaky = passRate > 0 && passRate < 1.0;

  return {
    schema: 'agent-sdlc/flaky-test-report/v1',
    command: cmd.join(' '),
    iterations,
    passed_count: passedCount,
    failed_count: iterations - passedCount,
    pass_rate: passRate,
    is_flaky: isFlaky,
    status: isFlaky ? 'FLAKY' : (passRate === 1.0 ? 'DETERMINISTIC_PASS' : 'DETERMINISTIC_FAIL'),
    timestamp: now(),
    runs
  };
}