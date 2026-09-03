# Workflow Module: code-review

> Internal orchestrator module. This is not a public Agent Skill and must not be independently discovered or invoked by the host. Load it only when the canonical workflow state selects this module. Return control to `sdlc-orchestrator`; never mark the global workflow COMPLETE yourself.

# Code Review

## Workflow preflight

The orchestrator's context compiler only loads this skill when the run's current stage authorizes it — there is no separate legacy state file to check. If you believe you were invoked out of order regardless, return `BLOCKED` with the required next logical skill rather than proceeding. Load only the artifacts required for this step.


Review the actual diff and verification artifacts. Prioritize correctness defects, requirement misses, regressions, security issues, data/compatibility risks, race/error handling, and missing tests over style preferences.
Additionally, audit the diff against `policies/coding-standards.json`:
- Verify strict adherence to naming conventions (`snake_case`, boolean prefixes, `camelCase` functions, `PascalCase` types, `kebab-case` filenames).
- Verify clean code principles: maximum 3 parameters per function, single responsibility, no duplicate logic, no dead code or unhandled promises.
- Verify typing and safety: absolute ban on `any`, all external I/O wrapped in safe try/catch or typed schemas, proper resource cleanup in finally.

Classify findings as blocking or non-blocking. Do not redesign unrelated code. If the diff diverges materially from approved design/plan, return it to the appropriate gate.
