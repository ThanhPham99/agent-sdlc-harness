// Real-Time Live Server & SSE Streaming Hub for Agent SDLC Harness.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {listRuns,listTasks,loadRun,loadState,projectConfig} from './store.mjs';
import {generateDashboardHtml} from './commands/dashboard.mjs';
import {metrics as getMetrics} from './telemetry.mjs';
import {readJson,rootFrom} from './util.mjs';

const ROOT=rootFrom(import.meta.url);
const clients = new Set();

/**
 * Broadcast an event to all connected SSE clients.
 */
export function broadcastSseEvent(event) {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of clients) {
    try {
      res.write(payload);
    } catch {
      clients.delete(res);
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

    if (pathname === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      });
      res.write(`data: ${JSON.stringify({ type: 'stream.connected', timestamp: new Date().toISOString() })}\n\n`);
      clients.add(res);

      const heartbeatTimer = setInterval(() => {
        try {
          res.write(': heartbeat\n\n');
        } catch {
          clearInterval(heartbeatTimer);
          clients.delete(res);
        }
      }, 15000);

      req.on('close', () => {
        clearInterval(heartbeatTimer);
        clients.delete(res);
      });
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
