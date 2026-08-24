# Evaluation Strategy

`npm test` runs deterministic, offline regression checks for routing, lifecycle consistency, gates, side-state recovery, progressive context disclosure, artifacts/replay, tool security, input normalization, model/cost routing, configuration, compatibility, parallelism, handoff, telemetry, MCP and provider package structure.

## Auto-activation corpus

```bash
npm run test:activation
```

- `evals/activation/deterministic-cases.json` — 34 cases: positive repository work, negative
  generic Q&A, and borderline pairs whose only difference is repository context;
- `evals/activation/multi-turn-cases.json` — Q&A then repository work, repository work then
  unrelated Q&A, requirement delta on active work, `clear`/`compact`/`resume` re-delivery, and a
  new unrelated task starting a fresh bounded run;
- `evals/activation/adversarial-cases.json` — ticket, README, log, tool-output, quoted-text and
  committed-config injections that must never disable activation or remove gates;
- `evals/activation/provider-expectations.json` — per-host delivery, budgets, limitations and the
  release assertions; it may never assert `strong_activation: true`.

The classifier in `runtime/activation.mjs` graded by this corpus is a deterministic diagnostic and
eval helper. The authoritative semantic activation decision at runtime belongs to `sdlc-router`.
Live activation measurement (prompts naming no skill) is part of `scripts/qualify-host.mjs`; see
`docs/QUALIFICATION.md`.

Run the package audit with:

```bash
node scripts/audit.mjs
```

Run provider preflight with:

```bash
node evals/provider-conformance/preflight.mjs
```

Preflight is intentionally fail-honest: an unavailable host reports `PENDING`, never `PASS`. A release candidate should additionally execute live semantic/e2e evaluation on installed and authenticated Claude Code, Codex and Antigravity hosts, bind results to the exact package digest, record host/model versions, and compare verified-task success, escaped defects, latency and cost against a pinned baseline.

Replay supports offline integrity/regression analysis; model generation itself is not claimed to be bit-for-bit deterministic.

## Gate quality suites (v3.0.0-alpha4)

```bash
npm run test:gates
```

- `evals/design-discovery/cases.json` — 13 mode-selection cases: docs-only and dependency bumps
  reach `SKIP`; a known local behaviour change reaches `COMPACT`; a new integration, a breaking
  public API, a security policy design, a data migration and an explicit "give me 3 approaches"
  reach `FULL`; a restored known policy is not turned into brainstorming; `STRICT` never reaches
  `SKIP`; and `FAST` cannot dodge a contract decision.
- `evals/design-discovery/adversarial-cases.json` — 7 decision-contract cases: FULL mode with no
  options, a single option without rejection evidence, an invented approval, an interface change
  with no verification obligation, and a bare `SKIP`.
- `evals/plan-quality/cases.json` — 21 plan cases over one shared base plan: valid linear and
  fan-out/fan-in DAGs plus every rejection the validator owns (unknown dependency, cycle, duplicate
  ID, uncovered acceptance criterion, missing done condition, testless behaviour task, overlapping
  parallel write and interface scope, destructive migration without rollback, interface change
  without a compatibility obligation, missing required category, giant task, forbidden scope,
  unresolved design decision or requirement, FAST micro-plan relaxation, and edge/`depends_on`
  disagreement).

Evidence: `evals/DESIGN-DISCOVERY-VALIDATION.json`, `evals/PLAN-QUALITY-VALIDATION.json`. Both
record `PENDING_LIVE_QUALIFICATION` for anything only a live host can establish.
