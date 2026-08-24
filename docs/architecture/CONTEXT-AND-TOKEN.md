# Context and Token Governance

Stable prefix + stage skill + compact project invariants + relevant artifact summaries + exact symbols/diff + objective + output schema. Never ship entire chat history, repo tree, all tool definitions, raw test output, full application logs, or every failed hypothesis.

## Always-on budget

The only always-on context is the auto-activation bootstrap: one compact instruction of **76
rough tokens** (canonical budget 120; Claude 90 per session, Antigravity 80 per invocation, Codex
120 per instruction-chain build). It names the two public skills and nothing else — no internal
skill body, repository document, log or artifact is loaded at session start. Claude is wired to
`SessionStart` rather than per-turn injection precisely so this cost is paid once per session plus
once after `/clear` and compaction. `scripts/test-auto-bootstrap.mjs` fails the build if the text
exceeds any budget. Rough tokens are this repository's `chars/4` proxy, not provider billing.

Priority order: symbol/LSP → targeted grep → diff → relevant file ranges. Tests: targeted first, full suite only when dependency/risk closure requires it. Subagents return bounded evidence contracts and do not share transient reasoning.

Primary efficiency metric is **cost per verified successful task**, not token/task. Track success@1, escaped defects, p95 wall time, fresh/cached/output/reasoning tokens, tool calls, cache hits, retries, fan-out and policy violations.
