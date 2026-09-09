---
name: sdlc-implement
description: Dispatched by sdlc-orchestrator when the active SDLC run state is IMPLEMENT. Not an entry point; do not activate from a user prompt.
metadata:
  version: "3.0.0-rc2"
---
# SDLC Implement Stage

Dispatched by `sdlc-orchestrator` when `navigation.stage_skill` is `sdlc-implement`.
Not an entry point.

The validated plan becomes a persistent task graph, and `IMPLEMENT` means
executing it: `bin/agent-sdlc task materialize`, then `task refresh` /
`task schedule` / `task start` / `task advance` per the `task-execution`
procedure module.

A task reaches `DONE` only with verification evidence bound to its current
attempt and diff, a clean spec-compliance review and a clean code-quality
review. `implementation_artifact` is derived by
`bin/agent-sdlc task implementation-complete` once every required task is
`DONE`; it cannot be asserted either.

One task, one bounded context, one primary writer, one workspace. A worker
returns a structured result and never transitions run or task state. A diff
outside a task's approved write scope is a planning event that re-enters
`PLAN`, not a retry. A retry needs new concrete evidence; the engine refuses
an identical repeat.

Load the procedure modules `navigation.procedure_skills` names for this stage.
