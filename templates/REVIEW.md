# Review Instructions

Review policy for automated and peer code review passes.

## Review Passes

Run three distinct passes and tag each finding with its corresponding category:

1. **Bugs & Correctness**
   - Logic errors, unhandled boundary conditions, broken edge cases.
   - Subtle regressions against existing interfaces.
   - Concurrency issues and race conditions.

2. **Security & Operability**
   - Injection risks, authentication / authorization gaps.
   - Secrets, tokens, credentials, or PII exposed in diffs or logs.
   - Resource leaks, unhandled timeouts, and denial-of-service risks.

3. **Compliance & Traceability**
   - Implementation faithfully matches `spec.md` and approved `plan.md`.
   - All acceptance criteria and verification obligations are satisfied.
   - Architectural constraints and design decisions are respected.

## Severity Classification

- **BLOCKING**: Any defect that would break runtime behavior, compromise security, leak data, or violate mandatory system invariants. Must be resolved before merge.
- **WARNING / IMPORTANT**: Sub-optimal design, potential performance trap, or missing documentation.
- **NIT**: Minor style preferences, variable naming suggestions, formatting.

## Cap the Nits

- Report at most **5 nits** per review session.
- If more than 5 nits exist, summarize the remainder as a count (`nit_count_omitted`) rather than listing every minor cosmetic comment. Human attention should concentrate on BLOCKING and IMPORTANT issues.

## Exclusions

- Do not report on generated code (e.g. `dist/`, `build/`, `*.min.js`, generated schema types).
- Do not report formatting issues that are already enforced by repository linters in CI.
