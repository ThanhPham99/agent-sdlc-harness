#!/usr/bin/env node
// Test suite for Expanded Secret Scanner and Shannon Entropy detection.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {calculateEntropy,isHighEntropySecret,scanTextForSecrets} from '../runtime/scanner.mjs';
import {readJson} from '../runtime/util.mjs';
import {createSuite} from './lib/suite.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const policy=readJson(path.join(ROOT,'policies','security-policy.json'));
const patterns=policy.secret_scan.patterns;

const {test,assert,finish}=createSuite('agent-sdlc/secret-scanner-validation/v1','SECRET-SCANNER-VALIDATION.json');

await test('shannon-entropy-calculation',()=>{
  const low=calculateEntropy('aaaaaaaaaaaaaaaa');
  assert(low===0,'entropy of uniform char string should be 0');

  const medium=calculateEntropy('hello world this is normal text');
  assert(medium>2.5&&medium<4.2,`expected medium entropy, got ${medium}`);

  const high=calculateEntropy('a8F#9xK2$mZ!pL0@qW3*vB7&eR4%tY1');
  assert(high>=4.5,`expected high entropy >= 4.5, got ${high}`);
  assert(isHighEntropySecret('a8F#9xK2$mZ!pL0@qW3*vB7&eR4%tY1',4.5,20)===true,'should be flagged high entropy');
});

await test('detect-anthropic-key',()=>{
  const text='const apiKey = "sk-ant-api03-1234567890abcdef1234567890abcdef";';
  const res=scanTextForSecrets(text,patterns);
  assert(res.clean===false,'should detect Anthropic API key');
  assert(res.findings.some(f=>f.id==='ANTHROPIC_API_KEY'),'missing ANTHROPIC_API_KEY finding');
});

await test('detect-openai-key',()=>{
  const text='export const OPENAI="sk-proj-1234567890abcdef1234567890abcdef";';
  const res=scanTextForSecrets(text,patterns);
  assert(res.clean===false,'should detect OpenAI key');
  assert(res.findings.some(f=>f.id==='OPENAI_API_KEY'),'missing OPENAI_API_KEY finding');
});

await test('detect-github-pat',()=>{
  const text='const token = "github_pat_11AAAAAAA01234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef12345678";';
  const res=scanTextForSecrets(text,patterns);
  assert(res.clean===false,'should detect GitHub Fine-grained PAT');
  assert(res.findings.some(f=>f.id==='GITHUB_FINE_GRAINED_PAT'),'missing GITHUB_FINE_GRAINED_PAT finding');
});

await test('detect-supabase-key',()=>{
  const text='const sb = "sbp_1234567890abcdef1234567890abcdef1234";';
  const res=scanTextForSecrets(text,patterns);
  assert(res.clean===false,'should detect Supabase key');
  assert(res.findings.some(f=>f.id==='SUPABASE_API_KEY'),'missing SUPABASE_API_KEY finding');
});

finish();