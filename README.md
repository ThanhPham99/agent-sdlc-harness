# Agent SDLC Harness 3.0.0-rc2

A provider-neutral, token-aware, evidence-driven software-development harness for **Claude Code, OpenAI Codex, Google Antigravity, Cursor, and Kimi Code**.

The repository is intentionally **GitHub-installable**: the same source tree is a Claude marketplace + plugin, a Codex marketplace + plugin, and an Antigravity plugin root. The canonical SDLC runtime remains provider-neutral.

## Install from GitHub

### Claude Code

```text
/plugin marketplace add ThanhPham99/agent-sdlc-harness
/plugin install agent-sdlc-harness@agent-sdlc-github
```

Non-interactive equivalents:

```bash
claude plugin marketplace add ThanhPham99/agent-sdlc-harness
claude plugin install agent-sdlc-harness@agent-sdlc-github
```

### Codex CLI / Codex App

```bash
codex plugin marketplace add ThanhPham99/agent-sdlc-harness
codex plugin add agent-sdlc-harness@agent-sdlc-github
```

Then start a new Codex thread/session so the installed skills and MCP surface are rendered into fresh context. In the Codex app, the same configured marketplace can surface the plugin in the Plugins UI.

### Antigravity CLI

```bash
agy plugin install https://github.com/ThanhPham99/agent-sdlc-harness
```

Re-run the same command to refresh/reinstall from the repository.

### Cursor

In Cursor Agent chat, install directly via plugin:

```text
/add-plugin ThanhPham99/agent-sdlc-harness
```

### Kimi Code

In Kimi Code, install via plugin command:

```text
/plugins install https://github.com/ThanhPham99/agent-sdlc-harness
```

### Auto-detect installer

From a checkout:

```bash
./install.sh --repo ThanhPham99/agent-sdlc-harness
```

Or from a raw GitHub URL after the repo exists:

```bash
curl -fsSL https://raw.githubusercontent.com/ThanhPham99/agent-sdlc-harness/main/install.sh | bash -s -- --repo ThanhPham99/agent-sdlc-harness
```

PowerShell:

```powershell
./install.ps1 -Repo ThanhPham99/agent-sdlc-harness -HostName all
```

The bootstrap installer delegates to each host's **native plugin/marketplace command**. It hand-edits exactly one user file, and only for Codex: a delimited, idempotent, reversible auto-activation block in `$CODEX_HOME/AGENTS.md` (skip it with `--no-auto-activate`, preview with `--dry-run`). Claude and Antigravity configuration is never edited.

## Auto-activation

After installation, just ask naturally:

```text
Add idempotent refund processing to this repository.
```

You do not need to invoke `sdlc-router` manually. Agent SDLC auto-routes repository/software
lifecycle work; generic programming Q&A, tutorials and standalone examples remain unaffected.

Delivery is one compact instruction (**76 rough tokens**, budget 120), not a large always-on prompt:

| Host | Delivery | Class |
|---|---|---|
| Claude Code | plugin `SessionStart` hook (`additionalContext`), re-delivered on resume/`/clear`/compact/fork | strong, pending live qualification |
| Antigravity | plugin `PreInvocation` hook + plugin rule | strong, pending live qualification |
| Codex | installed-skill discovery (**soft**); strong only with the reversible managed block in `$CODEX_HOME/AGENTS.md` installed by `./install.sh` | soft natively |

Caveats: the Codex plugin manifest declares **no hooks**, because that contract is not treated as
stable here — a native marketplace install of Codex is soft activation only. No host is labelled
strong on the basis of packaging alone; `strong_activation` stays `false` until live host
qualification observes it.

Activation is not authorization: production, destructive, credential and security-exception
actions still require approval, and the `PreToolUse` destructive-command guard is unchanged. There
is no `--force`/`approval` bypass on `transition`; a privileged capability is granted only through
`agent-sdlc approval grant`, an interactive, TTY-gated command that is never reachable over MCP.

```bash
agent-sdlc activation doctor            # per-host delivery, class, token cost, warnings
agent-sdlc activation print-bootstrap   # the exact instruction being injected
AGENT_SDLC_AUTO_ACTIVATE=0              # disable delivery
agent-sdlc activation disable           # persist the same decision for this project
```

Full detail: `docs/AUTO-ACTIVATION.md`.

## The skill surface

Skills are the only public surface, identical on every host — there is no separate `commands/`
directory. Every skill is slash-invocable: `/sdlc-router`, `/sdlc-status`, `/sdlc-task`,
`/sdlc-resume`, `/sdlc-approve` and `/sdlc-doctor` all work. `agent-sdlc.manifest.json` declares
four tiers:

