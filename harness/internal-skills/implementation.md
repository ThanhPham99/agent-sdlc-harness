# Workflow Module: implementation

> Internal orchestrator module. This is not a public Agent Skill and must not be independently discovered or invoked by the host. Load it only when the canonical workflow state selects this module. Return control to `sdlc-orchestrator`; never mark the global workflow COMPLETE yourself.

# Direct Implementation Build Strategy

## Workflow preflight

If an active `.ai-workflow/features/<id>/state.yaml` exists, verify that the current state/gate authorizes the build stage. If invoked out of order, return `BLOCKED`; do not bypass the orchestrator. Load only the current task plus its direct requirements, relevant design/standards, affected code, and tests.

Follow the approved plan/micro-plan. Keep changes minimal and cohesive. For behavior changes where test-first is not used, preserve the reason when it is not self-evident and ensure the verification plan still covers the behavior.

If implementation reveals a requirement contradiction, invalid architectural assumption, or materially larger blast radius, stop the affected task and return to the orchestrator with `NEEDS_CONFIRMATION` or `BLOCKED`; do not redesign product behavior implicitly.

Run focused checks and a lightweight scope/diff self-check before handoff. Do not claim final completion; hand off to `testing-verification`.
