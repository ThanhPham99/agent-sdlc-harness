#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {createSuite} from './lib/suite.mjs';
import {makeTempDir} from './lib/tempdir.mjs';
import {
  isPathExcluded,
  planSyncActions,
  syncToMarketplace,
  backupDestinationMetadata,
  restoreDestinationMetadata
} from './sync-marketplace.mjs';

const {test, assert, finish} = createSuite('agent-sdlc/test-sync-marketplace/v1', 'TEST-SYNC-MARKETPLACE.json');

test('isPathExcluded-matches-forbidden-and-ceremony-paths', () => {
  assert(isPathExcluded('scripts/lint-shell.mjs'), 'scripts should be excluded');
  assert(isPathExcluded('evals/REPORT.json'), 'evals should be excluded');
  assert(isPathExcluded('package.json'), 'package.json should be excluded');
  assert(isPathExcluded('.git/config'), '.git should be excluded');
  assert(isPathExcluded('.tmp/test.md'), '.tmp should be excluded');
  assert(!isPathExcluded('skills/sdlc-router/SKILL.md'), 'skills should NOT be excluded');
  assert(!isPathExcluded('README.md'), 'README should NOT be excluded');
  assert(!isPathExcluded('LICENSE'), 'LICENSE should NOT be excluded');
});

test('dry-run-does-not-write-to-destination', () => {
  const src_dir = makeTempDir('agent-sdlc-sync-src-');
  const dest_dir = path.join(makeTempDir('agent-sdlc-sync-dest-'), 'subfolder');

  fs.mkdirSync(path.join(src_dir, 'skills', 'my-skill'), {recursive: true});
  fs.writeFileSync(path.join(src_dir, 'skills', 'my-skill', 'SKILL.md'), '# Skill');

  const result = syncToMarketplace({
    src_dir,
    dest_dir,
    is_dry_run: true
  });

  assert(result.is_dry_run === true, 'expected dry-run result');
  assert(result.copied_count === 1, `expected 1 planned copy, got ${result.copied_count}`);
  assert(!fs.existsSync(dest_dir), 'dry run should not create destination directory');
});

test('sync-copies-allowed-files-and-preserves-metadata', () => {
  const src_dir = makeTempDir('agent-sdlc-sync-full-src-');
  const dest_dir = makeTempDir('agent-sdlc-sync-full-dest-');

  // Populate source
  fs.mkdirSync(path.join(src_dir, 'skills', 'my-skill'), {recursive: true});
  fs.writeFileSync(path.join(src_dir, 'skills', 'my-skill', 'SKILL.md'), '# New Skill Content');
  fs.mkdirSync(path.join(src_dir, 'scripts'), {recursive: true});
  fs.writeFileSync(path.join(src_dir, 'scripts', 'do-not-copy.mjs'), '// secret script');

  // Pre-seed destination with existing metadata
  fs.mkdirSync(path.join(dest_dir, 'skills', 'my-skill', 'agents'), {recursive: true});
  const custom_metadata = 'model: gpt-4o\ndescription: marketplace specific\n';
  fs.writeFileSync(path.join(dest_dir, 'skills', 'my-skill', 'agents', 'openai.yaml'), custom_metadata);

  // Execute sync
  const result = syncToMarketplace({
    src_dir,
    dest_dir,
    is_dry_run: false
  });

  assert(result.copied_count === 1, `expected 1 copied file, got ${result.copied_count}`);
  assert(fs.existsSync(path.join(dest_dir, 'skills', 'my-skill', 'SKILL.md')), 'SKILL.md should be copied');
  assert(!fs.existsSync(path.join(dest_dir, 'scripts')), 'scripts directory must NOT be copied');

  // Verify metadata preservation
  const preserved_content = fs.readFileSync(path.join(dest_dir, 'skills', 'my-skill', 'agents', 'openai.yaml'), 'utf8');
  assert(preserved_content === custom_metadata, 'destination metadata should be preserved untouched');
});

finish();
