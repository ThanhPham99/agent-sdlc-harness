# Agent SDLC Harness 3.0.0-alpha3

A provider-neutral, token-aware, evidence-driven software-development harness for **Claude Code, OpenAI Codex, and Google Antigravity**.

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

The bootstrap installer delegates to each host's **native plugin/marketplace command**. It does not hand-edit Claude/Codex/Antigravity user configuration files.

## Why only two public skills?

Only these are host-discoverable:

- `sdlc-router`
- `sdlc-orchestrator`

The 18 canonical internal capability groups live under `harness/internal-skills/` and are loaded only when the deterministic lifecycle selects them. This keeps discovery/base context small while preserving full SDLC coverage.

## Implemented scope

- deterministic lifecycle and 22 workflows covering feature work, requirement updates, bugfix/hotfix, refactor, performance, dependency upgrades, database migration, API breakage, security remediation, CI/CD, infrastructure, observability, incidents, maintenance, modernization, compliance, documentation, spikes, test-only work and deprecation/removal;
- 15 engineering/product/operations roles;
- deterministic input normalization for text, DOCX, XLSX and text-bearing PDF inputs, with explicit multimodal escalation for images/image-only PDFs;
- artifact-first external memory, JSONL event stream, durable handoffs, replay and token/cost ledger;
- bounded context compiler, progressive disclosure, model/effort routing, bounded parallelism and stage-specific budgets;
- stage/security policy engine, approval checks, deterministic tool gateway, secret redaction and MCP contracts for LSP/SAST/SCA/deploy/observability integrations;
- fixed live qualification corpus with 84 semantic/security + 8 repository-E2E cases per host, exact package/corpus/subject digest binding, freshness checks and fail-closed promotion.

## Local development

```bash
npm test
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
skills/                              exactly two public skills
harness/internal-skills/             on-demand internal capability modules
```

Provider-specific generated ZIPs remain available through `npm run build`; they are release artifacts, not the canonical Git repository.

## Release qualification

`alpha3` must remain **LIVE_HOST_PENDING** until the exact built Claude, Codex and Antigravity artifacts produce fresh FULL qualification evidence. Missing host CLIs or credentials are `PENDING`, never PASS. Only the release aggregator may produce a promotion approval.

See `docs/INSTALLATION.md`, `docs/GITHUB-DISTRIBUTION.md`, `docs/QUALIFICATION.md`, `docs/USAGE.md`, and `docs/architecture/`.
