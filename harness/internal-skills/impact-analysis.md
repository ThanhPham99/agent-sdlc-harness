# Workflow Module: impact-analysis

> Internal orchestrator module. This is not a public Agent Skill and must not be independently discovered or invoked by the host. Load it only when the canonical workflow state selects this module. Return control to `sdlc-orchestrator`; never mark the global workflow COMPLETE yourself.

# Impact Analysis

## Workflow preflight

If an active `.ai-workflow/features/<id>/state.yaml` exists, verify that the current state/gate authorizes this skill before changing project artifacts or code. If invoked out of order, return `BLOCKED` with the required next logical skill; do not bypass the orchestrator. Load only the artifacts required for this step.


Trace from changed requirements to affected code and system boundaries. Read only the direct dependency closure first; expand if evidence requires it.

Update `impact-analysis.md`. Explicitly identify: components, contracts/consumers, persistence, auth/security, compatibility, tests, deployment/rollback, frontend/client impact, documentation, risks, and unresolved uncertainty.

For later phases, diff against the previous impact analysis and preserve unaffected conclusions.
