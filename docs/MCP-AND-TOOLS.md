# MCP and Tool Gateway

The local runtime exposes a stdio MCP server at `runtime/mcp-server.mjs`. Provider packages connect to the same provider-neutral runtime so workflow state, policy and artifacts do not depend on the host.

The MCP surface includes route/start/status/context/transition, policy-aware tool checking and execution, artifact creation and model routing. Tools are registered in `config/tools.json`; stage authorization is defined in `policies/stage-policy.json` and security constraints in `policies/security-policy.json`.

Built-in deterministic tools include `input.normalize`, repository read/search/diff, git status, targeted/full tests, build execution and a redacted secret scan. Web research capabilities (`web.search`, `web.fetch_url`) provide bounded online documentation and advisory lookup with automated secret sanitization and host/domain security filtering. External capabilities such as LSP/symbol intelligence, SAST/SCA, deployment and observability are contracts: connect them through MCP or a host integration while retaining the canonical policy decision before execution.

`input.normalize` is the preprocess-before-LLM path. It handles common text formats directly, DOCX/XLSX via deterministic ZIP/XML extraction, and text-bearing PDFs through `pdftotext` when available. Native images and image-only PDFs return `NEEDS_MULTIMODAL`; the harness does not silently OCR or hallucinate missing source material.

`web.search` and `web.fetch_url` enable source-driven development across official documentation, vulnerability advisories (CVE), and package changelogs. Queries are sanitized through `policies/security-policy.json` to prevent ambient credential or internal network leakage, and payloads are bounded to protect context budgets.

Privileged production actions are never authorized by prompt text alone. Hooks are defense in depth; the canonical policy/tool gateway remains the enforcement point for harness-managed actions.

## Task runtime tools (alpha5)

Six read-mostly MCP tools expose the task graph to host orchestration:

| Tool | Purpose |
|---|---|
| `agent_sdlc_task_list` | task records with status, category, dependencies |
| `agent_sdlc_task_status` | one task, or whole-run progress when `task_id` is omitted |
| `agent_sdlc_task_ready` | dependency-satisfied set, with a reason per exclusion |
| `agent_sdlc_task_schedule` | bounded dispatch decision and why the rest was deferred |
| `agent_sdlc_task_context` | bounded per-task context manifest (or rendered prompt) |
| `agent_sdlc_task_evidence` | evidence/review refs, diff binding, failure state, events |

State-changing task operations are deliberately **not** exposed over MCP. Transitions,
verification, review recording and recovery stay behind `bin/agent-sdlc task`, where the
engine's policy checks cannot be bypassed.
