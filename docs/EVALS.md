# Evaluation Strategy

`npm test` runs deterministic, offline regression checks for routing, lifecycle consistency, gates, side-state recovery, progressive context disclosure, artifacts/replay, tool security, input normalization, model/cost routing, configuration, compatibility, parallelism, handoff, telemetry, MCP and provider package structure.

Run the package audit with:

```bash
node scripts/audit.mjs
```

Run provider preflight with:

```bash
node evals/provider-conformance/preflight.mjs
```

Preflight is intentionally fail-honest: an unavailable host reports `PENDING`, never `PASS`. A release candidate should additionally execute live semantic/e2e evaluation on installed and authenticated Claude Code, Codex and Antigravity hosts, bind results to the exact package digest, record host/model versions, and compare verified-task success, escaped defects, latency and cost against a pinned baseline.

Replay supports offline integrity/regression analysis; model generation itself is not claimed to be bit-for-bit deterministic.
