# Changelog

All notable changes to the Agent SDLC Harness project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- AI-Native SDLC Playbook enhancements:
  - Proto-spec and intent intake: added `templates/intent.md` proto-spec template, scaffolded `.agent-sdlc/intent/` directory in `runtime/store.mjs`, and updated `runtime/normalize.mjs` to recognize `# Intent:` headers and flag `is_intent: true`.
  - Policy escalation in design: added `flagged_policy_concerns` in `templates/design-decision.json` and `templates/design.md`, with automatic escalation to human approval on blocking concerns in `runtime/design-discovery.mjs`.
  - Test-file protection guard & plan-scope drift detection in `adapters/hooks/pretool-guard.mjs` (mirrored to `hooks/pretool-guard.mjs`): prevents test file deletion/modification during bugfix/hotfix tasks, and prompts for user confirmation upon drift from declared task files.
  - Tri-pass review protocol & nit capping: added `templates/REVIEW.md` (Pass 1 Bugs, Pass 2 Security, Pass 3 Compliance) and implemented nit capping (max 5 nits, reporting remainder in `nit_count_omitted`) in `runtime/task-review.mjs`.
  - Statistical control bands: added `templates/bands.yaml`, `policies/control-bands.json`, and `runtime/control-bands.mjs` to calculate metric baselines, classify anomalies (1-sigma normal, 2-sigma diagnose, 3-sigma breach), and automatically generate anomaly intent proto-specs.
  - Coexistence architecture: added `source_of_truth_mode` (`local_primary`, `external_primary`, `bi_directional_sync`) to `detectProject`/`initProject`, added `external_tracker` metadata to `protocol/schemas/Feature.schema.json`, and documented synchronization models in `docs/architecture/ARTIFACT-MODEL.md`.
- `hooks/test-output-guard.mjs` (`adapters/hooks/test-output-guard.mjs`): a second PreToolUse guard, wired alongside `pretool-guard.mjs` on Claude Code and Codex, that denies known-verbose unfiltered test-runner and log-dump commands (`npm test`, `pytest`, `cat *.log`, `docker/kubectl logs` without `--tail`, ...) and asks for a bounded form instead, so raw output does not reach the model's context uninspected. Already-bounded commands pass through untouched. Corpus and matcher-coverage checks: `scripts/validate-test-output-guard.mjs` / `npm run test:test-output-guard`, wired into `test:integrity`.
- `hooks/statusline.mjs` (`adapters/hooks/statusline.mjs`): opt-in Claude Code status line showing model, context %, cost and git branch, wired manually via `settings.json` since a status line is a per-user/per-project preference, not something a plugin manifest can impose. Smoke-tested by `scripts/test-statusline.mjs` / `npm run test:statusline`.
- `scripts/validate-ci-coverage.mjs`: every suite reachable from `npm run check` must be run by CI, directly or through an aggregate; wired into `test:integrity`.
- CI now gates `test:gates`, `test:tasks`, `test:alpha6` and both qualification suites, which were green locally but ungated.
- CI matrix: node 18 (the floor declared by `engines`) and node 22, plus a `windows-latest` job covering the platform-sensitive runtime surfaces.
- Router keyword coverage for Vietnamese objectives and for read-only assessment verbs (`investigate`, `assess`, `evaluate`, `feasibility`).
- `scripts/dev-link.mjs` plus `dev:status` / `dev:link` / `dev:unlink`: report how far the host's plugin cache has drifted from the working tree, and reversibly point it at the checkout so edits reach a live session.
- `scripts/coverage-report.mjs` plus `test:coverage` / `coverage:update`: dependency-free V8 block coverage for `runtime/`, ratcheted in `evals/COVERAGE-FLOOR.json`. Coverage is the union of every process that loaded a module, so a spawned CLI counts.
- `scripts/test-cli-contract.mjs` (`test:cli-contract`): 40 checks driving the real CLI as an agent does -- spawned, one argv at a time -- over the stage loop, artifact and handoff round-trips, usage accounting, replay, repository intelligence, the read-only reference surfaces, and the error contract (structured error, non-zero exit, no stack trace). Raised measured runtime coverage from 73% to 80% and `runtime/cli.mjs` from 0% to 47%.
- `scripts/validate-cli-surface.mjs` (`test:cli-surface`, part of `test:integrity`): the CLI help text must match the commands actually dispatched, in both directions.
- `scripts/test-normalize.mjs` (`test:normalize`): 19 checks over the untrusted document parsers, with OOXML fixtures built by the repository's own zip writer. Raised `runtime/normalize.mjs` from 22% to 90% coverage and the runtime to 82% overall.
- `zipDir` accepts `{prefix}`; `prefix:''` writes entries at the archive root, which OOXML containers require.

