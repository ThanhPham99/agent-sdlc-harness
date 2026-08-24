# GitHub Distribution

## Canonical rule

Push the **source tree**, not an offline-validation ZIP, to the repository root. The repository is the source of truth; GitHub Release assets are generated from it.

## Required root files

- `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`
- `.codex-plugin/plugin.json` and `.agents/plugins/marketplace.json`
- `plugin.json`, `mcp_config.json`, `hooks.json`, `agents/`, `rules/` for Antigravity
- `skills/sdlc-router/SKILL.md` and `skills/sdlc-orchestrator/SKILL.md`
- canonical runtime/config/policy directories

Do not move the internal capability modules back under the native `skills/` discovery tree. They belong in `harness/internal-skills/` so only the two entry skills add discovery/context overhead.

## Recommended repository workflow

1. Create a new GitHub repository.
2. Extract `agent-sdlc-harness-source-3.0.0-alpha4.zip`.
3. Push the extracted contents to repository root.
4. Run the GitHub Actions `CI` workflow.
5. Test marketplace/direct install from a clean account or throwaway host profile.
6. Run live host qualification.
7. Tag only after the release gate has the evidence required for the intended release class.

## Release assets

A tagged GitHub release should publish:

- `agent-sdlc-claude-<version>.zip`
- `agent-sdlc-codex-<version>.zip`
- `agent-sdlc-antigravity-<version>.zip`
- `agent-sdlc-harness-source-<version>.zip`
- `SHA256SUMS.txt`

The ZIPs are for archival/offline installation and qualification. GitHub marketplace/direct install should continue to target the repository itself.
