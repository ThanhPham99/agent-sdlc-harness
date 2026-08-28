# Gate Hygiene Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the remaining Medium/Low findings from the harness spike that are cheap to fix outright: a plugin-cache-drift warning that reaches an operator without them asking, a coverage floor that can no longer average away a weak agent-facing layer, a syntax gate over the 10% of bytes no suite executes, superseded CI runs that stop burning a Windows runner, and a `design mode`/`design validate` pair that finally composes. Three findings (F4, F7, and half of F5) are assessed and explicitly deferred rather than rushed — each because the fix, done properly, is a larger and riskier change than its severity justifies; see "What this plan deliberately does not do."

**Architecture:** Five independent, additive changes, none of which touch the execution path, the secret scanner, the router, or the task-verification launcher settled by the other three plans. `runtime/dev-link.mjs` is a new module carrying the read-only half of what `scripts/dev-link.mjs` already did, moved so `doctor` — which ships in the distributed package, unlike `scripts/` — can reuse it. `scripts/coverage-report.mjs` gains a second, narrower floor keyed by path prefix, computed the same way as the existing global one. `scripts/validate-syntax.mjs` is a new suite, wired into `test:integrity` (which both CI jobs already run) rather than into `ci.yml` directly. `.github/workflows/ci.yml` gains a `concurrency` block. `runtime/design-discovery.mjs` gains one new pure function, `scaffoldDesignDecision`, and `design.mjs` gains the `scaffold` subcommand that calls it.

**Tech Stack:** Node.js ESM (`.mjs`), zero runtime dependencies. Hand-rolled `test()` suites; `scripts/lib/suite.mjs` where the existing file already uses it.

