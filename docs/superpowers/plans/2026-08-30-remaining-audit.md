# Remaining Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish auditing the 40 runtime modules that the 2026-08-28/30 sweep never opened, and close the four decisions it deliberately deferred. Unlike the plans this repo has run before, this one does **not** consume a spec: no findings exist yet. Its output is findings plus their fixes, and its first job in every task is to look, not to patch.

**Architecture:** Six independent work streams, ordered by blast radius rather than by module count. Stream 1 covers the only remaining code that can corrupt data rather than merely misreport (parallel task execution); streams 2–5 walk decreasing-severity surfaces; stream 6 is four concrete decisions with no investigation left in them. Each stream is self-contained: no stream produces an interface another consumes, so they may be run in any order or in parallel, and a stream that finds nothing ends by recording that.

**Tech Stack:** Node.js ESM (`.mjs`), zero runtime dependencies. Hand-rolled suites; `scripts/lib/suite.mjs` for the ones that use it. `node:child_process.spawnSync` only — never `shell:true`.

**Spec:** none. This plan produces one. When a stream finds something, write it up in `docs/superpowers/specs/2026-08-30-remaining-audit-findings.md` with the `F<n> (Severity) <title>` shape the 2026-08-27 spike spec uses, then fix it.

---

## What is already established — do not redo

26 commits landed between `94b98ee` and `e594f46`. Twelve real defects, in two recurring shapes. **The shapes are the transferable part of this work; look for them first in any new module.**

**Shape A — a gate accepts a weaker proxy for the thing it stands for.** Eight instances: a `**` glob that compiled wrong, a bare branch name where a normalized ref was meant, all-approvals where valid-approvals was meant, an evidence ref where the verification record was meant, an optional `diff_hash` where a required binding was meant, a restated CI-currency rule instead of asking the module that owns it, "nothing reported a scope violation" instead of "the audit ran", and a policy regex that disabled its own rule when it failed to compile.

**Shape B — a git command that reports only tracked state, used as though it reported the workspace.** Six instances: `diff_hash`, `dirtyHash`, `security.secret_scan` (gateway), `security_secret_scan` (per-task), `repo.search`, `indexStale`; plus two under-reports in `repo.diff` and `workspace.uncommitted_changes_excluded`.

**Sweeps already run to exhaustion. Re-running these is waste:**

| sweep | command | result |
|---|---|---|
| every git invocation in runtime | `grep -rn "git(\[\|'git'," --include=*.mjs runtime/` | 20 hits, 6 defects, rest correct by nature |
| guarded inequality in gates | `grep -rn "===false" runtime/gates.mjs runtime/orchestrator.mjs runtime/task-engine.mjs runtime/policy.mjs` | 1 defect; now zero hits remain |
| defaults masking a missing value | `grep -rnE "\?\?\s*(true\|'PASS'\|\[\]\|0\|1)\b" runtime/` | 1 defect, 7 negatives |
| swallowed errors | `grep -rnE "catch\s*(\([^)]*\))?\s*\{" runtime/` | 35 hits, 1 defect |
| collation inside a hash | `grep -rn "localeCompare" runtime/` | 1 defect (self-inflicted, `cabb2bc`); the 14 that remain are display order or ISO-timestamp comparison, where both collations agree |

**Verified clean, with evidence — do not re-investigate without a new reason:**

- `appendJsonl` under concurrency: measured, 6 processes x 300 lines x payloads of 10 / 8 000 / 70 000 bytes, 1800/1800 lines, zero unparseable.
- `saveRun` optimistic locking: counter-based, correct, and its comment explains why a timestamp was not enough.
- `pretool-guard`: 13/13 destructive commands denied, 4/4 ordinary allowed, run as a real process against `evals/guard/cases.json`.
- MCP vs CLI surface parity: `agent_sdlc_transition` refuses `force`/`approval` outright; `tool_check`/`tool_run` share `checkTool`.
- `guardEvidenceAuthority`: runtime-authority tokens cannot be hand-asserted from CLI or MCP.
- `governor`: "risk raises a floor; budget never lowers one" holds.
- GC in `retention.mjs`: marks from run references, not artifact metadata, and its comment already reasons about hash collision across runs.

---

## Global Constraints

- Node `>=18` (`package.json` engines). No syntax or API newer than Node 18.
- Zero runtime dependencies. `package.json` has no `dependencies` block and must not gain one.
- All runtime code is ESM `.mjs` using `import`, never `require`.
- Never `spawnSync(..., {shell:true})`. Route every process launch through `resolveLaunch` from `runtime/launcher.mjs`.
- `npm run check` must be green (21/21) before every commit. It rewrites tracked reports under `evals/`; commit those with the change that caused them.
- Every offline suite reachable from `npm run check` must also run in `.github/workflows/ci.yml`; `scripts/validate-ci-coverage.mjs` enforces membership and per-stage order.
- Anything newly sensitive to untracked files must exclude `.agent-sdlc/`. A project that has not gitignored the harness's own state would otherwise invalidate its own evidence on every write and never pass a gate again. This was hit for real during `ea31577`; see `untrackedDigest` in `runtime/util.mjs`.
- Adding to a schema's `required` is documentation only — this repo ships no JSON Schema validator. Say what the runtime actually enforces, including when it enforces conditionally.

