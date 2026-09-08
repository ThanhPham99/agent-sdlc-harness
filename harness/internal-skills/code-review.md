# Workflow Module: code-review

> Internal orchestrator module. This is not a public Agent Skill and must not be independently discovered or invoked by the host. Load it only when the canonical workflow state selects this module. Return control to `sdlc-orchestrator`; never mark the global workflow COMPLETE yourself.

# Code Review

## Workflow preflight

The orchestrator's context compiler only loads this skill when the run's current stage authorizes it — there is no separate legacy state file to check. If you believe you were invoked out of order regardless, return `BLOCKED` with the required next logical skill rather than proceeding. Load only the artifacts required for this step.


Review the actual diff and verification artifacts. Prioritize correctness defects, requirement misses, regressions, security issues, data/compatibility risks, race/error handling, and missing tests over style preferences.

The review operates under two distinct, hardened rubrics:

## 1. Spec Compliance Review Rubric (Verdict: COMPLIANT | NON_COMPLIANT)
You evaluate ONLY whether the diff fulfills the task specification — no less, and nothing extra.
- **Acceptance Criteria Coverage**: Check 100% of acceptance criteria. Every criterion must cite concrete line-by-line evidence (`file:line`).
- **Zero Tolerance for Scope Creep**: Any unrequested library, speculative feature, extra endpoint, or unapproved architectural refactor must be marked `NON_COMPLIANT` (`SCOPE_CREEP`).
- **Write Scope Adherence**: The diff must touch ONLY files declared in `write_scope`. Any file modified outside the boundary is an immediate security/gate failure.
- **Design Decisions**: Confirm that implementation faithfully follows approved design decisions.

## 2. Code Quality Review Rubric (Verdict: ACCEPTED | CHANGES_REQUIRED)
The specification is already accepted. You evaluate safety, robustness, and maintainability.
- **Correctness & Edge Cases**: A `BLOCKING` correctness finding MUST carry a concrete `failure_scenario` (exact inputs, state, and expected vs actual outcome). Speculation without failure scenario is rejected by the harness.
- **Domain Modeling & Boundary Integrity**: Reject semantic redundancy or alias sprawl in enums (e.g. `BOY` and `MALE` in a single enum). External inputs MUST be sanitized and normalized at system boundaries (DTOs/transformers), never by polluting domain models.
- **Anti-Patching Defense**: Strictly reject band-aid fixes (type loosening, enum inflation, or hacky conditional branches added solely to pass tests without addressing root cause).
- **Clean Code & SOLID**: Maximum 3 parameters per function, single responsibility, no duplicated logic, no dead code, and zero use of `any`.
- **Resource & Concurrency Safety**: Ensure database connections, streams, and timers are released in `finally` blocks. Check for race conditions, idempotency violations, and unhandled promise rejections.
- **Testing Rigor**: Reject testing anti-patterns (tests asserting mocks, tautological assertions like `expect(true).toBe(true)`, or missing failure assertions).

## Severity Calibration
- `BLOCKING`: Correctness bugs with failure scenarios, security vulnerabilities, resource leaks, scope creep, or unapproved schema changes. Blocks task progression.
- `MAJOR`: High maintenance hazard, missing critical edge-case test coverage, or SOLID violations.
- `MINOR`: Minor clarity, naming, or non-critical refactoring recommendations.
- `INFO`: Contextual observations or future suggestions.

Do not redesign unrelated code. If the diff diverges materially from approved design/plan, return it to the appropriate gate.
