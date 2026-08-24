# Release Notes — 3.0.0-alpha4

Theme: **auto-bootstrap**. Normal software-engineering requests enter Agent SDLC without the user
naming `sdlc-router`, while the always-on context stays tiny and non-project Q&A stays unaffected.

## Added

- `policies/auto-activation.json` — canonical auto-activation policy: scope, skip list, entry
  chain, per-host delivery modes, token budgets, event names, config precedence.
- `runtime/activation.mjs` — canonical bootstrap text, policy/status/mode resolution, rough-token
  metrics, activation events, and a deterministic classifier for evals and diagnostics. Reads no
  repository content, opens no network connection, calls no model.
- `runtime/codex-bootstrap.mjs` + `scripts/codex-bootstrap.mjs` — managed, idempotent, reversible
  auto-activation block in `$CODEX_HOME/AGENTS.md`, with `AGENTS.override.md` masking detection.
- `adapters/hooks/claude-session-start.mjs` — Claude Code `SessionStart` hook returning the compact
  invariant as `hookSpecificOutput.additionalContext` for `startup|resume|clear|compact|fork`.
- `scripts/gen-activation-assets.mjs` — compiles the canonical text into every provider asset, so
  the Antigravity root/adapter hooks and rules cannot drift apart.
- `agent-sdlc activation` CLI: `status`, `enable`, `disable`, `print-bootstrap`, `policy`, `cost`,
  `classify`, `events`, `record`, `doctor`, `codex-bootstrap install|uninstall|status`.
- `evals/activation/` — deterministic (34 cases), multi-turn, adversarial and provider-expectation
  corpora.
- `scripts/test-auto-bootstrap.mjs`, `scripts/test-claude-bootstrap-hook.mjs`,
  `scripts/test-antigravity-bootstrap-hook.mjs`, `scripts/test-codex-bootstrap.mjs`, plus
  `npm run test:activation`.
- `docs/AUTO-ACTIVATION.md`.
- `scripts/archive.mjs` — portable zip/unzip so build, verification and packaging run on Windows as
  well as POSIX.

## Changed

- Claude hooks now declare `SessionStart` alongside the unchanged `PreToolUse` destructive-command
  guard. The Antigravity `PreInvocation` hook and plugin rule now carry auto-routing semantics
  instead of the alpha3 "follow the active workflow" reminder.
- `sdlc-router` description broadened for reliable automatic selection and explicit generic-Q&A
  exclusion; both public skills state that automatic entry is not approval.
- `scripts/build-dist.mjs`, `scripts/verify-dist.mjs`, `scripts/validate-github-install.mjs` and
  `evals/run-deterministic.mjs` now assert the bootstrap assets, budgets and generated-asset
  freshness. `verify-dist` also runs an `activation status` smoke check against extracted bytes.
- `scripts/qualify-host.mjs` runs an activation probe whose prompts name no Agent SDLC skill and
  records `activation_result` per case (`AUTO_ACTIVATED`, `SOFT_DISCOVERY_ACTIVATED`,
  `NOT_ACTIVATED`, `UNSUPPORTED`, `PENDING`). Probe rows gate the host verdict.
- `install.sh` / `install.ps1` gained `--auto-activate` / `--no-auto-activate` / `--dry-run`
  (`-AutoActivate` / `-NoAutoActivate` / `-DryRun`); `uninstall.sh` gained `--dry-run` and
  `--keep-bootstrap` and removes only the Agent SDLC managed block.
- Version references, plugin manifests and marketplaces moved to `3.0.0-alpha4`; the MCP server and
  project state stamp now read the version from the manifest instead of a hard-coded string.

## Fixed

- `runtime/util.mjs` `rootFrom()` used `URL.pathname`, which produced `D:\D:\...` on Windows and
  broke the MCP server and every packaged CLI invocation there. It now uses `fileURLToPath`.

## Boundaries and known limitations

- **No strong-activation claim.** Every offline status reports `strong_activation: false` with
  `NOT_ESTABLISHED_BY_OFFLINE_VALIDATION`. Claude and Antigravity are `STRONG_PENDING_LIVE_QUALIFICATION`;
  only live evidence may promote that.
- **Codex is soft natively.** `.codex-plugin/plugin.json` still declares no hooks. A native
  marketplace install gives skill discovery only; strong activation needs the managed
  `$CODEX_HOME/AGENTS.md` block installed by the universal installer, and an existing
  `AGENTS.override.md` masks it (reported as a warning, never as success).
- Activation is not authorization. Production, destructive, credential and security-exception
  actions keep their approval requirements, and untrusted repository/tool content cannot disable
  activation or bypass gates.
- Live host qualification remains **LIVE_HOST_PENDING**. Do not promote to `rc1` on offline
  simulations.

## Token overhead

Canonical bootstrap: 303 chars / **76 rough tokens** (budgets: canonical 120, Claude 90,
Antigravity 80, Codex 120). No internal skill body is injected at session start; public skill count
stays exactly two.
