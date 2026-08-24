# Workflow Module: operability-engineering

> Internal orchestrator module. This is not a public Agent Skill and must not be independently discovered or invoked by the host. Load it only when the canonical workflow state selects this module. Return control to `sdlc-orchestrator`; never mark the global workflow COMPLETE yourself.

# Operability Engineering

## Workflow preflight

If an active `.ai-workflow/features/<id>/state.yaml` exists, verify that the current workflow state/gate authorizes the operational change. If invoked out of order, return `BLOCKED`; do not bypass impact/design/release gates.

Identify affected environments and blast radius before changing pipeline/config/IaC/observability assets. Keep production execution separate from preparing code/config unless explicitly authorized. Require validation in the safest representative environment available, and document rollback/backout for meaningful operational changes.

For observability, verify signal usefulness, cardinality/cost implications, consumer/runbook impact, and secret/sensitive-data exposure. Attach `security` and `release-impact` overlays when applicable.
