# Workflow Module: tdd

> Internal orchestrator module. This is not a public Agent Skill and must not be independently discovered or invoked by the host. Load it only when the canonical workflow state selects this module. Return control to `sdlc-orchestrator`; never mark the global workflow COMPLETE yourself.

# TDD Build Strategy

## Workflow preflight

The orchestrator's context compiler only loads this skill when the run's current stage authorizes the build stage — there is no separate legacy state file to check. If you believe you were invoked out of order regardless, return `BLOCKED`; do not bypass the orchestrator.

## The Iron Law

```
NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST
```

Write code before the test? Delete it. Start over fresh from tests. No keeping it as "reference", no adapting it while writing tests. Delete means delete.

Do not keep the unverified code as reference. Do not adapt it while writing the
test. Do not look at it. **Delete means delete** — implement fresh from tests.

## The RED-GREEN-REFACTOR Cycle

```
RED: Write minimal failing test showing expected behavior
 ↓
VERIFY RED: Run test suite. Confirm it FAILS meaningfully (not syntax/setup error)
  If the test passes immediately, you are testing existing behaviour or the test is tautological. Fix the test.
 ↓
GREEN: Write the simplest minimal production code to pass
  Do not write speculative code, premature abstractions, or extra unrequested features.
 ↓
VERIFY GREEN: Run test suite. Confirm ALL tests PASS with pristine output
 ↓
REFACTOR: Clean up duplication, improve naming, ensure domain boundaries
 ↓
VERIFY REFACTOR: Confirm all tests STAY green. Do not add new behavior during refactor
```

## Rationalization Prevention

| Excuse / Rationalization | Reality |
|---|---|
| "This is too simple to need a test" | Simple code breaks too. "Simple" tasks with unexamined assumptions cause the most regressions. |
| "I'll write tests after to verify it works" | Tests written after code pass immediately, proving nothing. Test-first proves the test can actually catch bugs. |
| "Deleting my code is wasteful" | Sunk cost fallacy. Code written without failing tests is untrusted technical debt. Delete and rewrite test-first. |
| "I tested it manually" | Manual tests cannot be re-run automatically or in CI. Evidence requires repeatable automated tests. |
| "TDD is dogmatic, pragmatism means skipping it" | Pragmatism means catching bugs before commit, not debugging in production. Shortcuts are slower. |

For one bounded behavior slice:

1. identify the acceptance criterion/invariant;
2. add/update a test that fails for the missing/incorrect behavior;
3. confirm the failure is meaningful rather than broken setup;
4. implement the smallest clean production change that makes it pass within architectural boundaries. NEVER apply patch-to-pass shortcuts: do not widen types, duplicate enum semantics (e.g., adding BOY+MALE, GIRL+FEMALE to an enum), or corrupt domain models to satisfy disparate test inputs;
5. refactor while keeping tests green: eliminate duplication, enforce single source of truth, ensure external inputs are normalized at system boundaries (DTO/adapter) rather than polluting domain types, and remove any band-aid fixes;
6. run focused checks and perform a scope/diff self-check;
7. return the slice to `testing-verification` for final required evidence.

### Testing Anti-Patterns to Avoid

- **Testing Mocks Instead of Behavior**: Asserting that a mock function was called $N$ times instead of checking real business output or state transitions. Use real dependencies whenever possible; mock only external networks, hardware, third parties.
- **Bloated Multi-Assertion Tests**: Tests with "and" in the name testing multiple disjoint behaviors at once. Break them down: one test, one behavior.
- **Mutating Tests to Make Code Green**: When a test fails during the GREEN phase, modifying the test's assertions to fit flawed code instead of fixing the implementation.
- **Flaky Condition Waiting**: Using arbitrary `sleep(1000)` instead of condition-based polling or event-based assertions.

### Domain Integrity & Anti-Patching in TDD
When a test introduces or requires varied input formats (e.g., `'male'` vs `'boy'`), solve it by adding a boundary transformer/normalizer (anti-corruption layer in DTO/Controller) or clarifying the canonical contract. Never inflate a domain enum or entity with synonymous values or loose types just to turn a test green.

For risky legacy behavior, establish a characterization/integration test first. If test-first is genuinely infeasible, do not fabricate a red-green cycle; return a reason so the orchestrator can use the direct build path described in `task-execution.md`.

This skill **includes implementation for the selected slice**. Do not invoke `implementation` afterward unless a distinct remaining task explicitly requires the direct strategy.
