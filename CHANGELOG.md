# Changelog

All notable changes to the Agent SDLC Harness project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- `scripts/validate-ci-coverage.mjs`: every suite reachable from `npm run check` must be run by CI, directly or through an aggregate; wired into `test:integrity`.
- CI now gates `test:gates`, `test:tasks`, `test:alpha6` and both qualification suites, which were green locally but ungated.
- CI matrix: node 18 (the floor declared by `engines`) and node 22, plus a `windows-latest` job covering the platform-sensitive runtime surfaces.
- Router keyword coverage for Vietnamese objectives and for read-only assessment verbs (`investigate`, `assess`, `evaluate`, `feasibility`).
- `scripts/dev-link.mjs` plus `dev:status` / `dev:link` / `dev:unlink`: report how far the host's plugin cache has drifted from the working tree, and reversibly point it at the checkout so edits reach a live session.
- `scripts/coverage-report.mjs` plus `test:coverage` / `coverage:update`: dependency-free V8 block coverage for `runtime/`, ratcheted in `evals/COVERAGE-FLOOR.json`. Coverage is the union of every process that loaded a module, so a spawned CLI counts.
- `scripts/test-cli-contract.mjs` (`test:cli-contract`): 40 checks driving the real CLI as an agent does -- spawned, one argv at a time -- over the stage loop, artifact and handoff round-trips, usage accounting, replay, repository intelligence, the read-only reference surfaces, and the error contract (structured error, non-zero exit, no stack trace). Raised measured runtime coverage from 73% to 80% and `runtime/cli.mjs` from 0% to 47%.
- `scripts/validate-cli-surface.mjs` (`test:cli-surface`, part of `test:integrity`): the CLI help text must match the commands actually dispatched, in both directions.

### Fixed
- `context_hash` no longer depends on the checked-out line endings: text that feeds a hash goes through `readTextFile`/`normalizeText` in both context compilers and in the repository index, so the same commit produces the same hash on Windows and Linux.
- Run documents are written atomically (temp file + rename) like task records already were, and `saveRun` refuses a stale write (`STALE_RUN_STATE`) instead of silently discarding a concurrent writer's evidence.
- Router normalization folds diacritics, so an objective typed without accents (`sua loi`, `su co`) reaches its rule instead of falling through to `new-feature` with the wrong stage set and profile.
- CLI help text now documents `task replay`, `task fallback` and `task resume`, which were implemented but undiscoverable — the help text is the only CLI discovery surface an agent has.

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
