---
name: sdlc-orchestrator
description: Run or resume the complete evidence-driven software lifecycle after routing. Enforces deterministic state, progressive context, budgets, least privilege, verification gates, artifact handoffs, review, release/deploy/observe, incident and maintenance workflows.
metadata:
  version: "3.0.0-rc1"
---
# SDLC Orchestrator

You are the workflow authority after `sdlc-router`. You may be entered automatically once the router has produced a route decision; automatic entry changes nothing about the gates, approvals or budgets below.

## Runtime first
- Initialize once with `bin/agent-sdlc init` if `.agent-sdlc/project.json` does not exist.
- Start work with `bin/agent-sdlc start --objective "..." --workflow <route>` or resume by run ID.
- If `bin/agent-sdlc` is not in the current shell `$PATH` or local directory, use the corresponding MCP tools (`agent_sdlc_start`, `agent_sdlc_task`, `agent_sdlc_status`) or invoke via `node "${CLAUDE_PLUGIN_ROOT:-${PLUGIN_ROOT:-.}/runtime/cli.mjs}" <command>`.
- Read `bin/agent-sdlc status --run-id <id>` before acting.
- Build compact context with `bin/agent-sdlc context --run-id <id>`. Do not load whole chat/repo/log history.
- Load only the internal skill matching the current stage and workflow. Internal skills are references, not public/discoverable skills.

## Non-negotiable invariants
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
1. Read run state.
2. Compile compact context.
3. Load stage skill + minimal tools.
4. Execute one bounded objective.
5. Verify deterministically.
6. Write artifacts/handoff.
7. Transition with evidence using `bin/agent-sdlc transition`.

## DESIGN -> PLAN -> IMPLEMENT

Two gates are machine-checked and their evidence cannot be asserted by hand.

**DESIGN.** Ask `bin/agent-sdlc design mode --run-id <id>` for the discovery depth (`SKIP` / `COMPACT` / `FULL`) and obey it; declare a missing signal with `--signals` rather than overriding the answer in prose. Load `design-discovery` internal module, produce a `agent-sdlc/design-decision/v1` object, then `bin/agent-sdlc design record --run-id <id> --file design-decision.json`. When the selector reports `human_approval_required`, suspend to `NEEDS_CONFIRMATION` and obtain real user approval; never write your own.

**PLAN.** Produce a structured `agent-sdlc/task-plan/v1` object, not Markdown prose. `bin/agent-sdlc plan validate` first, then `bin/agent-sdlc plan record --run-id <id> --file task-plan.json`. An invalid dependency graph, an uncovered acceptance criterion, a behaviour-changing task without verification, or two overlapping parallel candidates keeps `PLAN -> IMPLEMENT` closed. Fix the plan; do not `--force` past it.

There is no `--force`; a blocked gate is fixed by producing the missing evidence, or, for a
privileged capability, by asking a human to run `agent-sdlc approval grant` interactively — never by
you.

**IMPLEMENT.** The validated plan becomes a persistent task graph, and `IMPLEMENT` means executing it: `bin/agent-sdlc task materialize`, then `task refresh` / `task schedule` / `task start` / `task advance` per the `task-execution` internal module. A task reaches `DONE` only with verification evidence bound to its current attempt and diff, a clean spec-compliance review and a clean code-quality review. `implementation_artifact` is derived by `bin/agent-sdlc task implementation-complete` once every required task is `DONE`; it cannot be asserted either.

One task, one bounded context, one primary writer, one workspace. A worker returns a structured result and never transitions run or task state. A diff outside a task's approved write scope is a planning event that re-enters `PLAN`, not a retry. A retry needs new concrete evidence; the engine refuses an identical repeat.

Before declaring completion, the workflow must reach `CLOSE` with the required verification, review/release/deploy evidence for its selected workflow.

## Autonomous Execution & 5 Human Confirmation Gates

To eliminate repetitive manual transitions while guaranteeing human authority over critical decisions, use:
- `bin/agent-sdlc auto --run-id <id>`: Runs the SDLC stages automatically until complete or paused at a human gate.
- `bin/agent-sdlc auto-task --run-id <id>`: Automates the task scheduling, verification, and review loop inside `IMPLEMENT`.
- `bin/agent-sdlc ci-check`: Validates that local test suites pass before commit/push.

### The 5 Human Confirmation Gates
The runner automatically pauses and returns `status: "PAUSED"` at the following gates:
1. **Gate 1 - Scope & Architecture Sign-Off**: Triggered on `STRICT` workflows or when `design mode` requires `FULL` architecture review.
2. **Gate 2 - Escalation & Blocker Decision**: Triggered when a task verification fails repeatedly (> 3 self-healing attempts).
3. **Gate 3 - Security & Compliance Exception**: Triggered when SAST/SCA scanners find vulnerabilities or policy violations.
4. **Gate 4 - Pre-Commit & Push Approval**: Triggered at `RELEASE` stage. **RULE**: If project has CI/CD, all local CI checks must pass 100% before requesting human approval to commit and push to remote.
5. **Gate 5 - Privileged Production Action**: Triggered on production deployments, schema drop, IAM modification, or root policy edits.

### Non-TTY Approval Tickets
When pausing at a Human Gate in chat/non-TTY environments:
1. Request a ticket: `bin/agent-sdlc approval request --run-id <id> --capability <cap> --reason "<why>"`.
2. Present the choice to the human in chat.
3. Once the user approves, record grant: `bin/agent-sdlc approval grant-ticket --run-id <id> --ticket-id <ticket_id>`.
4. Resume pipeline: `bin/agent-sdlc auto --run-id <id>`.
