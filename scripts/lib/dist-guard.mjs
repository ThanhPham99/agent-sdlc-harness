import fs from 'node:fs';
import path from 'node:path';

export const FORBIDDEN_DIST_PATTERNS = [
  /(^|\/)scripts(\/|$)/,
  /(^|\/)evals(\/|$)/,
  /(^|\/)tests(\/|$)/,
  /(^|\/)\.git(\/|$)/,
  /(^|\/)\.github(\/|$)/,
  /(^|\/)\.tmp(\/|$)/,
  /(^|\/)node_modules(\/|$)/,
  /(^|\/)\.vscode(\/|$)/,
  /(^|\/)\.idea(\/|$)/,
  /\.log$/,
  /(^|\/)\.env/
];

/**
 * Scan a directory recursively and find any entries matching forbidden patterns.
 */
export function findForbiddenEntries(root_dir, patterns = FORBIDDEN_DIST_PATTERNS) {
  const discovered_leaks = [];

  function scan(current_dir, base_rel = '') {
    for (const entry of fs.readdirSync(current_dir, {withFileTypes: true})) {
      const rel_path = base_rel ? `${base_rel}/${entry.name}` : entry.name;

      for (const pattern of patterns) {
        if (pattern.test(rel_path)) {
          discovered_leaks.push(rel_path);
          break;
        }
      }

      if (entry.isDirectory()) {
        scan(path.join(current_dir, entry.name), rel_path);
      }
    }
  }

  if (fs.existsSync(root_dir)) {
    scan(root_dir);
  }

  return discovered_leaks;
}

/**
 * Assert that no forbidden entries exist in the target directory.
 */
export function assertNoForbiddenEntries(root_dir, patterns = FORBIDDEN_DIST_PATTERNS) {
  const leaks = findForbiddenEntries(root_dir, patterns);
  if (leaks.length > 0) {
    throw new Error(`distribution contains forbidden internal entries: ${leaks.slice(0, 5).join(', ')}${leaks.length > 5 ? ` (+${leaks.length - 5} more)` : ''}`);
  }
  return true;
}
