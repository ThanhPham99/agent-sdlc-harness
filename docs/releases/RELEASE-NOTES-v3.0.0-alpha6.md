# Release Notes — 3.0.0-alpha6

Theme: **graph-driven understanding and traceability**. Context selection stops being a
guess, coverage stops being a claim, invalidation stops being all-or-nothing, and delivery
evidence is bound to an exact revision.

Local-first, incremental and deterministic throughout. No always-running index, no new
service, still zero runtime dependencies.

## Added

### Repository intelligence
- `runtime/repo-index.mjs` — incremental content-hash index of git-tracked files with an
  honest capability tier (`DETERMINISTIC_SYNTAX`), revision binding and staleness
  detection. Extracts symbols, exports, imports, HTTP routes, data entities and event
  contract names.
- `runtime/symbol-graph.mjs` — structural import resolution, dependents/dependencies,
  transitive closures, test-to-symbol and test-to-file mapping, module boundaries.
  External and unresolved imports are reported separately, never guessed.
- `runtime/repo-intelligence.mjs` — the query surface, including
  `getMinimalChangeSurface`, which returns a bounded surface or an explicit
  `NO_DETERMINISTIC_MATCH_BROADER_SEARCH_REQUIRED`.
- `runtime/task-context.mjs` `scopeIntelligence()` — deterministic facts for the task's
  declared scope, including the dependents of its write scope, rendered into the task
  prompt as `REPOSITORY FACTS`.

### Traceability and invalidation
- `protocol/schemas/TraceabilityGraph.schema.json`, `runtime/traceability.mjs` —
  15 node kinds, 13 edge kinds, built from durable state, storing refs and hashes only.
- Coverage computed from edges: an acceptance criterion with no `implemented_by` edge is
  uncovered regardless of any claim, and interfaces without compatibility verification are
  named.
- Seven delta classes with declared propagation. `WORDING_ONLY` preserves implementation;
  `INTERFACE_CHANGE` invalidates consumers and compatibility tests even when the code
  still compiles. Every affected node carries the graph path that justified it, and each
  decision is appended to a replayable log.

### Delivery
- `runtime/git-delivery.mjs` — `PR_READY` / `MERGED` / `RELEASE_READY` as claims the record
  must justify, protected-branch denial by default, base-drift detection with a
  re-verification action, explicit stacked order, and per-branch grouping that keeps
  interface-changing and migration work isolated.
- `runtime/ci-evidence.mjs` — revision-bound CI records; a revision change invalidates
  them, a failing required check fails the record, an optional failure does not.

### Governance, fallback and learning
- `runtime/governor.mjs` + `policies/cost-context-governance.json` — explainable decisions
  with a model floor that risk raises and budget can never lower, and mandatory
  independent review that cannot be traded for cost.
- `runtime/task-runner.mjs` `resumeFromCheckpoint()` — cross-provider continuation from
  structured artifacts, preserving the task's risk policy and transferring no hidden
  reasoning.
- `runtime/learning.mjs` + `scripts/promote-regression-case.mjs` — sanitized, deterministic
  regression candidates. A policy hypothesis is `PROPOSED_NOT_APPLIED`; adoption needs an
  eval pass and human review.

### Surfaces, evals and docs
- Seven new CLI groups: `repo`, `trace`, `delivery`, `ci`, `govern`, `fallback`, `learn`.
- `harness/internal-skills/repository-intelligence.md` and `traceability.md` (internal
  modules 21 and 22).
- `evals/alpha6-runtime.mjs` — 55 offline checks across repo intelligence, traceability,
  invalidation, delivery, fallback, governor and learning. Shared by `npm test` and
  `npm run test:alpha6`.
- `docs/architecture/REPOSITORY-INTELLIGENCE.md`,
  `docs/architecture/TRACEABILITY-GRAPH.md`.

## Fixed

- `collect()` applied an identifier filter to import specifiers, so every relative import
  was discarded and the dependency graph was empty for same-directory imports.
- `resolveImport` normalized away a leading `./`, after which a same-directory import no
  longer looked relative and was misclassified as an external package. Together these two
  meant test-to-code mapping, module boundaries, dependent closures and the minimal change
  surface were all silently degraded.
- `INTERFACE_CHANGE` and `DATA_CHANGE` propagated through no edges at all, because
  consumers point *at* the interface they affect. Reverse traversal is now declared
  per delta class.
- `recordDelivery` treated an omitted `ciEvidence` argument as "no CI ran"; it now loads
  the run's recorded evidence by default.

## Boundaries and known limitations

- Extraction is deterministic, not exhaustive. It resolves imports, exports, routes, table
  names and test links well; it does not do type resolution, dynamic dispatch or
  reflection. A missed symbol is a reported gap, not a claim the symbol does not exist.
- No LSP or language-parser tier is bundled. `detectCapability` reports the signals a
  higher tier could use and states plainly that it is not in use.
- The governor consumes per-run history only. Cross-run learning is a candidate pipeline,
  not an adaptive controller — by design.
- Provider fallback is validated offline against the checkpoint contract. Live
  cross-provider continuation still requires live qualification.
- Live host qualification remains **LIVE_HOST_PENDING**. Every alpha6 evidence file records
  `PENDING_LIVE_QUALIFICATION`.
