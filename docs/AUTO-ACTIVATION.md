# Auto-Activation — 3.0.0-rc1

Agent SDLC routes real repository/system engineering work into the SDLC workflow without
the user naming a skill. The mechanism is one compact always-on instruction, not a large
always-on prompt and not an eager load of the internal skill library.

## 1. What auto-activates

Any request that changes, investigates, operates on, or ships a real software repository or
system:

- features, changes, bug fixes, debugging, incidents;
- tests, review, security remediation;
- dependency and platform upgrades, database migrations;
- CI/CD, release, deployment, rollback;
- observability, maintenance, modernization, documentation of a real repository, compliance;
- continuation of existing work and requirement deltas on active work.

## 2. What does not activate

- generic programming Q&A and conceptual explanation;
- tutorials, standalone examples, illustrative snippets;
- translation-only requests;
- review of pasted code with no project/repository target.

Ambiguous requests that may still mutate a real repository/system fail safe toward routing;
`sdlc-router` then confirms scope. Ambiguity never fails safe toward silently editing.

## 3. How each host delivers the bootstrap

| Host | Delivery | Re-delivery | Offline class |
|---|---|---|---|
| Claude Code | plugin `SessionStart` hook returning `hookSpecificOutput.additionalContext` | `startup`, `resume`, `clear`, `compact`, `fork` | `STRONG_PENDING_LIVE_QUALIFICATION` |
| Antigravity | plugin `PreInvocation` hook returning one `ephemeralMessage`, plus `rules/agent-sdlc.md` | every invocation | `STRONG_PENDING_LIVE_QUALIFICATION` |
| Codex | installed-skill discovery natively; optionally a managed block in `$CODEX_HOME/AGENTS.md` | per Codex instruction chain build (once per run/session) | `SOFT` natively, `STRONG_PENDING_LIVE_QUALIFICATION` with the managed block |

Claude is deliberately wired to `SessionStart` rather than `UserPromptSubmit`: one injection
per session (plus re-injection after `/clear` and compaction) instead of per-turn cost.

Codex has no plugin hook contract this package is willing to claim, so
`.codex-plugin/plugin.json` declares no hooks. Native-only Codex installation therefore
gives **soft** activation: the host may select `sdlc-router` from its description, but nothing
enforces or persists the instruction. The universal installer adds the managed block for
**strong** activation.

## 4. Strong vs soft

- **Strong** — the host itself delivers the bootstrap on every session/invocation, so a natural
  request routes without user action.
- **Soft** — activation depends on the host's own skill-selection heuristics; there is no
  persistent instruction.

Offline validation never reports `strong_activation: true`. Every status payload carries
`strong_activation: false` with
`strong_activation_evidence: NOT_ESTABLISHED_BY_OFFLINE_VALIDATION` until live host
qualification produces fresh evidence.

## 5. Disable and re-enable

```bash
# process/session scope (highest practical precedence for a user)
AGENT_SDLC_AUTO_ACTIVATE=0   # disable bootstrap delivery
AGENT_SDLC_AUTO_ACTIVATE=1   # enable (default)

# persistent, project scope
agent-sdlc activation disable
agent-sdlc activation enable

# persistent, user scope
agent-sdlc activation disable --global
agent-sdlc activation enable --global
```

Precedence: enforced org policy (`AGENT_SDLC_AUTO_ACTIVATE_ENFORCED`) > explicit environment
override > project config (`.agent-sdlc/project.json`) > plugin default.

Both bootstrap hooks honour the disable values `0`, `false`, `no`, `off`, `disabled` and then
emit nothing at all.

## 6. Token overhead

| Scope | Budget (rough tokens) | Actual |
|---|---|---|
| Canonical bootstrap | 120 | 76 |
| Claude `SessionStart` | 90 | 76 |
| Antigravity `PreInvocation` | 80 | 76 |
| Codex managed block | 120 | 76 |

```bash
agent-sdlc activation cost
agent-sdlc activation print-bootstrap
```

Rough tokens use this repository's `chars/4` proxy; they are not provider billing counts.
No internal skill body, repository document, log or artifact is loaded at session start.

