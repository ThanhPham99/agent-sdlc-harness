#!/usr/bin/env node
// Test suite for Webhook Notifications & Exponential Backoff Retry.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {sendWebhook, sendWebhookWithRetry, getWebhookDeliveries, computeWebhookSignature, matchesPattern, testWebhook} from '../runtime/webhook.mjs';
import {initProject} from '../runtime/store.mjs';
import {createSuite} from './lib/suite.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const {test, assert, finish} = createSuite('agent-sdlc/webhook-validation/v1', 'WEBHOOK-VALIDATION.json');

function startTestServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        url: `http://127.0.0.1:${port}/webhook`,
        close: () => new Promise(res => server.close(res))
      });
    });
  });
}

await test('webhook-pattern-matching', () => {
  assert(matchesPattern('run.started', '*'), 'wildcard should match');
  assert(matchesPattern('run.started', 'run.*'), 'prefix wildcard should match');
  assert(matchesPattern('run.started', 'run.started'), 'exact match should match');
  assert(!matchesPattern('task.started', 'run.*'), 'non-matching prefix should fail');
});

await test('webhook-signature-computation', () => {
  const secret = 'super-secret-key';
  const payload = { hello: 'world' };
  const sig = computeWebhookSignature(secret, payload);
  assert(typeof sig === 'string' && sig.startsWith('sha256='), 'invalid signature format');
});

await test('webhook-direct-send-success', async () => {
  let received = null;
  const s = await startTestServer((REQ, RES) => {
    let body = '';
    REQ.on('data', c => { body += c; });
    REQ.on('end', () => {
      received = JSON.parse(body);
      RES.writeHead(200, { 'Content-Type': 'application/json' });
      RES.end(JSON.stringify({ ok: true }));
    });
  });

  try {
    const res = await sendWebhook(s.url, { event: 'test.event', data: 123 });
    assert(res.status === 'DELIVERED', 'status should be DELIVERED');
    assert(res.status_code === 200, 'status_code should be 200');
    assert(received && received.event === 'test.event', 'server did not receive payload');
  } finally {
    await s.close();
  }
});

await test('webhook-retry-recovers-after-transient-500', async () => {
  let attempts = 0;
  const s = await startTestServer((REQ, RES) => {
    attempts++;
    if (attempts === 1) {
      RES.writeHead(500, { 'Content-Type': 'application/json' });
      RES.end(JSON.stringify({ error: 'Internal Server Error' }));
    } else {
      RES.writeHead(200, { 'Content-Type': 'application/json' });
      RES.end(JSON.stringify({ ok: true }));
    }
  });

  try {
    const res = await sendWebhookWithRetry(s.url, { event: 'run.transition', stage: 'TEST' }, {
      maxRetries: 3,
      initialBackoffMs: 20,
      backoffMultiplier: 1.5,
      jitter: false
    });

    assert(res.status === 'DELIVERED', 'status should be DELIVERED after retry');
    assert(res.attempts === 2, 'should succeed on attempt 2');
    assert(res.history.length === 2, 'history should have 2 attempts');
    assert(res.history[0].status_code === 500, 'attempt 1 should be 500');
    assert(res.history[1].status_code === 200, 'attempt 2 should be 200');
  } finally {
    await s.close();
  }
});

await test('webhook-retry-fails-permanently-on-persistent-error', async () => {
  let attempts = 0;
  const s = await startTestServer((REQ, RES) => {
    attempts++;
    RES.writeHead(503, { 'Content-Type': 'application/json' });
    RES.end(JSON.stringify({ error: 'Service Unavailable' }));
  });

  try {
    const res = await sendWebhookWithRetry(s.url, { event: 'fatal.error' }, {
      maxRetries: 3,
      initialBackoffMs: 15,
      backoffMultiplier: 1.5,
      jitter: false
    });

    assert(res.status === 'FAILED_PERMANENTLY', 'status should be FAILED_PERMANENTLY');
    assert(res.attempts === 3, 'should have attempted 3 times');
    assert(attempts === 3, 'server should have received 3 requests');
  } finally {
    await(s.close());
  }
});

await test('webhook-delivery-logging-to-disk', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-sdlc-wh-'));
  initProject(d, { schema: 'agent-sdlc/project/v1', project: 'wh-test' });

  const s = await startTestServer((REQ, RES) => {
    RES.writeHead(200);
    RES.end('ok');
  });

  try {
    const res = await sendWebhookWithRetry(s.url, { type: 'run.completed', run_id: 'r-1' }, {
      projectRoot: d,
      maxRetries: 2,
      initialBackoffMs: 10
    });

    assert(res.status === 'DELIVERED', 'should be DELIVERED');
    const logs = getWebhookDeliveries(d);
    assert(logs.length === 1, 'should have 1 delivery log');
    assert(logs[0].event_type === 'run.completed', 'event_type mismatch');
    assert(logs[0].status === 'DELIVERED', 'status mismatch in log');
    assert(logs[0].attempts === 1, 'attempts mismatch in log');
  } finally {
    await s.close();
  }
});

finish();
