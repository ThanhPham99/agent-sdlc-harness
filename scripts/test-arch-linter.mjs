#!/usr/bin/env node
// Test suite for Architectural Linter & Module Boundary Enforcer.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {
  findCircularDependencies,
  checkModuleBoundaries,
  enforceLayerConstraints,
  checkForbiddenImports,
  auditArchitecture
} from '../runtime/arch-linter.mjs';
import {initProject} from '../runtime/store.mjs';
import {createSuite} from './lib/suite.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const {test, assert, finish} = createSuite('agent-sdlc/arch-linter-validation/v1', 'ARCH-LINTER-VALIDATION.json');

await test('arch-circular-dependency-detection', () => {
  const fakeGraph = {
    files: new Map([
      ['moduleA.mjs', { is_test: false }],
      ['moduleB.mjs', { is_test: false }],
      ['moduleC.mjs', { is_test: false }]
    ]),
    edges: [
      { from: 'moduleA.mjs', to: 'moduleB.mjs' },
      { from: 'moduleB.mjs', to: 'moduleC.mjs' },
      { from: 'moduleC.mjs', to: 'moduleA.mjs' }
    ]
  };

  const res = findCircularDependencies(fakeGraph);
  assert(res.cycle_count === 1, 'should detect exactly 1 circular cycle');
  const cycle = res.cycles[0];
  assert(cycle.length === 3, 'cycle should have 3 nodes');
});

await test('arch-layer-inversion-enforcer', () => {
  const layerOrder = ['domain', 'runtime', 'adapters', 'cli'];
  const fakeGraph = {
    edges: [
      // Valid: cli imports runtime, runtime imports domain
      { from: 'cli/main.mjs', to: 'runtime/engine.mjs' },
      { from: 'runtime/engine.mjs', to: 'domain/models.mjs' },
      // Inversion violation: domain imports cli
      { from: 'domain/models.mjs', to: 'cli/main.mjs' }
    ]
  };

  const res = enforceLayerConstraints(fakeGraph, { layerOrder });
  assert(res.violation_count === 1, 'should detect 1 layer inversion violation');
  assert(res.violations[0].type === 'LAYER_INVERSION', 'violation type should be LAYER_INVERSION');
  assert(res.violations[0].from_layer === 'domain', 'from_layer should be domain');
  assert(res.violations[0].to_layer === 'cli', 'to_layer should be cli');
});

await test('arch-forbidden-imports-checker', () => {
  const forbiddenRules = [
    {
      from: 'adapters',
      to: 'node:fs',
      reason: 'Adapters must use abstraction, not raw fs'
    }
  ];

  const fakeGraph = {
    edges: [
      { from: 'adapters/custom-hook.mjs', to: 'node:fs' },
      { from: 'runtime/store.mjs', to: 'node:fs' }
    ]
  };

  const res = checkForbiddenImports(fakeGraph, { forbiddenRules });
  assert(res.violation_count === 1, 'should detect 1 forbidden import');
  assert(res.violations[0].type === 'FORBIDDEN_IMPORT', 'violation type should be FORBIDDEN_IMPORT');
  assert(res.violations[0].from === 'adapters/custom-hook.mjs', 'from mismatch');
});

await test('audit-architecture-end-to-end', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-sdlc-arch-'));
  initProject(d, { schema: 'agent-sdlc/project/v1', project: 'arch-test' });

  fs.mkdirSync(path.join(d, 'domain'), { recursive: true });
  fs.mkdirSync(path.join(d, 'cli'), { recursive: true });

  fs.writeFileSync(path.join(d, 'domain', 'model.mjs'), `
    import { cliHelper } from '../cli/helper.mjs';
    export const user = { name: 'alice' };
  `);

  fs.writeFileSync(path.join(d, 'cli', 'helper.mjs'), `
    export function cliHelper() { return 'cli'; }
  `);

  execFileSync('git', ['init', '-q'], { cwd: d });
  execFileSync('git', ['add', '.'], { cwd: d });

  const audit = auditArchitecture(d, {
    layerOrder: ['domain', 'cli']
  });

  assert(audit.layer_violations_count === 1, 'should detect 1 layer violation');
  assert(audit.total_issues >= 1, 'total issues should be >= 1');
  assert(audit.status === 'WARN', 'non-strict audit should be WARN');
});

finish();

