# MCP and Tool Gateway

The local runtime exposes a stdio MCP server at `runtime/mcp-server.mjs`. Provider packages connect to the same provider-neutral runtime so workflow state, policy and artifacts do not depend on the host.

The MCP surface includes route/start/status/context/transition, policy-aware tool checking and execution, artifact creation and model routing. Tools are registered in `config/tools.json`; stage authorization is defined in `policies/stage-policy.json` and security constraints in `policies/security-policy.json`.

Built-in deterministic tools include `input.normalize`, repository read/search/diff, git status, targeted/full tests, build execution and a redacted secret scan. External capabilities such as LSP/symbol intelligence, SAST/SCA, deployment and observability are contracts: connect them through MCP or a host integration while retaining the canonical policy decision before execution.

`input.normalize` is the preprocess-before-LLM path. It handles common text formats directly, DOCX/XLSX via deterministic ZIP/XML extraction, and text-bearing PDFs through `pdftotext` when available. Native images and image-only PDFs return `NEEDS_MULTIMODAL`; the harness does not silently OCR or hallucinate missing source material.

Privileged production actions are never authorized by prompt text alone. Hooks are defense in depth; the canonical policy/tool gateway remains the enforcement point for harness-managed actions.
