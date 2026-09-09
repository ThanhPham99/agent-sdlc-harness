---
name: sdlc-requirements
description: Dispatched by sdlc-orchestrator when the active SDLC run state is REQUIREMENTS (or INTAKE). Not an entry point; do not activate from a user prompt.
metadata:
  version: "3.0.0-rc2"
---
# SDLC Requirements Stage

Dispatched by `sdlc-orchestrator` when `navigation.stage_skill` is `sdlc-requirements`.
Not an entry point.

Validate input completeness. If specifications or user requests lack critical
context, halt and confirm with the user using Socratic dialogue: ask one
question at a time, provide 2-3 concrete options with trade-offs and your
recommendation.

Only confirmed answers recorded in `clarifications.md` are accepted as product
truth; never proceed on unverified assumptions.

Load the procedure modules `navigation.procedure_skills` names for this stage
before drafting acceptance criteria and non-functional requirements.
