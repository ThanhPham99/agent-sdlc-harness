# Workflow Module: docs-update

> Internal orchestrator module. This is not a public Agent Skill and must not be independently discovered or invoked by the host. Load it only when the canonical workflow state selects this module. Return control to `sdlc-orchestrator`; never mark the global workflow COMPLETE yourself.

# Documentation Update

## Workflow preflight

If an active `.ai-workflow/features/<id>/state.yaml` exists, verify that the current state/gate authorizes this skill before changing project artifacts or code. If invoked out of order, return `BLOCKED` with the required next logical skill; do not bypass the orchestrator. Load only the artifacts required for this step.


Update by diff, not full regeneration. Reconcile implementation evidence with feature docs and then update project system context, architecture, feature index, decisions, deployment notes, and handover only where affected.

Do not promote speculative architecture to truth. Keep historical/superseded decisions identifiable rather than erasing them.

## Knowledge evolution handoff

When this change materially changes architecture, public contracts, accepted decisions, technical debt, deprecation state, or current system understanding, return `knowledge_maintenance_required: true` to the Orchestrator. The Orchestrator may fuse `knowledge-maintenance` into the same integration execution unit, but it must update only affected current entries and preserve cold history/provenance.
