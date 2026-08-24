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

---

# Addendum â€” design discovery and plan quality

The alpha4 scope in the master upgrade plan has three themes, not one. Auto-bootstrap shipped
first; conditional design discovery and the machine-checkable plan gate complete the release.

## Added

- `policies/design-discovery.json` â€” canonical design-discovery policy: modes, profile defaults and
  bounds, escalation signals (with `deescalatable` marking), de-escalation ceilings, human-approval
  signals and profiles, option requirements, gate evidence mapping.
- `runtime/design-discovery.mjs` â€” deterministic `selectDesignDiscoveryMode`, `evaluateDesignGate`,
  `validateDesignDecision`, `requiredGateEvidence`. No repository reads, no network, no inference.
- `harness/internal-skills/design-discovery.md` â€” internal module (not a public skill) with the
  SKIP/COMPACT/FULL protocol: minimum context, one focused question at a time, 2â€“3 materially
  distinct approaches, a recommendation, and recorded rejection evidence when only one legitimate
  option exists.
- `protocol/schemas/DesignDecision.schema.json` â€” `agent-sdlc/design-decision/v1`.
- `protocol/schemas/TaskPlan.schema.json`, `protocol/schemas/PlannedTask.schema.json`.
- `runtime/plan-validator.mjs` â€” `validateTaskPlan`, `computeTaskGraph`, `findCycles`,
  `computeReadySets`, `computeCoverage`, `computeScopeConflicts`, `planGateEvidence`.
- `agent-sdlc design mode|policy|validate|record` and `agent-sdlc plan validate|graph|record`.
- `evals/design-discovery/cases.json` (13), `evals/design-discovery/adversarial-cases.json` (7),
  `evals/plan-quality/cases.json` (21); `scripts/validate-gates.mjs` and `npm run test:gates`
  producing `evals/DESIGN-DISCOVERY-VALIDATION.json` and `evals/PLAN-QUALITY-VALIDATION.json`.
- `docs/architecture/DESIGN-DISCOVERY.md`, `docs/architecture/PLAN-QUALITY.md`.

## Changed

- `policies/stage-policy.json`: `PLAN.gate_requirements` is now `plan_artifact_created`,
  `plan_schema_valid`, `plan_graph_valid`, `plan_acceptance_coverage_valid`,
  `plan_scope_conflicts_resolved`. A new top-level `evidence_authority` map marks design and plan
  gate tokens as `runtime` (produced only by a validator) and `design_human_approved` as `human`
  (accepted only alongside a recorded approval).
- `runtime/orchestrator.mjs`: `transition` refuses caller-asserted `runtime`/`human` authority
  evidence, and gains stage-scoped `recordDesignDecision` / `recordTaskPlan` recorders that emit
  `design.decision_recorded` / `design.decision_rejected` / `plan.validated` / `plan.rejected`.
- `config/skills.json` registers `design-discovery` as the 19th internal module; `planning.md`,
  `implementation-plan.md` and `architecture.md` now point at the structured artifacts and the
  recorder commands. `sdlc-orchestrator` documents the DESIGN -> PLAN -> IMPLEMENT contract.
- `agent-sdlc.manifest.json` `canonical` now lists the auto-activation and design-discovery
  policies. `npm run check` gained `test:gates` and runs `build` before the package validations.

## Fixed

- `scripts/build-dist.mjs` copied a non-existent top-level `tools/` directory, so `npm run build`
  (and therefore `verify:dist` and every packaging step) failed outright. The canonical tool
  registry is `config/tools.json`; the bogus entry is gone and missing build inputs now fail with a
  named error.
- `scripts/qualification-lib.mjs` `resolveBinary()` silently fell through an explicit `--binary`
  override to the next candidate, so the offline transport regression measured the *real* installed
  host CLI instead of its fake shim â€” a PASS it had not earned. An explicit override is now the
  only candidate tried.
- Host binaries are launched through `spawnHost()`, which routes `.mjs`/`.js` "binaries" via the
  current Node executable. `scripts/qualify-host.mjs` also extracts the exact release package with
  the portable `unzipTo()` helper instead of requiring Info-ZIP `unzip`. Together with Node-script
  fixtures in `scripts/test-qualification-harness.mjs`, the qualification regressions now run on
  Windows as well as POSIX.

## Boundaries

- `--force` remains the operator escape hatch for a blocked gate. It is audited and is never the
  agent's answer to a validation failure.
- Selecting `FULL` design discovery grants no tool authority; every decision carries
  `approval_implied: false`.
- Offline gate evidence records `PENDING_LIVE_QUALIFICATION` for anything only a live host can
  establish.
