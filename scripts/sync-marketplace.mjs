#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const DEFAULT_EXCLUDES = [
  /^\.claude(\/|$)/,
  /^\.claude-plugin(\/|$)/,
  /^\.codex(\/|$)/,
  /^\.cursor-plugin(\/|$)/,
  /^\.git(\/|$)/,
  /^\.github(\/|$)/,
  /^\.gitignore$/,
  /^\.gitattributes$/,
  /^\.kimi-plugin(\/|$)/,
  /^\.tmp(\/|$)/,
  /^\.superpowers(\/|$)/,
  /^\.agent-sdlc(\/|$)/,
  /^node_modules(\/|$)/,
  /^package\.json$/,
  /^package-lock\.json$/,
  /^tsconfig\.json$/,
  /^CHANGELOG\.md$/,
  /^VERSION$/,
  /^dist(\/|$)/,
  /^release(\/|$)/,
  /^scripts(\/|$)/,
  /^evals(\/|$)/,
  /^commands(\/|$)/
];

/**
 * Check if a relative path matches any exclusion rule.
 */
export function isPathExcluded(rel_path, exclude_rules = DEFAULT_EXCLUDES) {
  const normalized = rel_path.split(path.sep).join('/');
  return exclude_rules.some(rule => rule.test(normalized));
}

/**
 * Backup and preserve destination metadata files (such as OpenAI agent metadata).
 */
export function backupDestinationMetadata(dest_dir) {
  const preserved_metadata = new Map();
  const skills_dir = path.join(dest_dir, 'skills');
  if (!fs.existsSync(skills_dir)) return preserved_metadata;

  function walk(current_dir) {
    for (const entry of fs.readdirSync(current_dir, {withFileTypes: true})) {
      const full_path = path.join(current_dir, entry.name);
      if (entry.isDirectory()) {
        walk(full_path);
      } else if (entry.isFile() && full_path.endsWith(path.join('agents', 'openai.yaml'))) {
        const rel_key = path.relative(dest_dir, full_path).split(path.sep).join('/');
        preserved_metadata.set(rel_key, fs.readFileSync(full_path));
      }
    }
  }

  walk(skills_dir);
  return preserved_metadata;
}

/**
 * Restore previously backed-up destination metadata files.
 */
export function restoreDestinationMetadata(dest_dir, preserved_metadata) {
  for (const [rel_key, data] of preserved_metadata.entries()) {
    const target_file = path.join(dest_dir, rel_key);
    fs.mkdirSync(path.dirname(target_file), {recursive: true});
    fs.writeFileSync(target_file, data);
  }
}

/**
 * Scan source directory and compute planned sync actions.
 */
export function planSyncActions(src_dir, dest_dir, exclude_rules = DEFAULT_EXCLUDES) {
  const actions = {
    copied: [],
    skipped: [],
    preserved: []
  };

  function scan(current_dir) {
    for (const entry of fs.readdirSync(current_dir, {withFileTypes: true})) {
      const full_path = path.join(current_dir, entry.name);
      const rel_path = path.relative(src_dir, full_path).split(path.sep).join('/');

      if (isPathExcluded(rel_path, exclude_rules)) {
        actions.skipped.push(rel_path);
        continue;
      }

      if (entry.isDirectory()) {
        scan(full_path);
      } else if (entry.isFile()) {
        actions.copied.push({src: full_path, rel: rel_path});
      }
    }
  }

  scan(src_dir);
  return actions;
}

/**
 * Perform sync from source to destination.
 */
export function syncToMarketplace({
  src_dir = ROOT,
  dest_dir,
  is_dry_run = false,
  exclude_rules = DEFAULT_EXCLUDES
}) {
  if (!dest_dir) {
    throw new Error('dest_dir is required for sync');
  }

  const actions = planSyncActions(src_dir, dest_dir, exclude_rules);
  const preserved_metadata = fs.existsSync(dest_dir) ? backupDestinationMetadata(dest_dir) : new Map();

  if (is_dry_run) {
    return {
      is_dry_run: true,
      dest_dir,
      copied_count: actions.copied.length,
      skipped_count: actions.skipped.length,
      preserved_count: preserved_metadata.size,
      copied_files: actions.copied.map(a => a.rel)
    };
  }

  // Ensure target directory exists
  fs.mkdirSync(dest_dir, {recursive: true});

  // Copy planned files
  for (const item of actions.copied) {
    const target_path = path.join(dest_dir, item.rel);
    fs.mkdirSync(path.dirname(target_path), {recursive: true});
    fs.copyFileSync(item.src, target_path);
  }

  // Restore preserved destination metadata
  restoreDestinationMetadata(dest_dir, preserved_metadata);

  return {
    is_dry_run: false,
    dest_dir,
    copied_count: actions.copied.length,
    skipped_count: actions.skipped.length,
    preserved_count: preserved_metadata.size,
    copied_files: actions.copied.map(a => a.rel)
  };
}

// --- CLI Runner ---
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  let target_dir = null;
  let is_dry_run = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--target' || arg === '--local') {
      target_dir = args[++i];
    } else if (arg === '--dry-run' || arg === '-n') {
      is_dry_run = true;
    }
  }

  if (!target_dir) {
    console.log(`
Usage:
  node scripts/sync-marketplace.mjs --target <destination-dir> [--dry-run]

Options:
  --target, --local <path>   Target directory inside marketplace repository
  --dry-run, -n              Preview copied and skipped files without writing
    `);
    process.exit(1);
  }

  const result = syncToMarketplace({
    src_dir: ROOT,
    dest_dir: path.resolve(target_dir),
    is_dry_run
  });

  console.log(`\nMarketplace Sync (${result.is_dry_run ? 'DRY-RUN' : 'APPLIED'}):`);
  console.log(`  Destination: ${result.dest_dir}`);
  console.log(`  Copied:      ${result.copied_count} files`);
  console.log(`  Skipped:     ${result.skipped_count} internal/ceremony paths`);
  console.log(`  Preserved:   ${result.preserved_count} destination metadata files\n`);

  if (result.is_dry_run) {
    console.log('Sample files to copy:');
    result.copied_files.slice(0, 15).forEach(f => console.log(`  + ${f}`));
    if (result.copied_files.length > 15) {
      console.log(`  ... and ${result.copied_files.length - 15} more files.`);
    }
  }
}
