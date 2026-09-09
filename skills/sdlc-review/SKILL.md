---
name: sdlc-review
description: Dispatched by sdlc-orchestrator when the active SDLC run state is REVIEW. Not an entry point; do not activate from a user prompt.
metadata:
  version: "3.0.0-rc2"
---
# SDLC Review Stage

Dispatched by `sdlc-orchestrator` when `navigation.stage_skill` is `sdlc-review`.
Not an entry point.

Run a two-stage review: spec compliance, then code quality, each with its own
verdict. Findings carry `file:line` evidence; a verdict without evidence
cannot close the gate.

Load the procedure modules `navigation.procedure_skills` names for this stage.
