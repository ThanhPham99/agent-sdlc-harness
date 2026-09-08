#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXCLUDE_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'release',
  '.tmp',
  '.agent-sdlc',
  '.superpowers',
  'evals',
  'docs/releases'
]);

/**
 * Validate SemVer or Pre-release version format (e.g. 3.0.0, 3.0.0-rc3).
 */
export function validateSemverFormat(version_string) {
  const semver_regex = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;
  return semver_regex.test(String(version_string || '').trim());
}

/**
 * Read the canonical VERSION file.
 */
export function readCanonicalVersion(repo_root = ROOT) {
  const version_path = path.join(repo_root, 'VERSION');
  if (!fs.existsSync(version_path)) {
    throw new Error(`VERSION file not found at ${version_path}`);
  }
  return fs.readFileSync(version_path, 'utf8').trim();
}

/**
 * Read a JSON file safely.
 */
function readJsonFile(file_path) {
  return JSON.parse(fs.readFileSync(file_path, 'utf8'));
}

/**
 * Write a JSON file preserving formatting (indentation).
 */
function writeJsonFile(file_path, data) {
  fs.writeFileSync(file_path, JSON.stringify(data, null, 2) + '\n');
}

/**
 * Get list of public skill directory names.
 */
export function getPublicSkills(repo_root = ROOT) {
  const config_path = path.join(repo_root, 'config', 'skills.json');
  if (!fs.existsSync(config_path)) return [];
  const config_data = readJsonFile(config_path);
  return config_data.public || [];
}

/**
 * List all declared files and locations that must match the exact version.
 */
export function getDeclaredManifests(repo_root = ROOT) {
  const manifests = [
    {type: 'plain', file: 'VERSION'},
    {type: 'json', file: 'package.json', path: 'version'},
    {type: 'json', file: 'agent-sdlc.manifest.json', path: 'version'},
    {type: 'json', file: '.claude-plugin/plugin.json', path: 'version'},
    {type: 'json', file: '.codex-plugin/plugin.json', path: 'version'},
    {type: 'json', file: '.cursor-plugin/plugin.json', path: 'version'},
    {type: 'json', file: '.kimi-plugin/plugin.json', path: 'version'},
    {type: 'json', file: 'adapters/claude/plugin.json', path: 'version'},
    {type: 'json', file: 'adapters/codex/plugin.json', path: 'version'},
    {type: 'marketplace', file: '.claude-plugin/marketplace.json', path: 'plugins[*].version'}
  ];

  for (const skill_name of getPublicSkills(repo_root)) {
    manifests.push({
      type: 'skill-frontmatter',
      file: `skills/${skill_name}/SKILL.md`,
      path: 'metadata.version'
    });
  }

  return manifests;
}

/**
 * Read frontmatter version from a markdown file.
 */
function readFrontmatterVersion(file_path) {
  if (!fs.existsSync(file_path)) return null;
  const content = fs.readFileSync(file_path, 'utf8');
  const frontmatter = content.split('---')[1] || '';
  const match = /^\s*version:\s*"?([^"\n]+)"?\s*$/m.exec(frontmatter);
  return match ? match[1].trim() : null;
}

/**
 * Update frontmatter version in a markdown file.
 */
function updateFrontmatterVersion(file_path, new_version) {
  const content = fs.readFileSync(file_path, 'utf8');
  const parts = content.split('---');
  if (parts.length < 3) return false;
  parts[1] = parts[1].replace(/^\s*version:\s*"?([^"\n]+)"?\s*$/m, `version: ${new_version}`);
  fs.writeFileSync(file_path, parts.join('---'));
  return true;
}

/**
 * Check versions across all declared manifests and detect drift.
 */
export function checkVersionDrift(repo_root = ROOT) {
  const canonical_version = readCanonicalVersion(repo_root);
  const declared_list = getDeclaredManifests(repo_root);
  const results = [];
  const version_counts = new Map();
  let has_drift = false;

  for (const entry of declared_list) {
    const full_path = path.join(repo_root, entry.file);
    if (!fs.existsSync(full_path)) {
      results.push({file: entry.file, field: entry.path || 'version', found: 'MISSING', is_match: false});
      has_drift = true;
      continue;
    }

    let found_version = null;
    if (entry.type === 'plain') {
      found_version = fs.readFileSync(full_path, 'utf8').trim();
    } else if (entry.type === 'skill-frontmatter') {
      found_version = readFrontmatterVersion(full_path);
    } else if (entry.type === 'marketplace') {
      const data = readJsonFile(full_path);
      const versions = (data.plugins || []).map(p => p.version);
      found_version = versions[0] || null;
    } else {
      const data = readJsonFile(full_path);
      found_version = data.version || null;
    }

    const is_match = found_version === canonical_version;
    if (!is_match) {
      has_drift = true;
    }

    version_counts.set(found_version, (version_counts.get(found_version) || 0) + 1);
    results.push({
      file: entry.file,
      field: entry.path || 'version',
      found: found_version,
      is_match
    });
  }

  return {
    has_drift,
    canonical_version,
    results,
    version_counts: Object.fromEntries(version_counts)
  };
}

