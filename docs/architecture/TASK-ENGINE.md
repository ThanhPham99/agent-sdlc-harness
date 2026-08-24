# Task Engine

Through alpha4, a "task" was a bullet in a plan. Alpha5 makes it a **first-class runtime entity**: a durable record with its own status, attempts, scope, evidence, reviews and failure history.

The outer run/feature state machine (`config/state-machine.json`) stays canonical. The task machine operates only inside execution-relevant outer stages and never mutates outer state — it reports the escalation the orchestrator must perform.

## Task states

```
CREATED -> READY -> RUNNING -> VERIFYING -> SPEC_REVIEW -> QUALITY_REVIEW -> DONE
```

with conditional edges to `BLOCKED`, `FAILED`, `INVALIDATED` and `SUPERSEDED`, and declared retry edges back to `RUNNING` from `VERIFYING`, `SPEC_REVIEW` and `QUALITY_REVIEW`.

There is no `WAITING_DEPENDENCY` state. Waiting is *derived* from dependency readiness, so it cannot go stale.

`config/task-state-machine.json` declares each edge's `requires` conditions, and `runtime/task-engine.mjs` checks them. What the machine forbids:

- the same task repeating unchanged with no new evidence;
- `DONE` without verification evidence;
- `DONE` with a blocking review finding;
- a diff outside the approved write scope without re-impact or replan;
- a dependency treated as complete while it is not `DONE`;
- silent expansion of interface scope.

## Materialization

`materializeTaskGraph` refuses an invalid plan — the plan quality gate is upstream of the task runtime, not optional to it. It is idempotent: an existing task record is preserved, never reset, so re-running mid-flight cannot destroy an in-progress attempt.

## Storage

```
.agent-sdlc/
├── tasks/<run_id>/TASK-001.json        durable task records
├── tasks/<run_id>/graph.json           the materialized dependency graph
├── tasks/<run_id>/migration.json       migration provenance, when migrated
├── task-events/<run_id>.jsonl          append-only lifecycle events
├── task-context/<run_id>/TASK-001.json bounded context manifests
├── workspaces/<run_id>/                one workspace record per task
└── ... existing run/artifact/event/cost stores
```

Task records are written through a temp file plus rename, so an interrupted process leaves either the previous record or the new one — never a truncated JSON file. Large evidence stays in the content-addressed artifact store; task records hold refs.

## Attempts and retries

`READY -> RUNNING` and every retry edge increment `attempt`. Verification and reviews are bound to `(attempt, diff_hash)`, so evidence can never straddle attempts and a review of an older diff is rejected outright.

Retry budget comes from `policies/task-failure-policy.json`: two retries by default, one under `STRICT`, with infrastructure retries counted separately and not charged against the task budget.

## Verification

`agent-sdlc/task-verification/v1` records the base revision, diff hash, the commands actually executed with exit codes, the environment fingerprint, and a scope audit of every changed path. The escalation ladder is nearest targeted test → affected integration/contract tests → broader suite only when policy or risk requires it.

A worker's self-claim is not evidence. There is no field a worker can set that reaches `DONE`.

## Two-stage review

`SPEC_REVIEW` asks whether the implementation matched exactly the task goal, acceptance criteria, design decisions and scope. `QUALITY_REVIEW` asks, given the accepted specification, whether it is safe and maintainable. Separating them stops each pass from doing the other's job badly.

For `STRICT` or security-critical tasks the reviewer should run in a fresh context. When the host cannot provide that, the limitation is **recorded**, not papered over: an `achieved: true` independence claim whose mode is `SAME_CONTEXT` is rejected, and an independent review that saw worker reasoning is rejected.

## The IMPLEMENT gate

`policies/stage-policy.json` `IMPLEMENT.gate_requirements` is `implementation_artifact` and `task_graph_complete`. Both carry `runtime` authority: `bin/agent-sdlc task implementation-complete` derives them from the graph once every required task (including declared integration tasks) is `DONE`. They cannot be asserted through `transition --evidence`.

## Migration from alpha4

`runtime/task-migration.mjs` turns a recorded `agent-sdlc/task-plan/v1` artifact into a graph plus task records. It preserves the original plan artifact ref and hash, generates stable IDs only where absent, never marks a generated task `DONE`, marks a run already past `IMPLEMENT` as `LEGACY_STAGE_EVIDENCE` rather than fabricating per-task evidence, backs up before mutation, and fails closed on an unknown newer plan schema.

## Evidence

`npm run test:tasks` produces `evals/TASK-ENGINE-VALIDATION.json`, `TASK-SCHEDULER-VALIDATION.json`, `TASK-CONTEXT-VALIDATION.json`, `TASK-REVIEW-VALIDATION.json` and `TASK-RECOVERY-VALIDATION.json`. The same suite runs under `npm test`, so the gate and the evidence cannot disagree.
