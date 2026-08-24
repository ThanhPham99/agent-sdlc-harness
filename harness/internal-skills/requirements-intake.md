# Workflow Module: requirements-intake

> Internal orchestrator module. This is not a public Agent Skill and must not be independently discovered or invoked by the host. Load it only when the canonical workflow state selects this module. Return control to `sdlc-orchestrator`; never mark the global workflow COMPLETE yourself.

# Requirements Intake

## Workflow preflight

If an active `.ai-workflow/features/<id>/state.yaml` exists, verify that the current state/gate authorizes this skill before changing project artifacts or code. If invoked out of order, return `BLOCKED` with the required next logical skill; do not bypass the orchestrator. Load only the artifacts required for this step.


Inventory every supplied source, identify feature/phase association, note version/date where available, detect duplicate/superseding inputs, and record extraction completeness.

Do not resolve ambiguities yet. Produce a source inventory and hand off content needing normalization to `requirements-normalize`.
