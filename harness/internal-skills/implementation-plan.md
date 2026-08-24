# Workflow Module: implementation-plan

> Internal orchestrator module. This is not a public Agent Skill and must not be independently discovered or invoked by the host. Load it only when the canonical workflow state selects this module. Return control to `sdlc-orchestrator`; never mark the global workflow COMPLETE yourself.

# Implementation Plan

## Workflow preflight

If an active `.ai-workflow/features/<id>/state.yaml` exists, verify that the current state/gate authorizes this skill before changing project artifacts or code. If invoked out of order, return `BLOCKED` with the required next logical skill; do not bypass the orchestrator. Load only the artifacts required for this step.

Break work into small independently verifiable tasks. Prefer incremental vertical slices over large batches. Include migration/rollback and documentation tasks when relevant. The plan is a scope boundary: unexpected broad changes trigger re-impact/re-design rather than silent scope expansion.

## The plan is a machine-checked artifact, not prose

Emit a `agent-sdlc/task-plan/v1` object (`protocol/schemas/TaskPlan.schema.json`, tasks per `protocol/schemas/PlannedTask.schema.json`). Markdown may be generated from it; the structured object is the authority.

Per task, declare: `task_id`, `title`, `goal`, `category`, `depends_on`, `acceptance_criteria`, `read_scope`, `write_scope`, `interface_scope`, `modules`, `likely_symbols`, `verification.targeted_tests`, `verification.expected_behavior`, `done_conditions`, `risk`, `parallel_candidate`.

Then validate and record:

```
bin/agent-sdlc plan validate --file task-plan.json
bin/agent-sdlc plan graph    --file task-plan.json
bin/agent-sdlc plan record   --run-id <id> --file task-plan.json
```

`plan record` is the only way to obtain `PLAN` gate evidence. Gate evidence cannot be asserted by hand; `PLAN -> IMPLEMENT` stays closed until the deterministic validator passes.

## What the validator will reject

- duplicate `task_id`, missing `goal`, missing `done_conditions`;
- a `depends_on` reference to a task that does not exist, or any dependency cycle;
- an acceptance criterion in `requirements` that no task implements or verifies;
- a behaviour-changing task with no `verification.targeted_tests` / `expected_behavior` (set `changes_behavior: false` only for genuinely behaviour-neutral work);
- an `interface_scope` task with no `compatibility_obligations`;
- a destructive data change with no `rollback_obligations`;
- two `parallel_candidate` tasks whose `write_scope` or `interface_scope` overlap without a dependency edge between them;
- a `write_scope` that reaches into plan-wide or task-local `forbidden_scope`;
- unresolved design decisions or unresolved requirements still listed on the plan;
- one giant task spanning several unrelated `modules` (or a very wide `write_scope`) with no `scope_justification`;
- a `required_categories` entry (migration / documentation / release / security work mandated by the workflow or risk overlay) with no task in that category.

## FAST micro-plans

`profile: "FAST"` is validated as a micro-plan: graph invariants and per-task invariants still apply, and coverage obligations relax to warnings. The four minimums never relax: **goal, scope, done condition, verification**.

## Parallelism

`parallel_candidate: true` is a claim the scheduler will check. Only claim it when write and interface scopes are genuinely disjoint. Parallelism is an optimization, not a default: serialize on shared write paths, contracts, migration ordering and shared security boundaries.
