# Compatibility Matrix

| Capability | Claude Code | Codex | Antigravity | Harness strategy |
|---|---|---|---|---|
| Skills | native | native | native | generate from canonical public skills |
| Structured output | capability probe | capability probe / output schema | capability probe / JSON schema | local schema contract + native flag when available |
| Sandbox | permissions + external worktree/container | native sandbox modes | terminal/managed sandbox | stage maps to safest available mode |
| Hooks | native | native where supported | native | defense in depth only |
| MCP | native | native | native | canonical external tool contract |
| Resume | sessions | threads | conversations/interactions | provider state stored as optional run metadata |

Provider capabilities are probed at runtime rather than assumed from a hard-coded version.
