# Workflow Module: project-bootstrap

> Internal orchestrator module. This is not a public Agent Skill and must not be independently discovered or invoked by the host. Load it only when the canonical workflow state selects this module. Return control to `sdlc-orchestrator`; never mark the global workflow COMPLETE yourself.

# Project Bootstrap

## Workflow preflight

If an active `.ai-workflow/features/<id>/state.yaml` exists, verify that the current state/gate authorizes this skill before changing project artifacts or code. If invoked out of order, return `BLOCKED` with the required next logical skill; do not bypass the orchestrator. Load only the artifacts required for this step.


Inspect repository structure, build/runtime configuration, entry points, modules/services, public interfaces, persistence, tests, deployment/config, and existing engineering guidance.

Create or update only enough project knowledge for safe work:
- `.ai-workflow/project/system-context.md`
- `.ai-workflow/project/architecture.md`
- `.ai-workflow/project/standards.md`
- `.ai-workflow/project/feature-index.md`

Label uncertain inferred architecture as `PROPOSED/UNCONFIRMED`. Do not pretend reverse engineering is authoritative business documentation. Prefer progressive understanding: deeply analyze the dependency closure relevant to current work, then enrich project docs after implementation confirms facts.

## Long-running knowledge baseline

Initialize `knowledge-index.yaml`, `decision-index.yaml`, `technical-debt-register.yaml`, and `deprecation-register.yaml` only when they add value to project continuity. For an existing large repository, index the affected/current architecture first; do not crawl every historical feature before the first task can proceed.
