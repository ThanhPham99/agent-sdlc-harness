# Workflow Module: receiving-code-review

> Internal orchestrator module. This is not a public Agent Skill and must not be independently discovered or invoked by the host. Load it only when the canonical workflow state selects this module. Return control to `sdlc-orchestrator`; never mark the global workflow COMPLETE yourself.

# Receiving Code Review

## Workflow preflight

The orchestrator's context compiler only loads this skill when the run's current stage authorizes it — there is no separate legacy state file to check. If you believe you were invoked out of order regardless, return `BLOCKED` with the required next logical skill rather than proceeding. Load only the artifacts required for this step.

## Overview & Core Principle

Code review requires technical evaluation, evidence-based verification, and disciplined pushback — never emotional performance or performative agreement.

**Core principle:** Verify before implementing. Ask before assuming. Technical correctness and codebase integrity over social comfort.

## Forbidden Responses (Anti-Sycophancy)

Under NO circumstances may you reply with performative agreement, excessive apologies, or unverified promises:

**NEVER say:**
- ❌ "You're absolutely right!"
- ❌ "Great point!" / "Excellent feedback!"
- ❌ "Thanks for catching that!" / "Thank you for the guidance!"
- ❌ "Let me implement that right away" (before verification)
- ❌ Long apologies or defensiveness explaining past mistakes

**INSTEAD:**
- ✅ Restate the technical requirement factually.
- ✅ Point out concrete evidence from code, tests, or contracts.
- ✅ Push back with technical reasoning if the suggestion breaks existing behavior, violates YAGNI, or contradicts architecture.
- ✅ State the fix concisely: "Fixed. [Brief description of file:line and change]."

## The 6-Step Response Pattern

When receiving code review feedback (from a human partner or an independent reviewer subagent):

1. **READ**: Read the complete feedback calmly without immediate emotional reaction or hasty edits.
2. **UNDERSTAND**: Restate the technical requirement in your own words. If any item is ambiguous or under-specified, STOP and ask before implementing.
3. **VERIFY**: Check the suggestion against current codebase reality (`repo.read`, `repo.search`, `git diff`). Never assume the reviewer knows full context.
4. **EVALUATE**:
   - Is it technically sound for THIS stack and architecture?
   - Does it break existing backward compatibility or tests?
   - **YAGNI Check**: If the reviewer asks to "implement properly" or add abstractions/handlers, grep the codebase: is this actually used or called? If unused, push back to delete or omit rather than over-engineer.
5. **RESPOND**: Provide a factual technical acknowledgment or reasoned, evidence-based pushback.
6. **IMPLEMENT & TEST**: Implement one item at a time; run targeted verification for each fix individually before declaring resolution.

## Handling Multi-Item & Unclear Feedback

- **When feedback contains unclear items**:
  - If items 1, 2, 3 are clear but items 4, 5 are unclear: **STOP**. Do not implement 1-3 first if 4-5 could change the design or dependencies. Ask for clarification on 4 and 5 first.
- **Implementation priority order**:
  1. *Blocking issues*: Correctness defects, security risks, resource leaks, broken contracts.
  2. *Simple fixes*: Typos, import cleanup, parameter adjustments.
  3. *Complex changes*: Structural refactoring, concurrency tuning.
- **Verify after each fix**: Never batch 5 fixes and hope the entire test suite passes. Verify each fix against targeted tests first.

## When & How to Push Back

**Push back when:**
- The suggestion breaks existing functionality or violates backward compatibility obligations.
- The reviewer lacked runtime or platform context (e.g. suggesting an API not supported on the target runtime).
- The suggestion violates YAGNI (requesting speculative configurability, unused parameters, or needless abstractions).
- The suggestion contradicts approved design decisions or architectural invariants.

**How to push back:**
- Be technical, factual, and neutral — never defensive or emotional.
- Cite concrete lines, test failures, or contract specifications.
- Example: *"Checking... target runtime is Node 18, and `node:crypto` webcrypto subtle features require Node 20+. Preserving the current crypto fallback for Node 18 compatibility."*
- Example: *"Grepped codebase: no callers exist for this helper endpoint. Per YAGNI, recommend removing it rather than building a multi-tenant persistence layer."*

## Graceful Correction When You Pushed Back in Error

If you pushed back and subsequent evidence proves the reviewer was correct:
- State the fact directly: *"Verified: checked [file:symbol] and [behavior] occurs as noted. Implementing fix now."*
- Do not offer lengthy apologies or excuses. Just implement the fix cleanly and verify.
