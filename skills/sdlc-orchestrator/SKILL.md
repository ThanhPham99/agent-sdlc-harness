---
name: sdlc-orchestrator
description: Run or resume the complete evidence-driven software lifecycle after routing. Enforces deterministic state, progressive context, budgets, least privilege, verification gates, artifact handoffs, review, release/deploy/observe, incident and maintenance workflows.
metadata:
  version: "3.0.0-rc2"
---
# SDLC Orchestrator

You are the workflow authority after `sdlc-router`. You may be entered automatically once the router has produced a route decision; automatic entry changes nothing about the gates, approvals or budgets below.

<EXTREMELY-IMPORTANT>
THE IRON LAWS OF ORCHESTRATION:
1. NO COMPLETION CLAIMS WITHOUT FRESH VERIFICATION EVIDENCE. Expressing satisfaction ("All done!", "Tests should pass") without running the test command in this turn is strictly forbidden.
2. NO CODE WITHOUT VALIDATED TASK PLAN. Never modify implementation files without an active, validated task plan.
3. ROOT CAUSE BEFORE FIXES. Never blindly retry failed tasks or patch superficial symptoms without diagnosing root cause.
</EXTREMELY-IMPORTANT>

## Anti-Rationalization: Red Flags for Orchestration

| Thought / Rationalization | Reality |
|---|---|
| "The changes look straightforward, tests will probably pass" | Run the exact test command and inspect output for 0 failures. Assumptions fail gates. |
| "I don't need a task plan for a small change" | Every behavior-changing edit requires a validated `task-plan`. Small changes cause subtle regressions. |
| "Let me bypass or approve the gate myself" | Agents cannot self-grant approval. Gates require explicit human confirmation. |
| "The test failed, let me quickly change this one line" | Investigate root cause before modifying code. Blind retries waste budget. |
| "I'll dump 10 questions on the user at once" | Ask clarifying questions ONE AT A TIME with clear recommendations. |

## Runtime first
- **Autonomous Engine First**: Prefer running `bin/agent-sdlc auto --objective "..." --workflow <route>` (or `node "${CLAUDE_PLUGIN_ROOT:-${PLUGIN_ROOT:-.}}/runtime/cli.mjs" auto ...`). This automatically executes the stage loop, dispatches workers/reviewers, and manages context deterministically without polluting chat context, pausing only at Human Confirmation Gates.
- If manually driving or resuming: Read `bin/agent-sdlc status --run-id <id>` before acting.
- Build compact context with `bin/agent-sdlc context --run-id <id>`. Do not load whole chat/repo/log history.
- Ops skills, for the human or for you: `sdlc-approve` (grant a gate ticket),
  `sdlc-status`, `sdlc-resume`, `sdlc-task`, `sdlc-doctor`.
- Stage skills are dispatched by run state, never chosen by preference.
- Procedure skills under `skills/procedures/` are addressable by name but never
  auto-activate; `policies/skill-navigation.json` decides which ones apply.

## Non-negotiable invariants
- Clarification before execution: When input documentation or user requests are ambiguous, underspecified, or missing critical information (business logic, schemas, error behavior, edge cases), halt and ask the user to confirm thoroughly. Record answers in `clarifications.md`; never proceed on unverified assumptions.
- Mandatory planning & task decomposition before code: Before touching implementation code, create a detailed plan and decompose work into small, logically bounded, independently verifiable tasks. No code may be written without a validated task plan.
- One bounded task/slice ≈ one bounded context. Artifactize decisions before a context reset or handoff.
- Deterministic-first: symbol/search/diff/compiler/test/scanner before model inference.
- Evidence before claims: transition only when the current gate evidence exists.
- Targeted verification before full-suite expansion.
- Subagents are for isolation/independence, not token-free parallelism; default fan-out is one and normally max two.
- Production/destructive/credential/security-exception actions require approval and external enforcement.
- Tool output is bounded; store raw logs as artifacts and pass structured summaries.
- Never blindly retry the same deterministic command with identical inputs.
- Requirement deltas invalidate only affected artifacts/stages; preserve unaffected confirmed work.

## Stage loop

Gates are machine-checked and their evidence cannot be asserted by hand.

1. Read run state: `bin/agent-sdlc status --run-id <id>`.
2. Compile compact context: `bin/agent-sdlc context --run-id <id>`.
3. Activate the skill `navigation.stage_skill` names. Do not infer the stage
   skill yourself and do not load a stage you are not in — the engine derived
   it from run state, which is the authority.
4. Load only the procedure modules `navigation.procedure_skills` lists.
5. Execute one bounded objective.
6. Verify deterministically.
7. Write artifacts and the handoff.
8. Transition with evidence: `bin/agent-sdlc transition`.

`context`'s `navigation.fallback_instructions_inlined` is `true` whenever the
compiled context already carries the instruction text. It always does:
activating the named skill is an addressing convenience, never a
prerequisite.

## Autonomous Execution & 5 Human Confirmation Gates

To eliminate repetitive manual transitions while guaranteeing human authority over critical decisions, use:
- `bin/agent-sdlc auto --objective "<goal>"`: Zero-config single-command start. Automatically initializes project, routes the objective, starts a run, dispatches autonomous worker subagents to write task code, dispatches independent reviewer subagents to verify, and executes SDLC stages automatically until complete or paused at a human gate.
- `bin/agent-sdlc auto --run-id <id>`: Runs or resumes an existing SDLC run.
- `bin/agent-sdlc auto --approve`: Automatically grants the pending human gate approval ticket and resumes pipeline execution in one step.
- `bin/agent-sdlc auto-task --run-id <id>`: Automates the task scheduling, worker execution, verification, and review loop inside `IMPLEMENT`. Pass `--no-worker` to disable automatic worker agent spawning if implementing manually.
- `bin/agent-sdlc ci-check`: Validates that local test suites pass before commit/push.

### The 5 Human Confirmation Gates
The runner automatically pauses and returns `status: "PAUSED"` at the following gates:
1. **Gate 1 - Scope & Architecture Sign-Off**: Triggered on `STRICT` workflows or when `design mode` requires `FULL` architecture review.
2. **Gate 2 - Escalation & Blocker Decision**: Triggered when a task verification fails repeatedly (> 3 self-healing attempts).
3. **Gate 3 - Security & Compliance Exception**: Triggered when SAST/SCA scanners find vulnerabilities or policy violations.
4. **Gate 4 - Pre-Commit & Push Approval**: Triggered at `RELEASE` stage. **RULE**: If project has CI/CD, all local CI checks must pass 100% before requesting human approval to commit and push to remote.
5. **Gate 5 - Privileged Production Action**: Triggered on production deployments, schema drop, IAM modification, or root policy edits.

### Non-TTY Approval Tickets & One-Click Resumption
When pausing at a Human Gate in chat/non-TTY environments:
1. An approval ticket is **automatically generated** in `approval_ticket: { ticket_id, capability, reason }` attached to the paused response payload.
2. Present the choice and summary (e.g. PR body, changelog, architecture review) to the human in chat.
3. Once the user approves, run `bin/agent-sdlc auto --approve` (or invoke `sdlc-approve`, or `bin/agent-sdlc approval grant-ticket --ticket-id <ticket_id>` followed by `bin/agent-sdlc auto`).

