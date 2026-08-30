#!/usr/bin/env node
// Test suite for Dead Code, Unused Export, and Ghost Dependency Eliminator.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {findDeadCode, extractExportedSymbols, extractImportedSymbols} from '../runtime/dead-code.mjs';
import {initProject} from '../runtime/store.mjs';
import {createSuite} from './lib/suite.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const {test, assert, finish} = createSuite('agent-sdlc/dead-code-validation/v1', 'DEAD-CODE-VALIDATION.json');

await test('extract-exported-symbols-scanner', () => {
  const code = `
    export function activeHelper() {}
    export async function runJob() {}
    export const MAX_RETRY = 5;
    export class ServiceEngine {}
    export default function main() {}
    export { alpha, beta as gamma };
  `;
  const exportsList = extractExportedSymbols(code);
  const names = exportsList.map(e => e.name);

  assert(names.includes('activeHelper'), 'missing activeHelper function export');
  assert(names.includes('runJob'), 'missing runJob async function export');
  assert(names.includes('MAX_RETRY'), 'missing MAX_RETRY const export');
  assert(names.includes('ServiceEngine'), 'missing ServiceEngine class export');
  assert(names.includes('default'), 'missing default export');
  assert(names.includes('alpha'), 'missing alpha named export');
  assert(names.includes('gamma'), 'missing gamma aliased export');
});

await test('extract-imported-symbols-scanner', () => {
  const code = `
    import { activeHelper, gamma } from './utils.mjs';
    import defaultService from './service.mjs';
    const { MAX_RETRY } = require('./config.mjs');
  `;
  const { namedImports, hasWildcard } = extractImportedSymbols(code);

  assert(namedImports.has('activeHelper'), 'missing activeHelper import');
  assert(namedImports.has('gamma'), 'missing gamma import');
  assert(namedImports.has('default'), 'missing default import');
  assert(namedImports.has('MAX_RETRY'), 'missing MAX_RETRY cjs import');
  assert(!hasWildcard, 'should not have wildcard');
});

await test('find-dead-code-unreachable-files-and-ghost-deps', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-sdlc-dead-'));
  initProject(d, { schema: 'agent-sdlc/project/v1', project: 'dead-test' });

  // package.json with ghost dep
  fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({
    name: 'dead-test',
    dependencies: {
      'used-pkg': '^1.0.0',
      'unused-ghost-pkg': '^2.0.0'
    }
  }, null, 2));

  // main entry point
  fs.writeFileSync(path.join(d, 'index.mjs'), `
    import 'used-pkg';
    import { usedFunction } from './reachable.mjs';
    usedFunction();
  `);

  // reachable module with used and unused exports
  fs.writeFileSync(path.join(d, 'reachable.mjs'), `
    export function usedFunction() { return 1; }
    export function abandonedFunction() { return 2; }
  `);

  // completely unreachable file
  fs.writeFileSync(path.join(d, 'orphan.mjs'), `
    export const NEVER_CALLED = 100;
  `);

  execFileSync('git', ['init', '-q'], { cwd: d });
  execFileSync('git', ['add', '.'], { cwd: d });

  const report = findDeadCode(d);

  assert(report.unreachable_files_count === 1, 'should find 1 unreachable file');
  assert(report.unreachable_files[0].path === 'orphan.mjs', 'orphan.mjs should be unreachable');

  const unusedNames = report.unused_exports.map(u => u.name);
  assert(unusedNames.includes('abandonedFunction'), 'abandonedFunction should be flagged as unused export');

  assert(report.ghost_dependencies_count === 1, 'should find 1 ghost dependency');
  assert(report.ghost_dependencies[0].name === 'unused-ghost-pkg', 'ghost dep mismatch');
  assert(report.health_score < 100, 'health_score should reflect issues');
});

finish();