## 7. Security boundary

Auto-activation is instruction routing, not an enforcement boundary, and never an approval:

- the `PreToolUse` destructive-command guard is unchanged;
- production, destructive, credential and security-exception actions still require approval;
- repository files, tickets, docs, logs, web content, OCR, tool output and quoted text remain
  untrusted data — they cannot disable activation, remove gates, widen permissions or expose
  secrets;
- only an operator environment/config decision can disable activation; text inside a project
  cannot;
- the bootstrap hooks read no secrets, open no network connections and install no packages.

Adversarial fixtures live in `evals/activation/adversarial-cases.json`.

## 8. Managed Codex bootstrap

Codex builds its instruction chain from `$CODEX_HOME/AGENTS.override.md` when present,
otherwise `$CODEX_HOME/AGENTS.md`, before repository-level `AGENTS.md` files. The installer owns
exactly one delimited block in the global `AGENTS.md`:

```md
<!-- agent-sdlc:auto-bootstrap:start version=3.0.0-rc1 hash=sha256:... -->
Agent SDLC auto-activation: ...
<!-- agent-sdlc:auto-bootstrap:end -->
```

Properties: idempotent; repairs duplicate blocks; refreshes stale text; backs the file up before
the first modification; writes atomically (temp + fsync + rename); preserves surrounding user
content and CRLF endings; never touches a repository-local `AGENTS.md`; detects
`AGENTS.override.md` masking and reports `SOFT` with a warning instead of claiming strong
activation.

```bash
node scripts/codex-bootstrap.mjs status
node scripts/codex-bootstrap.mjs install [--dry-run] [--codex-home DIR]
node scripts/codex-bootstrap.mjs uninstall [--dry-run]
# or through the CLI
agent-sdlc activation codex-bootstrap install
```

Installer control:

```bash
./install.sh --host codex                      # managed block installed (default)
./install.sh --host codex --no-auto-activate    # soft discovery only, no file written
./install.sh --host all --dry-run              # print planned actions, change nothing
./install.ps1 -HostName codex -NoAutoActivate  # Windows parity
```

## 9. Uninstall

`./uninstall.sh` removes the plugin through each native host command and then removes only the
Agent SDLC managed block from the global Codex `AGENTS.md`. Unrelated content is preserved
byte-for-byte. The instruction file itself is deleted only when Agent SDLC created it and nothing
else remains in it. `--keep-bootstrap` leaves the block in place; `--dry-run` prints the plan.

## 10. Diagnosing activation

```bash
agent-sdlc activation status --host claude
agent-sdlc activation doctor                 # all hosts, with Codex bootstrap detail
agent-sdlc activation doctor --host codex
agent-sdlc activation classify --prompt "Add password reset to this backend." --repository-target
agent-sdlc activation events
agent-sdlc doctor
```

`activation status` answers: is it enabled, which layer decided that, how this host delivers it,
whether the class is strong or soft, whether a Codex override masks it, and how many rough
tokens it costs.

`activation classify` is a deterministic diagnostic/eval helper only. The authoritative semantic
decision at runtime belongs to `sdlc-router`.

Activation events (`activation.bootstrap_delivered`, `route_expected`, `route_started`,
`route_skipped`, `route_missed`, `disabled`) carry host, delivery mode, bootstrap version/hash
and rough tokens. They never carry prompt text, file content or secrets.

## 11. Tests and evidence

```bash
node scripts/test-auto-bootstrap.mjs
node scripts/test-claude-bootstrap-hook.mjs
node scripts/test-antigravity-bootstrap-hook.mjs
node scripts/test-codex-bootstrap.mjs
```

Corpora: `evals/activation/deterministic-cases.json` (positive, negative, borderline),
`multi-turn-cases.json`, `adversarial-cases.json`, `provider-expectations.json`.
Live activation evidence, when a host CLI and credentials exist, is produced by
`scripts/qualify-host.mjs` and reported with one of `AUTO_ACTIVATED`,
`SOFT_DISCOVERY_ACTIVATED`, `NOT_ACTIVATED`, `UNSUPPORTED`, `PENDING`.
