---
name: sdlc-plan
description: Dispatched by sdlc-orchestrator when the active SDLC run state is PLAN. Not an entry point; do not activate from a user prompt.
metadata:
  version: "3.0.0-rc2"
---
# SDLC Plan Stage

Dispatched by `sdlc-orchestrator` when `navigation.stage_skill` is `sdlc-plan`.
Not an entry point.

Emit a structured `agent-sdlc/task-plan/v1` object, not Markdown prose.
Run `bin/agent-sdlc plan validate` first, then
`bin/agent-sdlc plan record --run-id <id> --file task-plan.json`.

An invalid dependency graph, an uncovered acceptance criterion, a
behaviour-changing task without verification, or two overlapping parallel
candidates keeps `PLAN -> IMPLEMENT` closed. Fix the plan; there is no
`--force`.

A blocked gate is fixed by producing the missing evidence, or, for a
privileged capability, by asking a human to run `agent-sdlc approval grant`
interactively — never by you.

Load the procedure modules `navigation.procedure_skills` names for this stage
before structuring the plan.
