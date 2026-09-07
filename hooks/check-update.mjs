#!/usr/bin/env node
// Claude Code SessionStart hook: checks for plugin updates in git remote with cooldown cache.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const DEFAULT_CHECK_INTERVAL_MS = 2 * 60 * 60 * 1000; // 2 hours cooldown
const GIT_FETCH_TIMEOUT_MS = 3000;
const GIT_PULL_TIMEOUT_MS = 5000;

export function shouldCheckUpdate(cache_file_path, interval_ms = DEFAULT_CHECK_INTERVAL_MS) {
  try {
    if (!fs.existsSync(cache_file_path)) {
      return true;
    }
    const raw_timestamp = fs.readFileSync(cache_file_path, 'utf8').trim();
    const last_check_ms = parseInt(raw_timestamp, 10);
    if (Number.isNaN(last_check_ms)) {
      return true;
    }
    const elapsed_ms = Date.now() - last_check_ms;
    return elapsed_ms >= interval_ms;
  } catch {
    return true;
  }
}

export function recordCheckTimestamp(cache_file_path, timestamp_ms = Date.now()) {
  try {
    const parent_dir = path.dirname(cache_file_path);
    if (!fs.existsSync(parent_dir)) {
      fs.mkdirSync(parent_dir, { recursive: true });
    }
    fs.writeFileSync(cache_file_path, String(timestamp_ms), 'utf8');
    return true;
  } catch {
    return false;
  }
}

export function checkGitUpdate(plugin_root) {
  try {
    const git_dir = path.join(plugin_root, '.git');
    if (!fs.existsSync(git_dir)) {
      return { has_update: false, reason: 'NOT_GIT_REPO' };
    }

    const fetch_result = spawnSync('git', ['fetch', '--quiet', 'origin'], {
      cwd: plugin_root,
      timeout: GIT_FETCH_TIMEOUT_MS,
      stdio: 'ignore'
    });

    if (fetch_result.status !== 0) {
      return { has_update: false, reason: 'FETCH_FAILED' };
    }

    const local_res = spawnSync('git', ['rev-parse', 'HEAD'], {
      cwd: plugin_root,
      encoding: 'utf8',
      timeout: 2000
    });
    const local_commit = (local_res.stdout || '').trim();

    let upstream_commit = '';
    const upstream_res = spawnSync('git', ['rev-parse', '@{upstream}'], {
      cwd: plugin_root,
      encoding: 'utf8',
      timeout: 2000
    });

    if (upstream_res.status === 0 && upstream_res.stdout) {
      upstream_commit = upstream_res.stdout.trim();
    } else {
      const origin_master_res = spawnSync('git', ['rev-parse', 'origin/master'], {
        cwd: plugin_root,
        encoding: 'utf8',
        timeout: 2000
      });
      if (origin_master_res.status === 0 && origin_master_res.stdout) {
        upstream_commit = origin_master_res.stdout.trim();
      }
    }

    if (!local_commit || !upstream_commit || local_commit === upstream_commit) {
      return { has_update: false, reason: 'UP_TO_DATE' };
    }

    const pull_result = spawnSync('git', ['pull', '--ff-only', '--quiet'], {
      cwd: plugin_root,
      timeout: GIT_PULL_TIMEOUT_MS,
      stdio: 'ignore'
    });

    const is_pulled = pull_result.status === 0;
    return {
      has_update: true,
      is_pulled,
      local_commit,
      upstream_commit
    };
  } catch (error) {
    return { has_update: false, reason: 'ERROR', error: String(error) };
  }
}

export function executeCheckHook() {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const plugin_root = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(here, '..');
    const cache_dir = path.join(os.homedir(), '.cache', 'agent-sdlc');
    const cache_file = path.join(cache_dir, 'last-update-check');

    const should_run = shouldCheckUpdate(cache_file);
    if (!should_run) {
      process.exit(0);
    }

    recordCheckTimestamp(cache_file);

    const update_info = checkGitUpdate(plugin_root);
    if (update_info.has_update && update_info.is_pulled) {
      const notice_message = '🔄 [Plugin Auto-Update] Đã phát hiện và tự động pull phiên bản mới nhất từ Git cho plugin `agent-sdlc-harness`. Nếu muốn nạp ngay các tính năng mới, hãy gõ lệnh `/reload-plugins`.';
      const output_payload = {
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: notice_message
        }
      };
      console.log(JSON.stringify(output_payload));
    }
  } catch {
    process.exit(0);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  executeCheckHook();
}