/**
 * Scan repository for undeclared references to a specific version string.
 */
export function auditUndeclaredReferences(repo_root = ROOT, version_string = null) {
  const target_version = version_string || readCanonicalVersion(repo_root);
  const declared_files = new Set(getDeclaredManifests(repo_root).map(e => e.file));
  const undeclared_matches = [];

  const historical_pattern = /\(v\d+\.\d+\.\d+[0-9A-Za-z.-]*\)|`v?\d+\.\d+\.\d+-[0-9A-Za-z.-]+`/;

  function scanDirectory(current_dir) {
    for (const entry of fs.readdirSync(current_dir, {withFileTypes: true})) {
      const relative_path = path.relative(repo_root, path.join(current_dir, entry.name)).split(path.sep).join('/');
      if (entry.isDirectory()) {
        let is_excluded = false;
        for (const excl of EXCLUDE_DIRS) {
          if (relative_path === excl || relative_path.startsWith(`${excl}/`)) {
            is_excluded = true;
            break;
          }
        }
        if (!is_excluded) {
          scanDirectory(path.join(current_dir, entry.name));
        }
        continue;
      }

      // Check text file content
      if (declared_files.has(relative_path)) {
        continue;
      }

      // Skip binary, image, lock files
      if (/\.(zip|tar|gz|png|jpg|ico|woff|woff2|lock)$/i.test(entry.name)) {
        continue;
      }

      try {
        const lines = fs.readFileSync(path.join(current_dir, entry.name), 'utf8').split('\n');
        lines.forEach((line, index) => {
          if (line.includes(target_version)) {
            if (!historical_pattern.test(line)) {
              undeclared_matches.push({
                file: relative_path,
                line_number: index + 1,
                line_content: line.trim().slice(0, 100)
              });
            }
          }
        });
      } catch {}
    }
  }

  scanDirectory(repo_root);
  return {
    target_version,
    matches_count: undeclared_matches.length,
    matches: undeclared_matches
  };
}

/**
 * Bump version across all declared manifests and documentation.
 */
export function bumpVersion(repo_root = ROOT, new_version = null) {
  if (!validateSemverFormat(new_version)) {
    throw new Error(`Invalid version format: '${new_version}'. Expected semver (e.g. 3.0.0 or 3.0.0-rc3).`);
  }

  const old_version = readCanonicalVersion(repo_root);
  const updated_files = [];

  // 1. Update VERSION file
  fs.writeFileSync(path.join(repo_root, 'VERSION'), `${new_version}\n`);
  updated_files.push({file: 'VERSION', old_version, new_version});

  // 2. Update JSON manifests
  const json_targets = [
    'package.json',
    'agent-sdlc.manifest.json',
    '.claude-plugin/plugin.json',
    '.codex-plugin/plugin.json',
    '.cursor-plugin/plugin.json',
    '.kimi-plugin/plugin.json',
    'adapters/claude/plugin.json',
    'adapters/codex/plugin.json'
  ];

  for (const rel of json_targets) {
    const full = path.join(repo_root, rel);
    if (fs.existsSync(full)) {
      const data = readJsonFile(full);
      const prev = data.version;
      data.version = new_version;
      writeJsonFile(full, data);
      updated_files.push({file: rel, old_version: prev, new_version});
    }
  }

  // 3. Update marketplace.json
  const marketplace_path = path.join(repo_root, '.claude-plugin', 'marketplace.json');
  if (fs.existsSync(marketplace_path)) {
    const marketplace_data = readJsonFile(marketplace_path);
    for (const plugin of marketplace_data.plugins || []) {
      plugin.version = new_version;
    }
    writeJsonFile(marketplace_path, marketplace_data);
    updated_files.push({file: '.claude-plugin/marketplace.json', old_version, new_version});
  }

  // 4. Update public skills frontmatter
  for (const skill_name of getPublicSkills(repo_root)) {
    const skill_path = path.join(repo_root, 'skills', skill_name, 'SKILL.md');
    if (fs.existsSync(skill_path)) {
      const prev_version = readFrontmatterVersion(skill_path);
      updateFrontmatterVersion(skill_path, new_version);
      updated_files.push({file: `skills/${skill_name}/SKILL.md`, old_version: prev_version, new_version});
    }
  }

  // 5. Update README.md header
  const readme_path = path.join(repo_root, 'README.md');
  if (fs.existsSync(readme_path)) {
    let readme_content = fs.readFileSync(readme_path, 'utf8');
    readme_content = readme_content.replace(
      /^# Agent SDLC Harness .*/m,
      `# Agent SDLC Harness ${new_version}`
    );
    fs.writeFileSync(readme_path, readme_content);
    updated_files.push({file: 'README.md', old_version, new_version});
  }

  // 6. Run audit scanner to find any remaining references
  const audit_result = auditUndeclaredReferences(repo_root, old_version);

  return {
    old_version,
    new_version,
    updated_count: updated_files.length,
    updated_files,
    audit_findings: audit_result
  };
}

