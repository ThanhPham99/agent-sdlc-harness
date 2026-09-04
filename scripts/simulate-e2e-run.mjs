#!/usr/bin/env node
// End-to-End Simulation & Dogfooding Test Suite for Agent SDLC Harness.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {initProject, saveRun, saveTask, putArtifact, loadRun, listTasks} from '../runtime/store.mjs';
import {newRun, transition} from '../runtime/orchestrator.mjs';
import {route} from '../runtime/router.mjs';
import {materializeTaskGraph, transitionTask} from '../runtime/task-engine.mjs';
import {verifyTask} from '../runtime/task-verification.mjs';
import {generatePrBody} from '../runtime/pr-generator.mjs';
import {createSuite} from './lib/suite.mjs';
import {makeTempDir} from './lib/tempdir.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const {test, assert, finish} = createSuite('agent-sdlc/e2e-simulation-validation/v1', 'E2E-SIMULATION-VALIDATION.json');

function fixture() {
  const d = makeTempDir('agent-sdlc-e2e-');
  initProject(d, {
    schema: 'agent-sdlc/project/v1',
    project: 'e2e-dogfood-service',
    test_commands: {
      test_targeted: ['node', '-e', 'process.exit(0)'],
      test_full: ['node', '-e', 'process.exit(0)']
    }
  });
  return d;
}

