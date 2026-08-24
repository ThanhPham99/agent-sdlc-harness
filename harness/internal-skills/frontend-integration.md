# Workflow Module: frontend-integration

> Internal orchestrator module. This is not a public Agent Skill and must not be independently discovered or invoked by the host. Load it only when the canonical workflow state selects this module. Return control to `sdlc-orchestrator`; never mark the global workflow COMPLETE yourself.

# Frontend / Client Integration

## Workflow preflight

If an active `.ai-workflow/features/<id>/state.yaml` exists, verify that the current state/gate authorizes this skill before changing project artifacts or code. If invoked out of order, return `BLOCKED` with the required next logical skill; do not bypass the orchestrator. Load only the artifacts required for this step.


Document only externally relevant integration details: endpoint/event contract, auth/permissions, request/response examples, validation/errors, sequencing, compatibility/deprecation, feature flags, rollout timing, and test/mock guidance.

Use confirmed contracts from design/implementation; do not expose irrelevant backend internals.
