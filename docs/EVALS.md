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

## Integrity gates

```bash
npm run test:integrity
```

Four cheap, offline suites that assert properties no other suite covered. Each one exists
because the property it checks had already drifted when it was written, and each writes its
own evidence file:

- **`npm run test:versions`** (`evals/VERSION-CONSISTENCY.json`) — `VERSION` is the single
  source of truth. Distribution manifests, marketplace entries, public skill metadata and doc
  titles must state it *exactly*; internal registry and policy stamps must merely not claim a
  release that does not exist yet, and any laggard is listed under `behind` so the drift stays
  visible. `docs/releases/*`, `(vX)` feature labels and versions quoted as inline code are
  history and are never rewritten.
- **`npm run test:registry`** (`evals/REGISTRY-VALIDATION.json`) — `config/skills.json` is what
  makes an internal skill real: `build-dist` copies exactly the registered entries. This fails on
  an entry pointing at a missing file, an entry naming a stage the run state machine does not
  have or a tool the registry does not define, a discoverable skill directory that is not in the
  public list, a workflow stage with no skill able to serve it, and any *new* unregistered file
  under `harness/internal-skills/`. Files that were already orphaned are listed as accepted debt,
  so the count can only go down.
- **`npm run test:root-sync`** (`evals/ROOT-SYNC-VALIDATION.json`) — the repository root doubles
  as an Antigravity plugin root, so seven files there are copies of files under `adapters/`. The
  adapter file is authoritative; this asserts the copies are byte-identical (line endings
  normalized) so a one-sided edit fails CI instead of shipping a stale root.
- **`npm run test:guard`** (`evals/GUARD-VALIDATION.json`) — the PreToolUse guard runs inside the
  host and is the only layer that still applies when every other rule has been argued away.
  `evals/guard/cases.json` pins 43 cases in both directions across POSIX and Windows shells:
  destructive commands must be stopped, and everyday commands (`rm -rf node_modules`,
  `git push origin feat/x`, `Get-ChildItem -Recurse -Force`) must not be. Failures are classed
  as `MISSED_DESTRUCTIVE` or `FALSE_POSITIVE`, because a guard that blocks ordinary work gets
  switched off and then protects nothing. The suite also asserts matcher coverage: every host
  adapter must route every shell-capable tool name — `Bash` *and* `PowerShell` — into the guard,
  since a perfect guard behind a matcher that never fires protects nothing either.

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

## Task runtime suite (v3.0.0-alpha5)

```bash
npm run test:tasks
```

`evals/task-runtime.mjs` — 67 offline checks over a temporary git fixture, grouped as:

- **state_machine** (15) — the legal forward flow to DONE, illegal status skips, DONE
  without verification, DONE with a blocking finding, retry with and without new
  evidence, terminal DONE, unsatisfied and failed dependencies, invalidation resume,
  one-writer-per-task, credential scrubbing, invalid-plan refusal, idempotent
  re-materialization, and the IMPLEMENT gate.
- **scheduler** (13) — linear DAG progression, disjoint parallel dispatch, write and
  interface conflicts, the benefit threshold, read-only fan-out, writer caps under
  STANDARD and STRICT, serialized migration boundaries, stage-category legality,
  blocked tasks, budget exhaustion, determinism, prefix-aware overlap.
- **context** (8) — scope containment, dependency outputs, named exclusions, budget
  derivation, manifest persistence and hash stability, artifact truncation, prompt
  prohibitions, risk-derived constraints.
- **verification_review** (16) — worker self-claim rejection, failing targeted tests,
  scope expansion, no-change-captured, spec and quality blockers re-entering RUNNING,
  the two contracts being distinct, diff/attempt binding, acceptance-criteria coverage,
  clean-verdict consistency, failure scenarios for blocking correctness findings,
  independence honesty, the escalation ladder, revision binding, scope auditing.
- **recovery** (9) — structural classification precedence, identical-retry refusal,
  budget exhaustion, upstream escalation, bounded infrastructure retries, ambiguity and
  design invalidation escalations, permission denial, checkpoint contents.
- **migration_telemetry** (6) — dry run, migration, idempotence, legacy stage evidence,
  fail-closed on an unknown schema, stable ID assignment, per-task cost attribution,
  evidence-safe workspace cleanup.

The same suite backs `npm test`, so a green gate and the release evidence describe the
same run.

## Alpha6 suite (v3.0.0-alpha6)

```bash
npm run test:alpha6
```

`evals/alpha6-runtime.mjs` — 55 offline checks over a small but realistic git fixture
(modules, tests, HTTP routes, a SQL migration, an event contract):

- **repo_intelligence** (12) — file classification, honest capability reporting, index
  incrementality and staleness, symbol resolution, structural dependency mapping and
  transitive dependents, strong test links, module surfaces, route/entity/event extraction,
  bounded change surfaces, honest empty results, separated external vs unresolved imports,
  and scope-anchored task-context integration that never pulls in an unrelated module.
- **traceability** (7) — full node/edge coverage, graph consistency, dangling-ref and
  unknown-kind rejection, edge-derived acceptance coverage, an unedged claim reported as
  uncovered, interface-to-compatibility mapping, and refs-not-content storage.
- **invalidation** (8) — wording-only and documentation-only preservation, exact behaviour
  closure, design and interface propagation, unrelated nodes staying valid, replayable
  reasons and paths, and every delta class bounded and declared.
- **delivery** (9) — protected-branch denial, revision-bound CI, required vs optional check
  failures, PR_READY vs MERGED, base drift, cross-revision evidence rejection, missing CI
  evidence, explicit stacked order, and per-branch isolation of interface and migration work.
- **fallback** (7) — checkpoint contents, timeout and unavailable-provider continuation,
  context-delta reporting, withheld reasoning, preserved risk policy, recorded events.
- **governor** (7) — scope-derived complexity, risk-raised model floors that budget cannot
  lower, non-negotiable independent review, deterministic-tools-first, context compaction
  then stop, retry escalation, and full explainability.
- **learning** (5) — secret and environment redaction, deterministic sanitized candidates,
  rejection of unsanitized or absolute-path candidates, no automatic policy mutation, and a
  runnable suite per source.

Evidence: `REPO-INTELLIGENCE-VALIDATION.json`, `TRACEABILITY-VALIDATION.json`,
`INVALIDATION-VALIDATION.json`, `DELIVERY-VALIDATION.json`, `FALLBACK-VALIDATION.json`,
`GOVERNOR-VALIDATION.json`, `LEARNING-VALIDATION.json`.