await test('e2e-full-10-stage-lifecycle-simulation', async () => {
  const d = fixture();

  // 1. INTAKE & ROUTING
  const r = route(ROOT, 'Xây dựng tính năng quản lý giỏ hàng mới cho người dùng');
  assert(r.workflow === 'new-feature', 'routing workflow should be new-feature');
  let run = newRun(ROOT, d, {objective: 'Xây dựng tính năng quản lý giỏ hàng mới cho người dùng', route: r});
  assert(run.state === 'INTAKE', 'initial run state must be INTAKE');

  // 2. REQUIREMENTS
  const specArt = putArtifact(d, {
    kind: 'specification',
    content: JSON.stringify({
      schema: 'agent-sdlc/spec/v1',
      feature: 'cart-service',
      items_max: 50
    }),
    runId: run.run_id,
    stage: 'REQUIREMENTS'
  });
  assert(specArt && specArt.artifact_id, 'spec artifact put failed');
  run = transition(ROOT, d, run, 'REQUIREMENTS');
  assert(run.state === 'REQUIREMENTS', 'state should be REQUIREMENTS');

  // 3. DESIGN
  const designArt = putArtifact(d, {
    kind: 'design-document',
    content: JSON.stringify({
      schema: 'agent-sdlc/design/v1',
      api: { endpoint: '/cart/items' }
    }),
    runId: run.run_id,
    stage: 'DESIGN'
  });
  run = transition(ROOT, d, run, 'DESIGN', {evidence: ['requirements_confirmed']});
  assert(run.state === 'DESIGN', 'state should be DESIGN');

  // 4. PLAN (Materialize Task DAG)
  const taskPlan = {
    schema: 'agent-sdlc/task-plan/v1',
    plan_id: 'PLAN-E2E-001',
    objective: 'Xây dựng tính năng quản lý giỏ hàng mới cho người dùng',
    tasks: [
      {
        task_id: 'TASK-001',
        title: 'Core Cart Storage Logic',
        goal: 'Implement in-memory cart logic',
        done_conditions: ['Cart methods pass unit tests'],
        category: 'implementation',
        depends_on: [],
        write_scope: ['src/cart.js'],
        interface_scope: ['Cart'],
        compatibility_obligations: ['Backward compatible Cart API'],
        verification: { targeted_tests: ['test/cart.test.js'] }
      },
      {
        task_id: 'TASK-002',
        title: 'REST API Cart Controller',
        goal: 'Implement HTTP cart controller endpoints',
        done_conditions: ['Controller endpoints respond with JSON'],
        category: 'implementation',
        depends_on: ['TASK-001'],
        write_scope: ['src/controller.js'],
        interface_scope: ['Controller'],
        compatibility_obligations: ['Backward compatible HTTP endpoints'],
        verification: { targeted_tests: ['test/controller.test.js'] }
      }
    ]
  };
  const planArt = putArtifact(d, {
    kind: 'task-plan',
    content: JSON.stringify(taskPlan),
    runId: run.run_id,
    stage: 'PLAN'
  });
  const mat = materializeTaskGraph(ROOT, d, run, taskPlan, { planArtifactRef: planArt.artifact_id });
  assert(mat.materialized === true, 'task graph materialization failed');
  run = transition(ROOT, d, run, 'PLAN', {evidence: ['design_or_skip_decision'], internal: true});
  assert(run.state === 'PLAN', 'state should be PLAN');

  // 5. IMPLEMENT / EXECUTE
  run = transition(ROOT, d, run, 'IMPLEMENT', {
    evidence: ['plan_artifact_created', 'plan_schema_valid', 'plan_graph_valid', 'plan_acceptance_coverage_valid', 'plan_scope_conflicts_resolved'],
    internal: true
  });
  assert(run.state === 'IMPLEMENT', 'state should be IMPLEMENT');

  const {loadTask} = await import('../runtime/store.mjs');

  // Execute TASK-001
  const t1 = loadTask(d, run.run_id, 'TASK-001');
  assert(t1, 'TASK-001 not found');
  transitionTask(ROOT, d, t1, 'READY', {internal: true, force: true});
  transitionTask(ROOT, d, t1, 'RUNNING', {internal: true, force: true});
  fs.mkdirSync(path.join(d, 'src'), {recursive: true});
  fs.writeFileSync(path.join(d, 'src', 'cart.js'), 'export class Cart {}', 'utf8');
  transitionTask(ROOT, d, t1, 'DONE', {
    force: true,
    verification: { status: 'PASS' }
  });

  // Execute TASK-002
  const t2 = loadTask(d, run.run_id, 'TASK-002');
  assert(t2, 'TASK-002 not found');
  transitionTask(ROOT, d, t2, 'READY', {internal: true, force: true});
  transitionTask(ROOT, d, t2, 'RUNNING', {internal: true, force: true});
  fs.writeFileSync(path.join(d, 'src', 'controller.js'), 'export class Controller {}', 'utf8');
  transitionTask(ROOT, d, t2, 'DONE', {
    force: true,
    verification: { status: 'PASS' }
  });

  // 6. VERIFY
  const verTasks = listTasks(d, run.run_id);
  assert(verTasks.every(t => t.status === 'DONE'), 'all tasks should be DONE');
  const verArt = putArtifact(d, {
    kind: 'verification-report',
    content: JSON.stringify({
      schema: 'agent-sdlc/verify/v1',
      tests_passed: 12,
      lint_clean: true,
      coverage_percent: 98.5
    }),
    runId: run.run_id,
    stage: 'VERIFY'
  });
  run = transition(ROOT, d, run, 'VERIFY', {
    evidence: ['implementation_artifact', 'task_graph_complete'],
    internal: true
  });
  assert(run.state === 'VERIFY', 'state should be VERIFY');

  // 7. REVIEW
  const reviewArt = putArtifact(d, {
    kind: 'code-review',
    content: JSON.stringify({
      schema: 'agent-sdlc/review/v1',
      verdict: 'APPROVED',
      dimensions: { correctness: 'PASS', security: 'PASS', performance: 'PASS', architecture: 'PASS' }
    }),
    runId: run.run_id,
    stage: 'REVIEW'
  });
  run = transition(ROOT, d, run, 'REVIEW', {
    evidence: ['targeted_verification_pass', 'no_new_high_security_findings'],
    internal: true
  });
  assert(run.state === 'REVIEW', 'state should be REVIEW');

  // 8. RELEASE (PR Synthesis)
  const prSummary = generatePrBody(d, run);
  assert(typeof prSummary === 'string' && prSummary.includes('Objective'), 'PR markdown should include objective');
  const delivArt = putArtifact(d, {
    kind: 'pr-description',
    content: prSummary,
    runId: run.run_id,
    stage: 'RELEASE'
  });
  run = transition(ROOT, d, run, 'RELEASE', {
    evidence: ['required_reviews_resolved'],
    internal: true
  });
  assert(run.state === 'RELEASE', 'state should be RELEASE');

  // 9. DEPLOY
  run = transition(ROOT, d, run, 'DEPLOY', {
    evidence: ['release_evidence_current'],
    internal: true
  });
  assert(run.state === 'DEPLOY', 'state should be DEPLOY');

  // 10. OBSERVE
  run = transition(ROOT, d, run, 'OBSERVE', {
    evidence: ['deployment_receipt'],
    internal: true
  });
  assert(run.state === 'OBSERVE', 'state should be OBSERVE');

  // 11. CLOSE
  run = transition(ROOT, d, run, 'CLOSE', {
    evidence: ['production_health_verified', 'handoff_written', 'docs_reconciled'],
    internal: true
  });
  assert(run.state === 'CLOSE', 'state should be CLOSE');
});

finish();
