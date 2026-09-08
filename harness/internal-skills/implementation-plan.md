# Workflow Module: implementation-plan

> Internal orchestrator module. This is not a public Agent Skill and must not be independently discovered or invoked by the host. Load it only when the canonical workflow state selects this module. Return control to `sdlc-orchestrator`; never mark the global workflow COMPLETE yourself.

# Implementation Plan

## Workflow preflight

The orchestrator's context compiler only loads this skill when the run's current stage authorizes it — there is no separate legacy state file to check. If you believe you were invoked out of order regardless, return `BLOCKED` with the required next logical skill rather than proceeding. Load only the artifacts required for this step.

Before touching code, author a comprehensive plan and break work into small, logically bounded, independently verifiable tasks. Prefer incremental vertical slices over large batches. Decompose tasks reasonably: strictly avoid monolithic tasks that bundle unrelated modules or wide unconstrained write scopes. Include migration/rollback and documentation tasks when relevant. The plan is a scope boundary: unexpected broad changes trigger re-impact/re-design rather than silent scope expansion.

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

## Task Granularity & Bite-Sized TDD Flow

A task is the smallest unit that carries its own test cycle and is worth a fresh reviewer gate. Break down each task into concrete 2–5 minute steps following strict TDD:
1. **Write failing test (RED)**: Add minimal test verifying expected behavior.
2. **Verify test fails (VERIFY RED)**: Run test suite; verify it fails meaningfully with the expected assertion error.
3. **Write minimal implementation (GREEN)**: Implement only the minimal code necessary to make the test pass.
4. **Verify test passes (VERIFY GREEN)**: Run test suite; confirm all tests pass.
5. **Commit**: Create atomic commit with descriptive message.

## Task Interface Contracts: `Consumes` & `Produces`

Implementer subagents operate in isolated context. To ensure seamless integration across tasks, each task declaration/brief must explicitly document:
- **Consumes**: What this task uses from earlier tasks (exact function signatures, types, or configuration keys).
- **Produces**: What later tasks rely upon (exact exported function names, parameter and return types). Implementers must not deviate from these agreed names.

## Zero-Placeholder Policy

Every step must contain the actual concrete details an engineer needs. The following are **Plan Failures** — never include them:
- `"TBD"`, `"TODO"`, `"implement later"`, `"fill in details"`.
- `"Add appropriate error handling"` / `"handle edge cases"` without detailing exact error types and recovery behavior.
- `"Write tests for the above"` without declaring concrete test cases and assertions.
- `"Similar to Task N"` without explicitly defining the code/schema (tasks may be executed in fresh subagent contexts).

## Pre-Flight Self-Review Checklist

Before running `plan record`, perform a self-review of the materialized plan:
1. **Spec Coverage**: Verify that every requirement and acceptance criterion maps to a concrete task.
2. **Placeholder Scan**: Scan for any vague directives or placeholder language. Fix them inline.
3. **Naming & Type Consistency**: Confirm that types and method signatures defined in early tasks match the names consumed by downstream tasks.

## FAST micro-plans

`profile: "FAST"` is validated as a micro-plan: graph invariants and per-task invariants still apply, and coverage obligations relax to warnings. The four minimums never relax: **goal, scope, done condition, verification**.

## Parallelism

`parallel_candidate: true` is a claim the scheduler will check. Only claim it when write and interface scopes are genuinely disjoint. Parallelism is an optimization, not a default: serialize on shared write paths, contracts, migration ordering and shared security boundaries.
