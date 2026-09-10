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
| "I don't need a task plan for a small change" | Every behavior-changing edit requires a validated `task-plan` or approved Bounded in-chat design. |
| "Let me bypass or approve the gate myself" | Agents cannot self-grant approval. Gates require explicit human confirmation. |
| "The test failed, let me quickly change this one line" | Investigate root cause before modifying code. Blind retries waste budget. |
| "I'll dump 10 questions on the user at once" | Ask clarifying questions ONE AT A TIME with clear recommendations. |
| "I should pause to ask user about naming or a minor ambiguity" | Rulings, not stalls. Decide it, ledger the ruling (`Ruling: <decision> — <why> — <cost if wrong>`), and keep moving. |
| "Task 1 finished, should I ask if I should continue to Task 2?" | Continuous execution: do not pause to ask. Execute all plan tasks until complete or hitting a Hard Stop. |
| "Memory compacted, let me restart from Task 1" | Never re-dispatch completed tasks. Read the progress ledger and resume at the first incomplete task. |

## Execution Momentum: Rulings, Not Stalls

A running plan does not wait on a human for minor implementation details. Conflicts, minor ambiguities, minor plan defects, or non-contractual naming choices — decide them.

- **Authority Hierarchy**: The specification is the binding authority, the plan is its operational argument, and your technical judgment settles what neither specifies.
- **The Ruling Protocol**: When encountering an ambiguous or underspecified choice that does not violate a gate, record the decision in the run decisions ledger:
  ```text
  Ruling: <what you decided> — <why> — <what it costs if wrong>
  ```
  Then keep moving immediately. A wrong ruling costs small rework that your human partner can review and adjust in the final diff; a session parked on a trivial question wastes their entire focus.

### The 4 Hard Stops

Only four conditions warrant stopping execution to request human input:
1. **Irreversible or Destructive Operation**: Database drop, permanent data deletion, force-pushing shared refs.
2. **Security or Credential Boundary**: Accessing secrets, modifying IAM/auth policies, or granting security waivers.
3. **External Side-Effect**: Operations outside the isolated workspace (git push to remote, production deployment, package publishing).
4. **Fundamentally Broken Plan**: Plan defects so severe that every conceivable path forward is pure guesswork.

For everything else: make the ruling, ledger it, and continue.

## Continuous Execution & Compaction Resilience

- **Continuous Task Execution**: Do not pause between individual tasks to ask "Should I continue?" or output lengthy conversational summaries. Execute all tasks in sequence until complete or paused by one of the 4 Hard Stops or a Human Gate.
- **Compaction Resilience**: Conversation memory in LLM sessions does not survive context compaction. Track progress in the run ledger artifact (`.agent-sdlc/runs/<id>/progress.md` or task state).
- **Resume Rule**: If a session resumes or after compaction, inspect the ledger: tasks marked complete are DONE — never re-dispatch them. Resume directly at the first incomplete task or active fix round.

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
- `bin/agent-sdlc auto-task --run-id <id>`: Automates the task scheduling, worker execution, verification, and review loop inside `IMPLEMENT`. Pass `--no-worker` when implementing tasks manually; the runner will set the ready task to `RUNNING`, prepare its isolated workspace, and cleanly pause with `AWAITING_MANUAL_IMPLEMENTATION` (showing the workspace path) until changes are made, without exhausting retry budgets.
- `bin/agent-sdlc ci-check`: Validates that local test suites pass before commit/push.

### Monorepo & Per-Task Verification (`verification.commands`)
For polyglot monorepos (e.g. Alembic migrations, Python microservices, and React frontend apps), tasks can declare explicit verification commands and service directories in `task-plan.json`:
- `verification.commands`: Array of command argv (e.g. `[["alembic", "upgrade", "head"], ["alembic", "downgrade", "-1"]]`) or objects with explicit working directory: `[{ "command": ["npm", "test"], "cwd": "apps/learner-ui" }]`.
- If a task declares shell commands in `targeted_tests` (e.g. `"npm test"` or `"alembic upgrade head && alembic downgrade -1"`), the engine automatically detects them as commands and infers the service directory from `write_scope`.

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

