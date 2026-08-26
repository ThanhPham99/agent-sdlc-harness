# Workflow Module: solution-design

> Internal orchestrator module. This is not a public Agent Skill and must not be independently discovered or invoked by the host. Load it only when the canonical workflow state selects this module. Return control to `sdlc-orchestrator`; never mark the global workflow COMPLETE yourself.

# Solution Design

## Workflow preflight

The orchestrator's context compiler only loads this skill when the run's current stage authorizes it — there is no separate legacy state file to check. If you believe you were invoked out of order regardless, return `BLOCKED` with the required next logical skill rather than proceeding. Load only the artifacts required for this step.


Design the smallest solution that satisfies confirmed requirements and system constraints. Cover flows, component boundaries, contracts, data model, errors, compatibility, security, alternatives, migration/rollout/rollback, and open decisions as applicable.

Do not turn optional future phases into current scope. Mark deferred design explicitly. Return `NEEDS_CONFIRMATION` for product/business decisions the agent cannot legitimately choose.
