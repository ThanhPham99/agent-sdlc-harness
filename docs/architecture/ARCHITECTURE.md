# Architecture

The harness separates **control plane** from **execution plane**. The canonical source of truth is provider-neutral. Host syntax is compiled at build time.

```text
Interface / plugin shim
  -> always-on auto-activation bootstrap (one compact invariant, ~76 rough tokens)
  -> is this real repository/system work?  no -> normal response
  -> deterministic router + orchestrator
  -> context compiler + budget + policy
  -> provider adapter and/or tool gateway
  -> sandbox/host tools/MCP
  -> evidence/artifact/event/cost stores
  -> replay/evals/telemetry
```

Core invariants: provider-neutral, token-aware, evidence-driven, replayable, least privilege, artifact-first, deterministic-first, progressive disclosure.

Auto-activation is defined once in `policies/auto-activation.json` + `runtime/activation.mjs` and
compiled into per-host assets by `scripts/gen-activation-assets.mjs` (Claude `SessionStart` hook,
Antigravity `PreInvocation` hook and plugin rule, Codex managed instruction block). The bootstrap
is a routing instruction, not an enforcement boundary: stage policy, approvals and the `PreToolUse`
guard remain authoritative, and it can only be disabled by an operator environment/config decision.

The local-first runtime intentionally has zero npm runtime dependencies. The canonical protocol is language-neutral, so a later team/enterprise control plane can replace file stores with Postgres/object storage/OTel without changing workflow contracts.

## Design and plan gates

`DESIGN` and `PLAN` are enforced by deterministic validators rather than by model prose:

- `policies/design-discovery.json` + `runtime/design-discovery.mjs` select `SKIP` / `COMPACT` /
  `FULL` design discovery and validate the resulting `agent-sdlc/design-decision/v1` artifact;
- `runtime/plan-validator.mjs` validates the `agent-sdlc/task-plan/v1` dependency graph, coverage,
  obligations and parallel scope conflicts.

Both gates' evidence tokens carry `runtime` (or `human`) authority in
`policies/stage-policy.json.evidence_authority`, so they cannot be asserted through
`transition --evidence`; they exist only when `design record` / `plan record` produced them.
See `docs/architecture/DESIGN-DISCOVERY.md` and `docs/architecture/PLAN-QUALITY.md`.

## Task runtime (alpha5)

`IMPLEMENT` executes a persistent task graph. The outer run state machine stays
canonical; a second, inner state machine (`config/task-state-machine.json`) governs
individual tasks and never mutates outer state — it reports the escalation the
orchestrator performs.

```text
validated TaskPlan
  -> materialized TaskGraph + durable Task records (.agent-sdlc/tasks/<run_id>/)
  -> scheduler: dependency-satisfied, conflict-free, budget-bounded dispatch
  -> per task: bounded context manifest + exactly one primary writer + one workspace
  -> verification evidence bound to (base revision, diff hash, attempt)
  -> spec compliance review, then code quality review
  -> DONE, or evidence-driven recovery
  -> implementation_artifact derived from the graph
```

See `docs/architecture/TASK-ENGINE.md` and `docs/architecture/TASK-SCHEDULER.md`.

## Graph-driven understanding (alpha6)

```text
git-tracked files
  -> incremental content-hash index (.agent-sdlc/index/) with an honest capability tier
  -> symbol/dependency graph: dependents, test mapping, module boundaries, interfaces
  -> minimal change surface, or an explicit "could not narrow this"
  -> task context anchored to declared scope, consulted before any broad search

durable run state
  -> traceability graph (requirements -> design -> tasks -> code/interfaces/data
     -> tests/evidence -> build/release/deployment/observation)
  -> coverage derived from edges, never from claims
  -> invalidation propagating only through the edge kinds a delta class declares
  -> revision-bound CI and delivery evidence; PR_READY is never MERGED
```

The cost/context governor (`runtime/governor.mjs`) turns per-task telemetry into explainable
execution decisions. Risk raises its model floor; budget never lowers one, and a mandatory
security or independent-review requirement is never traded for cost.

See `docs/architecture/REPOSITORY-INTELLIGENCE.md` and `docs/architecture/TRACEABILITY-GRAPH.md`.
