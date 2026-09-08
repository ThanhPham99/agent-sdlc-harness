#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {createSuite} from './lib/suite.mjs';
import {makeTempDir} from './lib/tempdir.mjs';
import {findForbiddenEntries, assertNoForbiddenEntries} from './lib/dist-guard.mjs';

const {test, assert, finish} = createSuite('agent-sdlc/test-dist-leak-guard/v1', 'TEST-DIST-LEAK-GUARD.json');

test('clean-dist-tree-passes-leak-guard', () => {
  const fixture_dir = makeTempDir('agent-sdlc-leak-clean-');
  fs.mkdirSync(path.join(fixture_dir, 'bin'), {recursive: true});
  fs.writeFileSync(path.join(fixture_dir, 'bin', 'agent-sdlc'), '#!/bin/sh\n');
  fs.mkdirSync(path.join(fixture_dir, 'skills', 'sdlc-router'), {recursive: true});
  fs.writeFileSync(path.join(fixture_dir, 'skills', 'sdlc-router', 'SKILL.md'), '# Router\n');
  fs.writeFileSync(path.join(fixture_dir, 'README.md'), '# Readme\n');

  const leaks = findForbiddenEntries(fixture_dir);
  assert(leaks.length === 0, `expected 0 leaks in clean fixture, got: ${JSON.stringify(leaks)}`);
  assert(assertNoForbiddenEntries(fixture_dir) === true, 'expected assertNoForbiddenEntries to return true');
});

test('catches-internal-scripts-directory', () => {
  const fixture_dir = makeTempDir('agent-sdlc-leak-scripts-');
  fs.mkdirSync(path.join(fixture_dir, 'scripts'), {recursive: true});
  fs.writeFileSync(path.join(fixture_dir, 'scripts', 'internal.mjs'), 'console.log("leak");');

  const leaks = findForbiddenEntries(fixture_dir);
  assert(leaks.some(l => l.includes('scripts')), 'expected leaks to detect scripts directory');

  let has_thrown = false;
  try {
    assertNoForbiddenEntries(fixture_dir);
  } catch (err) {
    has_thrown = true;
    assert(err.message.includes('forbidden internal entries'), 'expected error message to mention forbidden entries');
  }
  assert(has_thrown, 'expected assertNoForbiddenEntries to throw on leak');
});

test('catches-evals-directory', () => {
  const fixture_dir = makeTempDir('agent-sdlc-leak-evals-');
  fs.mkdirSync(path.join(fixture_dir, 'evals'), {recursive: true});
  fs.writeFileSync(path.join(fixture_dir, 'evals', 'REPORT.json'), '{}');

  const leaks = findForbiddenEntries(fixture_dir);
  assert(leaks.some(l => l.includes('evals')), 'expected leaks to detect evals directory');
});

test('catches-env-and-logs', () => {
  const fixture_dir = makeTempDir('agent-sdlc-leak-env-');
  fs.writeFileSync(path.join(fixture_dir, '.env'), 'SECRET=123');
  fs.writeFileSync(path.join(fixture_dir, 'debug.log'), 'log data');

  const leaks = findForbiddenEntries(fixture_dir);
  assert(leaks.includes('.env'), 'expected leaks to include .env');
  assert(leaks.includes('debug.log'), 'expected leaks to include debug.log');
});

finish();
