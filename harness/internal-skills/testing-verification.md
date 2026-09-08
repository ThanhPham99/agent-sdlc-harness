# Workflow Module: testing-verification

> Internal orchestrator module. This is not a public Agent Skill and must not be independently discovered or invoked by the host. Load it only when the canonical workflow state selects this module. Return control to `sdlc-orchestrator`; never mark the global workflow COMPLETE yourself.

# Testing & Verification

## Workflow preflight

The orchestrator's context compiler only loads this skill when the run's current stage authorizes it — there is no separate legacy state file to check. If you believe you were invoked out of order regardless, return `BLOCKED` with the required next logical skill rather than proceeding. Load only the artifacts required for this step.


## The Iron Law

```
NO COMPLETION CLAIMS WITHOUT FRESH VERIFICATION EVIDENCE
```

If you have not run the verification command in this turn, you cannot claim it passes. Any wording implying success ("should work", "probably", "looks good", "perfect") before fresh execution evidence is captured is strictly prohibited.

## The Gate Function

```
BEFORE claiming any status or expressing satisfaction:

1. IDENTIFY: What command proves this claim?
2. RUN: Execute the FULL command (fresh, complete)
3. READ: Read full output, check exit code, count failures
4. VERIFY: Does output explicitly confirm the claim?
   - If NO: State actual failure status with evidence.
   - If YES: State claim WITH verifiable evidence.
5. ONLY THEN: Make the completion claim.
```

## Rationalization Prevention

| Excuse / Rationalization | Reality |
|---|---|
| "Should work now" / "Probably passing" | RUN the verification command. Speculation is not evidence. |
| "I'm confident in this change" | Confidence $\neq$ Evidence. An exit code of 0 with 0 failures is evidence. |
| "Linter passed" | Linter $\neq$ Test suite / Compiler. Passing linter proves nothing about runtime behavior. |
| "I tested it before that small tweak" | ANY edit after a test run invalidates previous evidence. Re-run fresh. |
| "Subagent reported success" | Never trust claims. Inspect the diff and run the verification suite yourself. |
| "Partial check is enough" | Partial checks prove nothing about regression across the integrated tree. |
| "Looks identical to working pattern" | Syntactic similarity $\neq$ Semantic equivalence. Small environment/import differences cause bugs. |
| "It's just a one-line comment or typo fix" | Trivial edits have caused syntax breaks and broken builds. Verify every change. |
| "Different wording so rule doesn't apply" | Spirit over letter. ANY communication implying success without fresh verification is forbidden. |

## Common Verification Failures

| Claim | Requires | Not Sufficient |
|---|---|---|
| Tests pass | Test command output: exit 0, 0 failures | Previous run, "should pass", partial log |
| Linter clean | Linter output: 0 errors, 0 warnings | Partial check, extrapolation |
| Build succeeds | Build command: exit 0 | Linter passing, code looks clean |
| Bug fixed | Test reproducing original symptom passes | Code changed, assumed fixed |
| Regression test works | Red-green cycle verified (fails without fix, passes with fix) | Test passes once |
| Subagent completed | VCS diff verified + fresh test suite output | Subagent reporting "success" |
| Requirements met | Line-by-line acceptance criteria checklist verified | Tests passing alone |

Every task verified its own diff in its own workspace during `IMPLEMENT`; those workspaces have since been merged. This stage verifies the merge, which is where the regressions that no single task could see actually live — so a suite has to run here, over the integrated tree, and the gate token comes from that run rather than from a claim. If no test command is configured, say so and let the orchestrator decide; a missing suite is not a pass.

Create/update `test-plan.md` as needed, then execute the smallest sufficient verification set plus required regression coverage. Consider unit, integration, contract, migration, security, performance, build/lint/static checks, and manual validation only when relevant.

Update `verification.md` with acceptance-criterion traceability, actual checks run, results, gaps, and blockers. A claimed check without execution evidence is not a pass. If a required environment/check is unavailable, record it explicitly and let the orchestrator decide whether completion is blocked.


For STANDARD/STRICT product/change workflows, create/update `traceability.md` from the canonical template. Before returning DONE, verify every confirmed in-scope acceptance criterion has a design/implementation reference and executed evidence, or report a gap/authorized exception. Do not let G6 pass on narrative claims alone.

## Testing anti-patterns to reject

| Anti-pattern | Why it fails | Instead |
|---|---|---|
| **Testing mocks** | Asserts a mock configuration, not system behaviour. | Test real domain classes and interfaces with real inputs. |
| **Tautological assertions** | Passes by definition (`expect(true).toBe(true)`, asserting a mocked return). | Assert actual state changes, return values, or store side-effects. |
| **Testing private internals** | Binds the test to a private helper or internal variable. | Test only through public contracts. |
| **Assertionless tests** | Calls a function and asserts nothing. | Every test verifies a concrete invariant or post-condition. |
| **Giant monolithic tests** | One case asserting fifteen unrelated behaviours. | One test, one behaviour. |
| **Broad try/catch in tests** | Swallows the exception that should have failed the run. | Let it bubble, or assert `toThrow()`. |
