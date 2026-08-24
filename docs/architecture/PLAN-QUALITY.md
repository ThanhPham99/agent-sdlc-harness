# Plan Quality Gate

Before alpha4 the implementation plan was semantically good prose: "break work into small independently verifiable tasks". Prose cannot be checked. A plan with a dependency cycle, an acceptance criterion nobody implements, or two "parallel" tasks writing the same file reads exactly like a good plan.

Alpha4 makes the plan a **structured artifact validated by code** before `PLAN -> IMPLEMENT` opens.

## The artifact

- `protocol/schemas/TaskPlan.schema.json` — `agent-sdlc/task-plan/v1`
- `protocol/schemas/PlannedTask.schema.json` — `agent-sdlc/planned-task/v1`

A plan declares the objective, `requirements` (acceptance criterion IDs), `design_decisions`, plan-wide `forbidden_scope`, `required_categories`, and the task list. Each task declares goal, category, `depends_on`, acceptance criteria, read/write/interface/forbidden scope, modules, likely symbols, verification expectation, compatibility and rollback obligations, done conditions, risk and whether it is a parallel candidate.

`edges` is optional. Dependencies are always derived from `depends_on`; when an explicit edge list is supplied it must agree with them.

## The validator

`runtime/plan-validator.mjs` is deterministic: no repository reads, no network, no model inference.

```
bin/agent-sdlc plan validate --file task-plan.json
bin/agent-sdlc plan graph    --file task-plan.json
bin/agent-sdlc plan record   --run-id <id> --file task-plan.json
```

Exported functions: `validateTaskPlan`, `computeTaskGraph`, `findCycles`, `computeReadySets`, `computeCoverage`, `computeScopeConflicts`, `planGateEvidence`.

### Invariants enforced

Graph:

- `DUPLICATE_TASK_ID`, `TASK_MISSING_ID`
- `UNKNOWN_DEPENDENCY` — a `depends_on` pointing at a task that does not exist
- `CYCLE_DETECTED` — every simple cycle is reported, canonically rotated
- `EDGE_NOT_IN_DEPENDS_ON` — an explicit edge with no matching dependency

Per task:

- `TASK_MISSING_GOAL`, `TASK_MISSING_DONE_CONDITION`, `TASK_UNKNOWN_CATEGORY`
- `BEHAVIOR_TASK_WITHOUT_VERIFICATION` — no targeted tests and no expected behaviour. Set `changes_behavior: false` only for genuinely behaviour-neutral work.
- `INTERFACE_TASK_WITHOUT_COMPATIBILITY_OBLIGATION`
- `DESTRUCTIVE_TASK_WITHOUT_ROLLBACK`
- `FORBIDDEN_SCOPE_VIOLATION` — a write scope reaching into a plan-wide or task-local forbidden boundary
- `GIANT_TASK_WITHOUT_JUSTIFICATION` — three or more unrelated modules, or twelve or more write-scope entries, with no `scope_justification`

Coverage and upstream state:

- `UNCOVERED_ACCEPTANCE_CRITERION`, `UNVERIFIED_ACCEPTANCE_CRITERION`
- `UNRESOLVED_DESIGN_DECISION`, `UNRESOLVED_REQUIREMENT`
- `MISSING_REQUIRED_TASK_CATEGORY` — migration / documentation / release / security work mandated by the workflow or a risk overlay

Parallelism:

- `PARALLEL_WRITE_SCOPE_CONFLICT`, `PARALLEL_INTERFACE_SCOPE_CONFLICT` — two `parallel_candidate` tasks with overlapping scope and no dependency edge between them. Scope entries are compared as path prefixes with glob stems, so `src/auth/` and `src/auth/reset.js` collide.

### Metrics

Every validation reports `task_count`, `edge_count`, `ac_coverage`, `verification_coverage`, `cycle_count`, `parallel_candidate_count`, `conflict_count`, `wave_count` (the topological critical-path length) and `unreachable_task_count`.

### FAST micro-plans

`profile: "FAST"` is validated as a micro-plan. Graph and per-task invariants still apply; plan-wide coverage obligations relax to warnings. The four minimums never relax: **goal, scope, done condition, verification**.

## The gate

`policies/stage-policy.json` `PLAN.gate_requirements` is now:

```
plan_artifact_created
plan_schema_valid
plan_graph_valid
plan_acceptance_coverage_valid
plan_scope_conflicts_resolved
```

`bin/agent-sdlc plan record` runs the validator and writes all five plus the compatibility alias `plan_ready` — only on success. All of them carry `runtime` authority in `evidence_authority`, so `transition --evidence plan_ready` is refused. An invalid plan keeps `PLAN -> IMPLEMENT` closed; the fix is a better plan, not `--force`.

The recorder is stage-scoped: `recordTaskPlan` throws outside `PLAN`, and a rejected plan emits a `plan.rejected` event and leaks no evidence.

## Forward compatibility

Task `category` values (`implementation`, `migration`, `verification`, `security`, `integration`, `documentation`, `release`, `operability`) and the wave decomposition are the inputs the alpha5 task DAG scheduler will consume. `parallel_candidate` is a *claim* the validator sanity-checks now and the scheduler will re-check against live scope at dispatch time.

## Evidence artifacts

`npm run test:gates` produces `evals/PLAN-QUALITY-VALIDATION.json`: per-case metrics and error codes, the set of invariants actually exercised, graph-helper output for the fan-out and cyclic fixtures, and the gate wiring.
