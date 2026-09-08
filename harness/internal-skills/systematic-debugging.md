# Workflow Module: systematic-debugging

> Internal orchestrator module. This is not a public Agent Skill and must not be independently discovered or invoked by the host. Load it only when the canonical workflow state selects this module. Return control to `sdlc-orchestrator`; never mark the global workflow COMPLETE yourself.

# Systematic Debugging

## Workflow preflight

The orchestrator's context compiler only loads this skill when the run's current stage authorizes it — there is no separate legacy state file to check. If you believe you were invoked out of order regardless, return `BLOCKED` with the required next logical skill rather than proceeding. Load only the artifacts required for this step.


## The 4-Phase Systematic Debugging Process

```
1. REPRODUCE & MINIMIZE: Establish reliable reproduction evidence with the smallest reproducible case.
 ↓
2. FORM & ISOLATE HYPOTHESIS: Inspect changes, separate symptom from root cause. Test ONE hypothesis at a time.
 ↓
3. CHARACTERIZE & REGRESS: Write an automated test reproducing the failure (RED) before touching production code.
 ↓
4. TARGETED FIX & VERIFY: Apply the minimal root-cause fix at the proper boundary. Verify green without side effects.
```

## Rationalization Prevention

| Excuse / Rationalization | Reality |
|---|---|
| "Let me try changing this to see if it works" | Guess-and-check creates compounding bugs. Form an explicit hypothesis first. |
| "I'll change 3 things at once to be safe" | Test ONE variable at a time. Confounding edits obscure what actually solved the issue. |
| "It's an edge case, probably won't happen again" | If it failed once, it will fail again. Identify root cause and capture it with a test. |
| "I can fix this by loosening domain types/enums" | Domain degradation is forbidden. Normalize bad inputs at boundary DTOs/adapters. |
| "I don't need a regression test for a simple fix" | Without an automated regression test, this bug will silently re-emerge in future refactors. |

Reproduce or establish reliable evidence, minimize the failure, inspect recent/relevant changes, form explicit hypotheses, test one hypothesis at a time, and identify root cause before choosing a fix.

Separate symptom, trigger, root cause, and contributing factors. Add regression evidence before/with the fix whenever feasible. Avoid random patching or repeated speculative edits. Specifically avoid domain degradation (e.g., adding synonymous enum values or loosening types to satisfy unexpected test inputs); resolve mismatches by normalizing data at system boundaries (DTOs/adapters) or updating invalid test expectations.
