// Standalone Security & Secret Scanner with Shannon Entropy calculation.
import fs from 'node:fs';
import path from 'node:path';
import {readJson} from './util.mjs';

/**
 * Calculate Shannon Entropy of a string to detect high-randomness secrets.
 * Entropy >= 4.5 on strings > 20 chars usually indicates cryptographic tokens/keys.
 */
export function calculateEntropy(str) {
  if (!str || typeof str !== 'string') return 0;
  const len = str.length;
  const frequencies = new Map();
  for (let i = 0; i < len; i++) {
    const char = str[i];
    frequencies.set(char, (frequencies.get(char) || 0) + 1);
  }
  let entropy = 0;
  for (const count of frequencies.values()) {
    const p = count / len;
    entropy -= p * Math.log2(p);
  }
  return Number(entropy.toFixed(4));
}

/**
 * Check if a token/word has high entropy and sufficient length.
 */
export function isHighEntropySecret(str, minEntropy = 4.5, minLength = 20) {
  if (!str || typeof str !== 'string' || str.length < minLength) return false;
  // Ignore base64 image data or normal URLs if they match common non-secret prefixes
  if (str.startsWith('data:image/') || str.startsWith('http://') || str.startsWith('https://')) return false;
  return calculateEntropy(str) >= minEntropy;
}

/**
 * Scan a text content against declared security policy patterns.
 */
export function scanTextForSecrets(text, patterns = []) {
  const findings = [];
  for (const p of patterns) {
    try {
      const rx = new RegExp(p.regex, 'g');
      let match;
      while ((match = rx.exec(text)) !== null) {
        findings.push({
          id: p.id,
          matched: match[0].slice(0, 8) + '...' + match[0].slice(-4),
          index: match.index
        });
      }
    } catch {}
  }
  return {
    clean: findings.length === 0,
    findings_count: findings.length,
    findings
  };
}