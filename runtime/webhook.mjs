// Native Zero-Dependency Webhook Notifications System for Agent SDLC Harness.
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {projectConfig, stateDir} from './store.mjs';
import {now, ensureDir, readJson, writeJson} from './util.mjs';

const deliveriesPath = projectRoot => path.join(stateDir(projectRoot), 'webhooks', 'deliveries.json');

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
 * Helper to determine if a webhook result should be retried.
 */
function isRetryable(result) {
  if (!result) return false;
  if (result.status === 'NETWORK_ERROR' || result.status === 'TIMEOUT') return true;
  if (result.status === 'HTTP_ERROR') {
    const code = Number(result.status_code);
    return code === 429 || (code >= 500 && code <= 599);
  }
  return false;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Record a delivery attempt into .agent-sdlc/webhooks/deliveries.json (bounded to latest 100 entries).
 */
export function recordWebhookDelivery(projectRoot, deliveryRecord) {
  if (!projectRoot) return;
  try {
    const filePath = deliveriesPath(projectRoot);
    ensureDir(path.dirname(filePath));
    const data = fs.existsSync(filePath) ? readJson(filePath, { deliveries: [] }) : { deliveries: [] };
    const list = Array.isArray(data.deliveries) ? data.deliveries : [];
    list.unshift(deliveryRecord);
    const bounded = list.slice(0, 100);
    writeJson(filePath, {
      schema: 'agent-sdlc/webhook-deliveries/v1',
      updated_at: now(),
      count: bounded.length,
      deliveries: bounded
    });
  } catch {}
}

/**
 * Get recent webhook deliveries from disk.
 */
export function getWebhookDeliveries(projectRoot, { limit = 50 } = {}) {
  if (!projectRoot) return [];
  try {
    const filePath = deliveriesPath(projectRoot);
    if (!fs.existsSync(filePath)) return [];
    const data = readJson(filePath, { deliveries: [] });
    const list = Array.isArray(data.deliveries) ? data.deliveries : [];
    return list.slice(0, Number(limit) || 50);
  } catch {
    return [];
  }
}

/**
 * Send an HTTP/HTTPS webhook with exponential backoff and retry.
 */
export async function sendWebhookWithRetry(targetUrl, payload, {
  secret = null,
  timeoutMs = 5000,
  maxRetries = 3,
  initialBackoffMs = 100,
  backoffMultiplier = 2,
  maxBackoffMs = 5000,
  jitter = true,
  projectRoot = null
} = {}) {
  const startTime = Date.now();
  const deliveryId = `wh_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const eventType = payload?.type || payload?.event || 'generic';
  const history = [];

  let lastResult = null;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const result = await sendWebhook(targetUrl, payload, { secret, timeoutMs });
    lastResult = result;
    history.push({
      attempt,
      status: result.status,
      status_code: result.status_code || null,
      error: result.error || null,
      time: result.time || now()
    });

    if (result.status === 'DELIVERED') {
      const record = {
        delivery_id: deliveryId,
        url: targetUrl,
        event_type: eventType,
        status: 'DELIVERED',
        attempts: attempt,
        history,
        duration_ms: Date.now() - startTime,
        created_at: now()
      };
      if (projectRoot) recordWebhookDelivery(projectRoot, record);
      return {
        ...record,
        last_result: result
      };
    }

    if (attempt < maxRetries && isRetryable(result)) {
      const baseDelay = Math.min(maxBackoffMs, initialBackoffMs * Math.pow(backoffMultiplier, attempt - 1));
      const delay = jitter ? baseDelay + Math.floor(Math.random() * (initialBackoffMs * 0.5)) : baseDelay;
      await sleep(delay);
    } else {
      break;
    }
  }

  const finalRecord = {
    delivery_id: deliveryId,
    url: targetUrl,
    event_type: eventType,
    status: 'FAILED_PERMANENTLY',
    attempts: history.length,
    history,
    error: lastResult?.error || `Failed with status code ${lastResult?.status_code}`,
    duration_ms: Date.now() - startTime,
    created_at: now()
  };
  if (projectRoot) recordWebhookDelivery(projectRoot, finalRecord);

  return {
    ...finalRecord,
    last_result: lastResult
  };
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
export async function testWebhook(targetUrl, { secret = null, payload = null } = {}) {
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
export function dispatchWebhooks(projectRoot, event, { withRetry = true } = {}) {
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
        const sender = withRetry
          ? sendWebhookWithRetry(hook.url, event, {
              secret: hook.secret || null,
              timeoutMs: hook.timeout_ms || 5000,
              maxRetries: hook.max_retries || 3,
              projectRoot
            })
          : sendWebhook(hook.url, event, { secret: hook.secret || null, timeoutMs: hook.timeout_ms || 5000 });
        dispatches.push(sender);
      }
    }
    return dispatches;
  } catch {
    return [];
  }
}