**Spec:** `docs/superpowers/specs/2026-08-27-harness-spike-findings.md`, findings F3, F5, F6, F8, F13. (F4, F7, and F5's second half are addressed in "What this plan deliberately does not do" rather than fixed here.)

## Global Constraints

- Node `>=18`. No syntax or API newer than Node 18.
- Zero runtime dependencies.
- `scripts/` is excluded from every distributed package (`scripts/build-dist.mjs`'s `common` list has no `scripts` entry). Code that `runtime/commands/*.mjs` imports must live under `runtime/`, `protocol/`, `config/`, `policies/`, `prompts/`, `workflows/`, `roles/`, `templates/`, `overlays/`, or `docs/` — never under `scripts/` — or a real installed plugin crashes the first time the importing command runs.
- Every offline suite reachable from `npm run check` must be classified in exactly one of `scripts/coverage-report.mjs`'s `ENTRIES` (it runs suite bodies against `runtime/` and its coverage counts) or `NOT_MEASURED` (it does not); the script enforces this and exits 1 on an unclassified suite.
- Every offline suite reachable from `npm run check` must also be run by `.github/workflows/ci.yml`; `scripts/validate-ci-coverage.mjs` enforces membership **and** order, but only textually — it does not distinguish which job a step runs in (this is F5's second half, deferred below).
- `evals/COVERAGE-FLOOR.json` is a ratchet: `overall_percent: 90` and any `path_floors` entry must never be lowered by this plan.
- `npm run check` rewrites tracked report files under `evals/`; commit those with the task that caused them.
- Do not touch `runtime/launcher.mjs`, `runtime/tools.mjs`'s `secretScan`, `runtime/router.mjs`, or `runtime/task-verification.mjs` — settled by the execution-path-correctness, gate-signal-correctness, and router-scoring plans.

---

### Task 1: Surface plugin-cache drift from `doctor`, not just on request (F3)

**Files:**
- Create: `runtime/dev-link.mjs` — the read-only half of `scripts/dev-link.mjs`
- Modify: `scripts/dev-link.mjs` — import the shared functions instead of defining them
- Modify: `runtime/commands/project.mjs` — `doctor` calls `driftStatus`
- Test: `scripts/test-dev-link.mjs` (existing suite, must still pass byte-for-byte on its assertions), `scripts/test-cli-contract.mjs` (new case)

**Interfaces:**
- Produces: `runtime/dev-link.mjs` exports `PLUGIN`, `BACKUP_SUFFIX`, `hostHome()`, `installedRecords()`, `linkKind`, `linkTarget`, `sameTree`, `describeRecord(record,{root,repoVersion})`, `driftStatus(root,repoVersion)`.
- Consumes: nothing from another plan.

`node scripts/dev-link.mjs` (status mode, read-only) reports a `drift` field per host-recorded install when the cached copy's `VERSION` file disagrees with this checkout's — but only when a plugin developer remembers to run it. `doctor` is what's already run to sanity-check an environment (`runtime/commands/project.mjs:20`); it never mentioned cache drift. The obvious fix — importing `scripts/dev-link.mjs` from `runtime/commands/project.mjs` — would work in this checkout and then crash the first time `doctor` runs from an actually-installed plugin, because `scripts/` is not part of any distributed package (`scripts/build-dist.mjs:22`'s `common` list). The read-only logic therefore moves to `runtime/dev-link.mjs`, which ships; the mutating `apply`/`revert`/`guard` actions stay in `scripts/dev-link.mjs`, which does not need to.

- [x] **Step 1: Move the read-only logic**

Created `runtime/dev-link.mjs` with `PLUGIN`, `BACKUP_SUFFIX`, `hostHome()`, `installedRecords()`, `linkKind`, `linkTarget`, `sameTree`, `describeRecord(record,{root,repoVersion})`, and `driftStatus(root,repoVersion)` — the exact same logic `scripts/dev-link.mjs`'s `describe()`/status branch used, parameterized on `root`/`repoVersion` instead of closing over module-scope constants, so a caller with a different `root` (an installed plugin's own directory, when `doctor` runs from a real install) gets a correct answer rather than one hardcoded to this checkout.

`scripts/dev-link.mjs` now imports these and keeps only `guard()`, `apply()`, `revert()`, `removeLink()` and the CLI's `main()` — the mutating, dev-only half.

- [x] **Step 2: Verify the CLI is unchanged**

Run: `node scripts/dev-link.mjs`

Expected and observed: identical JSON shape to before the refactor (`schema`, `mode`, `repo_root`, `repo_version`, `host_record`, `host_record_present`, `plugins`, `note` when nothing is recorded).

Run: `node scripts/test-dev-link.mjs`

Expected and observed: `"results": "all-pass"`, `6/6` — this suite spawns the script as a subprocess and parses its stdout, so it is a byte-level regression check on the refactor, not just a smoke test.

- [x] **Step 3: Wire `driftStatus` into `doctor`**

In `runtime/commands/project.mjs`, the `doctor` handler now imports `driftStatus` from `../dev-link.mjs` and adds a `dev_link` key to its printed report: `{host_record_present, plugins, ...(hint?{hint}:{})}`.

Run: `node runtime/cli.mjs doctor`

Expected and observed: the existing `version`/`node`/`project`/`providers`/`auto_activation` fields unchanged, plus a new `dev_link: {host_record_present: false, plugins: []}` (no host record on this machine).

Added `doctor-reports-dev-link-drift-status` to `scripts/test-cli-contract.mjs`, asserting `out.dev_link.host_record_present` is a boolean and `out.dev_link.plugins` is an array.

- [x] **Step 4: Prove the shipped package is unaffected**

Run: `npm run build && npm run verify:dist`

Expected and observed: both exit 0. `verify:dist` spawns the built package's own binary and calls `doctor` (among other things) — this is the actual proof that `runtime/dev-link.mjs`'s import path resolves inside a packaged tree, which was the whole reason the logic could not stay in `scripts/`.

- [x] **Step 5: Run the full suites touched**

Run: `node evals/run-deterministic.mjs && node scripts/test-cli-contract.mjs && node scripts/test-dev-link.mjs && node scripts/validate-cli-surface.mjs`

Expected and observed: all pass; checks up by 1 in `test-cli-contract.mjs` (117, was 116).

- [x] **Step 6: Commit**

```bash
git add runtime/dev-link.mjs scripts/dev-link.mjs runtime/commands/project.mjs scripts/test-cli-contract.mjs evals/CLI-CONTRACT-VALIDATION.json
git commit -m "fix(doctor): surface plugin-cache drift without asking (F3)"
```

---

### Task 2: A coverage floor that can't average away the agent-facing layer (F6)

**Files:**
- Modify: `scripts/coverage-report.mjs`
- Modify: `evals/COVERAGE-FLOOR.json` — add `path_floors`

**Interfaces:**
- Consumes: nothing from another task.
- Produces: `evals/COVERAGE.json` gains a `path_coverage` key and `floor.path_floors`; `scripts/coverage-report.mjs --update` now also ratchets any configured path floor, not just the global one.

The global 90% floor is an average across every file under `runtime/`. `runtime/commands/*` — the CLI surface skills are instructed to call — sat at 70.9-75.2% per file (`commands/activation.mjs`, `commands/delivery.mjs`, `commands/artifacts.mjs`, `commands/run.mjs`, `commands/task.mjs`) while well-covered modules elsewhere kept the global number clear of 90. A regression specific to that layer would not move the global number enough to fail the gate.

- [x] **Step 1: Measure the current aggregate**

Measured `runtime/commands/*`'s aggregate (`covered_bytes`/`total_bytes` summed across every module under that prefix, the same aggregation the global floor already uses) against the tree at the start of this task: **82.1%** (`46549`/`56705` bytes after Task 1's `runtime/dev-link.mjs` addition and Task 5's `design.mjs` change moved a small amount of code across the boundary).

- [x] **Step 2: Implement the per-path floor**

In `scripts/coverage-report.mjs`, added `pathAggregate(prefix)` (sums `covered_bytes`/`total_bytes` over every `modules` entry whose `file` starts with `prefix`) and read `floor.path_floors` (an object, prefix → minimum percent) from `evals/COVERAGE-FLOOR.json`. The existing regression loop gained one line per configured prefix: `if (pathReport[prefix].percent < need) problems.push(...)`. `--update` now also rewrites each configured prefix's floor to `Math.floor(current)`, the same ratchet rule the global floor already uses. The report gained `path_coverage` (always present) and `floor.path_floors` (empty object when none are configured, so an unconfigured tree's `evals/COVERAGE.json` shape does not change).

