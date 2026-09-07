#!/usr/bin/env node
/**
 * End-to-End Autonomous Pipeline Simulation Suite across all 21 SDLC Workflows.
 * Tests that every workflow reaches CLOSE/COMPLETED via runAutoPipeline without
 * unhandled exceptions, infinite loops, or illegal transitions.
 */
import fs from 'node:fs';
import path from 'node:path';
import {execSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createSuite} from './lib/suite.mjs';
import {makeTempDir} from './lib/tempdir.mjs';
import {initProject, loadRun} from '../runtime/store.mjs';
import {newRun, recordDesignDecision} from '../runtime/orchestrator.mjs';
import {runAutoPipeline} from '../runtime/autonomous-runner.mjs';
import {resolveWorkflows} from '../runtime/config.mjs';
import {grantApprovalTicket} from '../runtime/approvals.mjs';
import {getTaskWorkspace} from '../runtime/workspace.mjs';
import crypto from 'node:crypto';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const {test, assert, finish} = createSuite('agent-sdlc/all-workflows-e2e-validation/v1', 'ALL-WORKFLOWS-E2E-VALIDATION.json');

const workflows = resolveWorkflows(ROOT);
const workflowNames = Object.keys(workflows);

function setupRepoFixture(wfName) {
  const d = makeTempDir(`test-e2e-wf-${wfName}-`);
  initProject(d, {
    schema: 'agent-sdlc/project/v1',
    project: `test-${wfName}`,
    commands: {
      test_targeted: ['node', '-e', 'process.exit(0)'],
      test_full: ['node', '-e', 'process.exit(0)']
    }
  });

  fs.mkdirSync(path.join(d, 'test'), {recursive: true});
  fs.writeFileSync(path.join(d, 'test', 'sample.test.js'), '// test\n', 'utf8');
  fs.mkdirSync(path.join(d, 'src'), {recursive: true});
  fs.writeFileSync(path.join(d, 'src', 'index.js'), '// initial code\n', 'utf8');

  execSync('git init && git config user.email "test@example.local" && git config user.name "Tester" && git add . && git commit -m "initial commit"', {
    cwd: d,
    stdio: 'pipe'
  });

  return d;
}

for (const wf of workflowNames) {
  const spec = workflows[wf];
  await test(`e2e-workflow-autonomous-pipeline-${wf}`, async () => {
    const projectDir = setupRepoFixture(wf);
    const routeObj = {
      workflow: wf,
      profile: spec.default_profile,
      overlays: spec.required_overlays || []
    };

    let run = newRun(ROOT, projectDir, {
      objective: `E2E automated simulation for ${wf}`,
      route: routeObj
    });

    let maxSteps = 12;
    let step = 0;
    let finalRes = null;

    while (step++ < maxSteps) {
      const res = runAutoPipeline(ROOT, projectDir, run, {
        spawnWorker: false,
        spawnReviewer: false,
        workerCallback: (task) => {
          const ws = getTaskWorkspace(projectDir, run.run_id, task.task_id);
          const targetDir = ws ? ws.root : projectDir;
          fs.mkdirSync(path.join(targetDir, 'src'), {recursive: true});
          fs.writeFileSync(path.join(targetDir, 'src', 'index.js'), `// modified by ${task.task_id}\n`, 'utf8');
        },
        reviewerCallback: (task) => {
          return {
            specReview: {
              schema: 'agent-sdlc/spec-compliance-review/v1',
              task_id: task.task_id,
              attempt: task.attempt || 1,
              diff_hash: task.diff_hash || 'hash',
              verdict: 'COMPLIANT',
              findings: [],
              independence: {requested: true, achieved: true}
            },
            qualityReview: {
              schema: 'agent-sdlc/code-quality-review/v1',
              task_id: task.task_id,
              attempt: task.attempt || 1,
              diff_hash: task.diff_hash || 'hash',
              verdict: 'ACCEPTED',
              findings: [],
              independence: {requested: true, achieved: true}
            }
          };
        }
      });

      finalRes = res;
      run = loadRun(projectDir, run.run_id);

      if (res.status === 'PAUSED') {
        if (res.validation_errors && res.current_stage === 'DESIGN') {
          // Author design decision for STRICT workflows requiring FULL design mode
          recordDesignDecision(ROOT, projectDir, run, {
            schema: 'agent-sdlc/design-decision/v1',
            decision_id: `design_${crypto.randomUUID()}`,
            objective: run.objective,
            mode: 'FULL',
            decision: 'Architecture approach confirmed',
            options: [
              {id: 'OPTION-A', summary: 'Option A architecture', benefits: ['Fast'], tradeoffs: ['Complex']},
              {id: 'OPTION-B', summary: 'Option B architecture', benefits: ['Simple'], tradeoffs: ['Slow']}
            ],
            recommended_option: 'OPTION-A',
            approval: {required: true, status: 'APPROVED'}
          });
          run = loadRun(projectDir, run.run_id);
          continue;
        }

        if (res.approval_ticket) {
          grantApprovalTicket(ROOT, projectDir, run, {
            ticketId: res.approval_ticket.ticket_id,
            actor: 'E2E_TEST_ORCHESTRATOR',
            reason: `Approved gate ${res.pause_gate}`
          });
          run = loadRun(projectDir, run.run_id);
          continue;
        }

        // Paused without handled condition
        break;
      } else {
        // COMPLETED or reached final stage
        break;
      }
    }

    assert(run.state === 'CLOSE', `workflow ${wf} should reach CLOSE stage, ended at ${run.state}`);
    assert(finalRes?.status === 'COMPLETED', `pipeline status for ${wf} should be COMPLETED, got ${finalRes?.status}`);
  });
}

finish();
