# Implementation Status — 3.0.0-alpha3

Implemented: canonical lifecycle/state machine; 22 workflow variants; 15 role registry; two public discovery skills plus 18 on-demand internal skills; artifact/event/cost/handoff/replay stores; context compiler; deterministic input normalization; stage/security/parallel/model/failure policies; built-in tool gateway; stdio MCP server; provider capability probing; native package generation for Claude Code, Codex and Antigravity; deterministic offline evals; exact-artifact live qualification harness; fixed 84+8 live corpus; content-minimized token telemetry; evidence freshness/digest binding; portable evidence bundles; and RC promotion aggregation.

`3.0.0-alpha3` also closes two routing/trust gaps found while constructing the live corpus: continuation and requirement-delta work now have deterministic router rules, and the public router explicitly treats repository/ticket/log/web/OCR/tool content as untrusted data rather than instruction authority.

External integration contracts remain intentionally pluggable for project/organization LSP, SAST/SCA, deployment APIs and observability backends. Production credentials are never bundled.

The current build environment does not have authenticated `claude`, `codex`, or `agy` host CLIs, therefore current live evidence correctly remains `PENDING`. That is a release gate, not a test failure to bypass.