### Method — non-negotiable, this is what made the previous 26 commits trustworthy

1. **Write the failing test first, and read the failure message.** Twice in the previous session a test was red for the wrong reason (a `vendor/` fixture that sorted after `src/`; an xlsx fixture missing `<row>` wrappers). A red test proves nothing until its message is the one you predicted.
2. **Mutation-test whenever the red state is unavailable or ambiguous** — for example when the test names an API that does not exist yet. Break the fix, confirm the case goes red, restore. This caught a test that asserted only `DENY` while an earlier branch was supplying that `DENY`, so the branch under test never ran.
3. **Make a fixture refuse to run when it stops discriminating.** See `the-anchor-orders-node-ids-by-code-point-not-by-locale`, which fails loudly if the two collations ever agree on its ids.
4. **Run the full gate after every change**, and read the run's own stdout — not the tracked report files, which are stale until the run rewrites them.
5. **Report negative results explicitly.** A hypothesis checked and disproved is a deliverable; it stops the next worker repeating it.

### Traps this environment has already sprung — cost hours, will recur

- **Bash heredocs collapse `\\` to `\`.** Three separate syntax breakages came from `python - <<'PY'` scripts containing `\\n`. Use the Edit tool for anything with backslash escapes, or build the escape with `bytes([92,48])`.
- **The Edit tool can write a literal NUL** if a draft contained `\0`; the file then reads as binary to grep and git, and every suite still passes. Check with `python -c "print(open(p,'rb').read().count(b'\x00'))"` after editing a file that mentions NUL.
- **A suspended machine skews `wall_clock`** in the check report (one run reported 133325s) and can time a coverage subject out. Re-run before blaming a change.
- **`git ls-files --others` returns a nested repository as one opaque `name/` entry**, not its files. Handle the trailing slash.

---

### Task 1: Parallel task execution — the only remaining data-loss surface

**Files:**
- Read first: `runtime/task-runner.mjs`, `runtime/parallel.mjs`, `runtime/task-scheduler.mjs` (already partly audited)
- Test: `evals/task-runtime.mjs`

**Interfaces:** Consumes nothing. Produces nothing other tasks consume.

Every other module left can, at worst, report something untrue. These two dispatch real concurrent work, so a defect here can lose or corrupt state. Prior evidence says the file layer is sound (`appendJsonl` measured safe, `saveRun` locking correct), which sharpens rather than removes the question: the risk is in what the runner does *between* those calls.

Concrete hypotheses, in priority order:

1. **Read-modify-write of the run record across a dispatch.** `saveRun` throws `STALE_RUN_STATE` on a revision mismatch. Does `task-runner.mjs` hold a `run` object across an `await`, then save? Two concurrent tasks would make one of them throw — or, worse, a `catch` somewhere turns that throw into a silent skip. Grep the runner for `saveRun` and check every holder's lifetime.
2. **Workspace writer binding under a race.** `createTaskWorkspace` refuses a second writer, but the check is read-then-write against a JSON file with no lock. Two dispatches for the same task in the same millisecond may both see "no existing record". Reproduce with concurrent processes the way the `appendJsonl` probe did.
3. **`git worktree add` concurrency.** Several isolated workspaces are created at once against one repository. Git takes its own index lock; confirm the failure path degrades honestly (`WORKTREE_UNAVAILABLE`) rather than silently falling back to `provider-sandbox` with `root=projectRoot`, which would put two writers in the same tree — the exact thing `checkWriterIsolation` exists to prevent.
4. **Budget accounting.** `scheduleTasks` bounds `max_parallel_agents`; verify the count reflects tasks actually dispatched, not tasks selected, when a dispatch fails.

- [ ] **Step 1: Read all three modules end to end before forming a hypothesis.** Note every place a value is read, awaited across, then written.
- [ ] **Step 2: Build a concurrent probe harness** modelled on the `appendJsonl` measurement: N real child processes against one fixture project, then assert on the resulting state. Put it in the scratchpad, not the repo, until it demonstrates something.
- [ ] **Step 3: For each hypothesis above, either reproduce it or record it as a negative result** with the evidence that settled it.
- [ ] **Step 4: For each reproduction — failing test, fix, mutation-check, full gate, commit.**
- [ ] **Step 5: Write the stream up in the spec file**, findings and negatives both.

**Exit criteria:** all four hypotheses resolved to a fix or a documented negative; `npm run check` green.

---

### Task 2: Decision determinism — router, model-router, governor

**Files:**
- Read first: `runtime/router.mjs`, `runtime/model-router.mjs`, `runtime/governor.mjs`, `config/router-rules.json`
- Test: `evals/run-deterministic.mjs`

**Interfaces:** Consumes nothing. Produces nothing other tasks consume.

`model-router.mjs` has the lowest coverage of any runtime module (82.6%) and has never been opened. `governor` was spot-checked only for its floor/budget invariant.

What to look for, derived from Shape A and from the determinism defects already fixed:

1. **Ordering that reaches a decision.** `graph_sha256` was hashed in filesystem order and then in locale order. Any `sort` whose result selects a winner — cheapest qualified tier, first matching rule — must be code-point stable and total. A comparator returning 0 for distinct items leaves the order to the engine.
2. **A tie broken by declaration order without saying so.** The 2026-08-27 spec's F2 recorded exactly this in `router.mjs` (first-match-wins, no ambiguity signal). Verify what actually shipped and whether `model-router` has the same shape.
3. **A floor that can be lowered.** `governor` holds for risk vs budget; check whether `require_structured`, provider availability, or a missing tier can route *below* a floor rather than failing closed.
4. **An unknown input ranked lowest instead of refused.** `design-discovery`'s `mode_rank[mode]??0` is the known example, deliberately left (see Task 6). Look for the same `??0` shape in tier ranking.

- [ ] **Step 1: Read the three modules; list every comparator and every default.**
- [ ] **Step 2: For each comparator that selects a winner, write a case with inputs that make declaration order and value order disagree.**
- [ ] **Step 3: Fix, mutation-check, gate, commit; record negatives.**

**Exit criteria:** every winner-selecting comparator is total and code-point stable, or documented as intentionally order-dependent; ties emit a reason code.

---

### Task 3: The CLI command surface

**Files:**
- Read first: `runtime/commands/*.mjs` (12 files), `runtime/cli.mjs`
- Test: `scripts/test-cli-contract.mjs`

**Interfaces:** Consumes nothing. Produces nothing other tasks consume.

`runtime/commands/` sits at 92.4% coverage against a 92 floor and was never audited. It is also the surface an operator drives by hand, so a defect here is one a human meets directly.

What to look for:

1. **A flag parsed but not honoured**, or honoured with different semantics than its help text claims. `sanitize_queries` and `checkTool`'s `projectCfg` were both of this family; the CLI is where the family is likeliest to be dense.
2. **A command that reads state the run does not own** — cross-run reads, or a `--run-id` that silently falls back to "the latest run".
3. **Argument coercion at a decision point.** `commands/tools.mjs:26-27` was noted as coercion and cleared during the `&&.*!==` sweep, but only for that pattern.
4. **`--force` semantics.** Documented as an operator escape hatch on task transitions and rejected on run transitions; confirm every other command that accepts it is on the documented side of that line.

- [ ] **Step 1: Build the flag inventory** — every flag each command reads, against `docs/USAGE.md` and `scripts/validate-cli-surface.mjs`. Mismatches are the finding list.
- [ ] **Step 2: For each mismatch, decide "wire it" or "delete it"** using the rule Task 6 sets out: an off switch that already exists elsewhere means delete.
- [ ] **Step 3: Fix, gate, commit.**

**Exit criteria:** every declared flag is either honoured or gone; no command widens what a stage policy denies.

---

### Task 4: Feature and requirement lifecycle

**Files:**
- Read first: `runtime/features.mjs`, `runtime/requirement-update.mjs`, `runtime/learning.mjs`, `runtime/telemetry.mjs`, `runtime/project-knowledge.mjs`
- Test: `evals/alpha6-runtime.mjs`

**Interfaces:** Consumes nothing. Produces nothing other tasks consume.

These carry state across runs, which is where the artifact-metadata defect (`5e46e6d`) lived. Look for the same shape: a record keyed by one identity that a second writer can take over, and any listing filtered by a field that is not the real owner.

1. `features.mjs:54` and `:85` both do `readdirSync(...).map(readJson)` **unsorted** — the same construct that made `graph_sha256` unstable. Check whether either result reaches a hash or a "first match wins".
2. Cross-run references: `retention.mjs` already marks from run references because artifact metadata is unreliable. Anything else that resolves ownership from metadata is suspect.
3. `learning.mjs` and `telemetry.mjs` aggregate; confirm an aggregate cannot silently drop a run whose record is malformed.

- [ ] **Step 1: Read; list every listing and every cross-run reference.**
- [ ] **Step 2: For each unsorted listing, determine whether order reaches an output. Sort it if so.**
- [ ] **Step 3: Fix, gate, commit; record negatives.**

---

### Task 5: Code intelligence

**Files:**
- Read first: `runtime/symbol-graph.mjs`, `runtime/repo-intelligence.mjs`, `runtime/task-context.mjs`, `runtime/context.mjs`
- Test: `evals/alpha6-runtime.mjs`

**Interfaces:** Consumes nothing. Produces nothing other tasks consume.

Lowest severity of the code streams: these inform an agent rather than gate anything. Two known entry points:

1. **`context_hash` is compared** (`task-runner.mjs:199` drives `contextDelta.changed`), so anything unstable that reaches it produces a spurious "the context changed". Already verified: it hashes `run.artifacts` (insertion-ordered), excludes `created_at`, and reads text through `readTextFile` so CRLF cannot move it. Extend that check to every remaining field.
2. **`buildIndex` indexes tracked files only** — see Task 6.

- [ ] **Step 1: Enumerate every field that reaches `context_hash` and `estimated_tokens`; confirm each is stable across machines.**
- [ ] **Step 2: Check the `symbol-graph` comparators against the Task 2 criteria.**
- [ ] **Step 3: Fix, gate, commit; record negatives.**

---

### Task 6: The four deferred decisions

**Files:** as listed per decision.

**Interfaces:** Consumes nothing. Produces nothing other tasks consume.

Each was investigated to a conclusion and left because it is a judgement the repo owner should make, not because it is unclear.

**6a — `buildIndex` indexes tracked files only** (`runtime/repo-index.mjs:255`). A task's new module is absent from the index and the symbol graph, so dependency analysis omits the code just written. Not a one-line fix: the index is keyed by `revision` plus git blob SHAs (`git ls-files -s`) and an untracked file has no blob, so including them needs a second identity for unstaged content. `cf61705` made `indexStale` at least *say* the index no longer describes the tree. **Decision needed:** invent that identity, or accept the boundary and document it in the index's own schema.

- [ ] Decide, then either implement with a failing test first, or write the boundary into `protocol/schemas/` and close this item.

**6b — `seq` collides across concurrent processes** (`runtime/store.mjs`, `nextSeq`). `seqCache` is module-level, so each process seeds from the file's line count and two concurrent writers issue the same number. Every consumer was traced: `mcp-server.mjs:133` displays it, and `validateReplay` hashes the event array as read rather than by `seq`. **Decision needed:** leave it cosmetic and comment `nextSeq` to say so, or make it authoritative.

- [ ] Add the comment at minimum — the next reader should not have to re-derive that the collision is harmless.

**6c — `design-discovery` ranks an unknown mode lowest** (`runtime/design-discovery.mjs:26`, `mode_rank[mode]??0`). A typo in `policies/design-discovery.json` silently ranks a mode below `SKIP` instead of being refused. `collectSignals` already emits `UNKNOWN_SIGNAL_IGNORED:<id>` for unknown signals, so the module's own convention is to report what it ignored. **Decision needed:** apply that convention to `mode_rank`, or accept that the policy file is trusted input.

- [ ] Decide; if applying, a failing test with a policy fixture naming a bogus mode.

**6d — `util.mjs` swallows the temp-file cleanup failure** (`runtime/util.mjs`, `try{fs.rmSync(tmp,{force:true})}catch{}` after an atomic write). Worst case is a stray `.tmp` beside a state file. **Decision needed:** leave it, or have `agent-sdlc doctor` report strays.

- [ ] Lowest priority in this plan. Decide and close.

---

## Definition of done

- [ ] Every task above is either fixed or recorded as a negative result in `docs/superpowers/specs/2026-08-30-remaining-audit-findings.md`.
- [ ] `npm run check` green (21/21) at every commit, not only at the end.
- [ ] No module in the "never touched" list below remains unread.
- [ ] This plan file is deleted in the same commit that closes the last task, following `b462d59`.

### Never-touched inventory (40 modules, as of `e594f46`)

`activation` · `cli` · `codex-bootstrap` · `commands/artifacts` · `commands/design` · `commands/feature` · `commands/index` · `commands/project` · `commands/provider` · `commands/repo` · `commands/run` · `commands/task` · `commands/tools` · `compat` · `context` · `design-discovery` · `dev-link` · `evidence` · `features` · `gates` · `governor` · `handoff` · `init` · `launcher` · `learning` · `mcp-server` · `model-router` · `parallel` · `procedures` · `project-knowledge` · `provider` · `repo-intelligence` · `requirement-update` · `retention` · `router` · `symbol-graph` · `task-context` · `task-recovery` · `task-runner` · `telemetry`

Some were read during the sweeps above and cleared for the pattern being swept; none was audited on its own terms.
