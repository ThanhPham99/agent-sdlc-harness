# Compatibility Matrix

| Capability | Claude Code | Codex | Antigravity | Harness strategy |
|---|---|---|---|---|
| Skills | native | native | native | generate from canonical public skills |
| Structured output | capability probe | capability probe / output schema | capability probe / JSON schema | local schema contract + native flag when available |
| Sandbox | permissions + external worktree/container | native sandbox modes | terminal/managed sandbox | stage maps to safest available mode |
| Hooks | native | native where supported | native | defense in depth only |
| MCP | native | native | native | canonical external tool contract |
| Resume | sessions | threads | conversations/interactions | provider state stored as optional run metadata |
| Auto-activation delivery | plugin `SessionStart` hook (`additionalContext`) | no claimed plugin hook contract; installed-skill discovery, plus optional managed block in `$CODEX_HOME/AGENTS.md` | plugin `PreInvocation` hook + plugin rule | one canonical compact instruction compiled per host |
| Auto-activation class (offline) | strong, pending live qualification | **soft** natively; strong only with the managed bootstrap | strong, pending live qualification | never asserted from packaging alone |
| Bootstrap re-delivery | startup, resume, `/clear`, compact, fork | per Codex instruction-chain build | every invocation | budgets 90 / 120 / 80 rough tokens |

Provider capabilities are probed at runtime rather than assumed from a hard-coded version.
`strong_activation` is reported `false` by every offline validation; only live host qualification
evidence (`scripts/qualify-host.mjs`) may report it true. Codex activation is labelled soft unless
the reversible managed bootstrap is installed and unmasked by `AGENTS.override.md`.
