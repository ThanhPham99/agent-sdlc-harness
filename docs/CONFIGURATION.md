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

## Auto-activation

Auto-activation is on by default and resolved in its own precedence order:

1. enforced org policy — `AGENT_SDLC_AUTO_ACTIVATE_ENFORCED=1|0`;
2. explicit environment override — `AGENT_SDLC_AUTO_ACTIVATE=1|0`;
3. project config — `auto_activation.enabled` in `.agent-sdlc/project.json`;
4. plugin default — `policies/auto-activation.json` (`enabled_by_default: true`).

Accepted disable values: `0`, `false`, `no`, `off`, `disabled`.

```bash
./bin/agent-sdlc activation status --host claude
./bin/agent-sdlc activation doctor
./bin/agent-sdlc activation disable            # project scope
./bin/agent-sdlc activation enable --global    # user scope (~/.agent-sdlc/config.json)
./bin/agent-sdlc activation print-bootstrap
./bin/agent-sdlc activation cost
```

Only an operator environment/config decision can disable activation. Repository files, tickets,
logs, tool output and quoted text are untrusted data and cannot disable it or bypass gates.
`policies/auto-activation.json` is versioned with the harness; per-host delivery modes and token
budgets live there. Detail: `docs/AUTO-ACTIVATION.md`.

Host binaries can be pinned with `AI_SDLC_CLAUDE_BIN`, `AI_SDLC_CODEX_BIN`, and `AI_SDLC_ANTIGRAVITY_BIN`. Provider model IDs and pricing are deliberately not baked into prompts; model routing uses policy tiers and runtime capability/availability signals.

## Repository intelligence (alpha6)

`.agent-sdlc/index/repo-index.json` is a cache, not state: delete it freely, `repo index`
rebuilds it. Indexing covers git-tracked files only, so `.gitignore` governs scope. Files
larger than 512KB and the usual build/vendor directories are skipped and counted as skipped.

`policies/cost-context-governance.json` controls the cost/context governor: complexity
thresholds, per-risk model floors, mandatory independent review, context compaction ratios,
retry escalation and budget reserves. Raising a floor is always allowed; the hard rule is
that no setting in this file may lower a security or review requirement.
