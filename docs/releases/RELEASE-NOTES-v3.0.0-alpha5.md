# Release Notes — 3.0.0-alpha5

Theme: **first-class task execution**. A validated plan becomes a persistent task
graph; every execution task has durable status, bounded context, one writer, its own
verification evidence and two distinct reviews; retries are evidence-driven and bounded.

The outer run/feature state machine is unchanged and remains canonical.

## Added

### Task runtime
- `config/task-state-machine.json` — inner task lifecycle with per-edge `requires`
  conditions and an explicit list of forbidden behaviours.
- `runtime/task-engine.mjs` — plan → graph materialization (refuses an invalid plan,
  idempotent for existing records), dependency truth, readiness promotion, transition
  evaluation and enforcement, progress aggregation.
- `runtime/task-scheduler.mjs` + `policies/task-scheduling.json` — dependency-aware
  bounded dispatch with serialized boundaries, writer/read-only caps, benefit
  threshold, stage-category legality and budget respect. Every non-dispatched ready
  task is reported with a reason.
- `runtime/task-context.mjs` — per-task bounded context package and
  `agent-sdlc/task-context-manifest/v1`, which also names what it excluded.
- `runtime/workspace.mjs` — `shared-readonly` / `isolated-worktree` /
  `provider-sandbox`, one writer per task, writer-isolation check, credential
  scrubbing, evidence-safe cleanup, honest degradation.
- `runtime/task-verification.mjs` — `agent-sdlc/task-verification/v1` bound to base
  revision, diff hash and attempt, with a scope audit and an escalation ladder.
- `runtime/task-review.mjs` — separate spec-compliance and code-quality contracts,
  with truthful independence recording.
- `runtime/task-recovery.mjs` + `policies/task-failure-policy.json` — twelve failure
  classes, evidence fingerprinting so an identical retry is refused, bounded
  infrastructure retries, and outer-escalation reporting.
- `runtime/task-runner.mjs` — the driver, plus `agent-sdlc/task-checkpoint/v1` for
  provider fallback (structured artifacts only; never hidden reasoning).
- `runtime/task-migration.mjs` — deterministic alpha4 → alpha5 migration.

### Schemas
`Task`, `TaskGraph`, `TaskEvent`, `TaskVerification`, `TaskContextManifest`,
`SpecComplianceReview`, `CodeQualityReview`.

### Surfaces
- `agent-sdlc task` with 28 subcommands (list, show, graph, events, progress,
  state-machine, materialize, migrate, refresh, ready, schedule, transition, context,
  context-show, start, capture, verify, review, advance, checkpoint, usage-add, usage,
  metrics, workspaces, workspace-clean, failure-policy, classify,
  implementation-complete).
- Six read-mostly MCP tools: `agent_sdlc_task_list`, `_status`, `_ready`, `_schedule`,
  `_context`, `_evidence`. State-changing task operations stay behind the CLI and the
  engine's policy checks.
- `harness/internal-skills/task-execution.md` — the 20th internal module.

### Evaluation
- `evals/task-runtime.mjs` — 67 offline checks across state machine, scheduler,
  context, verification/review, recovery, migration/telemetry. Shared by `npm test`
  and `npm run test:tasks`, so the gate and the release evidence cannot disagree.
- `scripts/validate-task-engine.mjs` → `TASK-ENGINE-VALIDATION.json`,
  `TASK-SCHEDULER-VALIDATION.json`, `TASK-CONTEXT-VALIDATION.json`,
  `TASK-REVIEW-VALIDATION.json`, `TASK-RECOVERY-VALIDATION.json`.
- `docs/architecture/TASK-ENGINE.md`, `docs/architecture/TASK-SCHEDULER.md`.

## Changed

- `IMPLEMENT.gate_requirements` is now `implementation_artifact` +
  `task_graph_complete`, both `runtime` authority: derived by
  `task implementation-complete` from the graph, never assertable.
- `runtime/orchestrator.mjs` gained `materializeRunTasks` and
  `recordImplementationComplete`.
- `runtime/cost.mjs` attributes usage to `task_id` and reports cost per verified DONE
  task, `success@1` and retry rate; `runtime/telemetry.mjs` gained `taskMetrics`.
- `runtime/parallel.mjs` now shares the scheduler's prefix-aware conflict predicate
  instead of exact-element matching. Its public shape and decisions are unchanged for
  file-level task lists.
- `runtime/store.mjs` gained atomic task persistence and the task event log.

## Fixed

- `listTasks` read every `*.json` in the task directory, so `migration.json` was
  returned as a task record.
- The per-task context hash included `created_at`, so identical inputs produced
  different hashes and replay comparison was meaningless.
- A serialized-boundary dispatch broke out of the admission loop silently; the
  remaining candidates are now recorded as deferred.

## Boundaries and known limitations

- The engine performs every transition, but the **judgement** in a review still comes
  from an agent. What is enforced is the contract: bound to the current attempt and
  diff, evidence per finding, no clean verdict alongside a blocking finding, no
  independence claim the host did not deliver.
- `isolated-worktree` needs a git repository with at least one commit. Without one the
  workspace degrades to `shared-readonly` and says so.
- Provider fallback is defined as a checkpoint contract and validated offline. Live
  cross-provider continuation is alpha6 work.
- Live host qualification remains **LIVE_HOST_PENDING**. Every alpha5 evidence file
  records `PENDING_LIVE_QUALIFICATION`.