Seeded `evals/COVERAGE-FLOOR.json` with `"path_floors": {"runtime/commands/": 82}` — `Math.floor(82.1)`.

- [x] **Step 3: Prove the regression path actually fires**

Temporarily raised the seeded floor to `99` and re-ran:

```
node scripts/coverage-report.mjs
```

Observed: exit 1, `"problems": ["runtime/commands/ coverage fell to 82.1% (floor 99%)"]`, `"status": "FAIL"`. Restored the floor to `82` and re-ran: exit 0, `"status": "PASS"`. This is the same before/after proof Task 1 of the gate-signal-correctness plan used for its worktree fix — asserting the mechanism fires, not just that it exists.

- [x] **Step 4: Run the full gate**

Run: `npm run check`

Expected and observed: exit 0. Global coverage measured 91% (floor 90, unchanged), `runtime/commands/` measured 82.3% (floor 82).

- [x] **Step 5: Commit**

```bash
git add scripts/coverage-report.mjs evals/COVERAGE-FLOOR.json evals/COVERAGE.json
git commit -m "fix(coverage): a per-path floor for runtime/commands/, so it can't be averaged away (F6)"
```

---

### Task 3: A syntax gate over the 10% of bytes no suite executes (F8)

**Files:**
- Create: `scripts/validate-syntax.mjs`
- Modify: `package.json` — new `test:syntax` script, added as a child of `test:integrity`
- Modify: `scripts/coverage-report.mjs` — classify the new suite in `NOT_MEASURED`
- Modify: `.github/workflows/ci.yml` — upload the new report

**Interfaces:**
- Consumes: nothing from another task.
- Produces: `evals/SYNTAX-VALIDATION.json`.

36k lines of hand-written ESM had no `eslint`/`prettier`/`tsconfig` and no `node --check` sweep. With a 90% global coverage floor, up to 10% of bytes are never executed by any suite, so a syntax or reference error there would ship undetected until a human happened to exercise that path.

- [x] **Step 1: Write the suite**

`scripts/validate-syntax.mjs` walks every `.mjs` file from the repo root — skipping `.git`, `node_modules`, `dist`, `.agent-sdlc`, `.claude`, `release`, `.superpowers` (the same scratch/build exclusions the legacy-reference guard in `evals/run-deterministic.mjs` uses) — and runs `node --check <file>` on each (parse-only, nothing executes). `process.execPath` is used directly, not `resolveLaunch`: this is launching `node` itself to check a source file, not a configured project command, so the launcher's Windows-shim / script-host resolution does not apply. Writes `evals/SYNTAX-VALIDATION.json` and exits 1 if any file fails to parse.

