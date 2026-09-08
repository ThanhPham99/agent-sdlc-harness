# Workflow Module: tdd

> Internal orchestrator module. This is not a public Agent Skill and must not be independently discovered or invoked by the host. Load it only when the canonical workflow state selects this module. Return control to `sdlc-orchestrator`; never mark the global workflow COMPLETE yourself.

# TDD Build Strategy

## Workflow preflight

The orchestrator's context compiler only loads this skill when the run's current stage authorizes the build stage — there is no separate legacy state file to check. If you believe you were invoked out of order regardless, return `BLOCKED`; do not bypass the orchestrator.

For one bounded behavior slice:

1. identify the acceptance criterion/invariant;
2. add/update a test that fails for the missing/incorrect behavior;
3. confirm the failure is meaningful rather than broken setup;
4. implement the smallest clean production change that makes it pass within architectural boundaries. NEVER apply patch-to-pass shortcuts: do not widen types, duplicate enum semantics (e.g., adding BOY+MALE, GIRL+FEMALE to an enum), or corrupt domain models to satisfy disparate test inputs;
5. refactor while keeping tests green: eliminate duplication, enforce single source of truth, ensure external inputs are normalized at system boundaries (DTO/adapter) rather than polluting domain types, and remove any band-aid fixes;
6. run focused checks and perform a scope/diff self-check;
7. return the slice to `testing-verification` for final required evidence.

### Domain Integrity & Anti-Patching in TDD
When a test introduces or requires varied input formats (e.g., `'male'` vs `'boy'`), solve it by adding a boundary transformer/normalizer (anti-corruption layer in DTO/Controller) or clarifying the canonical contract. Never inflate a domain enum or entity with synonymous values or loose types just to turn a test green.

For risky legacy behavior, establish a characterization/integration test first. If test-first is genuinely infeasible, do not fabricate a red-green cycle; return a reason so the orchestrator can use the direct `implementation` build strategy.

This skill **includes implementation for the selected slice**. Do not invoke `implementation` afterward unless a distinct remaining task explicitly requires the direct strategy.
