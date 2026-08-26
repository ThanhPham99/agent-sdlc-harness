# Workflow Module: requirements-clarify

> Internal orchestrator module. This is not a public Agent Skill and must not be independently discovered or invoked by the host. Load it only when the canonical workflow state selects this module. Return control to `sdlc-orchestrator`; never mark the global workflow COMPLETE yourself.

# Requirements Clarify

## Workflow preflight

The orchestrator's context compiler only loads this skill when the run's current stage authorizes it — there is no separate legacy state file to check. If you believe you were invoked out of order regardless, return `BLOCKED` with the required next logical skill rather than proceeding. Load only the artifacts required for this step.


Check scope, actors, business rules, edge cases, error behavior, acceptance criteria, data semantics, permissions, compatibility, rollout constraints, and non-functional expectations only where relevant.

Before asking a question, inspect existing `clarifications.md`, confirmed requirements, accepted decisions, and project artifacts. Never ask the user to repeat a resolved answer.

Ask only questions whose answers can materially change design, behavior, acceptance criteria, safety, compatibility, or release strategy. Record confirmed answers; leave agent hypotheses explicitly unconfirmed.
