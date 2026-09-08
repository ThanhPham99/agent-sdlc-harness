# Workflow Module: task-execution

> Internal orchestrator module. This is not a public Agent Skill and must not be independently discovered or invoked by the host. Load it only when the canonical workflow state selects this module. Return control to `sdlc-orchestrator`; never mark the global workflow COMPLETE yourself.

<SUBAGENT-STOP>
If you were dispatched as a subagent to execute a specific task, execute ONLY your assigned task slice within your declared write_scope. Do not re-bootstrap the outer SDLC orchestrator or attempt to transition the global workflow.
</SUBAGENT-STOP>

# Task Execution

`IMPLEMENT` no longer means "write the code". It means **execute a persistent task graph until every required node is DONE**.

## Narration Constraint

Between tool calls, narrate at most one short line — the ledger and tool results carry the record. Never output verbose conversational paragraphs between CLI invocations; preserve orchestrator context for long runs.

## Pre-Flight Plan Review

Before dispatching Task 1, scan the materialized plan once for conflicts:
- Tasks contradicting each other or violating global architecture constraints.
- Requirements in the plan that review rubrics would reject as defects.
Batch any discoveries into one single clarification before execution begins, rather than interrupting mid-execution per discovery.

## The loop

```
bin/agent-sdlc task materialize --run-id <id> --file task-plan.json   # once, from the validated plan
bin/agent-sdlc task refresh     --run-id <id>                         # promote CREATED -> READY
bin/agent-sdlc task schedule    --run-id <id>                         # what may run now, and why the rest may not
bin/agent-sdlc task start       --run-id <id> --task-id TASK-00X --writer <id>
#   ... the writer changes only what the task's write scope allows ...
bin/agent-sdlc task advance     --run-id <id> --task-id TASK-00X \
    [--spec-review spec.json] [--quality-review quality.json]
bin/agent-sdlc task implementation-complete --run-id <id>
```

`task start` binds exactly one primary writer, compiles the bounded context, creates the single workspace and returns the prompt. `task advance` walks verify → spec review → quality review → DONE, and applies recovery instead of advancing whenever a step does not pass.

## What you must not do

- Do not transition the outer run from inside a task. Return the structured result; the engine and the orchestrator own state.
- Do not write outside the task's declared `write_scope`. The verification scope audit will catch it, and it is classified as `SCOPE_EXPANSION` — a planning event that re-enters `PLAN`, not a retry.
- Do not declare a task DONE. `DONE` requires verification evidence bound to the current attempt and diff, a clean spec compliance review, and a clean code quality review.
- Do not retry an identical attempt. A retry needs new concrete evidence, changed context, a changed plan, a changed implementation, or an explicit recovery decision; the engine refuses the rest.
- Do not claim independent review you did not get. Record the limitation instead — an `achieved: true` claim whose mode is `SAME_CONTEXT` is rejected.

## Reviews are two separate questions

**Spec compliance** (`agent-sdlc/spec-compliance-review/v1`): did this implement exactly the task goal, acceptance criteria, design decisions and scope? Every acceptance criterion the task owns must appear in `acceptance_criteria_checked`. Findings need concrete evidence — `file:line`, a symbol, a test name.

**Code quality** (`agent-sdlc/code-quality-review/v1`): given the accepted specification, is this safe and maintainable? A `BLOCKING` correctness finding needs a `failure_scenario` — concrete inputs or state leading to the wrong outcome. Without one it is a guess, and the validator rejects it.

Run the quality pass only after spec compliance is clean, so it never re-argues what the task was for.

The quality gate is not your verdict alone. Before it accepts the review, the engine lints the task's changed files against the coding-standards policy and merges the violations in as findings with `file:line` evidence. A `BLOCKING` violation overrides an `ACCEPTED` verdict to `CHANGES_REQUIRED` — so review what the linter cannot prove (design, safety, error paths, resource handling) rather than re-checking `var`, `any`, parameter counts and filenames by eye.

Every quality review carries a `standards_audit` block saying whether that audit ran (`RAN`, `DISABLED`, `NO_LINTABLE_FILES`, `SKIPPED`, `ERROR`), over how many files, and under which policy. Read it before trusting an empty finding list: a diff nobody could lint is not a compliant diff. A project chooses its own policy — or opts out — through `coding_standards` in `.agent-sdlc/project.json`; if it did, that is its decision to make and not a gap for you to work around.

Neither review may be a formality. Under `agent-sdlc auto` each review is produced by a reviewer agent spawned as its own process against the diff, shown the specification and nothing the writer said about its own work — which is what makes `independence.achieved` true rather than claimed. The harness writes every identifier, attempt and `diff_hash` onto the returned document itself; the reviewer supplies the verdict and the findings and nothing else.

A reviewer that cannot be reached does not produce a clean review. The run falls back to marked placeholders, and `REVIEW` refuses to resolve on them until someone records real reviews with `agent-sdlc task review`.

## Parallelism

The scheduler decides, not you. It admits a second writer only when dependencies are satisfied, write and interface scopes are disjoint, no serialized boundary (migration, release, high security or data risk, destructive change) is involved, the wall-time benefit is real, and risk and budget policy permit. Every ready task it does not dispatch appears in `deferred` or `excluded` with a reason.

## When a task fails

`bin/agent-sdlc task classify --run-id <id> --task-id TASK-00X ...` maps observable signals to a failure class and the policy action. Escalations that leave the task engine — `REQUIREMENT_AMBIGUITY` to `NEEDS_CONFIRMATION`, `DESIGN_INVALIDATED` back to `DESIGN`, `SCOPE_EXPANSION` back to `PLAN` — are reported to the orchestrator, which performs them.

## Cost

Attribute usage to the task: `bin/agent-sdlc task usage-add --run-id <id> --task-id TASK-00X --input N --output N --model-calls N --tool-calls N`. The metric that matters is `bin/agent-sdlc task metrics --run-id <id>` → cost per verified DONE task, not tokens saved on a task that had to be redone.
