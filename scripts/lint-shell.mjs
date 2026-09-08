#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {writeReport} from './lib/report-io.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'agent-sdlc.manifest.json'), 'utf8')).version;
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'release', '.tmp', '.agent-sdlc', '.superpowers']);

/**
 * Resolve path to sh or bash executable across Linux, macOS and Windows.
 * On Windows, Git's bash/sh is strongly preferred over WSL system32 bash.
 */
function resolveShellExecutable(shell_name) {
  if (process.platform === 'win32') {
    const git_candidates = [
      'D:\\Programs\\Git\\bin',
      'C:\\Program Files\\Git\\bin',
      'C:\\Program Files (x86)\\Git\\bin',
      'D:\\Program Files\\Git\\bin'
    ];
    for (const candidate_dir of git_candidates) {
      const exe_path = path.join(candidate_dir, `${shell_name}.exe`);
      if (fs.existsSync(exe_path)) {
        return exe_path;
      }
    }
    try {
      const where_git = spawnSync('where.exe', ['git.exe'], {encoding: 'utf8'});
      if (where_git.status === 0 && where_git.stdout) {
        const first_path = where_git.stdout.trim().split(/\r?\n/)[0];
        const git_bin_dir = path.resolve(path.dirname(first_path), '..', 'bin');
        const candidate = path.join(git_bin_dir, `${shell_name}.exe`);
        if (fs.existsSync(candidate)) {
          return candidate;
        }
      }
    } catch {}
  }

  // On POSIX or fallback
  const direct = spawnSync(shell_name, ['--version'], {encoding: 'utf8'});
  if (direct.status === 0 || direct.stdout || direct.stderr) {
    return shell_name;
  }

  return null;
}

/**
 * Check whether a file is a shell script by extension or shebang.
 */
function isShellFile(file_path) {
  if (file_path.endsWith('.sh')) {
    return true;
  }
  const file_name = path.basename(file_path);
  if (file_name.includes('.')) {
    return false;
  }
  try {
    const fd = fs.openSync(file_path, 'r');
    const buffer = Buffer.alloc(256);
    const bytes_read = fs.readSync(fd, buffer, 0, 256, 0);
    fs.closeSync(fd);
    if (bytes_read === 0) return false;
    const first_line = buffer.toString('utf8', 0, bytes_read).split(/\r?\n/)[0];
    return /^#!.*[/\s](bash|dash|ksh|sh)(\s|$)/.test(first_line);
  } catch {
    return false;
  }
}

/**
 * Find all shell files in the repository.
 */
function findShellFiles(dir_path) {
  const discovered_files = [];
  for (const entry of fs.readdirSync(dir_path, {withFileTypes: true})) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) {
        discovered_files.push(...findShellFiles(path.join(dir_path, entry.name)));
      }
      continue;
    }
    const full_path = path.join(dir_path, entry.name);
    if (isShellFile(full_path)) {
      discovered_files.push(full_path);
    }
  }
  return discovered_files;
}

/**
 * Determine the intended shell runner from shebang.
 */
function detectShellType(file_path) {
  try {
    const first_line = fs.readFileSync(file_path, 'utf8').split(/\r?\n/)[0];
    if (first_line.includes('/bash') || first_line.includes('env bash')) {
      return 'bash';
    }
  } catch {}
  return 'sh';
}

/**
 * Check whether file has CRLF endings.
 */
function checkLineEndings(file_path) {
  const content = fs.readFileSync(file_path);
  const has_crlf = content.includes(Buffer.from('\r\n'));
  return !has_crlf;
}

/**
 * Run syntax check (sh -n or bash -n) on a single file.
 */
