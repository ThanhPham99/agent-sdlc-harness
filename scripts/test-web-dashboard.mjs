#!/usr/bin/env node
// Test suite for Built-in Live Web Dashboard & Server APIs.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {initProject, saveTask} from '../runtime/store.mjs';
import {startServer} from '../runtime/server.mjs';
import {newRun} from '../runtime/orchestrator.mjs';
import {route} from '../runtime/router.mjs';
import {createSuite} from './lib/suite.mjs';
import {makeTempDir} from './lib/tempdir.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const {test, assert, finish} = createSuite('agent-sdlc/web-dashboard-validation/v1', 'WEB-DASHBOARD-VALIDATION.json');

function fixture() {
  const d = makeTempDir('agent-sdlc-web-dash-');
  initProject(d, { schema: 'agent-sdlc/project/v1', project: 'web-dash-test' });
  return d;
}

function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get(url, {headers}, res => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => resolve({statusCode: res.statusCode, headers: res.headers, body}));
    }).on('error', reject);
  });
}

function httpPost(url, payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const parsed = new URL(url);
    const req = http.request(parsed, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      }
    }, res => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => resolve({statusCode: res.statusCode, headers: res.headers, body}));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

await test('web-dashboard-html-and-static-render', async () => {
  const d = fixture();
  const r = route(ROOT, 'Web Dashboard Test Feature');
  const run = newRun(ROOT, d, {objective: 'Web Dashboard Test Feature', route: r});

  saveTask(d, {
    run_id: run.run_id,
    task_id: 'TASK-001',
    title: 'Initial Dashboard Task',
    status: 'DONE',
    category: 'FEATURE',
    attempt: 1,
    dependencies: [],
    scope: {write: ['src/index.js'], interfaces: []}
  });

  saveTask(d, {
    run_id: run.run_id,
    task_id: 'TASK-002',
    title: 'Dependent Task',
    status: 'RUNNING',
    category: 'FEATURE',
    attempt: 1,
    dependencies: ['TASK-001'],
    scope: {write: ['src/api.js'], interfaces: ['Api']}
  });

  const srv = await startServer(d, {port: 0, host: '127.0.0.1'});
  const baseUrl = srv.url;

  try {
    // GET / (HTML Dashboard)
    const home = await httpGet(baseUrl);
    assert(home.statusCode === 200, 'GET / should return 200');
    assert(home.body.includes('Agent SDLC'), 'GET / should contain Agent SDLC');
    assert(home.body.includes('/api/events'), 'GET / should contain SSE script');

    // GET /api/health
    const health = await httpGet(baseUrl + '/api/health');
    assert(health.statusCode === 200, 'GET /api/health should return 200');
    const healthJson = JSON.parse(health.body);
    assert(healthJson.status === 'HEALTHY', 'health check status failed');

    // GET /api/status
    const statusRes = await httpGet(baseUrl + '/api/status');
    assert(statusRes.statusCode === 200, 'GET /api/status should return 200');
    const statusJson = JSON.parse(statusRes.body);
    assert(statusJson.schema === 'agent-sdlc/server-status/v1', 'status schema mismatch');
    assert(statusJson.runs_count >= 1, 'status runs_count failed');

    // GET /api/run
    const runRes = await httpGet(baseUrl + '/api/run?run_id=' + run.run_id);
    assert(runRes.statusCode === 200, 'GET /api/run should return 200');
    const runJson = JSON.parse(runRes.body);
    assert(runJson.run.run_id === run.run_id, 'run id mismatch');
    assert(runJson.tasks.length === 2, 'tasks length mismatch');

    // GET /api/dag
    const dagRes = await httpGet(baseUrl + '/api/dag?run_id=' + run.run_id);
    assert(dagRes.statusCode === 200, 'GET /api/dag should return 200');
    const dagJson = JSON.parse(dagRes.body);
    assert(dagJson.schema === 'agent-sdlc/dag-view/v1', 'dag schema mismatch');
    assert(dagJson.mermaid.includes('TASK_001 --> TASK_002'), 'Mermaid DAG missing dependency');

    // GET /api/trace
    const traceRes = await httpGet(baseUrl + '/api/trace?run_id=' + run.run_id);
    assert(traceRes.statusCode === 200, 'GET /api/trace should return 200');
    const traceJson = JSON.parse(traceRes.body);
    assert(traceJson.schema === 'agent-sdlc/trace-view/v1', 'trace schema mismatch');

    // POST /api/v1/events/publish
    const pubRes = await httpPost(baseUrl + '/api/v1/events/publish', {
      type: 'task.completed',
      task_id: 'TASK-001'
    });
    assert(pubRes.statusCode === 200, 'POST /api/v1/events/publish should return 200');
    const pubJson = JSON.parse(pubRes.body);
    assert(pubJson.status === 'PUBLISHED', 'publish status mismatch');

    // GET /api/v1/webhooks/deliveries
    const whRes = await httpGet(baseUrl + '/api/v1/webhooks/deliveries');
    assert(whRes.statusCode === 200, 'GET webhooks deliveries should return 200');
  } finally {
    await srv.close();
  }
});

finish();
