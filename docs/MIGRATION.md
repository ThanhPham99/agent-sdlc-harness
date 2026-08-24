# Migration and Versioning

Canonical runtime state uses schema `agent-sdlc/state/v1` and run records use `agent-sdlc/run/v1`. Provider-specific session/thread identifiers are optional metadata; the canonical `run_id` belongs to the harness.

Use:

```bash
./bin/agent-sdlc compat-check
./bin/agent-sdlc migrate
```

The alpha migration command only performs conversions that are explicitly lossless. Legacy `.ai-workflow` state is detected but not silently rewritten because earlier workflow semantics and evidence fields may differ. For an incompatible project, export durable artifacts/handoffs, initialize v3, and attach those artifacts to the new run.

Protocol, schema, policy, skill and provider package versions are independently traceable in replay/evidence. Breaking canonical schema changes require a major harness version; additive fields should remain backward-readable whenever feasible.
