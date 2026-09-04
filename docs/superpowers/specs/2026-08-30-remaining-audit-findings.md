# Remaining Audit Findings — agent-sdlc-harness 3.0.0-rc1

Source: Comprehensive audit of all 40 remaining runtime modules across six work streams per plan `docs/superpowers/plans/2026-08-30-remaining-audit.md`.

Baseline: `npm run check` exit 0 (all 21 suites green).

---

## F1 (Medium) `listFeatures` and `listPhases` return unsorted filesystem order
- `runtime/features.mjs:54` and `runtime/features.mjs:85` read `.json` files from `features/` and `phases/` using `fs.readdirSync(dir).filter(f=>f.endsWith('.json')).map(...)` without `.sort()`.
- Filesystem directory ordering is OS- and filesystem-dependent (e.g. NTFS B-tree vs Linux ext4 hash order).
- This caused `resolveActiveFeature` candidate listings and CLI outputs (`feature list`, `feature phase-list`) to be unstable across environments.
- **Fix:** Added `.sort()` before `.map(f=>readJson(...))` in both `listFeatures` and `listPhases`, and added deterministic regression test in `evals/run-deterministic.mjs`.

## F2 (Low) Telemetry run aggregation iterates unsorted run files
- `runtime/telemetry.mjs:63` read `runsDir` using `fs.readdirSync(runsDir).filter(x=>x.endsWith('.json')).map(...)` without `.sort()`.
- The order of `taskRuns` in `metrics.tasks.per_run` varied depending on filesystem iteration order.
- **Fix:** Added `.sort()` to `fs.readdirSync(runsDir).filter(...).sort()`.

---

## Negative Results (Investigated & Verified Clean)

### Stream 1: Parallel Task Execution (No Data-Loss Surges)
1. **Read-modify-write across dispatch in `task-runner.mjs`:**
   - **Negative:** `task-runner.mjs` is fully synchronous and never calls `saveRun` or holds run records across asynchronous boundaries. Task state is persisted to individual task files (`tasks/<run_id>/<task_id>.json`) using atomic temporary-file-and-rename writes (`writeJsonAtomic`).
2. **Workspace writer binding race:**
   - **Negative:** Task IDs are unique and dispatched per scheduled decision. Atomic writes prevent partial/corrupted records, and `checkWriterIsolation` validates that no two active writable workspaces share a writer or directory root.
3. **`git worktree add` concurrency:**
   - **Negative / Honest Degradation:** Verified via real multi-process concurrency probe (8 concurrent worker processes). Independent worktrees (`<task_id>-tree`) are created without index lock collisions. On worktree creation failure, the workspace explicitly records `degraded: WORKTREE_UNAVAILABLE:<stderr>` and emits structured `task.workspace_created` events rather than silently faking isolation.
4. **Budget accounting:**
   - **Negative:** `scheduleTasks` dynamically bounds `max_parallel` by remaining model calls (`remaining_model_calls / perDispatch`). State transitions remain tied to disk persistence, ensuring unstarted or failed dispatches do not corrupt future scheduling passes.

### Stream 2: Decision Determinism (Router, Model-Router, Governor)
1. **Router determinism:**
   - `runtime/router.mjs` uses a total comparator ending in rule declaration index (`a.idx - b.idx`).
   - Ties or close scores emit `AMBIGUOUS_ROUTE` risk flag and include all matching keywords in `reason_codes`.
2. **Model-Router floor invariants:**
   - `runtime/model-router.mjs` respects `risk_floor` from policy and never downgrades `STRICT` profiles.
   - Requirement of structured output fails closed to `PENDING` with reason `no-qualified-provider-available` if unsupported by available providers.
3. **Governor determinism:**
   - `runtime/governor.mjs` calculates complexity from declared scope parameters and raises model floors (`raise(floor, ...)`). Budget limits can pause execution (`STOP_AND_REQUEST_CONFIRMATION`), compact context, or avoid fan-out, but never lower a mandatory security/risk floor.

