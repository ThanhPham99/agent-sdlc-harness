# Traceability Graph

One graph, two jobs: prove coverage, and invalidate precisely.

## Nodes and edges

Node kinds: `REQUIREMENT`, `ACCEPTANCE_CRITERION`, `DESIGN_DECISION`, `TASK`, `SYMBOL`, `INTERFACE`, `DATA_ENTITY`, `TEST`, `EVIDENCE`, `REVIEW_FINDING`, `BUILD`, `RELEASE`, `DEPLOYMENT`, `OBSERVATION`, `DOCUMENTATION`.

Edge kinds: `decomposes_to`, `addressed_by`, `implemented_by`, `changes`, `affects`, `verified_by`, `produces`, `reviewed_by`, `supports`, `contains`, `deploys`, `validates`, `documents`.

The graph is built from durable state — the task graph, the task records, the recorded artifacts — never inferred from prose. It stores IDs, refs and hashes; the suite asserts that neither file content nor artifact content leaks into it.

## Coverage from edges, not claims

`computeTraceCoverage` reports, per acceptance criterion, which tasks implement it, which tests verify it and which evidence supports it, plus `ac_coverage`, `verification_coverage` and `evidence_coverage`.

An acceptance criterion with no `implemented_by` edge is **uncovered**, whatever a summary artifact says about it. It also reports `interfaces_without_compatibility_verification`: a task declaring `interface_scope` with no linked test is an unverified contract change.

## Consistency

`validateTraceabilityGraph` rejects dangling edge endpoints, unknown node or edge kinds, duplicate nodes and node-id/kind mismatches. Orphan nodes are warnings, not errors — a node can legitimately exist before its edges do.

## Graph-driven invalidation

Classify the semantic delta, locate the changed node, then propagate through **only the edge kinds that class declares**:

| Delta class | Propagates through | Earliest outer gate |
|---|---|---|
| `WORDING_ONLY` | nothing | — |
| `DOCUMENTATION_ONLY` | `documents` | `CLOSE` |
| `BEHAVIOR_CHANGE` | design, tasks, tests, evidence, reviews, build/release/deploy | `REQUIREMENTS` |
| `DESIGN_CHANGE` | implementing tasks and their verification chain | `DESIGN` |
| `INTERFACE_CHANGE` | consumers (reverse `affects`) and compatibility tests | `DESIGN` |
| `DATA_CHANGE` | affected entities, tasks and their verification chain | `DESIGN` |
| `SCOPE_REMOVAL` | tasks, tests, evidence, reviews | `PLAN` |

Two details matter:

**Direction.** Some arrows point the wrong way for propagation. A consumer task points *at* the `INTERFACE` it affects, and evidence points *at* the `TASK` it supports. Those edge kinds are traversed backwards; the rest are not, which is why an implementation change never invalidates the requirement above it.

**Preservation is structural.** Because only declared edge kinds are followed, unrelated work is preserved by construction rather than by a heuristic. `computeInvalidationClosure` returns both the `affected` closure and the `preserved` set, and every affected node carries the graph path that justified its inclusion.

A wording-only requirement change therefore preserves implementation, while a public interface change invalidates consumers and compatibility tests **even when the code still compiles** — the case that makes compilation a bad proxy for compatibility.

## Replay

`applyInvalidation` marks affected nodes invalid with the reason and appends a record — changed node, delta class, reason, affected closure with paths, preserved count, earliest outer gate, and a hash of the resulting validity map — to `.agent-sdlc/traceability/<run_id>-invalidations.jsonl`. `invalidationHistory` replays it.

## Evidence

`npm run test:alpha6` produces `evals/TRACEABILITY-VALIDATION.json` and `evals/INVALIDATION-VALIDATION.json`.