| Tier | Count | Members | Auto-activates |
|---|---|---|---|
| `entry_skills` | 2 | `sdlc-router`, `sdlc-orchestrator` | `sdlc-router` only (bootstrap); it hands control to `sdlc-orchestrator` |
| `ops_skills` | 5 | `sdlc-approve`, `sdlc-status`, `sdlc-resume`, `sdlc-task`, `sdlc-doctor` | no — invoked by name or slash command |
| `stage_skills` | 7 | `sdlc-requirements`, `sdlc-design`, `sdlc-plan`, `sdlc-implement`, `sdlc-verify`, `sdlc-review`, `sdlc-release` | no — `sdlc-orchestrator` activates the one named by `navigation.stage_skill` |
| `procedure_skills` | 24 | deeper single-purpose methodology modules under `skills/procedures/` (e.g. `tdd`, `systematic-debugging`, `git-delivery`, `code-review`) | no — resolved from run state via `navigation.procedure_skills`, never from a host's own picker |

38 skills total: the 14 entry/ops/stage skills sit at the `skills/` discovery root; the 24
procedure skills live under `skills/procedures/` so they never sit beside them. Read the surface
programmatically with `readSkillTiers()` from `scripts/lib/skill-tiers.mjs` — the single reader
every script in this repo uses, replacing six independent re-derivations of "what's public."
`config/skills.json` and `config/procedures.json` register the deeper per-skill metadata and
instruction bodies; `harness/internal-skills/` holds the 24 underlying guidance files those
procedure skills point at, loaded only when the deterministic lifecycle selects one. This keeps
discovery/base context small while preserving full SDLC coverage.

## Implemented scope

- deterministic lifecycle and 22 workflows covering feature work, requirement updates, bugfix/hotfix, refactor, performance, dependency upgrades, database migration, API breakage, security remediation, CI/CD, infrastructure, observability, incidents, maintenance, modernization, compliance, documentation, spikes, test-only work and deprecation/removal;
- 15 engineering/product/operations roles;
- deterministic input normalization for text, DOCX, XLSX and text-bearing PDF inputs, with explicit multimodal escalation for images/image-only PDFs;
- artifact-first external memory, JSONL event stream, durable handoffs, replay and token/cost ledger;
- bounded context compiler, progressive disclosure, model/effort routing, bounded parallelism and stage-specific budgets;
- stage/security policy engine, approval checks, deterministic tool gateway, secret redaction and MCP contracts for LSP/SAST/SCA/deploy/observability integrations;
- fixed live qualification corpus with 84 semantic/security + 8 repository-E2E cases per host, exact package/corpus/subject digest binding, freshness checks and fail-closed promotion;
- PreToolUse token-hygiene guard (`hooks/test-output-guard.mjs`) that denies unfiltered verbose test/log commands and nudges toward a bounded form, alongside the destructive-command safety guard;
- opt-in status line (`hooks/statusline.mjs`) showing model, context %, cost and git branch on every turn — see [Configuration](docs/CONFIGURATION.md).

## Local development

```bash
npm test
npm run test:activation
npm run validate:github
npm run test:github-installers
npm run build
npm run verify:dist
```

Or run the complete offline gate:

```bash
npm run check
```

Runtime quick start:

```bash
./bin/agent-sdlc init
./bin/agent-sdlc normalize --file ./requirements.docx
./bin/agent-sdlc route --objective "Add idempotent refund processing"
./bin/agent-sdlc start --objective "Add idempotent refund processing"
./bin/agent-sdlc doctor
```

## Repository distribution surfaces

```text
.claude-plugin/plugin.json          Claude plugin manifest
.claude-plugin/marketplace.json     Claude same-repo marketplace
.codex-plugin/plugin.json           Codex plugin manifest
.agents/plugins/marketplace.json    Codex same-repo marketplace
plugin.json                          Antigravity plugin manifest
mcp_config.json                      Antigravity MCP definition
hooks.json                           Antigravity hooks
rules/agent-sdlc.md                  Antigravity plugin rule (generated)
hooks/                               generated bootstrap + guard hooks
policies/auto-activation.json        canonical auto-activation policy
policies/skill-navigation.json       canonical stage/workflow/overlay -> skill policy
skills/                              14 entry/ops/stage skills (discovery root)
skills/procedures/                   24 procedure skills, never at the discovery root
harness/internal-skills/             24 on-demand internal capability modules
```

Provider-specific generated ZIPs remain available through `npm run build`; they are release artifacts, not the canonical Git repository.

## Release qualification

`alpha4` must remain **LIVE_HOST_PENDING** until the exact built Claude, Codex and Antigravity artifacts produce fresh FULL qualification evidence. Missing host CLIs or credentials are `PENDING`, never PASS. Only the release aggregator may produce a promotion approval.

See `docs/AUTO-ACTIVATION.md`, `docs/INSTALLATION.md`, `docs/GITHUB-DISTRIBUTION.md`, `docs/QUALIFICATION.md`, `docs/USAGE.md`, and `docs/architecture/`.
