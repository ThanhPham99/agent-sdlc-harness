#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createSuite} from './lib/suite.mjs';
import {makeTempDir} from './lib/tempdir.mjs';
import {lintShellFiles} from './lint-shell.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'agent-sdlc.manifest.json'), 'utf8')).version;
const {test, assert, finish} = createSuite('agent-sdlc/test-lint-shell/v1', 'TEST-LINT-SHELL.json');

test('tracked-shell-files-pass-validation', () => {
  const {report, failures} = lintShellFiles();
  assert(report.status === 'PASS', `expected PASS but got FAIL with ${failures.length} errors`);
  assert(failures.length === 0, `tracked shell files had failures: ${JSON.stringify(failures)}`);
  assert(report.checks >= 4, `expected at least 4 shell files checked, got ${report.checks}`);
});

test('detects-syntax-error-in-shell-script', () => {
  const fixture_dir = makeTempDir('agent-sdlc-lint-syntax-');
  const broken_file = path.join(fixture_dir, 'broken.sh');
  fs.writeFileSync(broken_file, '#!/bin/sh\nif then fi\n', {mode: 0o755});

  const {report, failures} = lintShellFiles([broken_file]);
  assert(failures.length > 0, 'expected linter to fail on syntax error');
  assert(report.status === 'FAIL', 'expected report status to be FAIL');
});

test('detects-crlf-line-endings-in-shell-script', () => {
  const fixture_dir = makeTempDir('agent-sdlc-lint-crlf-');
  const crlf_file = path.join(fixture_dir, 'windows.sh');
  fs.writeFileSync(crlf_file, '#!/bin/sh\r\necho "hello"\r\n', {mode: 0o755});

  const {report, failures} = lintShellFiles([crlf_file]);
  assert(failures.length > 0, 'expected linter to fail on CRLF line endings');
  assert(report.status === 'FAIL', 'expected report status to be FAIL');
  assert(failures.some(f => f.error.includes('CRLF')), 'expected error detail to mention CRLF');
});

test('identifies-shebang-file-without-extension', () => {
  const fixture_dir = makeTempDir('agent-sdlc-lint-shebang-');
  const executable_file = path.join(fixture_dir, 'custom-tool');
  fs.writeFileSync(executable_file, '#!/usr/bin/env sh\necho "tool execution"\n', {mode: 0o755});

  const {report, failures} = lintShellFiles([executable_file]);
  assert(report.status === 'PASS', 'expected valid extensionless shell file to PASS');
  assert(failures.length === 0, 'expected zero failures for valid extensionless shell file');
});

finish({version: VERSION});