### Fixed
- `context_hash` no longer depends on the checked-out line endings: text that feeds a hash goes through `readTextFile`/`normalizeText` in both context compilers and in the repository index, so the same commit produces the same hash on Windows and Linux.
- Run documents are written atomically (temp file + rename) like task records already were, and `saveRun` refuses a stale write (`STALE_RUN_STATE`) instead of silently discarding a concurrent writer's evidence. The version token is a monotonic `revision` counter, not `updated_at`: millisecond timestamps collide on a fast filesystem, so the timestamp version of this guard let the stale write through on Linux while passing on Windows.
- Router normalization folds diacritics, so an objective typed without accents (`sua loi`, `su co`) reaches its rule instead of falling through to `new-feature` with the wrong stage set and profile.
- CLI help text now documents `task replay`, `task fallback` and `task resume`, which were implemented but undiscoverable — the help text is the only CLI discovery surface an agent has.

- `scripts/test-provider.mjs` (`test:provider`): 23 checks over host probing, capability detection, invocation building and run outcomes, with `spawn` injected so the bounds hold on every platform. Raised `runtime/provider.mjs` from 39% to 94% coverage and the runtime to 83% overall.

- `scripts/test-compat.mjs` (`test:compat`): 12 checks over state discovery, refusal paths and migration, including the CLI surface. Raised `runtime/compat.mjs` from 35% to 99% coverage and the runtime to 83% overall.
- `compat-check` reports `HARNESS_VERSION_CHANGED` when state was written by a different harness version, and `migrate` records the change in `state.json` with a `migrations` history instead of answering `NOOP`. State that does not record any harness version is stamped rather than reported as clean.

- `scripts/test-mcp.mjs` (`test:mcp`): 24 checks spoken to a spawned MCP server over newline-delimited JSON-RPC, covering protocol handling, the run loop, untrusted argument types, profile enforcement and clean shutdown on stdin EOF. Raised `runtime/mcp-server.mjs` from 65% to 85% coverage and the runtime to 84% overall.

- `scripts/test-project-detection.mjs` (`test:detection`): 22 checks over per-stack detection, hand-edited manifests, polyglot repositories and config layering. Raised `runtime/init.mjs` from 50% to 99% and `runtime/config.mjs` from 73% to 98%; runtime 85% overall.
- Project detection covers maven (`pom.xml`), gradle (`build.gradle`, preferring `./gradlew` when a wrapper is present), dotnet (`*.sln`/`*.csproj`/`*.fsproj`) and python via `requirements.txt`, `setup.py` or `tox.ini`. Each previously reported `stack: unknown` with no commands, leaving verification gates nothing to run.
- `detectProject` reports every detected stack in `stacks` and explains what it could not work out in `detection_warnings`, including when no test command could be derived.

- `scripts/validate-ci-coverage.mjs` asserts step *order* as well as membership. Checking membership alone let CI run the qualification suites before `build`, so they validated packages that did not exist yet.
- The CI workflow's step list is generated from the `check` chain rather than hand-ordered, and validation reports upload even when a run fails, so a red CI can be diagnosed from its evidence instead of by reproducing the environment.
- The coverage floor is advisory on a machine missing `unzip` or `pdftotext`: those suites skip, which lowers the number for a reason that is not a regression. `optional_tools` records what was available.

