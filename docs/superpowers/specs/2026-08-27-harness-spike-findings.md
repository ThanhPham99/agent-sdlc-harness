# Spike findings — agent-sdlc-harness 3.0.0-rc1

Source: technical-spike run `run_8018882d-f4ec-463b-a6c3-945bf32806aa`, git `aba951a`, win32, node v24.14.0.
Run reached VERIFY and is BLOCKED on `no_new_high_security_findings` — by F12 below, which is one of the findings.

Baseline: `npm run check` exit 0 (all 25 offline suites green). Coverage 90.9% vs floor 90.

This spec is consumed by three plans, one per subsystem:

- `plans/2026-08-27-execution-path-correctness.md` — F1, F9, F10, F11 (+ dead per-tool config)
- `plans/2026-08-27-router-scoring.md` — F2
- `plans/2026-08-27-gate-hygiene.md` — F3-F8, F13-F14 (F12 ended up resolved by gate-signal-correctness.md instead, alongside F15)

---

Baseline: `npm run check` exit 0 (full offline gate green). Coverage 90.9% vs 90 floor.
Read-only investigation; no source changed.

## F1 (High) Documented entry point `bin/agent-sdlc` is unusable on Windows
- `bin/agent-sdlc` is a 4-line `#!/usr/bin/env sh` shim; no `.cmd`/`.ps1` sibling.
- PowerShell: "Cannot run a document in the middle of a pipeline". cmd.exe: "not recognized".
- 120 references in skills/ + harness/internal-skills/ + docs/USAGE.md tell the agent to run it.
- scripts/verify-dist.mjs:28-33 already documents and works around this ("The POSIX shell
  entrypoint is not executable on Windows") — the fix lives in test code, not the product surface.
- CI's windows-validation job only calls `npm run ...`, so the gap is invisible to CI.
- Fix: ship `bin/agent-sdlc.cmd` + `bin/agent-sdlc.ps1`; assert shim parity in
  scripts/validate-cli-surface.mjs; have a suite spawn the platform shim on win32.

## F2 (High) Router is first-match-wins with no scoring and no ambiguity signal
runtime/router.mjs:29 returns the first rule with any keyword hit; config/router-rules.json
order then decides. Reproduced with `bin/agent-sdlc route`:
| objective | got | expected |
|---|---|---|
| investigate optimization opportunities | performance/STANDARD | technical-spike |
| assess whether we can optimize the plugin | performance/STANDARD | technical-spike |
| read-only investigation of slow startup | performance/STANDARD | technical-spike |
| nang cap va toi uu plugin, chi dieu tra | performance/STANDARD | technical-spike |
| investigation of the plugin | new-feature/STANDARD (DEFAULT) | technical-spike |
- `reason_codes` reports only the winning keyword, so the competing match is invisible to
  the orchestrator and to the human.
- No stemming: `investigate` is a keyword, `investigation` matches nothing (last row).
- Every routing eval case (evals/run-deterministic.mjs:51-58) is single-intent, so the whole
  mixed-intent class is untested.
- Fix: score all matching rules (hits x keyword specificity x rule priority); emit every match
  in reason_codes; add `AMBIGUOUS_ROUTE` risk flag on a near-tie or on conflicting intent
  classes (investigate vs change); keep STRICT when any tied rule is STRICT; add mixed-intent
  eval cases including Vietnamese; add suffix folding for the -ate/-ation family.

## F3 (Medium) Host loads a stale plugin version, silently
`node scripts/dev-link.mjs`: host loads `3.0.0-alpha4`, working tree is `3.0.0-alpha6`. This very
session executed alpha4 skill bodies against an alpha6 tree. dev-link reports drift only when
asked. Fix: surface drift as a warning from the Claude SessionStart bootstrap hook (and
`doctor`), so a two-version-stale plugin cannot shape a whole session unnoticed.

## F4 (Medium) `npm run check` executes the offline suites twice
`test:coverage` (scripts/coverage-report.mjs) re-runs all 16 subject suites under
NODE_V8_COVERAGE after they already ran individually in the chain; the coverage step alone was
the longest segment of the run. Fix: run the suites once under coverage and treat that pass as
the gate, or split coverage into its own parallel CI job.

## F5 (Low) CI hardening
- No `concurrency: cancel-in-progress` in .github/workflows/ci.yml -> superseded pushes keep
  burning a 2-job matrix plus a Windows runner.
- scripts/validate-ci-coverage.mjs reads ci.yml as one text blob, so it is job-blind: a suite
  present only in windows-validation can satisfy the gate meant for offline-validation.

## F6 (Low) Coverage floor is global only, and the weak spot is the agent-facing layer
Lowest modules are all CLI command handlers — the surface the skills instruct the model to
call: commands/activation 70.9, commands/delivery 71.8, commands/artifacts 72.3,
commands/run 74.9, commands/task 75.2. Fix: add per-path floors for `runtime/commands/*`
alongside the global 90.

## F7 (Low) No retention/gc for `.agent-sdlc`
45-command CLI surface has no `prune`/`gc`. Runs, per-run event JSONL, task records and
content-addressed artifact objects only grow (330K/13 files here — cheap now, unbounded later).

## F8 (Low) No syntax or lint gate over 36k lines of hand-written ESM
No eslint/prettier/tsconfig and no `node --check` sweep. With a 90% global floor, up to 10% of
bytes are never executed by any suite, so a syntax or reference error there ships.

## Not defects (blocked upstream, correctly reported)
- Codex activation is SOFT: this package declares no Codex plugin hook; the managed
  `$CODEX_HOME/AGENTS.md` bootstrap is not installed here (`activation doctor`).
- Live qualification PENDING: no authenticated codex host CLI in this environment. Release gate,
  not a test failure.

---

All reproduced with `bin/agent-sdlc` on win32, node v24.14.0, at aba951a.

## F9 (High) `spawnSync` cannot launch the project commands `init` itself writes
`runtime/tools.mjs:10` execs the configured command with bare `spawnSync`, no shell and no
Windows shim resolution. `.agent-sdlc/project.json` (written by `init`'s node detection) holds
`["npm","test"]` / `["npm","run","build"]`, and `npm` is `npm.cmd` on Windows:
  spawnSync('npm',['test',...]) -> {status:null, error:'ENOENT'}
  spawnSync('node',['scripts/validate-cli-surface.mjs']) -> {status:0, 1182 bytes stdout}
So `test.run_targeted`, `test.run_full` and `build.run` are all dead on Windows for a node
project. runtime/provider.mjs already solved this class for host binaries (`launcher()` at :50
handles .mjs/.cjs/.js), but it does not handle `.cmd`/`.bat` and tools.mjs does not use it.
Fix: one shared `launcher`/`resolveExecutable` covering script hosts AND Windows shims, used by
both provider.mjs and tools.mjs.

## F10 (High) ENOENT and ETIMEDOUT are laundered into "test failure" with zero diagnostics
`exec()` maps `status!==0` to FAIL, `exit_code: r.status ?? 1`, and `summary` to
`(stdout||'')+(stderr||'')`. On ENOENT/ETIMEDOUT all three are empty, `raw` is '' so
`full_log_artifact` stays null, and `r.error`/`r.signal` are discarded:
  {"tool":"test.run_targeted","status":"FAIL","exit_code":1,"summary":"","full_log_artifact":null}
`recordEvidence` then writes `targeted_verification_pass: FAIL` from it. An operator sees a
failing test suite; the truth was "the binary does not exist". Fix: surface `error.code` and
`signal` as distinct statuses (`TOOL_NOT_EXECUTABLE`, `TIMEOUT`), never as FAIL.

## F11 (High) Vacuous PASS: an empty selector satisfies the VERIFY gate
`runtime/commands/tools.mjs:22` builds tool args from `--args` JSON **only**; `--selector` is not
read. The CLI accepts unknown flags silently, so `--selector X` looks accepted, `{selector}`
substitutes to `''`, and:
  spawnSync('node',['']) -> {status:0, stdout:0 bytes}
  bin/agent-sdlc tool-run --tool test.run_targeted --selector scripts/validate-cli-surface.mjs
    -> {"status":"PASS","exit_code":0,"summary":""}
That PASS was recorded as `targeted_verification_pass` and satisfied the VERIFY gate. A flag typo
defeats the "evidence, not assertion" invariant. Fix: reject an empty/unsubstituted `{selector}`
before spawning; reject a PASS with no captured output; make the CLI fail on unknown flags.

## F12 (Medium) Built-in secret scan cries wolf on ordinary code and its own fixtures
`security.secret_scan` (runtime/tools.mjs:14) has no allowlist and its pattern
`token\s*[:=]` matches ordinary code. Current result: FAIL on
  runtime/telemetry.mjs:74   `const token={input_tokens:0,...}`
  evals/alpha6-runtime.mjs   the scanner's own leak fixtures (AKIA..., api_key = "sk-...")
  evals/run-deterministic.mjs the scanner's own test fixtures
All three are false positives. This does not block the VERIFY gate: `no_new_high_security_findings`
is absent from `evidence_authority` in `policies/stage-policy.json`, and `guardEvidenceAuthority`
(`runtime/orchestrator.mjs:25-34`) throws only for tokens whose authority is `'runtime'`, so the
token is operator-assertable regardless of what the scanner reports. The harm is signal quality,
not gating: a scanner that fires on `const token={` and on its own fixtures trains an operator to
assert past it, which is worse than a scanner that stays quiet. Fix: require a value-shaped match
(`(token|secret|api[_-]?key)\s*[:=]\s*['"][A-Za-z0-9_\-]{16,}`), and support a project allowlist
of path globs + pattern IDs.

## F13 (Low) DX: `design mode` output is not accepted by `design validate`
`design mode` emits `agent-sdlc/design-discovery-decision/v1`; `design validate` requires
`agent-sdlc/design-decision/v1` and additionally `decision_id`, `objective`, `skip_reason`. The
two commands in one group do not compose, and templates/ has no design-decision scaffold, so the
artifact the DESIGN gate requires must be hand-authored from the validator's error codes.
Fix: emit a valid draft from `design mode`, or add `design scaffold`.

## F14 (Low) Running the gate dirties the tracked tree
`npm run check` rewrites tracked report JSONs (evals/COVERAGE.json, PROVIDER-VALIDATION.json,
CLI-SURFACE-VALIDATION.json), so every local gate run leaves the worktree dirty and can produce
a spurious diff in a delivery check. Fix: write reports to a gitignored dir, or commit them only
via an explicit `--update`.

## F15 (High) Task-verification path bypasses the launcher and repeats F9/F10/F11
`runtime/task-verification.mjs:82` runs `spawnSync(c.command[0], c.command.slice(1), ...)` with
`c.command` read verbatim from `.agent-sdlc/project.json`'s `plannedCommands` (lines 34-42) --
no `resolveLaunch`, no `describeSpawn`, no `{selector}` substitution. This is a second consumer
of the same project config that `runtime/tools.mjs` now routes through `runtime/launcher.mjs`,
and it still carries all three original bugs on this execution path: `npm` is ENOENT on Windows
because no shim resolution runs, that ENOENT is laundered into `exit_code:1`/FAIL with no
diagnostic, and an unsubstituted `{selector}` is handed to the test runner literally. Found by
the whole-branch review of this plan and deliberately deferred, since fixing it belongs to its
own reviewed change rather than a final-review commit. Fix: route `plannedCommands` execution
through `runtime/launcher.mjs` the way `runtime/tools.mjs` now does.

## Local state changed by this spike (disclosed)
`.agent-sdlc/project.json` `commands.test_targeted` was changed from `["npm","test","--",
"{selector}"]` to `["node","{selector}"]` to get past F9 and obtain real verification evidence.
`.agent-sdlc/` is gitignored; the previous file is at `.agent-sdlc/project.json.bak`.
No tracked file was modified: `git status --porcelain` is empty.
