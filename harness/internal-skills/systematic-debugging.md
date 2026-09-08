# Workflow Module: systematic-debugging

> Internal orchestrator module. This is not a public Agent Skill and must not be independently discovered or invoked by the host. Load it only when the canonical workflow state selects this module. Return control to `sdlc-orchestrator`; never mark the global workflow COMPLETE yourself.

# Systematic Debugging

## Workflow preflight

The orchestrator's context compiler only loads this skill when the run's current stage authorizes it — there is no separate legacy state file to check. If you believe you were invoked out of order regardless, return `BLOCKED` with the required next logical skill rather than proceeding. Load only the artifacts required for this step.


## The Iron Law

```
NO FIXES WITHOUT ROOT CAUSE INVESTIGATION FIRST
```

If you have not completed Phase 1 (Root Cause Investigation), you are strictly forbidden from proposing or applying fixes. Random patching wastes time, masks underlying flaws, and introduces compounding regressions.

## The 4-Phase Systematic Debugging Process

```
1. REPRODUCE & TRACE ROOT CAUSE: Inspect stack trace, add boundary logging, trace backward to original trigger.
 ↓
2. PATTERN ANALYSIS: Compare with working examples, identify exact differences and dependencies.
 ↓
3. FORM & ISOLATE HYPOTHESIS: State one clear hypothesis. Test one variable at a time with minimal changes.
 ↓
4. TARGETED FIX & DEFENSE-IN-DEPTH: Write failing test (RED), apply minimal fix at source, add boundary defenses, verify GREEN.
```

### Phase 1: Root Cause Investigation
- **Read Error Messages Completely**: Do not skim stack traces or warnings. Note line numbers, error codes, and exact call sites.
- **Reproduce Consistently & Minimize**: Establish the smallest reproducible test case.
- **Inspect Recent Changes**: Check `git diff`, recent commits, environment or dependency changes.
- **Multi-Component Diagnostic Instrumentation**: When an issue spans multiple boundaries (e.g. CLI → runtime → git/subprocess or API → DTO → handler):
  - Log what data enters and exits each component boundary.
  - Verify environment variables and configuration propagation.
  - Determine exactly WHICH layer fails before touching code.
- **Backward Root-Cause Tracing**:
  - When an error appears deep in the call stack (e.g. `git init` in wrong directory or `undefined` property access), do NOT patch where the error manifests.
  - Ask: *What called this with invalid data?* Trace backward level by level until you find where the invalid value originated. Fix at the source.

### Phase 2: Pattern Analysis
- **Locate Working Examples**: Find similar functioning code or tests within the same codebase.
- **Identify Differences**: Compare broken vs working implementations line-by-line. Do not assume "that difference cannot matter."

### Phase 3: Hypothesis & Minimal Testing
- **Form Single Hypothesis**: State explicitly: *"I hypothesize X is the root cause because Y."*
- **Test Minimally**: Make the smallest single-variable change to test the hypothesis.
- **Never Pile Fixes**: If a hypothesis fails, revert the speculative edit before testing a new hypothesis.

### Phase 4: Implementation & Defense-in-Depth
- **Create Failing Test First**: Write an automated test reproducing the exact failure before touching production code.
- **Fix Root Cause at Source**: Apply minimal change at the architectural boundary.
- **Defense-in-Depth**: Add input validation/assertions at every layer between the original trigger and the failure point.
- **Condition-Based Waiting**: NEVER use arbitrary sleeps (`sleep 1000`, `setTimeout(..., 1000)`) in tests or debug scripts. Use event-driven waiting or condition polling to prevent flakiness and slow execution.

## The Anti-Thrashing Rule (Quy tắc 3 lần)

Track how many fix attempts have been made for the issue:
- **Attempts 1–2 Failed**: STOP. Return to Phase 1. Re-gather evidence and form a new hypothesis.
- **Attempt 3 Failed**: **HARD STOP. QUESTION THE ARCHITECTURE.**
  - If 3 fixes have failed or each fix reveals new problems in different places, this is NOT a normal bug; it is an **Architectural Failure** or a fundamentally broken pattern.
  - DO NOT attempt Fix #4.
  - Immediately escalate to `DESIGN_INVALIDATED` or halt to consult with the human partner before touching further code.

## Rationalization Prevention

| Excuse / Rationalization | Reality |
|---|---|
| "Let me try changing this to see if it works" | Guess-and-check creates compounding bugs. Form an explicit hypothesis first. |
| "I'll change 3 things at once to be safe" | Test ONE variable at a time. Confounding edits obscure what actually solved the issue. |
| "It's an edge case, probably won't happen again" | If it failed once, it will fail again. Identify root cause and capture it with a test. |
| "I can fix this by loosening domain types/enums" | Domain degradation is forbidden. Normalize bad inputs at boundary DTOs/adapters. |
| "I don't need a regression test for a simple fix" | Without an automated regression test, this bug will silently re-emerge in future refactors. |
| "Quick fix for now, investigate later" | Emergency or rushing guarantees rework. Systematic debugging is faster than guess thrashing. |
| "Just one more fix attempt (after 2+ failures)" | 3 failures = architectural breakdown. Stop thrashing and question the fundamentals. |

Avoid random patching or repeated speculative edits. Specifically avoid domain degradation (e.g., adding synonymous enum values or loosening types to satisfy unexpected test inputs); resolve mismatches by normalizing data at system boundaries (DTOs/adapters) or updating invalid test expectations.
