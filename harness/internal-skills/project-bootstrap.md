# Workflow Module: project-bootstrap

> Internal orchestrator module. This is not a public Agent Skill and must not be independently discovered or invoked by the host. Load it only when the canonical workflow state selects this module. Return control to `sdlc-orchestrator`; never mark the global workflow COMPLETE yourself.

# Project Bootstrap

## Workflow preflight

The orchestrator's context compiler only loads this skill when the run's current stage authorizes it — there is no separate legacy state file to check. If you believe you were invoked out of order regardless, return `BLOCKED` with the required next logical skill rather than proceeding. Load only the artifacts required for this step.


Inspect repository structure, build/runtime configuration, entry points, modules/services, public interfaces, persistence, tests, deployment/config, and existing engineering guidance.

Create or update only enough project knowledge for safe work, each stored as a content-addressed artifact via `agent-sdlc artifact-put --kind <kind>` and attached to the run:
- `kind: system-context`
- `kind: architecture`
- `kind: standards`
- `kind: feature-index`

Label uncertain inferred architecture as `PROPOSED/UNCONFIRMED`. Do not pretend reverse engineering is authoritative business documentation. Prefer progressive understanding: deeply analyze the dependency closure relevant to current work, then enrich project docs after implementation confirms facts.

## Long-running knowledge baseline

Initialize `knowledge-index.yaml`, `decision-index.yaml`, `technical-debt-register.yaml`, and `deprecation-register.yaml` only when they add value to project continuity. For an existing large repository, index the affected/current architecture first; do not crawl every historical feature before the first task can proceed.
