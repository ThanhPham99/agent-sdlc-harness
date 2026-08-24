# Installation

The source repository itself is installable through each supported host. Generated ZIPs under `dist/` are optional release artifacts.

## Claude Code — GitHub marketplace

The repository root contains `.claude-plugin/marketplace.json` whose single entry points to `./`, and `.claude-plugin/plugin.json` contains the Claude plugin metadata and component paths.

```text
/plugin marketplace add ThanhPham99/agent-sdlc-harness
/plugin install agent-sdlc-harness@agent-sdlc-github
```

CLI automation:

```bash
claude plugin marketplace add ThanhPham99/agent-sdlc-harness
claude plugin install agent-sdlc-harness@agent-sdlc-github
```

For a tag/ref, Claude's marketplace command supports pinning the GitHub marketplace source to a ref. Keep the plugin version and marketplace version synchronized when publishing tagged releases.

## Codex — GitHub marketplace

The repository contains `.agents/plugins/marketplace.json` and `.codex-plugin/plugin.json`.

```bash
codex plugin marketplace add ThanhPham99/agent-sdlc-harness
codex plugin add agent-sdlc-harness@agent-sdlc-github
```

Use a new Codex thread after install/update. `codex plugin add` is intentionally safe to run again as the reinstall/repair path.

## Antigravity — direct GitHub plugin

The repository root is also a valid Antigravity plugin root (`plugin.json`, `mcp_config.json`, `hooks.json`, `skills/`, `agents/`, `rules/`).

```bash
agy plugin install https://github.com/ThanhPham99/agent-sdlc-harness
```

Reinstall with the same command to update.

## Universal bootstrap

```bash
./install.sh --repo ThanhPham99/agent-sdlc-harness --host all
./install.sh --repo ThanhPham99/agent-sdlc-harness --host claude
./install.sh --repo ThanhPham99/agent-sdlc-harness --host codex
./install.sh --repo ThanhPham99/agent-sdlc-harness --host antigravity
```

Auto-activation options:

```bash
./install.sh --host all --dry-run            # print planned actions, change nothing
./install.sh --host codex --no-auto-activate # soft skill discovery only, write no file
./install.sh --host codex --auto-activate    # explicit (this is also the default)
./install.ps1 -HostName all -DryRun
./install.ps1 -HostName codex -NoAutoActivate
```

The script invokes native host commands; the only host-owned file it writes is the delimited
Agent SDLC auto-activation block in `$CODEX_HOME/AGENTS.md`, which exists because Codex has no
plugin hook contract this package will claim. It is idempotent, backed up before first
modification, reversible, and preserves surrounding content. Claude Code and Antigravity receive
their bootstrap from the plugin's own hooks, so nothing outside the plugin is touched. If
`$CODEX_HOME/AGENTS.override.md` exists it masks the block, and the installer says so instead of
claiming strong activation. See `docs/AUTO-ACTIVATION.md`.

Requires `node >= 18` in the shell running the installer for the managed Codex block; below that
floor the installer reports soft activation and writes nothing.

## Uninstall

```bash
./uninstall.sh --host all
./uninstall.sh --host codex --keep-bootstrap   # leave the managed block in place
./uninstall.sh --host all --dry-run
```

Uninstall removes the plugin through each native host command and removes only the Agent SDLC
managed block from the global Codex `AGENTS.md`; other content in that file is preserved. The file
itself is deleted only when Agent SDLC created it and nothing else remains.

Project run state under `.agent-sdlc/` is intentionally not deleted by plugin uninstall.
