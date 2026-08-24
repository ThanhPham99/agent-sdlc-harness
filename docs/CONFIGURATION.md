# Configuration

Configuration is resolved in deterministic precedence order:

1. built-in policies and registries shipped with the harness;
2. global user config at `~/.agent-sdlc/config.json`;
3. project config at `.agent-sdlc/project.json`;
4. environment overrides supported by the runtime/provider adapter;
5. explicit CLI arguments.

Inspect the effective configuration with:

```bash
./bin/agent-sdlc config-show
```

Project config owns repository-local facts such as build/test commands, project invariants and provider preference. Security policy, stage gates and protocol schemas are versioned with the harness. Do not place API keys or production credentials in project config; use the host/provider credential mechanism or an external secret broker.

Host binaries can be pinned with `AI_SDLC_CLAUDE_BIN`, `AI_SDLC_CODEX_BIN`, and `AI_SDLC_ANTIGRAVITY_BIN`. Provider model IDs and pricing are deliberately not baked into prompts; model routing uses policy tiers and runtime capability/availability signals.
