# Qualification — 3.0.0-rc1

Qualification is intentionally split into three gates so an unavailable provider can never be reported as a behavioral PASS.

## Gate 1 — deterministic/offline

```bash
npm test
npm run test:activation
npm run build
npm run verify:dist
```

This validates the canonical workflow/runtime, state and evidence gates, context bounds, security/tool behavior, MCP surface, package discovery boundary, package extraction and CLI smoke flows without model calls.

## Gate 2 — host capability preflight

```bash
node scripts/host-preflight.mjs
node scripts/qualify-host.mjs --host claude --preflight-only
node scripts/qualify-host.mjs --host codex --preflight-only
node scripts/qualify-host.mjs --host antigravity --preflight-only
```

Statuses and exit codes are fail-closed:

- `READY` / `QUALIFIED` → `0`
- `FAIL` → `1`
- `PENDING` (binary/auth unavailable) → `2`
- `BLOCKED` (required capability missing or transient infrastructure block) → `3`

Binary paths may be pinned with `AI_SDLC_CLAUDE_BIN`, `AI_SDLC_CODEX_BIN`, and `AI_SDLC_ANTIGRAVITY_BIN`.

## Gate 3 — live behavioral qualification

The fixed corpus contains **84 semantic/security cases** plus **8 repository-grounded E2E cases**. FULL is the only promotion-eligible tier. SMOKE and NIGHTLY exist to reduce feedback cost during adapter development.

### Auto-activation probe

Every host run also executes an activation probe whose prompts **never name any Agent SDLC skill**
(6 positive repository cases, 4 negative generic-Q&A cases, drawn from
`evals/activation/deterministic-cases.json`). Evidence lands under `auto_activation` /
`auto_activation_results` with, per case, `prompt_explicitly_named_skill`,
`router_invocation_observed`, `orchestrator_handoff_observed`, `run_or_artifact_created`,
`write_before_route` and one `activation_result` of `AUTO_ACTIVATED`,
`SOFT_DISCOVERY_ACTIVATED`, `NOT_ACTIVATED`, `UNSUPPORTED` or `PENDING`.

Rules kept deliberately conservative:

- probe rows gate the host verdict exactly like semantic and E2E rows;
- `bootstrap_delivery_observed` and `write_before_route` are reported `UNOBSERVED` in print-mode
  evaluation rather than asserted, since a print transcript does not prove tool ordering;
- negative cases must not create a run or artifact;
- `strong_activation` can only become true for Claude/Antigravity with a `READY` preflight and all
  positive cases `AUTO_ACTIVATED`; native Codex reports `soft_activation` at best;
- an unavailable host or missing credentials yields `PENDING`, never PASS.

```bash
node scripts/qualify-host.mjs --host claude --tier FULL
node scripts/qualify-host.mjs --host codex --tier FULL
node scripts/qualify-host.mjs --host antigravity --tier FULL
node scripts/qualify-release.mjs
```

Or locally:

```bash
node scripts/qualify-all-live.mjs --tier FULL
```

Each host run executes against the **exact ZIP artifact**: the qualification runner verifies the distributions, hashes the ZIP, extracts that ZIP to a private temporary directory and loads only that extracted package. Evidence binds:

- host package SHA-256;
- fixed evaluation corpus SHA-256;
- behavior + qualification-subject SHA-256;
- host CLI version and capability contract;
- runtime/model/effort request metadata;
- semantic and repository-E2E pass counts;
- content-minimized token telemetry and case latency;
- timestamp and environment fingerprint.

The evidence deliberately does **not** store API keys, repository source, full prompts, full host output or full logs. PASS rows retain only the structured decision and usage counters. Failure diagnostics are bounded and token-like values are redacted.

### Token telemetry

When a host exposes usage counters, evidence marks them `ACTUAL_HOST_REPORTED`. Otherwise the runner emits `PROXY_ESTIMATE` based on bounded prompt/output character counts. Proxy values are for regression comparison only and must not be presented as provider billing data.

### Freshness and promotion

Promotion evidence expires after **168 hours** and rejects timestamps more than **10 minutes** in the future. `qualify-release.mjs` accepts RC promotion only when all three required hosts provide fresh FULL `QUALIFIED` evidence bound to the current exact package/corpus/qualification subject. It then emits `dist/V3-PROMOTION-APPROVAL.json`. No approval file is created for PENDING, BLOCKED, FAIL, stale or digest-mismatched evidence.

### Portable evidence bundle

```bash
node scripts/qualification-bundle.mjs pack \
  --evidence-dir evals/qualification \
  --output dist/live-evidence-v3.0.0-alpha4.zip

node scripts/qualification-bundle.mjs verify \
  --bundle dist/live-evidence-v3.0.0-alpha4.zip
```

The bundle manifest checksum-binds each host evidence file plus the corpus and qualification-subject digests. This provides integrity, not organizational signer identity; release signing/attestation can be layered on top.

## CI

`.github/workflows/live-qualification.yml` builds the exact three host artifacts once, fans qualification out to isolated Claude/Codex/Antigravity jobs, uploads content-minimized evidence, then runs a final fail-closed aggregator. Credentials exist only in host jobs. The aggregator never needs provider credentials.
