#!/usr/bin/env node
// Test suite for Claude Code auto-update hook.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createSuite } from './lib/suite.mjs';
import { shouldCheckUpdate, recordCheckTimestamp, checkGitUpdate } from '../hooks/check-update.mjs';
import { auditFileContent } from '../runtime/coding-standards-linter.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { test, assert, finish } = createSuite(
  'agent-sdlc/check-update-test/v1',
  null // Print only, no tracked evals artifact
);

const temp_dir = path.join(os.tmpdir(), `test-check-update-${Date.now()}`);
fs.mkdirSync(temp_dir, { recursive: true });

try {
  await test('shouldCheckUpdate returns true when cache does not exist', () => {
    const missing_file = path.join(temp_dir, 'non-existent-cache');
    const result = shouldCheckUpdate(missing_file);
    assert(result === true, 'should check when cache file is missing');
  });

  await test('recordCheckTimestamp records and shouldCheckUpdate respects cooldown', () => {
    const cache_file = path.join(temp_dir, 'test-cache');
    const recorded = recordCheckTimestamp(cache_file, Date.now());
    assert(recorded === true, 'recordCheckTimestamp should succeed');

    const should_run_now = shouldCheckUpdate(cache_file, 60000); // 1 minute interval
    assert(should_run_now === false, 'should not check when within cooldown interval');

    const should_run_past = shouldCheckUpdate(cache_file, -1000); // negative interval => past
    assert(should_run_past === true, 'should check when elapsed time exceeds interval');
  });

  await test('checkGitUpdate handles non-git directory gracefully', () => {
    const empty_dir = path.join(temp_dir, 'not-a-git-repo');
    fs.mkdirSync(empty_dir, { recursive: true });
    const res = checkGitUpdate(empty_dir);
    assert(res.has_update === false, 'has_update must be false for non-git directory');
    assert(res.reason === 'NOT_GIT_REPO', 'reason must be NOT_GIT_REPO');
  });

  await test('coding-standards-linter passes on hooks/check-update.mjs', () => {
    const hook_path = path.join(ROOT, 'hooks', 'check-update.mjs');
    if (fs.existsSync(hook_path)) {
      const code = fs.readFileSync(hook_path, 'utf8');
      const audit = auditFileContent('hooks/check-update.mjs', code);
      assert(audit.is_compliant === true, `Linter violations: ${JSON.stringify(audit.violations)}`);
    }
  });

  await test('claude-hooks-declares-check-update', () => {
    const hooks_json_path = path.join(ROOT, 'adapters', 'claude', 'hooks.json');
    const content = JSON.parse(fs.readFileSync(hooks_json_path, 'utf8'));
    const session_start = content.hooks?.SessionStart?.[0]?.hooks;
    assert(Array.isArray(session_start), 'SessionStart hooks should be an array');
    const has_update_hook = session_start.some(h => h.command?.includes('hooks/check-update.mjs'));
    assert(has_update_hook === true, 'adapters/claude/hooks.json must declare hooks/check-update.mjs');
  });
} finally {
  try {
    fs.rmSync(temp_dir, { recursive: true, force: true });
  } catch {}
}

finish();
