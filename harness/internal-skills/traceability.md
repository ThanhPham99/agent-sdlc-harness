# Workflow Module: traceability

> Internal orchestrator module. This is not a public Agent Skill and must not be independently discovered or invoked by the host. Load it only when the canonical workflow state selects this module. Return control to `sdlc-orchestrator`; never mark the global workflow COMPLETE yourself.

# Traceability and Invalidation

```
bin/agent-sdlc trace build     --run-id <id> [--design design-decision.json]
bin/agent-sdlc trace validate  --run-id <id>
bin/agent-sdlc trace coverage  --run-id <id>
bin/agent-sdlc trace closure   --run-id <id> --node <NODE> --delta <CLASS>
bin/agent-sdlc trace invalidate --run-id <id> --node <NODE> --delta <CLASS> [--dry-run]
bin/agent-sdlc trace history   --run-id <id>
```

The graph is built from durable state — the task graph, task records and recorded artifacts. Nothing in it is inferred from prose, and it stores IDs, refs and hashes rather than content.

## Coverage is an edge, not a claim

`trace coverage` answers whether each acceptance criterion is implemented, verified and evidenced *by a real edge*. An artifact that says "AC-003 is covered" with no `implemented_by` edge is reported as uncovered. That is the point.

It also reports `interfaces_without_compatibility_verification`. A task that declares `interface_scope` and has no test linked to it is an unverified contract change, regardless of what the review said.

## Invalidation is precise on purpose

Classify the delta before propagating it:

| Delta class | Propagates to |
|---|---|
| `WORDING_ONLY` | nothing |
| `DOCUMENTATION_ONLY` | documentation nodes only |
| `BEHAVIOR_CHANGE` | design, tasks, tests, evidence, reviews, build/release/deployment |
| `DESIGN_CHANGE` | implementing tasks and their verification chain |
| `INTERFACE_CHANGE` | consumers and compatibility tests, **even when the code still compiles** |
| `DATA_CHANGE` | affected entities, tasks and their verification chain |
| `SCOPE_REMOVAL` | tasks, tests, evidence, reviews |

Rewording a requirement must not throw away working implementation. Only declared edge kinds are traversed, so unrelated work stays valid by construction, and every affected node carries the graph path that justified including it.

Each applied invalidation is appended to a replayable log with its reason, the affected closure, the preserved count and the earliest outer gate to re-enter. Use `--dry-run` first and read the closure before applying it.

## What this module must not do

- Do not invalidate broadly "to be safe". An over-wide closure discards verified work and costs a re-run.
- Do not mark a node valid again by hand. Validity returns when the upstream artifact is refreshed and the graph is rebuilt.
- Do not use the graph to claim a release is ready. That claim needs revision-bound CI and delivery evidence (`bin/agent-sdlc ci status`, `bin/agent-sdlc delivery record`).