- [x] **Step 2: Verify it catches a real syntax error**

Wrote a deliberately-broken file (`function broken( { }`) into `scripts/`, ran the suite, confirmed `status: FAIL`, `failures: 1`, and the actual `SyntaxError: Unexpected end of input` from Node captured in the file's `error` field. Deleted the probe file and re-ran to confirm a clean tree passes: `120/120`.

- [x] **Step 3: Wire it into the gate without touching `ci.yml`'s step list**

Added `"test:syntax": "node scripts/validate-syntax.mjs"` to `package.json` and appended it as the last child of `test:integrity`. `test:integrity` already runs in both CI jobs (`offline-validation` and `windows-validation`) as a single step, so `scripts/validate-ci-coverage.mjs` — which only checks that a leaf suite is reachable via an invoked ancestor, not the fine order of an aggregate's own children — considers `test:syntax` gated via `test:integrity` automatically, with **no `ci.yml` step-list edit required**.

Run: `node scripts/validate-ci-coverage.mjs`

Expected and observed: `31` checks (up from `30`), `"suites": "all-gated"`, `"status": "PASS"` — confirmed before adding any `ci.yml` change.

Classified `scripts/validate-syntax.mjs` itself in `scripts/coverage-report.mjs`'s `NOT_MEASURED` (`node --check` parses a file; it never imports or executes `runtime/`), since `npm run check`'s own suite-completeness check would otherwise refuse to run coverage at all once `test:syntax` became reachable from `check`.

Added `evals/SYNTAX-VALIDATION.json` to the artifact-upload list in `.github/workflows/ci.yml`, next to `CLI-SURFACE-VALIDATION.json`, for parity with every other `test:integrity` child's report.

- [x] **Step 4: Run the full gate**

Run: `npm run check`

Expected and observed: exit 0, including the new `test:syntax` step inside `test:integrity`'s output (`120/120` parse clean).

- [x] **Step 5: Commit**

```bash
git add scripts/validate-syntax.mjs package.json scripts/coverage-report.mjs .github/workflows/ci.yml evals/SYNTAX-VALIDATION.json evals/CI-COVERAGE-VALIDATION.json
git commit -m "feat(ci): a node --check syntax gate over every .mjs file (F8)"
```

---

### Task 4: Cancel a superseded CI run (F5, first half)

**Files:**
- Modify: `.github/workflows/ci.yml`

**Interfaces:** none; a workflow-level YAML addition.

No `concurrency: cancel-in-progress` meant a superseded push kept its full 2-node-version ubuntu matrix plus a Windows runner running to completion for no reason once a newer push to the same ref existed.

- [x] **Step 1: Add the concurrency group**

```yaml
concurrency:
  group: ci-${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true
```

Added directly under `permissions:`, before `jobs:`.

- [x] **Step 2: Verify nothing else reads the file structurally in a way this breaks**

Run: `node scripts/validate-ci-coverage.mjs && node scripts/validate-root-sync.mjs`

Expected and observed: both `PASS`, unchanged check counts — the added block contains no `run:` lines, so the regex-based order/membership scan in `validate-ci-coverage.mjs` (which only looks for `run:\s*npm ...` lines) is unaffected. Also parsed the file with `python3 -c "import yaml; yaml.safe_load(...)"` to confirm it is still valid YAML.

