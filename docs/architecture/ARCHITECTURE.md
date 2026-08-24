# Architecture

The harness separates **control plane** from **execution plane**. The canonical source of truth is provider-neutral. Host syntax is compiled at build time.

```text
Interface / plugin shim
  -> deterministic router + orchestrator
  -> context compiler + budget + policy
  -> provider adapter and/or tool gateway
  -> sandbox/host tools/MCP
  -> evidence/artifact/event/cost stores
  -> replay/evals/telemetry
```

Core invariants: provider-neutral, token-aware, evidence-driven, replayable, least privilege, artifact-first, deterministic-first, progressive disclosure.

The local-first runtime intentionally has zero npm runtime dependencies. The canonical protocol is language-neutral, so a later team/enterprise control plane can replace file stores with Postgres/object storage/OTel without changing workflow contracts.
