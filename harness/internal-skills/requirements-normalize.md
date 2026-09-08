# Workflow Module: requirements-normalize

> Internal orchestrator module. This is not a public Agent Skill and must not be independently discovered or invoked by the host. Load it only when the canonical workflow state selects this module. Return control to `sdlc-orchestrator`; never mark the global workflow COMPLETE yourself.

# Requirements Normalize

## Workflow preflight

The orchestrator's context compiler only loads this skill when the run's current stage authorizes it — there is no separate legacy state file to check. If you believe you were invoked out of order regardless, return `BLOCKED` with the required next logical skill rather than proceeding. Load only the artifacts required for this step.


Convert source material into `requirements.md` with stable requirement and acceptance-criterion IDs. Preserve provenance to source sections/sheets/pages where available.

For existing features, compare against the latest confirmed requirements and create/update `requirement-changes.md` with `ADDED`, `CHANGED`, `REMOVED`, `UNCHANGED`, or `CONFLICTING` classifications.

Never silently replace confirmed requirements. Changed/conflicting semantics must go through clarification/confirmation.

Prefer the deterministic `normalize` command for text, Markdown, JSON, CSV, DOCX,
XLSX and text-bearing PDF input. Mark native images and image-only PDFs
`NEEDS_MULTIMODAL`: never silently OCR them and never invent missing content.

## What the requirement artifact must separate

Keep these apart rather than blending them into prose: confirmed requirements,
assumptions, constraints, acceptance criteria, unresolved questions, phase scope,
and deferred work. A reader must be able to tell which is which without asking.

If an ambiguity can change implementation or acceptance, transition to
`NEEDS_CONFIRMATION` rather than guessing.
