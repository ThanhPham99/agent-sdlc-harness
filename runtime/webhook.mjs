// Native Zero-Dependency Webhook Notifications System for Agent SDLC Harness.
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import {projectConfig} from './store.mjs';
import {now} from './util.mjs';

/**
 * Send an HTTP/HTTPS JSON POST webhook with optional HMAC-SHA256 signature.
 */
export function sendWebhook(targetUrl, payload, { secret=null, timeoutMs=5000 } = {}) {
  return new Promise((resolve) => {
    try {
      const parsed = new URL(targetUrl);
      const isHttps = parsed.protocol === 'https:';
      const transport = isHttps ? https : http;
      const jsonBody = typeof payload === 'string' ? payload : JSON.stringify(payload);

      const headers = {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(jsonBody),
        'User-Agent': 'agent-sdlc-harness/3.0.0'
      };

      if (secret) {
        const sig = crypto.createHmac('sha256', secret).update(jsonBody).digest('hex');
        headers['X-Agent-SDLC-Signature'] = `sha256=${sig}`;
      }

      const req = transport.request(parsed, {
        method: 'POST',
        headers,
        timeout: timeoutMs
      }, (res) => {
        let body = '';
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => {
          resolve({
            status: res.statusCode >= 200 && res.statusCode < 300 ? 'DELIVERED' : 'HTTP_ERROR',
            status_code: res.statusCode,
            url: targetUrl,
            time: now()
          });
        });
      });

      req.on('error', (err) => {
        resolve({
          status: 'NETWORK_ERROR',
          error: err.message,
          url: targetUrl,
          time: now()
        });
      });

      req.on('timeout', () => {
        req.destroy();
        resolve({
          status: 'TIMEOUT',
          error: `request timed out after ${timeoutMs}ms`,
          url: targetUrl,
          time: now()
        });
      });

      req.write(jsonBody);
      req.end();
    } catch (e) {
      resolve({
        status: 'INVALID_URL',
        error: e.message,
        url: targetUrl,
        time: now()
      });
    }
  });
}

/**
 * Compute HMAC-SHA256 signature for a webhook payload.
 */
export function computeWebhookSignature(secret, body) {
  const jsonBody = typeof body === 'string' ? body : JSON.stringify(body);
  return `sha256=${crypto.createHmac('sha256', secret).update(jsonBody).digest('hex')}`;
}

/**
 * Test a webhook URL by sending a ping payload.
 */
export async function testWebhook(targetUrl, { secret=null, payload=null } = {}) {
  const pingPayload = payload || {
    event: 'agent-sdlc.ping',
    message: 'Test webhook notification from Agent SDLC Harness',
    timestamp: now()
  };
  return sendWebhook(targetUrl, pingPayload, { secret });
}

export function matchesPattern(eventType, pattern) {
  if (!pattern || pattern === '*') return true;
  if (pattern.endsWith('*')) {
    const prefix = pattern.slice(0, -1);
    return eventType.startsWith(prefix);
  }
  return eventType === pattern;
}

/**
 * Dispatch webhooks declared in .agent-sdlc/project.json asynchronously (non-blocking).
 */
export function dispatchWebhooks(projectRoot, event) {
  try {
    const cfg = projectConfig(projectRoot);
    const webhooks = Array.isArray(cfg?.webhooks) ? cfg.webhooks : [];
    if (webhooks.length === 0) return [];

    const eventType = event.type || 'unknown';
    const dispatches = [];

    for (const hook of webhooks) {
      if (!hook.url) continue;
      const patterns = Array.isArray(hook.events) ? hook.events : ['*'];
      const matched = patterns.some(p => matchesPattern(eventType, p));
      if (matched) {
        // Fire-and-forget promise with silent error logging to prevent breaking main loop
        const p = sendWebhook(hook.url, event, { secret: hook.secret || null, timeoutMs: hook.timeout_ms || 5000 });
        dispatches.push(p);
      }
    }
    return dispatches;
  } catch {
    return [];
  }
}
