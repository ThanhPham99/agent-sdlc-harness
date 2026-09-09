# GitHub Distribution

## Canonical rule

Push the **source tree**, not an offline-validation ZIP, to the repository root. The repository is the source of truth; GitHub Release assets are generated from it.

## Required root files

- `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`
- `.codex-plugin/plugin.json` and `.agents/plugins/marketplace.json`
- `plugin.json`, `mcp_config.json`, `hooks.json`, `agents/`, `rules/` for Antigravity
- the 14 entry/ops/stage skills directly under `skills/` (`skills/sdlc-router/SKILL.md`,
  `skills/sdlc-orchestrator/SKILL.md`, and the rest — see `agent-sdlc.manifest.json`'s
  `entry_skills`/`ops_skills`/`stage_skills`)
- `skills/procedures/` — the 24 generated procedure-skill wrappers, one level below the discovery
  root
- canonical runtime/config/policy directories

Do not hand-edit `skills/procedures/`; `scripts/gen-skill-surface.mjs --check` fails CI on drift
between it and `config/procedures.json`. Do not move a procedure skill's real guidance out of
`harness/internal-skills/` into a discovery-root `skills/` directory of its own — only the 14
entry/ops/stage skills belong at the discovery root, so only they add discovery/context overhead
on every host.

## Recommended repository workflow

1. Create a new GitHub repository.
2. Extract `agent-sdlc-harness-source-3.0.0-rc2.zip`.
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
