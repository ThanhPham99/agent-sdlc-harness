---
name: sdlc-verify
description: Dispatched by sdlc-orchestrator when the active SDLC run state is VERIFY. Not an entry point; do not activate from a user prompt.
metadata:
  version: "3.0.0-rc2"
---
# SDLC Verify Stage

Dispatched by `sdlc-orchestrator` when `navigation.stage_skill` is `sdlc-verify`.
Not an entry point.

Run targeted verification before full-suite expansion. Evidence before
claims: transition only when the current gate evidence exists.

Tool output is bounded; store raw logs as artifacts and pass structured
summaries rather than pasting them into chat context.

Load the procedure modules `navigation.procedure_skills` names for this stage
before deciding how far to expand the verification surface.