// --- CLI Runner ---
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const command_arg = process.argv[2];

  if (!command_arg || command_arg === '--help' || command_arg === '-h') {
    console.log(`
Usage:
  node scripts/bump-version.mjs <new-version>   Bump all declared manifests to <new-version>
  node scripts/bump-version.mjs --check         Check current versions across manifests for drift
  node scripts/bump-version.mjs --audit         Check drift and scan for undeclared old versions
    `);
    process.exit(0);
  }

  if (command_arg === '--check') {
    const report = checkVersionDrift(ROOT);
    console.log(`\nVersion check (Canonical: ${report.canonical_version}):\n`);
    for (const r of report.results) {
      const status_mark = r.is_match ? '✓' : '✗';
      console.log(`  ${status_mark} ${r.file.padEnd(45)} ${r.found}`);
    }
    console.log('');
    if (report.has_drift) {
      console.error('DRIFT DETECTED: Not all manifests are in sync!');
      process.exit(1);
    } else {
      console.log(`All ${report.results.length} declared locations are in sync at ${report.canonical_version}.`);
      process.exit(0);
    }
  }

  if (command_arg === '--audit') {
    const check_report = checkVersionDrift(ROOT);
    console.log(`\nAudit: Checking version consistency & scanning undeclared references...\n`);
    const audit_result = auditUndeclaredReferences(ROOT, check_report.canonical_version);
    if (audit_result.matches_count === 0) {
      console.log(`All clear: No undeclared files contain version string '${audit_result.target_version}'.`);
      process.exit(0);
    } else {
      console.log(`Found ${audit_result.matches_count} undeclared occurrences of '${audit_result.target_version}':`);
      for (const m of audit_result.matches) {
        console.log(`  ${m.file}:${m.line_number} -> ${m.line_content}`);
      }
      process.exit(0);
    }
  }

  // Otherwise assume command_arg is the new version
  try {
    const bump_result = bumpVersion(ROOT, command_arg);
    console.log(`\nSuccessfully bumped version: ${bump_result.old_version} -> ${bump_result.new_version}`);
    console.log(`Updated ${bump_result.updated_count} files:\n`);
    for (const f of bump_result.updated_files) {
      console.log(`  ✓ ${f.file.padEnd(45)} (${f.old_version} -> ${f.new_version})`);
    }

    if (bump_result.audit_findings.matches_count > 0) {
      console.log(`\nNotice: ${bump_result.audit_findings.matches_count} undeclared occurrences of '${bump_result.old_version}' remain:`);
      for (const m of bump_result.audit_findings.matches) {
        console.log(`  ${m.file}:${m.line_number} -> ${m.line_content}`);
      }
    } else {
      console.log(`\nAudit passed: No residual references to old version '${bump_result.old_version}'.`);
    }

    // Run validate-versions to ensure full harness compliance
    console.log('\nRunning validate-versions.mjs verification...');
    const verify_run = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'validate-versions.mjs')], {
      encoding: 'utf8',
      cwd: ROOT
    });
    if (verify_run.status === 0) {
      console.log('✓ Validation gate PASSED.');
      process.exit(0);
    } else {
      console.error('✗ Validation gate FAILED after bump:\n', verify_run.stderr || verify_run.stdout);
      process.exit(1);
    }
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}
