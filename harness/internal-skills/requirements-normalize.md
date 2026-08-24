# Workflow Module: requirements-normalize

> Internal orchestrator module. This is not a public Agent Skill and must not be independently discovered or invoked by the host. Load it only when the canonical workflow state selects this module. Return control to `sdlc-orchestrator`; never mark the global workflow COMPLETE yourself.

# Requirements Normalize

## Workflow preflight

If an active `.ai-workflow/features/<id>/state.yaml` exists, verify that the current state/gate authorizes this skill before changing project artifacts or code. If invoked out of order, return `BLOCKED` with the required next logical skill; do not bypass the orchestrator. Load only the artifacts required for this step.


Convert source material into `requirements.md` with stable requirement and acceptance-criterion IDs. Preserve provenance to source sections/sheets/pages where available.

For existing features, compare against the latest confirmed requirements and create/update `requirement-changes.md` with `ADDED`, `CHANGED`, `REMOVED`, `UNCHANGED`, or `CONFLICTING` classifications.

Never silently replace confirmed requirements. Changed/conflicting semantics must go through clarification/confirmation.
