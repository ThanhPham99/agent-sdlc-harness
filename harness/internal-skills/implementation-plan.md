# Workflow Module: implementation-plan

> Internal orchestrator module. This is not a public Agent Skill and must not be independently discovered or invoked by the host. Load it only when the canonical workflow state selects this module. Return control to `sdlc-orchestrator`; never mark the global workflow COMPLETE yourself.

# Implementation Plan

## Workflow preflight

If an active `.ai-workflow/features/<id>/state.yaml` exists, verify that the current state/gate authorizes this skill before changing project artifacts or code. If invoked out of order, return `BLOCKED` with the required next logical skill; do not bypass the orchestrator. Load only the artifacts required for this step.


Break work into small independently verifiable tasks. Each task must identify goal, dependencies, likely files/components, test expectation, and completion condition.

Prefer incremental vertical slices over large batches. Include migration/rollback and documentation tasks when relevant. The plan is a scope boundary: unexpected broad changes trigger re-impact/re-design rather than silent scope expansion.
