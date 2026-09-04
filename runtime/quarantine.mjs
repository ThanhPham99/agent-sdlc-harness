// Flaky Test Quarantine Manager for Agent SDLC Harness.
import path from 'node:path';
import fs from 'node:fs';
import {stateDir} from './store.mjs';
import {readJson,writeJson,now,uuid} from './util.mjs';

const norm = p => String(p || '').replace(/\\/g, '/').replace(/^\.\//, '');

function quarantinePath(projectRoot) {
  return path.join(stateDir(projectRoot), 'quarantine.json');
}

/**
 * Load the current flaky test quarantine database.
 */
export function loadQuarantine(projectRoot) {
  const p = quarantinePath(projectRoot);
  return readJson(p, {
    schema: 'agent-sdlc/quarantine/v1',
    tests: [],
    updated_at: null
  });
}

/**
 * Save the quarantine database atomically.
 */
export function saveQuarantine(projectRoot, data) {
  const p = quarantinePath(projectRoot);
  const full = {
    schema: 'agent-sdlc/quarantine/v1',
    tests: Array.isArray(data?.tests) ? data.tests : [],
    updated_at: now()
  };
  writeJson(p, full);
  return full;
}

/**
 * Add a test to the quarantine list.
 */
export function addToQuarantine(projectRoot, { testPath, reason = 'FLAKY_TEST', runId = null } = {}) {
  const target = norm(testPath);
  if (!target) throw new Error('testPath required');
  const data = loadQuarantine(projectRoot);
  const existing = data.tests.find(t => t.test_path === target);

  let record;
  if (existing) {
    existing.reason = reason;
    existing.run_id = runId || existing.run_id;
    existing.last_seen = now();
    record = existing;
  } else {
    record = {
      quarantine_id: uuid('qtn'),
      test_path: target,
      reason,
      run_id: runId,
      quarantined_at: now(),
      last_seen: now()
    };
    data.tests.push(record);
  }

  saveQuarantine(projectRoot, data);
  return record;
}

/**
 * Remove a test from quarantine.
 */
export function removeFromQuarantine(projectRoot, testPath) {
  const target = norm(testPath);
  const data = loadQuarantine(projectRoot);
  const originalCount = data.tests.length;
  data.tests = data.tests.filter(t => t.test_path !== target);
  const removed = data.tests.length < originalCount;

  if (removed) {
    saveQuarantine(projectRoot, data);
  }

  return {
    removed,
    test_path: target,
    remaining_count: data.tests.length
  };
}

/**
 * Check whether a given test is currently quarantined.
 */
export function isQuarantined(projectRoot, testPath) {
  const target = norm(testPath);
  const data = loadQuarantine(projectRoot);
  return data.tests.some(t => t.test_path === target);
}

/**
 * Get quarantine status report.
 */
export function quarantineStatus(projectRoot) {
  const data = loadQuarantine(projectRoot);
  return {
    schema: 'agent-sdlc/quarantine-status/v1',
    quarantined_count: data.tests.length,
    tests: data.tests,
    updated_at: data.updated_at
  };
}