function checkSyntax(abs_path, shell_type) {
  const shell_executable = resolveShellExecutable(shell_type);
  if (!shell_executable) {
    return {
      is_available: false,
      is_valid: true,
      error_message: `shell '${shell_type}' not available on system for syntax check`
    };
  }

  const working_dir = abs_path.startsWith(ROOT) ? ROOT : path.dirname(abs_path);
  const target_path = abs_path.startsWith(ROOT)
    ? path.relative(ROOT, abs_path).split(path.sep).join('/')
    : path.basename(abs_path);

  const result = spawnSync(shell_executable, ['-n', target_path], {
    cwd: working_dir,
    encoding: 'utf8',
    timeout: 10000
  });

  const is_valid = result.status === 0;
  const error_message = is_valid ? null : (result.stderr || result.stdout || `exit code ${result.status}`).trim();
  return {
    is_available: true,
    is_valid,
    error_message
  };
}

/**
 * Run shellcheck if installed.
 */
function runShellCheck(abs_path) {
  const working_dir = abs_path.startsWith(ROOT) ? ROOT : path.dirname(abs_path);
  const target_path = abs_path.startsWith(ROOT)
    ? path.relative(ROOT, abs_path).split(path.sep).join('/')
    : path.basename(abs_path);

  const result = spawnSync('shellcheck', ['--severity=warning', target_path], {
    cwd: working_dir,
    encoding: 'utf8',
    timeout: 15000
  });
  if (result.error && result.error.code === 'ENOENT') {
    return {is_available: false, is_valid: true, error_message: null};
  }
  const is_valid = result.status === 0;
  return {
    is_available: true,
    is_valid,
    error_message: is_valid ? null : (result.stderr || result.stdout || '').trim()
  };
}

// --- Main execution ---
export function lintShellFiles(target_files = null) {
  const files_to_check = target_files
    ? target_files.filter(isShellFile)
    : findShellFiles(ROOT);

  const normalized_files = files_to_check
    .map(p => path.resolve(p))
    .sort();

  const results = [];
  const failures = [];

  for (const abs_path of normalized_files) {
    const display_path = abs_path.startsWith(ROOT)
      ? path.relative(ROOT, abs_path).split(path.sep).join('/')
      : abs_path.split(path.sep).join('/');

    const shell_type = detectShellType(abs_path);
    const is_lf = checkLineEndings(abs_path);

    if (!is_lf) {
      const error_detail = 'CRLF line endings detected. Shell scripts must use LF line endings.';
      results.push({file: display_path, shell_type, status: 'FAIL', error: error_detail});
      failures.push({file: display_path, error: error_detail});
      continue;
    }

    const syntax_result = checkSyntax(abs_path, shell_type);
    if (!syntax_result.is_valid) {
      results.push({file: display_path, shell_type, status: 'FAIL', error: syntax_result.error_message});
      failures.push({file: display_path, error: syntax_result.error_message});
      continue;
    }

    const shellcheck_result = runShellCheck(abs_path);
    if (!shellcheck_result.is_valid) {
      results.push({file: display_path, shell_type, status: 'FAIL', error: shellcheck_result.error_message});
      failures.push({file: display_path, error: shellcheck_result.error_message});
      continue;
    }

    results.push({
      file: display_path,
      shell_type,
      status: 'PASS',
      note: syntax_result.is_available ? 'syntax verified' : 'syntax skipped (no shell)'
    });
  }

  const report = {
    schema: 'agent-sdlc/shell-lint-validation/v1',
    version: VERSION,
    checked: 'shell syntax (-n), LF line-endings, and optional shellcheck',
    checks: results.length,
    passes: results.length - failures.length,
    failures: failures.length,
    results,
    status: failures.length ? 'FAIL' : 'PASS'
  };

  writeReport(path.join(ROOT, 'evals', 'SHELL-LINT-VALIDATION.json'), report);
  return {report, failures};
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const args = process.argv.slice(2).filter(a => !a.startsWith('-'));
  const target_list = args.length ? args.map(a => path.resolve(ROOT, a)) : null;
  const {report, failures} = lintShellFiles(target_list);
  console.log(JSON.stringify({...report, results: failures.length ? failures : 'all-pass'}, null, 2));
  process.exit(failures.length ? 1 : 0);
}
