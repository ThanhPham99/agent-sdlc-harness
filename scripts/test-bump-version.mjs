#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {createSuite} from './lib/suite.mjs';
import {makeTempDir} from './lib/tempdir.mjs';
import {
  validateSemverFormat,
  readCanonicalVersion,
  checkVersionDrift,
  auditUndeclaredReferences,
  bumpVersion,
  getDeclaredManifests
} from './bump-version.mjs';

const {test, assert, finish} = createSuite('agent-sdlc/test-bump-version/v1', 'TEST-BUMP-VERSION.json');

test('validate-semver-format-rule', () => {
  assert(validateSemverFormat('1.0.0'), '1.0.0 should be valid');
  assert(validateSemverFormat('3.0.0-rc2'), '3.0.0-rc2 should be valid');
  assert(validateSemverFormat('0.0.1-alpha.5'), '0.0.1-alpha.5 should be valid');
  assert(!validateSemverFormat('v1.0.0'), 'v1.0.0 with leading v should be invalid');
  assert(!validateSemverFormat('1.0'), '1.0 without patch should be invalid');
  assert(!validateSemverFormat('latest'), 'non-semver string should be invalid');
  assert(!validateSemverFormat(''), 'empty string should be invalid');
});

test('check-version-drift-passes-on-clean-repo', () => {
  const drift_report = checkVersionDrift();
  assert(!drift_report.has_drift, `drift detected on clean repo: ${JSON.stringify(drift_report.results.filter(r => !r.is_match))}`);
  assert(drift_report.results.length >= 16, `expected at least 16 locations, got ${drift_report.results.length}`);
});

test('detects-version-drift-when-manifest-differs', () => {
  const fixture_dir = makeTempDir('agent-sdlc-drift-test-');
  fs.writeFileSync(path.join(fixture_dir, 'VERSION'), '3.0.0\n');
  fs.writeFileSync(path.join(fixture_dir, 'package.json'), JSON.stringify({name: 'test', version: '2.9.0'}));
  fs.writeFileSync(path.join(fixture_dir, 'agent-sdlc.manifest.json'), JSON.stringify({version: '3.0.0'}));

  const report = checkVersionDrift(fixture_dir);
  assert(report.has_drift, 'expected has_drift to be true');
  const package_json_result = report.results.find(r => r.file === 'package.json');
  assert(package_json_result && !package_json_result.is_match, 'expected package.json to be flagged as mismatch');
});

test('bump-version-updates-fixture-manifests-cleanly', () => {
  const fixture_dir = makeTempDir('agent-sdlc-bump-test-');

  // Setup complete fixture tree matching declared manifests
  fs.writeFileSync(path.join(fixture_dir, 'VERSION'), '1.0.0\n');
  fs.writeFileSync(path.join(fixture_dir, 'package.json'), JSON.stringify({name: 'test-pkg', version: '1.0.0'}, null, 2));
  fs.writeFileSync(path.join(fixture_dir, 'agent-sdlc.manifest.json'), JSON.stringify({version: '1.0.0'}, null, 2));

  for (const dir_rel of ['.claude-plugin', '.codex-plugin', '.cursor-plugin', '.kimi-plugin', 'adapters/claude', 'adapters/codex']) {
    fs.mkdirSync(path.join(fixture_dir, dir_rel), {recursive: true});
    fs.writeFileSync(path.join(fixture_dir, dir_rel, 'plugin.json'), JSON.stringify({version: '1.0.0'}, null, 2));
  }

  fs.writeFileSync(path.join(fixture_dir, '.claude-plugin', 'marketplace.json'), JSON.stringify({plugins: [{version: '1.0.0'}]}, null, 2));

  fs.mkdirSync(path.join(fixture_dir, 'config'), {recursive: true});
  fs.writeFileSync(path.join(fixture_dir, 'config', 'skills.json'), JSON.stringify({public: ['test-skill']}, null, 2));
  fs.mkdirSync(path.join(fixture_dir, 'skills', 'test-skill'), {recursive: true});
  fs.writeFileSync(path.join(fixture_dir, 'skills', 'test-skill', 'SKILL.md'), '---\nname: test-skill\nversion: 1.0.0\n---\nBody');
  fs.writeFileSync(path.join(fixture_dir, 'README.md'), '# Agent SDLC Harness 1.0.0\n\nDocs for 1.0.0\n');

  // Verify pre-bump is clean
  const pre_drift = checkVersionDrift(fixture_dir);
  assert(!pre_drift.has_drift, `pre-bump fixture should have no drift: ${JSON.stringify(pre_drift.results)}`);

  // Perform bump
  const bump_result = bumpVersion(fixture_dir, '2.0.0-rc1');
  assert(bump_result.old_version === '1.0.0', `expected old version 1.0.0, got ${bump_result.old_version}`);
  assert(bump_result.new_version === '2.0.0-rc1', `expected new version 2.0.0-rc1, got ${bump_result.new_version}`);

  // Check updated files
  assert(readCanonicalVersion(fixture_dir) === '2.0.0-rc1', 'VERSION file not updated');
  const pkg = JSON.parse(fs.readFileSync(path.join(fixture_dir, 'package.json'), 'utf8'));
  assert(pkg.version === '2.0.0-rc1', 'package.json version not updated');
  const manifest = JSON.parse(fs.readFileSync(path.join(fixture_dir, 'agent-sdlc.manifest.json'), 'utf8'));
  assert(manifest.version === '2.0.0-rc1', 'agent-sdlc.manifest.json version not updated');
  const readme = fs.readFileSync(path.join(fixture_dir, 'README.md'), 'utf8');
  assert(readme.includes('# Agent SDLC Harness 2.0.0-rc1'), 'README title not updated');

  // Verify no drift in fixture post-bump
  const post_bump_drift = checkVersionDrift(fixture_dir);
  assert(!post_bump_drift.has_drift, `expected zero drift after bump: ${JSON.stringify(post_bump_drift.results.filter(r => !r.is_match))}`);
});

test('audit-finds-undeclared-references-in-content', () => {
  const fixture_dir = makeTempDir('agent-sdlc-audit-test-');
  fs.writeFileSync(path.join(fixture_dir, 'VERSION'), '5.0.0\n');
  fs.mkdirSync(path.join(fixture_dir, 'docs'), {recursive: true});
  fs.writeFileSync(path.join(fixture_dir, 'docs', 'guide.md'), 'Download agent-sdlc version 5.0.0 from GitHub.');

  const audit_result = auditUndeclaredReferences(fixture_dir, '5.0.0');
  assert(audit_result.matches_count === 1, `expected 1 undeclared match, got ${audit_result.matches_count}`);
  assert(audit_result.matches[0].file === 'docs/guide.md', 'expected match in docs/guide.md');
});

finish();
