# Workflow Module: task-execution

> Internal orchestrator module. This is not a public Agent Skill and must not be independently discovered or invoked by the host. Load it only when the canonical workflow state selects this module. Return control to `sdlc-orchestrator`; never mark the global workflow COMPLETE yourself.

# Task Execution

`IMPLEMENT` no longer means "write the code". It means **execute a persistent task graph until every required node is DONE**.

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

## Parallelism

The scheduler decides, not you. It admits a second writer only when dependencies are satisfied, write and interface scopes are disjoint, no serialized boundary (migration, release, high security or data risk, destructive change) is involved, the wall-time benefit is real, and risk and budget policy permit. Every ready task it does not dispatch appears in `deferred` or `excluded` with a reason.

## When a task fails

`bin/agent-sdlc task classify --run-id <id> --task-id TASK-00X ...` maps observable signals to a failure class and the policy action. Escalations that leave the task engine — `REQUIREMENT_AMBIGUITY` to `NEEDS_CONFIRMATION`, `DESIGN_INVALIDATED` back to `DESIGN`, `SCOPE_EXPANSION` back to `PLAN` — are reported to the orchestrator, which performs them.

## Cost

Attribute usage to the task: `bin/agent-sdlc task usage-add --run-id <id> --task-id TASK-00X --input N --output N --model-calls N --tool-calls N`. The metric that matters is `bin/agent-sdlc task metrics --run-id <id>` → cost per verified DONE task, not tokens saved on a task that had to be redone.
