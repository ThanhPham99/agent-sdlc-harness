# Migration and Versioning

Canonical runtime state uses schema `agent-sdlc/state/v1` and run records use `agent-sdlc/run/v1`. Provider-specific session/thread identifiers are optional metadata; the canonical `run_id` belongs to the harness.

Use:

```bash
./bin/agent-sdlc compat-check
./bin/agent-sdlc migrate
```

The alpha migration command only performs conversions that are explicitly lossless. Legacy `.ai-workflow` state is detected but not silently rewritten because earlier workflow semantics and evidence fields may differ. For an incompatible project, export durable artifacts/handoffs, initialize v3, and attach those artifacts to the new run.

Protocol, schema, policy, skill and provider package versions are independently traceable in replay/evidence. Breaking canonical schema changes require a major harness version; additive fields should remain backward-readable whenever feasible.

## alpha4 -> alpha5 (task runtime)

Run state (`agent-sdlc/run/v1`) is unchanged; task schemas begin at v1 and are additive.

Existing runs keep working. To give a run the alpha5 task runtime:

```bash
./bin/agent-sdlc task migrate --run-id <id> --dry-run
./bin/agent-sdlc task migrate --run-id <id>
```

The migration reads the run's recorded `task-plan` artifact and materializes a task graph
plus one `CREATED` task record per planned task. It:

- preserves the original plan artifact ref and SHA-256;
- generates stable task IDs only where absent, never rewriting an existing one;
- never marks a generated task DONE;
- marks a run already past `IMPLEMENT` as `LEGACY_STAGE_EVIDENCE` instead of fabricating
  per-task evidence for work that ran stage-level;
- backs up `.agent-sdlc/tasks/<run_id>/` before mutation;
- fails closed on an unknown newer plan schema;
- reports `SKIPPED` when a graph and task records already exist.

A run with no recorded plan artifact reports `NO_PLAN_ARTIFACT` and is left untouched.

Note that `IMPLEMENT.gate_requirements` changed to `implementation_artifact` +
`task_graph_complete`, both derived by `task implementation-complete`. A run already past
`IMPLEMENT` is unaffected; a run sitting *in* `IMPLEMENT` needs either a migrated task
graph or an audited `--force`.

## alpha5 -> alpha6 (intelligence, traceability, delivery)

Purely additive. No run, task or plan schema changed, and no existing gate requirement moved.

New state directories, all created on demand:

```
.agent-sdlc/index/                  repository index (safe to delete; rebuilt on demand)
.agent-sdlc/traceability/           traceability graphs and the invalidation log
.agent-sdlc/delivery/               delivery records
.agent-sdlc/ci-evidence/            revision-bound CI records
evals/regressions/candidates/       regression candidates (never auto-adopted)
```

Nothing needs migrating. To adopt the new capabilities on an existing run:

```bash
./bin/agent-sdlc repo index                 # build the index once
./bin/agent-sdlc trace build --run-id <id>   # build the graph from durable state
./bin/agent-sdlc trace coverage --run-id <id>
```

`.agent-sdlc/index/` is a cache. Deleting it costs one rebuild and nothing else. If
`repo status` reports `stale`, rebuild before relying on an answer.

Two additions change behaviour you may notice:

- Task contexts now include a `REPOSITORY FACTS` block for the task's declared scope. It is
  bounded and anchored to that scope; when the index is unavailable the manifest records
  `unavailable` with a reason instead of failing.
- `runtime/parallel.mjs` uses prefix-aware scope overlap (shared with the task scheduler).
  A task list declaring `src/auth/` and `src/auth/reset.js` is now correctly reported as
  conflicting. File-level lists behave as before.
