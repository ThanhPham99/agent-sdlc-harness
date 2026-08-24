# Changelog

All notable changes to the Agent SDLC Harness project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
