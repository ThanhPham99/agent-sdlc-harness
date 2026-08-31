#!/usr/bin/env node
// Test suite for Mutation Testing and Test Strength Analyzer.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {
  generateMutations,
  runMutationSuite,
  analyzeRepositoryMutations
} from '../runtime/mutation.mjs';
import {initProject} from '../runtime/store.mjs';
import {createSuite} from './lib/suite.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const {test, assert, finish} = createSuite('agent-sdlc/mutation-validation/v1', 'MUTATION-VALIDATION.json');

await test('generate-mutations-operator-coverage', () => {
  const code = `
    if (a === b && c > 10) {
      const sum = a + b * 2;
      if (arr.length === 0) return true;
      return false;
    }
  `;
  const mutants = generateMutations(code, { maxMutants: 20 });
  assert(mutants.length >= 5, 'should generate at least 5 mutants across operators');

  const types = mutants.map(m => m.type);
  assert(types.includes('EQUALITY'), 'missing EQUALITY mutant');
  assert(types.includes('LOGICAL'), 'missing LOGICAL mutant');
  assert(types.includes('COMPARISON'), 'missing COMPARISON mutant');
  assert(types.includes('ARITHMETIC'), 'missing ARITHMETIC mutant');
  assert(types.includes('RETURN_VALUE'), 'missing RETURN_VALUE mutant');
  assert(types.includes('ARRAY_BOUNDARY'), 'missing ARRAY_BOUNDARY mutant');
});

await test('run-mutation-suite-on-target-file', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-sdlc-mut-'));
  initProject(d, { schema: 'agent-sdlc/project/v1', project: 'mutation-test' });

  fs.writeFileSync(path.join(d, 'calc.mjs'), `
    export function add(a, b) {
      if (a > 0 && b > 0) {
        return a + b;
      }
      return 0;
    }
  `);

  fs.mkdirSync(path.join(d, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(d, 'tests', 'calc.test.mjs'), `
    import { add } from '../calc.mjs';
    if (add(1, 2) !== 3) throw new Error('fail');
  `);

  execFileSync('git', ['init', '-q'], { cwd: d });
  execFileSync('git', ['add', '.'], { cwd: d });
  execFileSync('git', ['-c', 'user.email=test@test.local', '-c', 'user.name=Tester', 'commit', '-qm', 'init'], { cwd: d });

  const rep = runMutationSuite(d, { targetFile: 'calc.mjs' });
  assert(rep.total_mutants > 0, 'mutants should be generated');
  assert(rep.impacted_test_count === 1, 'tests/calc.test.mjs should be recognized as impacted');
  assert(rep.killed === rep.total_mutants, 'all mutants should be killed by impacted test');
  assert(rep.mutation_score === 100, 'mutation score should be 100%');
  assert(rep.status === 'PASS', 'status should be PASS');
});

await test('analyze-repository-mutations-multimodule', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-sdlc-repo-mut-'));
  initProject(d, { schema: 'agent-sdlc/project/v1', project: 'repo-mut-test' });

  // Covered module
  fs.writeFileSync(path.join(d, 'auth.mjs'), `
    export function verify(token) {
      if (token === 'secret') return true;
      return false;
    }
  `);
  fs.mkdirSync(path.join(d, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(d, 'tests', 'auth.test.mjs'), `
    import { verify } from '../auth.mjs';
    if (!verify('secret')) throw new Error('fail');
  `);

  // Uncovered module (no tests)
  fs.writeFileSync(path.join(d, 'payment.mjs'), `
    export function process(amount) {
      if (amount > 100) return amount * 0.9;
      return amount;
    }
  `);

  execFileSync('git', ['init', '-q'], { cwd: d });
  execFileSync('git', ['add', '.'], { cwd: d });
  execFileSync('git', ['-c', 'user.email=test@test.local', '-c', 'user.name=Tester', 'commit', '-qm', 'init'], { cwd: d });

  const repoRep = analyzeRepositoryMutations(d, { maxMutantsPerFile: 5 });
  assert(repoRep.total_files_analyzed === 2, 'should analyze 2 non-test modules');
  assert(repoRep.total_killed > 0, 'some mutants should be killed');
  assert(repoRep.total_survived > 0, 'some mutants in payment.mjs should survive');
  assert(repoRep.weak_spots_count === 1, 'payment.mjs should be identified as weak spot');
  assert(repoRep.weak_spots[0].file === 'payment.mjs', 'weak spot file mismatch');
});

finish();