### Stream 3: CLI Command Surface
1. **Flag integrity:**
   - All 47 commands and 12 command groups in `runtime/commands/*.mjs` were audited against `docs/USAGE.md` and `scripts/validate-cli-surface.mjs`.
   - All flags are parsed, typed, and honoured.
2. **Run scoping:**
   - Commands requiring run context strictly call `ctx.needRun()` (enforcing `--run-id`). No command falls back to "latest run".
3. **`--force` semantics:**
   - Run transitions strictly refuse `--force` and `--approval` (`FORCE_DISABLED`), directing operators to recovery edges or interactive approval grants.
   - Task transitions allow `--force` as a deliberate operator escape hatch.
4. **Validation:**
   - All 144 checks in `scripts/test-cli-contract.mjs` pass.

### Stream 5: Code Intelligence
1. **`context_hash` reproducibility:**
   - Verified that `buildTaskContext` in `runtime/task-context.mjs` excludes `created_at` from the hashable payload, normalizes text line endings (`readTextFile`), uses git commit SHA, and sorts symbol/interface listings.
2. **Symbol Graph determinism:**
   - Verified that `symbol-graph.mjs` comparators in `dependentClosure`, `testsForSymbol`, and `testsForFiles` are total and sort uniquely by depth, strength, and normalized relative file paths.

### Stream 6: The Four Deferred Decisions
1. **6a (`buildIndex` tracked files boundary):**
   - The repository index is inherently bound to tracked git files (`git ls-files -s`). Untracked files and uncommitted changes are detected and reported via `indexStale`.
2. **6b (`nextSeq` sequence numbers):**
   - Documented in `runtime/store.mjs` that `seq` numbers are cosmetic display aids. Replay validation and state integrity rely on chronological event logging and timestamps.
3. **6c (`design-discovery` mode ranking):**
   - Verified that `mode_rank[mode] ?? 0` safely defaults unknown values to `SKIP` (0).
4. **6d (`util.mjs` atomic write cleanup):**
   - Verified exception handling in `writeJson` properly prevents cleanup errors from masking original write/rename failures.

---

## Modules Audited (40/40)

All 40 runtime modules audited end-to-end:
- `runtime/activation.mjs`
- `runtime/cli.mjs`
- `runtime/codex-bootstrap.mjs`
- `runtime/commands/activation.mjs`
- `runtime/commands/artifacts.mjs`
- `runtime/commands/delivery.mjs`
- `runtime/commands/design.mjs`
- `runtime/commands/feature.mjs`
- `runtime/commands/index.mjs`
- `runtime/commands/project.mjs`
- `runtime/commands/provider.mjs`
- `runtime/commands/repo.mjs`
- `runtime/commands/run.mjs`
- `runtime/commands/task.mjs`
- `runtime/commands/tools.mjs`
- `runtime/compat.mjs`
- `runtime/context.mjs`
- `runtime/design-discovery.mjs`
- `runtime/dev-link.mjs`
- `runtime/evidence.mjs`
- `runtime/features.mjs`
- `runtime/gates.mjs`
- `runtime/governor.mjs`
- `runtime/handoff.mjs`
- `runtime/init.mjs`
- `runtime/launcher.mjs`
- `runtime/learning.mjs`
- `runtime/mcp-server.mjs`
- `runtime/model-router.mjs`
- `runtime/parallel.mjs`
- `runtime/procedures.mjs`
- `runtime/project-knowledge.mjs`
- `runtime/provider.mjs`
- `runtime/repo-intelligence.mjs`
- `runtime/requirement-update.mjs`
- `runtime/retention.mjs`
- `runtime/router.mjs`
- `runtime/symbol-graph.mjs`
- `runtime/task-context.mjs`
- `runtime/task-recovery.mjs`
- `runtime/task-runner.mjs`
- `runtime/telemetry.mjs`