- [x] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "chore(ci): cancel a superseded run instead of finishing it (F5)"
```

(This commit is folded into Task 3's commit in the actual history, since both touched `ci.yml` in the same session; recorded here as its own task because it is logically independent.)

---

### Task 5: Make `design mode` and `design validate` compose (F13)

**Files:**
- Modify: `runtime/design-discovery.mjs` — new `scaffoldDesignDecision`
- Modify: `runtime/commands/design.mjs` — new `scaffold` subcommand
- Modify: `runtime/commands/index.mjs` — register the subcommand
- Modify: `docs/USAGE.md`
- Create: `templates/design-decision.json`
- Test: `evals/run-deterministic.mjs`, `scripts/test-cli-contract.mjs`

**Interfaces:**
- Consumes: nothing from another task.
- Produces: `scaffoldDesignDecision(selection, {objective, decisionId?})` — a pure function other callers could use; `design scaffold` on the CLI surface.

`design mode` emits `agent-sdlc/design-discovery-decision/v1` (a mode *selection*: `SKIP`/`COMPACT`/`FULL`, reason codes, whether human approval is required). `design validate`/`design record` require `agent-sdlc/design-decision/v1` (the decision content itself: `decision_id`, `objective`, and for `FULL` mode, real `options` with `benefits`/`tradeoffs` and a `recommended_option`). The two commands did not compose — an operator had to hand-build the decision artifact from `validate`'s error codes, one field at a time, with no template to start from.

- [x] **Step 1: Add the pure scaffolding function**

`scaffoldDesignDecision(selection, {objective, decisionId})` in `runtime/design-discovery.mjs` builds a correctly-shaped `agent-sdlc/design-decision/v1` draft for whatever mode the selection carries:
- `SKIP`: `skip_reason` is filled from the selection's own `reason_codes` — a real, deterministic answer to "why was design skipped here", not a placeholder. This draft validates immediately.
- `COMPACT`: `validateDesignDecision` requires no `decision`/`options` content for this mode (only the `FULL`-mode block in `validateDesignDecision` checks for them), so the bare draft (`schema`, `decision_id`, `objective`, `mode`) already validates.
- `FULL`: `options` gets `policy.options.min_options_full_mode` (currently `2`) stub entries (`id`, `summary: 'TODO'`, `benefits: ['TODO']`, `tradeoffs: ['TODO']`), `recommended_option` points at the first, and `decision` is a `'TODO: ...'` placeholder — correctly shaped, but still needs real judgment (and, if the selection required it, real approval) before `validateDesignDecision` accepts it.

- [x] **Step 2: Wire the CLI subcommand**

`design scaffold` (`runtime/commands/design.mjs`) accepts the same inputs as `design mode` (`--objective`, `--profile`, `--signals`, `--approved`, `--run-id`), runs `selectDesignDiscoveryMode`, calls `scaffoldDesignDecision`, and prints `{schema:'agent-sdlc/design-decision-scaffold/v1', selection, draft, validation: validateDesignDecision(draft)}` — so the caller sees the mode decision, the draft, and whether the draft already validates, in one call.

Registered in `runtime/commands/index.mjs`'s `COMMANDS.design.subcommands` (`["mode","policy","validate","scaffold","record"]`) — required by `scripts/validate-cli-surface.mjs`, which cross-checks every `sub===` dispatched in a handler's source against this declared list.

- [x] **Step 3: Verify against all three modes**

```
node runtime/cli.mjs design scaffold --objective "Add refund capability" --profile STANDARD
  -> mode COMPACT, validation.valid: true, 0 errors
