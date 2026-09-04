# Workflow Module: implementation

> Internal orchestrator module. This is not a public Agent Skill and must not be independently discovered or invoked by the host. Load it only when the canonical workflow state selects this module. Return control to `sdlc-orchestrator`; never mark the global workflow COMPLETE yourself.

# Direct Implementation Build Strategy

## Workflow preflight

The orchestrator's context compiler only loads this skill when the run's current stage authorizes the build stage — there is no separate legacy state file to check. If you believe you were invoked out of order regardless, return `BLOCKED`; do not bypass the orchestrator. Load only the current task plus its direct requirements, relevant design/standards, affected code, and tests.

Follow the approved plan/micro-plan. Keep changes minimal and cohesive. For behavior changes where test-first is not used, preserve the reason when it is not self-evident and ensure the verification plan still covers the behavior.

All created or modified code must strictly adhere to `policies/coding-standards.json`:
- **Naming Conventions**: `snake_case` for properties and variables, `is_`/`has_`/`can_`/`should_` prefix for booleans, `camelCase` for functions (verb-first), `PascalCase` for types/classes, `SCREAMING_SNAKE` for constants, `kebab-case` for files.
- **Clean Code & SOLID**: Maximum 3 function parameters (use object DTOs otherwise), single responsibility per function/module, no code duplication, prefer pure functions and immutability (`const`).
- **Security & Quality**: Validate inputs at boundaries, no ambient secrets/tokens, zero `any` types, release resources in `finally` blocks, and ensure cold-start efficiency.

If implementation reveals a requirement contradiction, invalid architectural assumption, or materially larger blast radius, stop the affected task and return to the orchestrator with `NEEDS_CONFIRMATION` or `BLOCKED`; do not redesign product behavior implicitly.

Run focused checks and a lightweight scope/diff self-check before handoff. Do not claim final completion; hand off to `testing-verification`.
