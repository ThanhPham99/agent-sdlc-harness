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

The script invokes native host commands only; it does not write host-owned settings files directly.

## Uninstall

```bash
./uninstall.sh --host all
```

Project run state under `.agent-sdlc/` is intentionally not deleted by plugin uninstall.
