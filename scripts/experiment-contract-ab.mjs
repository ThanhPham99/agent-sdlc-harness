#!/usr/bin/env node
/**
 * Controlled A/B: is the long instruction contract causing the STRICT-profile
 * failures on SEM007 / SEM023 / SEM033?
 *
 * The contract text is READ OUT OF scripts/qualify-host.mjs, never retyped, so
 * arm A is the shipped prompt by construction. Arm B is derived from arm A by
 * deleting the guidance body and keeping only the two output-format sentences,
 * so the guidance text is the single variable. Both are digested and recorded.
 *
 * Extraction and failure classification are imported from the harness's own
 * qualification-lib, not reimplemented: a second copy would be free to grade
 * differently from the thing being explained.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath, pathToFileURL} from 'node:url';

// Resolved from this file, not from an environment variable: a run that pointed
// AB_REPO at one tree while importing the lib from another would compare two
// different prompts and call the difference a finding.
const REPO = process.env.AB_REPO || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lib = await import(pathToFileURL(path.join(REPO, 'scripts', 'qualification-lib.mjs')).href);
const {unzipTo} = await import(pathToFileURL(path.join(REPO, 'scripts', 'archive.mjs')).href);
const {makeTempDir} = await import(pathToFileURL(path.join(REPO, 'scripts', 'lib', 'tempdir.mjs')).href);
const OUT = process.env.AB_OUT || path.join(REPO, 'evals', 'live', 'experiments', `contract-ab-claude-${lib.VERSION}.json`);

const HOST = 'claude';
const CASE_IDS = ['SEM007', 'SEM023', 'SEM033'];
const REPS = Number(process.env.AB_REPS || 5);
const TIMEOUT_MS = Number(process.env.AB_TIMEOUT_SEC || 180) * 1000;
const sha = s => crypto.createHash('sha256').update(s).digest('hex');

// ---- lift the shipped prompt out of the shipped script ---------------------
const src = fs.readFileSync(path.join(REPO, 'scripts', 'qualify-host.mjs'), 'utf8');
const cm = src.match(/const contract\s*=\s*'([^']*)';/);
if (!cm) throw new Error('could not locate the contract literal in qualify-host.mjs');
const CONTRACT_A = cm[1];
const FORMAT_MARK = 'Return only one JSON object conforming to the supplied schema.';
const cut = CONTRACT_A.indexOf(FORMAT_MARK);
if (cut < 0) throw new Error('contract does not contain the output-format sentence');
const CONTRACT_B = CONTRACT_A.slice(cut);           // output-format sentences only
const GUIDANCE = CONTRACT_A.slice(0, cut);          // the removed variable
if (!CONTRACT_A.endsWith(CONTRACT_B)) throw new Error('arm B is not a suffix of arm A');
if (GUIDANCE.length < 500) throw new Error('guidance body implausibly short; refusing to run');

// The semantic preamble, also lifted verbatim (the trailing `return` in promptFor).
const pm = src.match(/return `(Evaluation mode\. Do not edit files or execute the requested work\. Use the installed Agent SDLC router\.[\s\S]*?)`;\n\}/);
if (!pm) throw new Error('could not locate the semantic prompt template');
const TEMPLATE = pm[1];
if (!TEMPLATE.includes('${c.prompt}') || !TEMPLATE.includes('${contract}')) throw new Error('template lost its placeholders');
const buildPrompt = (casePrompt, contract) =>
  TEMPLATE.replace(/\\n/g, '\n').replace('${c.prompt}', casePrompt).replace('${contract}', contract);

// ---- fixed inputs ----------------------------------------------------------
const cases = JSON.parse(fs.readFileSync(path.join(REPO, 'evals/live/semantic-cases.json'), 'utf8'))
  .cases.filter(c => CASE_IDS.includes(c.id));
if (cases.length !== CASE_IDS.length) throw new Error('missing a case');

if (process.env.AB_DUMP) {
  const c = cases.find(x => x.id === 'SEM007');
  fs.writeFileSync(process.env.AB_DUMP + '.A.txt', buildPrompt(c.prompt, CONTRACT_A));
  fs.writeFileSync(process.env.AB_DUMP + '.B.txt', buildPrompt(c.prompt, CONTRACT_B));
  console.log('dumped');
  process.exit(0);
}

const pf = lib.hostPreflight(HOST, {});
if (pf.status !== 'READY') { console.error('host not READY:', pf.status, pf.reason); process.exit(2); }

const schemaPath = path.join(REPO, 'evals/live/semantic-decision.schema.json');
const schemaText = JSON.stringify(lib.stripSchemaDialect(JSON.parse(fs.readFileSync(schemaPath, 'utf8'))));
const helpText = (() => {
  const r = lib.spawnHost(pf.resolved_binary, ['--help'], {encoding: 'utf8', timeout: 15000});
  return (r.stdout || '') + '\n' + (r.stderr || '');
})();

// Claude branch of commandFor. --bare is deliberately absent, as in the harness.
function argvFor(prompt, pkg) {
  const a = ['--plugin-dir', pkg, '-p', prompt, '--output-format', 'json', '--json-schema', schemaText];
  if (helpText.includes('--no-session-persistence')) a.push('--no-session-persistence');
  if (helpText.includes('--max-turns')) a.push('--max-turns', '3');
  return a;
}

function callHost(prompt, pkg, cwd) {
  const args = argvFor(prompt, pkg);
  const t0 = Date.now();
  const r = lib.spawnHost(pf.resolved_binary, args, {cwd, env: {...process.env}, encoding: 'utf8', timeout: TIMEOUT_MS, maxBuffer: 20 * 1024 * 1024});
  const duration_ms = Date.now() - t0;
  const combined = (r.stdout || '') + '\n' + (r.stderr || '');
  const failure = lib.classifyFailure(combined, r.status ?? 1);
  if (r.error && r.error.code === 'ETIMEDOUT') return {outcome: 'BLOCKED', reason: 'HOST_TIMEOUT', duration_ms};
  if (failure === 'PENDING_AUTH') return {outcome: 'SKIP', reason: 'AUTH_UNAVAILABLE', duration_ms};
  if (failure === 'BLOCKED_TRANSIENT') return {outcome: 'BLOCKED', reason: 'TRANSIENT_PROVIDER_OR_NETWORK', duration_ms, diagnostic: lib.sanitizeDiagnostic(combined)};
  if ((r.status == null ? 1 : r.status) !== 0) return {outcome: 'BLOCKED', reason: 'HOST_NONZERO_EXIT', exit_code: r.status, duration_ms, diagnostic: lib.sanitizeDiagnostic(combined)};
  const decision = lib.extractStructured(r.stdout || '', null, 'activate');
  if (!decision) return {outcome: lib.hostProducedNoAnswer(r.stdout || '', null) ? 'BLOCKED' : 'NO_DECISION', reason: 'NO_STRUCTURED_DECISION', duration_ms, diagnostic: lib.sanitizeDiagnostic(combined)};
  return {outcome: 'ANSWERED', duration_ms, decision};
}

function tally(rows, arm) {
  const a = rows.filter(r => r.arm === arm);
  const answered = a.filter(r => r.outcome === 'ANSWERED');
  const per = {};
  for (const id of CASE_IDS) {
    const s = answered.filter(r => r.case_id === id);
    per[id] = {answered: s.length, profile_correct: s.filter(r => r.profile_correct).length,
               profiles: s.map(r => r.actual_profile)};
  }
  return {calls: a.length, answered: answered.length, not_answered: a.length - answered.length,
          profile_correct: answered.filter(r => r.profile_correct).length, per_case: per};
}

function envelope(rows, skillSource) {
  return {
    schema: 'agent-sdlc/contract-ab-experiment/v1',
    version: lib.VERSION,
    experiment: 'the instruction contract as the only variable, graded on profile',
    evaluated_at: lib.utcNow(),
    host: HOST, host_version: pf.host_version, resolved_binary: pf.resolved_binary,
    package: {file: path.basename(lib.packagePath(HOST)), sha256: lib.packageDigest(HOST)},
    host_skill_source: skillSource,
    reps_per_case_per_arm: REPS, cases: CASE_IDS,
    arms: {
      A: {label: 'shipped prompt, full contract', contract_sha256: sha(CONTRACT_A), contract_chars: CONTRACT_A.length},
      B: {label: 'guidance body removed, output-format sentences kept', contract_sha256: sha(CONTRACT_B), contract_chars: CONTRACT_B.length}
    },
    removed_guidance: {sha256: sha(GUIDANCE), chars: GUIDANCE.length},
    graded_field: 'profile',
    tally: {A: tally(rows, 'A'), B: tally(rows, 'B')},
    results: rows
  };
}

// ---- run -------------------------------------------------------------------
const tmp = makeTempDir(`agent-sdlc-ab-${HOST}-`);
const rows = [];
let skillSource = null;
try {
  const extracted = path.join(tmp, 'exact-package');
  fs.mkdirSync(extracted, {recursive: true});
  unzipTo(lib.packagePath(HOST), extracted);
  const pkg = path.join(extracted, `agent-sdlc-${HOST}-${lib.VERSION}`);
  skillSource = await lib.hostSkillSource(pkg);
  const work = path.join(tmp, 'workspace');
  fs.mkdirSync(work, {recursive: true});

  const total = REPS * cases.length * 2;
  let n = 0;
  for (let rep = 1; rep <= REPS; rep++) {
    // Alternate which arm goes first so ordering cannot favour one arm.
    const arms = rep % 2 === 1 ? ['A', 'B'] : ['B', 'A'];
    for (const c of cases) {
      for (const arm of arms) {
        const prompt = buildPrompt(c.prompt, arm === 'A' ? CONTRACT_A : CONTRACT_B);
        const res = callHost(prompt, pkg, work);
        const profile = res.decision ? (res.decision.profile == null ? null : res.decision.profile) : null;
        rows.push({
          rep, arm, case_id: c.id,
          expected_profile: c.expected.profile,
          actual_profile: profile,
          profile_correct: res.outcome === 'ANSWERED' ? profile === c.expected.profile : null,
          expected_workflow: c.expected.workflow,
          actual_workflow: res.decision ? (res.decision.workflow == null ? null : res.decision.workflow) : null,
          outcome: res.outcome, reason: res.reason == null ? null : res.reason,
          duration_ms: res.duration_ms,
          prompt_sha256: sha(prompt),
          diagnostic: res.diagnostic
        });
        n++;
        process.stderr.write(`[${n}/${total}] rep${rep} ${arm} ${c.id} -> ${res.outcome} profile=${profile} (${res.duration_ms}ms)\n`);
        // Written after every call: a run that dies at call 23 keeps 22 measurements.
        fs.writeFileSync(OUT, JSON.stringify(envelope(rows, skillSource), null, 2) + '\n');
      }
    }
  }
} finally {
  try { fs.rmSync(tmp, {recursive: true, force: true, maxRetries: 5, retryDelay: 200}); } catch {}
}

fs.writeFileSync(OUT, JSON.stringify(envelope(rows, skillSource), null, 2) + '\n');
console.log(JSON.stringify(envelope(rows, skillSource).tally, null, 2));
