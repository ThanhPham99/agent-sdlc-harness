# Workflow Module: testing-verification

> Internal orchestrator module. This is not a public Agent Skill and must not be independently discovered or invoked by the host. Load it only when the canonical workflow state selects this module. Return control to `sdlc-orchestrator`; never mark the global workflow COMPLETE yourself.

# Testing & Verification

## Workflow preflight

The orchestrator's context compiler only loads this skill when the run's current stage authorizes it — there is no separate legacy state file to check. If you believe you were invoked out of order regardless, return `BLOCKED` with the required next logical skill rather than proceeding. Load only the artifacts required for this step.


Create/update `test-plan.md` as needed, then execute the smallest sufficient verification set plus required regression coverage. Consider unit, integration, contract, migration, security, performance, build/lint/static checks, and manual validation only when relevant.

Update `verification.md` with acceptance-criterion traceability, actual checks run, results, gaps, and blockers. A claimed check without execution evidence is not a pass. If a required environment/check is unavailable, record it explicitly and let the orchestrator decide whether completion is blocked.


For STANDARD/STRICT product/change workflows, create/update `traceability.md` from the canonical template. Before returning DONE, verify every confirmed in-scope acceptance criterion has a design/implementation reference and executed evidence, or report a gap/authorized exception. Do not let G6 pass on narrative claims alone.