### Security
- **`force` could be set by a value that says false.** `!!"false"` is true, and hosts (and the models driving them) routinely serialize booleans as strings, so `{"force":"false"}` over MCP — and `--force false` on the CLI — bypassed gate evidence: a run skipped two stages with no evidence and no approval. `truthy()` now parses booleans at both boundaries for flags that *remove* a protection (`force`, `approved`, `allow-interface-grouping`); flags that add one stay permissive so an unparseable value fails safe in both directions.
- **The MCP profile was advisory.** `AGENT_SDLC_MCP_PROFILE=core` hid the granular task tools from `tools/list` while `tools/call` still answered them, so the narrowed surface constrained nothing. Calls to a tool outside the active profile are now refused.
- An MCP argument declared as an array but sent as a string was spread character by character downstream, turning one evidence token into twenty-two one-letter ones. Such arguments are now rejected with what was wrong.
- **Unbounded host probing.** `probe()` ran `--version` and `--help` with no timeout and the default 1 MB buffer, so a host CLI that hung — or one waiting on input — blocked `doctor`, `model-route` and every stage invocation indefinitely. Probes are now bounded (5 s, 4 MB) and a host that does not answer is reported as unavailable. Results are memoized per process; `resetProbeCache()` clears them.
- **Unspawnable prompts failed opaquely.** The stage prompt travels as an argv element, and Windows caps a command line at 32767 characters while POSIX caps one argument at 128 KiB. `buildInvocation` now returns `PENDING` / `PROMPT_EXCEEDS_ARGV_LIMIT` with the measured size instead of letting `spawn` fail with `E2BIG`.
- **Output amplification in the XLSX parser.** A cell reference past the format's column limit was honoured: a single `r="ZZZZZ1"` cell padded the row to 12.3 million entries, turning a 1 KB workbook into a 111 MB markdown artifact (583 MB RSS), and one letter more threw `RangeError: Invalid array length`. References outside `A`–`XFD` are now dropped.
- **Crash on a malformed character reference.** `&#1114112;` in a DOCX or XLSX reached `String.fromCodePoint` and threw out of the parser; such references are now left as literal text.
- **Option and traversal injection via archive entry names.** XLSX sheet targets are read from `xl/_rels/workbook.xml.rels` inside the file, and were passed to `unzip` unchecked, so a name beginning with `-` arrived as an option and `..` was followed. Entry names are now validated before they reach the argv.
- A parser failure on untrusted input returns `PENDING` with `NORMALIZATION_FAILED` and a detail, instead of throwing out of `normalizeInput` and surfacing as a harness error.
- An unparseable `package.json` no longer stops initialization. A trailing comma made `init` — and `start`, which auto-initializes — fail outright with a bare `SyntaxError` on a repository the harness could otherwise work in; the parse failure is now a recorded warning naming the file.
- A repository whose primary stack declares no test script gets its test commands from another detected stack instead of ending up with none. Commands are filled per key, so a `package.json` with only a build keeps `npm run build` and still gets `go test` beside it.
- An unreadable global or project config layer is skipped and named in `problems` instead of throwing out of `resolveConfig`, which took down `config-show`, `doctor` and every activation check.
- `compat-check` no longer throws a raw `SyntaxError` on unreadable `state.json` — the command you run to diagnose broken state failed on exactly the file a non-atomic write could truncate. It now reports `CORRUPT_STATE` with the parse detail and a recovery action, and `migrate` refuses to touch it.
- `migrate` backs up `state.json`, the file it actually rewrites, instead of copying `project.json`, which migration never touches.
- `runHost` reports `timed_out` and the spawn `error` code, and leaves `exit_code` null when the host never ran. It previously forced `exit_code: 1` and discarded the error, making a wall-clock timeout indistinguishable from a host that ran and returned 1 — the distinction the fallback policy is built on.

### Changed
- Event sequence numbers come from a per-stream counter instead of re-reading and splitting the whole event log on every append (was quadratic per run).

## [3.0.0-alpha6] - 2026-08-25

### Added
- Complete registration of all 41 internal skills in `config/skills.json`.
- Slash commands support for Claude Code (`/sdlc-route`, `/sdlc-status`, `/sdlc-resume`, `/sdlc-task`, `/sdlc-doctor`).
- `AGENT_SDLC_MCP_PROFILE` profile support (`core` vs `full`) and `annotations.readOnlyHint` for MCP tools.
- Unified `agent_sdlc_task` MCP tool with `op` enum for compact host environments.
- Repository-level index truncation tracking (`is_truncated`, `omitted_files`) for large monorepos.
- Versioned model ID registry in `policies/model-routing.json`.
- Standard project distribution files (`LICENSE`, `SECURITY.md`, `CONTRIBUTING.md`, `CHANGELOG.md`).

### Changed
- Lazy dynamic `import()` for CLI subcommands, eliminating monolithic startup overhead.
- Multi-project isolation: cached policies and state machines in runtime are now keyed by project `root`.
- CI trigger branches updated to include both `master` and `main`.
- PreToolUse guard updated with comprehensive Windows command patterns (PowerShell, CMD) and test suites.

## [3.0.0-alpha5]

### Added
- Two-stage task review protocol (Spec Compliance then Code Quality).
- Live qualification harness and transport fixtures.

## [3.0.0-alpha4]

### Added
- Auto-activation contract and bootstrap hooks for Claude Code, Codex, and Antigravity.
- Local repository intelligence indexer with incremental blob hashing.

## [3.0.0-alpha3]

### Added
- Cost and context governance policies.
- Initial deterministic task graph scheduler.
