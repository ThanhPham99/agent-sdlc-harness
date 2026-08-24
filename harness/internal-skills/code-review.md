# Workflow Module: code-review

> Internal orchestrator module. This is not a public Agent Skill and must not be independently discovered or invoked by the host. Load it only when the canonical workflow state selects this module. Return control to `sdlc-orchestrator`; never mark the global workflow COMPLETE yourself.

# Code Review

## Workflow preflight

If an active `.ai-workflow/features/<id>/state.yaml` exists, verify that the current state/gate authorizes this skill before changing project artifacts or code. If invoked out of order, return `BLOCKED` with the required next logical skill; do not bypass the orchestrator. Load only the artifacts required for this step.


Review the actual diff and verification artifacts. Prioritize correctness defects, requirement misses, regressions, security issues, data/compatibility risks, race/error handling, and missing tests over style preferences.

Classify findings as blocking or non-blocking. Do not redesign unrelated code. If the diff diverges materially from approved design/plan, return it to the appropriate gate.
