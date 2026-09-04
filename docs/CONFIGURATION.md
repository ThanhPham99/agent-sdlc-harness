# Configuration

Configuration is resolved in deterministic precedence order:

1. built-in policies and registries shipped with the harness;
2. global user config at `~/.agent-sdlc/config.json` — set `AGENT_SDLC_HOME` to resolve that `~` somewhere else (a sandbox, a test fixture, an XDG-style layout). It is the single override for the global layer on every platform, including Windows, where `$HOME` is not what a home directory resolves from;
3. project config at `.agent-sdlc/project.json`;
4. environment overrides supported by the runtime/provider adapter;
5. explicit CLI arguments.

Inspect the effective configuration with:

```bash
./bin/agent-sdlc config-show
```

Project config owns repository-local facts such as build/test commands, project invariants and provider preference. Security policy, stage gates and protocol schemas are versioned with the harness. Do not place API keys or production credentials in project config; use the host/provider credential mechanism or an external secret broker.

## Verification commands

`commands.test_targeted` is the command a task's own verification runs, and
`{selector}` is replaced by the task's `verification.targeted_tests`. The
selector has to actually narrow what runs. `init` writes the conventional
default for the stack — for Node, `npm test -- {selector}` — which is right for
a runner that filters on its argument and silently wrong for a bespoke runner
that ignores it: the whole suite runs, every task takes the same minutes, and
the evidence says `TARGETED` while nothing was targeted.

If your `npm test` ignores its arguments, point the command at something that
does not. Naming npm scripts is usually the least surprising choice:

```json
{ "commands": { "test_targeted": ["npm", "run", "{selector}"] } }
```

with each task declaring the script it needs in `verification.targeted_tests`.

A task's verification also parses the JavaScript files in its own diff with
`node --check`, whatever the test command does, so a file the task broke fails
that task rather than surviving to the run's VERIFY stage. This is not
configurable and costs nothing on a diff with no JavaScript in it.

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

## Hooks: shell guards and status line

Two PreToolUse hooks wire into every Bash-capable tool call on Claude Code and Codex (`adapters/claude/hooks.json`, `adapters/codex/hooks.json`):

- `hooks/pretool-guard.mjs` — defense-in-depth guard for destructive/irreversible shell commands.
- `hooks/test-output-guard.mjs` — token-hygiene guard: denies known verbose, unfiltered test-runner and log-dump commands (`npm test`, `pytest`, `cat *.log`, `docker logs` without `--tail`, ...) and asks for a bounded form instead (piped through `grep`/`head`, a quiet/reporter flag, or a line cap), so raw output does not reach the model's context uninspected. Already-bounded commands are left untouched. Disable with `AGENT_SDLC_TEST_OUTPUT_GUARD=0|false|off`. Corpus and matcher-coverage checks: `npm run test:test-output-guard`.

A status line is a per-user/per-project display preference, so it is not wired automatically. Opt in from `.claude/settings.json` (project) or `~/.claude/settings.json` (user):

```json
{
  "statusLine": {
    "type": "command",
    "command": "node \"${CLAUDE_PLUGIN_ROOT}/hooks/statusline.mjs\""
  }
}
```

It prints `model | ctx N% | cost $N.NN | branch <name>`, omitting any field the host's status payload does not provide. Smoke test: `npm run test:statusline`.

## Repository intelligence (alpha6)

`.agent-sdlc/index/repo-index.json` is a cache, not state: delete it freely, `repo index`
rebuilds it. Indexing covers git-tracked files only, so `.gitignore` governs scope. Files
larger than 512KB and the usual build/vendor directories are skipped and counted as skipped.

`policies/cost-context-governance.json` controls the cost/context governor: complexity
thresholds, per-risk model floors, mandatory independent review, context compaction ratios,
retry escalation and budget reserves. Raising a floor is always allowed; the hard rule is
that no setting in this file may lower a security or review requirement.
