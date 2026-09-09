---
name: sdlc-design
description: Dispatched by sdlc-orchestrator when the active SDLC run state is DESIGN. Not an entry point; do not activate from a user prompt.
metadata:
  version: "3.0.0-rc2"
---
# SDLC Design Stage

Dispatched by `sdlc-orchestrator` when `navigation.stage_skill` is `sdlc-design`.
Not an entry point.

Ask `bin/agent-sdlc design mode --run-id <id>` for the discovery depth
(`SKIP` / `COMPACT` / `FULL`) and obey it; declare a missing signal with
`--signals` rather than overriding the answer in prose.

Present the design in bite-sized sections of 150-250 words and take incremental
user feedback before finalizing.

Load the procedure modules `navigation.procedure_skills` names for this stage,
produce an `agent-sdlc/design-decision/v1` object, then run
`bin/agent-sdlc design record --run-id <id> --file design-decision.json`.

When the selector reports `human_approval_required`, suspend to
`NEEDS_CONFIRMATION` and obtain real user approval. Never write your own.
