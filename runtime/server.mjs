// Real-Time Live Server & SSE Streaming Hub for Agent SDLC Harness.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {listRuns,listTasks,loadRun,loadState} from './store.mjs';
import {generateDashboardHtml} from './commands/dashboard.mjs';

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

function renderLiveDashboardHtml(projectRoot, run) {
  const staticHtml = generateDashboardHtml(projectRoot, run);
  // Inject live SSE streaming client script into static HTML
  const sseScript = `
<script>
  (function() {
    const statusBadge = document.querySelector('.badge');
    const es = new EventSource('/api/events');
    es.onopen = function() {
      console.log('[Agent SDLC] Connected to live event stream');
    };
    es.onmessage = function(e) {
      try {
        const event = JSON.parse(e.data);
        console.log('[Agent SDLC Live Event]', event);
        if (event.type === 'run.started' || event.type === 'run.completed' || event.type === 'task.transition' || event.type === 'task.completed' || event.type === 'run.rewound') {
          // Auto-refresh data on key lifecycle transitions
          setTimeout(() => location.reload(), 500);
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
      const state = loadState(projectRoot);
      const runId = state.active_run_id || (listRuns(projectRoot)[0]);
      const run = runId ? loadRun(projectRoot, runId) : null;
      const html = renderLiveDashboardHtml(projectRoot, run);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
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
