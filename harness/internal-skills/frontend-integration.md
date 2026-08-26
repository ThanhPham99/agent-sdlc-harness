# Workflow Module: frontend-integration

> Internal orchestrator module. This is not a public Agent Skill and must not be independently discovered or invoked by the host. Load it only when the canonical workflow state selects this module. Return control to `sdlc-orchestrator`; never mark the global workflow COMPLETE yourself.

# Frontend / Client Integration

## Workflow preflight

The orchestrator's context compiler only loads this skill when the run's current stage authorizes it — there is no separate legacy state file to check. If you believe you were invoked out of order regardless, return `BLOCKED` with the required next logical skill rather than proceeding. Load only the artifacts required for this step.


Document only externally relevant integration details: endpoint/event contract, auth/permissions, request/response examples, validation/errors, sequencing, compatibility/deprecation, feature flags, rollout timing, and test/mock guidance.

Use confirmed contracts from design/implementation; do not expose irrelevant backend internals.
