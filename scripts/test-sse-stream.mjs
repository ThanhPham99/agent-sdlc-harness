#!/usr/bin/env node
// Test suite for Real-Time Live SSE Event Stream & Event Replay.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {startServer, broadcastSseEvent} from '../runtime/server.mjs';
import {initProject} from '../runtime/store.mjs';
import {createSuite} from './lib/suite.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const {test, assert, finish} = createSuite('agent-sdlc/sse-stream-validation/v1', 'SSE-STREAM-VALIDATION.json');

function fixture() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-sdlc-sse-'));
  initProject(d, { schema: 'agent-sdlc/project/v1', project: 'sse-test' });
  return d;
}

function listenSse(url, { headers = {}, signal } = {}) {
  return new Promise((resolve, reject) => {
    const events = [];
    const parsed = new URL(url);
    const req = http.request(parsed, {
      method: 'GET',
      headers: {
        'Accept': 'text/event-stream',
        ...headers
      },
      signal
    }, (res) => {
      let buffer = '';
      res.on('data', (chunk) => {
        buffer += chunk.toString();
        const parts = buffer.split('\n\n');
        buffer = parts.pop();
        for (const p of parts) {
          const lines = p.split('\n');
          let id = null;
          let data = null;
          for (const line of lines) {
            if (line.startsWith('id: ')) id = line.slice(4).trim();
            if (line.startsWith('data: ')) data = line.slice(6).trim();
          }
          if (data) {
            try {
              events.push({ id, data: JSON.parse(data) });
            } catch {}
          }
        }
      });

      resolve({
        statusCode: res.statusCode,
        events,
        close: () => req.destroy()
      });
    });

    req.on('error', (err) => {
      if (err.name !== 'AbortError') reject(err);
    });
    req.end();
  });
}

function postJson(url, payload) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const body = JSON.stringify(payload);
    const req = http.request(parsed, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      let responseBody = '';
      res.on('data', c => { responseBody += c; });
      res.on('end', () => {
        try {
          resolve({ statusCode: res.statusCode, body: JSON.parse(responseBody) });
        } catch {
          resolve({ statusCode: res.statusCode, body: responseBody });
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request(parsed, { method: 'GET' }, (res) => {
      let responseBody = '';
      res.on('data', c => { responseBody += c; });
      res.on('end', () => {
        try {
          resolve({ statusCode: res.statusCode, body: JSON.parse(responseBody) });
        } catch {
          resolve({ statusCode: res.statusCode, body: responseBody });
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

await test('sse-stream-connection-and-heartbeat', async () => {
  const d = fixture();
  const s = await startServer(d, { port: 0 });

  try {
    const conn = await listenSse(`${s.url}/api/v1/events/stream`);
    assert(conn.statusCode === 200, 'should establish 200 OK SSE connection');
    await new Promise(r => setTimeout(r, 50));
    assert(conn.events.length >= 1, 'should receive initial stream.connected event');
    assert(conn.events[0].data.type === 'stream.connected', 'missing stream.connected type');
    conn.close();
  } finally {
    await s.close();
  }
});

await test('sse-stream-broadcasts-live-events', async () => {
  const d = fixture();
  const s = await startServer(d, { port: 0 });

  try {
    const conn = await listenSse(`${s.url}/api/events`);
    await new Promise(r => setTimeout(r, 50));

    broadcastSseEvent({ type: 'run.transition', stage: 'DEVELOP' });
    broadcastSseEvent({ type: 'task.completed', task_id: 't-1' });

    await new Promise(r => setTimeout(r, 50));
    const types = conn.events.map(e => e.data.type);
    assert(types.includes('run.transition'), 'missing run.transition event');
    assert(types.includes('task.completed'), 'missing task.completed event');
    conn.close();
  } finally {
    await s.close();
  }
});

await test('sse-stream-event-filtering-by-type', async () => {
  const d = fixture();
  const s = await startServer(d, { port: 0 });

  try {
    const conn = await listenSse(`${s.url}/api/v1/events/stream?types=task.*`);
    await new Promise(r => setTimeout(r, 50));

    broadcastSseEvent({ type: 'run.transition', stage: 'DEVELOP' });
    broadcastSseEvent({ type: 'task.started', task_id: 't-2' });

    await new Promise(r => setTimeout(r, 50));
    const types = conn.events.map(e => e.data.type);
    assert(!types.includes('run.transition'), 'should filter out run.transition');
    assert(types.includes('task.started'), 'should include task.started');
    conn.close();
  } finally {
    await s.close();
  }
});

await test('sse-stream-replays-backlog-via-last-event-id', async () => {
  const d = fixture();
  const s = await startServer(d, { port: 0 });

  try {
    broadcastSseEvent({ type: 'run.created', id: '100' });
    broadcastSseEvent({ type: 'run.started', id: '101' });
    broadcastSseEvent({ type: 'task.scheduled', id: '102' });

    const conn = await listenSse(`${s.url}/api/v1/events/stream`, {
      headers: { 'Last-Event-ID': '100' }
    });

    await new Promise(r => setTimeout(r, 50));
    const replayed = conn.events.filter(e => e.id === '101' || e.id === '102');
    assert(replayed.length === 2, 'should replay 2 backlog events with id > 100');
    conn.close();
  } finally {
    await s.close();
  }
});

await test('sse-stream-publish-and-webhook-deliveries-endpoints', async () => {
  const d = fixture();
  const s = await startServer(d, { port: 0 });

  try {
    const pubRes = await postJson(`${s.url}/api/v1/events/publish`, {
      event: { type: 'agent.message', text: 'hello SSE' }
    });
    assert(pubRes.statusCode === 200, 'publish should return 200');
    assert(pubRes.body.status === 'PUBLISHED', 'publish status should be PUBLISHED');

    const whRes = await getJson(`${s.url}/api/v1/webhooks/deliveries`);
    assert(whRes.statusCode === 200, 'deliveries should return 200');
    assert(whRes.body.schema === 'agent-sdlc/webhook-deliveries/v1', 'invalid schema in deliveries');
    assert(Array.isArray(whRes.body.deliveries), 'deliveries should be array');
  } finally {
    await s.close();
  }
});

finish();
