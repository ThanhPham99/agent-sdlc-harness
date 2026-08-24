# Task Scheduler

The scheduler answers one question deterministically: **given the persisted task graph, which tasks may be dispatched right now, and how many at once?**

Parallelism is an optimization, not a philosophy. The default is one writer.

## One policy model, not two

`runtime/task-scheduler.mjs` and `runtime/parallel.mjs` share the same `scopeConflicts` and benefit predicates. Overlap is prefix-aware, so `src/auth/` and `src/auth/reset.js` collide while `src/auth/a.js` and `src/auth/b.js` do not.

## Admission

A ready task is admitted only when every requirement in `policies/task-scheduling.json` holds:

- dependencies satisfied — and a dependency is satisfied only when it is `DONE`;
- write scopes disjoint from everything already selected;
- interface scopes disjoint;
- no shared serialized boundary;
- wall-time benefit justified;
- risk policy permits;
- budget permits.

### Serialized boundaries

A `migration` or `release` task, a `HIGH` security risk, a `MEDIUM`/`HIGH` data risk, or a destructive data change runs **alone**. When such a task takes the head of the dispatch set, every other eligible task is explicitly recorded as `HEAD_IS_SERIALIZED_BOUNDARY`.

### Caps

Writers are capped by the minimum of the policy hard default (2), the profile cap (`STRICT` → 1), the active stage's `max_parallel_agents`, and the absolute maximum (4). Read-only tasks have their own, higher cap because they cannot conflict.

### Benefit

Admitting a *second* writer must actually save wall-clock time. Below `benefit_threshold.min_estimated_seconds` (60s) the coordination and review cost exceeds the saving, and the second candidate is deferred as `NO_BENEFIT`. Read-only fan-out has no such threshold.

### Stage legality

`stage_categories` declares which task categories are legal in which outer stage. A `release` task is not dispatchable during `IMPLEMENT`; it becomes dispatchable in `RELEASE`. This is what stops release and documentation work from being force-fit into implementation.

## No silent caps

Every ready task that is *not* dispatched appears in `deferred` (with a reason such as `WRITER_CAP:2`, `SCOPE_CONFLICT`, `NO_BENEFIT:…`, `NOT_A_PARALLEL_CANDIDATE`) or in `excluded` (with reasons such as `STATUS:BLOCKED`, `DEPENDENCIES:…`, `CATEGORY_NOT_LEGAL_IN_IMPLEMENT:release`).

A dropped candidate the caller cannot see reads as "there was nothing else to do". The decision artifact `agent-sdlc/task-schedule-decision/v1` is persisted as a `task.dispatched` event per selected task.

## Workspace isolation

The scheduler does not know how a host isolates a writer. `runtime/workspace.mjs` offers three modes:

| Mode | Use |
|---|---|
| `shared-readonly` | investigators and reviewers; no writes |
| `isolated-worktree` | the default writer mode: a git worktree on a task branch at the base revision |
| `provider-sandbox` | the host provides isolation; we record the binding |

Rules it enforces: one writable workspace per task; binding a second writer to the same task is refused; two active writable workspaces may not share a root or a writer (`checkWriterIsolation`); cleanup refuses to run while evidence is unpersisted; and production/deploy credentials are stripped from a writer's environment (`scrubbedEnv`) — an ambient credential is the one thing a sandbox cannot take back.

When a worktree cannot be created, the workspace degrades honestly (`degraded: WORKTREE_UNAVAILABLE:…`) rather than silently pretending to be isolated. Uncommitted tracked changes do not cancel isolation; they are recorded as `uncommitted_changes_excluded`, because a worktree at the base revision is still the honest thing to branch from.

## Determinism

Eligible tasks are considered in `task_id` order, so the same graph and the same policy always produce the same dispatch decision. `evals/task-runtime.mjs` asserts this directly.
