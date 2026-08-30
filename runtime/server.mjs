// Real-Time Live Server & SSE Streaming Hub for Agent SDLC Harness.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {listRuns,listTasks,loadRun,loadState,projectConfig} from './store.mjs';
import {generateDashboardHtml} from './commands/dashboard.mjs';
import {metrics as getMetrics} from './telemetry.mjs';
import {readJson,rootFrom} from './util.mjs';
import {getWebhookDeliveries, matchesPattern} from './webhook.mjs';

const ROOT = rootFrom(import.meta.url);
const clients = new Set();
let eventSeq = 0;
const RECENT_EVENTS = [];
const MAX_BACKLOG = 50;

/**
 * Broadcast an event to all connected SSE clients, respecting individual event filters.
 */
export function broadcastSseEvent(event) {
  if (!event) return;
  eventSeq++;
  const eventRecord = {
    id: String(event.id || eventSeq),
    type: event.type || 'generic',
    timestamp: event.timestamp || new Date().toISOString(),
    ...event
  };

  RECENT_EVENTS.push(eventRecord);
  if (RECENT_EVENTS.length > MAX_BACKLOG) {
    RECENT_EVENTS.shift();
  }

  const payload = `id: ${eventRecord.id}\ndata: ${JSON.stringify(eventRecord)}\n\n`;

  for (const client of clients) {
    try {
      const match = client.filterPatterns.length === 0 || client.filterPatterns.some(p => matchesPattern(eventRecord.type, p));
      if (match) {
        client.res.write(payload);
      }
    } catch {
      clients.delete(client);
    }
  }
}

function renderLiveDashboardHtml(projectRoot) {
  const project = fs.existsSync(path.join(projectRoot, '.agent-sdlc', 'project.json')) ? projectConfig(projectRoot) : {};
  const state = loadState(projectRoot);
  const runIds = listRuns(projectRoot);
  const runs = runIds.map(id => {
    try { return loadRun(projectRoot, id); } catch { return null; }
  }).filter(Boolean);
  const allTasks = [];
  for (const r of runs) {
    try { allTasks.push(...listTasks(projectRoot, r.run_id)); } catch {}
  }
  const metrics = getMetrics(projectRoot);
  const version = (readJson(path.join(ROOT, 'agent-sdlc.manifest.json'), {}).version) || '3.0.0';
  const staticHtml = generateDashboardHtml({
    project,
    state,
    runs,
    tasks: allTasks,
    metrics,
    version
  });

  // Inject live SSE streaming client script into static HTML
  const sseScript = `
<script>
  (function() {
    const badge = document.querySelector('.badge');
    const es = new EventSource('/api/events');
    es.onopen = function() {
      console.log('[Agent SDLC] Connected to live event stream');
      if (badge) {
        badge.textContent = '🟢 Live (SSE Connected)';
        badge.style.background = '#22c55e22';
        badge.style.color = '#22c55e';
        badge.style.borderColor = '#22c55e66';
      }
    };
    es.onerror = function() {
      if (badge) {
        badge.textContent = '⚪ Disconnected (Reconnecting...)';
        badge.style.background = '#eab30822';
        badge.style.color = '#eab308';
        badge.style.borderColor = '#eab30866';
      }
    };
    es.onmessage = function(e) {
      try {
        const event = JSON.parse(e.data);
        console.log('[Agent SDLC Live Event]', event);
        if (['run.started','run.completed','run.transition','task.transition','task.completed','task.workspace_created','task.workspace_committed','task.workspace_integrated','run.rewound'].includes(event.type)) {
          // Auto-refresh data on key lifecycle transitions
          setTimeout(() => location.reload(), 300);
        }
      } catch (err) {}
    };
  })();
</script>
</body>`;
  return staticHtml.replace('</body>', sseScript);
}

/**
 * Start the built-in zero-dependency Live Web Server.
 */
export function startServer(projectRoot, { port = 4100, host = '127.0.0.1' } = {}) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${host}:${port}`);
    const pathname = url.pathname;

    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (pathname === '/' || pathname === '/index.html') {
      const html = renderLiveDashboardHtml(projectRoot);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    if (pathname === '/api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'HEALTHY', timestamp: new Date().toISOString() }));
      return;
    }

    if (pathname === '/api/events' || pathname === '/api/v1/events/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      });

      const typesParam = url.searchParams.get('types');
      const filterPatterns = typesParam ? typesParam.split(',').map(s => s.trim()).filter(Boolean) : [];
      const lastEventId = req.headers['last-event-id'] || url.searchParams.get('last_event_id') || null;

      const clientObj = { res, filterPatterns, lastEventId };
      clients.add(clientObj);

      res.write(`data: ${JSON.stringify({ type: 'stream.connected', timestamp: new Date().toISOString() })}\n\n`);

      // Replay backlog if client provided Last-Event-ID
      if (lastEventId) {
        const lastIdNum = Number(lastEventId);
        for (const ev of RECENT_EVENTS) {
          if (Number(ev.id) > lastIdNum) {
            const match = filterPatterns.length === 0 || filterPatterns.some(p => matchesPattern(ev.type, p));
            if (match) {
              res.write(`id: ${ev.id}\ndata: ${JSON.stringify(ev)}\n\n`);
            }
          }
        }
      }

      const heartbeatTimer = setInterval(() => {
        try {
          res.write(': heartbeat\n\n');
        } catch {
          clearInterval(heartbeatTimer);
          clients.delete(clientObj);
        }
      }, 15000);

      req.on('close', () => {
        clearInterval(heartbeatTimer);
        clients.delete(clientObj);
      });
      return;
    }

    if ((pathname === '/api/v1/events/publish' || pathname === '/api/events/publish') && req.method === 'POST') {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        try {
          const payload = JSON.parse(body || '{}');
          const event = payload.event || payload;
          broadcastSseEvent(event);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'PUBLISHED', id: String(eventSeq), type: event.type }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    if (pathname === '/api/v1/webhooks/deliveries' || pathname === '/api/webhooks/deliveries') {
      const limit = Number(url.searchParams.get('limit')) || 50;
      const deliveries = getWebhookDeliveries(projectRoot, { limit });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        schema: 'agent-sdlc/webhook-deliveries/v1',
        deliveries_count: deliveries.length,
        deliveries
      }, null, 2));
      return;
    }

    if (pathname === '/api/status') {
      const state = loadState(projectRoot);
      const runs = listRuns(projectRoot);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        schema: 'agent-sdlc/server-status/v1',
        active_run_id: state.active_run_id || null,
        runs_count: runs.length,
        connected_clients: clients.size,
        timestamp: new Date().toISOString()
      }, null, 2));
      return;
    }

    if (pathname === '/api/run') {
      const state = loadState(projectRoot);
      const runId = url.searchParams.get('run_id') || state.active_run_id || (listRuns(projectRoot)[0]);
      if (!runId) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'No run found' }));
        return;
      }
      const run = loadRun(projectRoot, runId);
      const tasks = listTasks(projectRoot, runId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ run, tasks }, null, 2));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  });

  return new Promise((resolve, reject) => {
    server.listen(port, host, () => {
      const addr = server.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : port;
      resolve({
        server,
        port: actualPort,
        host,
        url: `http://${host}:${actualPort}`,
        close: () => new Promise(res => server.close(res))
      });
    });
    server.on('error', reject);
  });
}