node runtime/cli.mjs design scaffold --objective "database schema migration with backfill" --profile STRICT
  -> mode FULL, human_approval_required: true, validation.errors: ["APPROVAL_REQUIRED_NOT_APPROVED"] only
     (no FULL_MODE_WITHOUT_OPTIONS / MISSING_RECOMMENDED_OPTION / MISSING_DECISION_STATEMENT / OPTION_MISSING_* --
      shape is right; what's left is real content and real approval, not structure)
node runtime/cli.mjs design scaffold --objective "Update README documentation" --profile FAST
  -> mode SKIP, skip_reason: "Design discovery selected SKIP (PROFILE_DEFAULT:FAST:SKIP; DEESCALATE:DOCS_ONLY:SKIP)",
     validation.valid: true
```

Added `design-scaffold-skip-mode-is-immediately-valid`, `design-scaffold-compact-mode-is-immediately-valid`, and `design-scaffold-full-mode-is-correctly-shaped-but-still-needs-content` to `evals/run-deterministic.mjs`, and `design-scaffold` to the CLI-contract read-surface sweep (`scripts/test-cli-contract.mjs`).

- [x] **Step 4: Add the static reference template**

Created `templates/design-decision.json` — a filled-in `FULL`-mode example with `TODO` placeholders, matching the finding's second complaint ("templates/ has no design-decision scaffold") for a reader who wants to see the shape without invoking the CLI.

- [x] **Step 5: Document it**

`docs/USAGE.md`'s DESIGN section gained the `design scaffold` command line and a paragraph explaining why `design mode`'s output cannot be fed to `design validate` directly and what `scaffold` bridges.

- [x] **Step 6: Run the full gate**

Run: `node evals/run-deterministic.mjs && node scripts/test-cli-contract.mjs && node scripts/validate-cli-surface.mjs && node scripts/validate-versions.mjs`

Expected and observed: all pass. `run-deterministic.mjs` up to `322` checks (was `319`); `test-cli-contract.mjs` up to `116` (was `115`); CLI surface `"subcommand_groups": "all-documented"`; versions `"status": "PASS"` (the `docs/USAGE.md` edit introduced no bare version literal).

- [x] **Step 7: Commit**

```bash
git add runtime/design-discovery.mjs runtime/commands/design.mjs runtime/commands/index.mjs docs/USAGE.md templates/design-decision.json evals/run-deterministic.mjs evals/DETERMINISTIC-VALIDATION.json scripts/test-cli-contract.mjs evals/CLI-CONTRACT-VALIDATION.json evals/CLI-SURFACE-VALIDATION.json
git commit -m "feat(design): design scaffold bridges design mode and design validate (F13)"
```

---

### Task 6: Full gate

**Files:** report files under `evals/` only.

- [x] **Step 1: Run the whole gate**

Run: `npm run check`

Expected and observed: exit 0.

- [x] **Step 2: Confirm both floors are unchanged or improved, never lowered**

Run: `node scripts/coverage-report.mjs`

Expected and observed: `"status": "PASS"`; global `91%` (floor `90`, unchanged); `runtime/commands/` `82.3%` (floor `82`, newly added this plan). Do NOT run `--update`.

- [x] **Step 3: Commit the reports**

```bash
git add evals/
git commit -m "chore(evals): record the reports for the gate-hygiene fixes"
```

---

## What this plan deliberately does not do

- **Does not fix F4** (`npm run check` runs each of 16 subject suites once individually, then `test:coverage` re-runs all 16 again under `NODE_V8_COVERAGE` — the longest segment of the run). Both fixes the finding names are architecturally invasive: running everything once under a shared coverage env means restructuring how `check`'s chain invokes suites, which `scripts/validate-ci-coverage.mjs` currently reasons about by regex-parsing `package.json`'s `npm run X && npm run Y` script bodies — a JS orchestrator in place of that chain would need that validator rewritten too. Splitting coverage into a parallel CI job does not reduce total suite executions, only CI wall-clock, and today coverage actually runs *three* times (ubuntu×2 node versions + Windows) because `evals/COVERAGE-FLOOR.json`'s own note explains ubuntu and Windows measure different numbers (SKIPped cases differ), so consolidating risks silently losing a platform-specific `never_loaded` regression signal. This is real, load-bearing coupling built by two other merged plans; a Medium-severity CI-speed finding does not justify restructuring it without dedicated design attention.
- **Does not fix F7** (no `prune`/`gc` for `.agent-sdlc`). This is a new CLI feature, not a fix to broken behavior — it needs its own design decision (age-based? explicit ack before deleting run history that might be audit-relevant? which of runs/events/tasks/artifacts is prunable and under what default). Low severity, "cheap now, unbounded later," no reported operator pain yet. Scoping it properly is a task-sized effort of its own.
- **Does not fix F5's second half** (`scripts/validate-ci-coverage.mjs` is job-blind: it checks that a suite is invoked *somewhere* in `ci.yml`'s text, not which job). Making it job-aware means parsing the workflow's job/step structure instead of scanning the whole file as one blob — a rewrite of a validator three other plans depend on for their own correctness guarantees. The failure mode it would catch (a suite present only in `windows-validation` satisfying a gate meant for `offline-validation`) has not actually happened; it is a latent risk, not an active one.
- **Does not fix F14** (`npm run check` rewrites tracked report JSONs, leaving the worktree dirty). The execution-path-correctness and gate-signal-correctness plans' own Global Constraints already treat this as intentional: *"`npm run check` rewrites tracked report files under `evals/`. Commit those with the task that caused them."* Every task in this plan follows that same convention. Changing it now (gitignoring reports, or requiring `--update`) would be a process reversal affecting three merged plans' worth of established practice, not a Low-severity DX fix.
- **Does not touch F1, F2, F9-F12, F15** — settled by the execution-path-correctness, router-scoring, and gate-signal-correctness plans.
