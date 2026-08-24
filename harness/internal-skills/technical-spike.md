# Workflow Module: technical-spike

> Internal orchestrator module. This is not a public Agent Skill and must not be independently discovered or invoked by the host. Load it only when the canonical workflow state selects this module. Return control to `sdlc-orchestrator`; never mark the global workflow COMPLETE yourself.

# Technical Spike

## Workflow preflight

If an active feature state exists, confirm the spike is authorized by the current workflow/plan. Otherwise treat this as a read-only/disposable investigation unless the user explicitly asks to promote it to production work.

Define the question, evidence needed, time/scope boundary, and stop condition. Prefer small experiments over broad implementation. Record evidence, options/trade-offs, recommendation, unresolved unknowns, and productionization implications in `spike.md` when durable output is useful.

Prototype code is disposable by default. Do not mark experimental conclusions as confirmed requirements or production design without the appropriate workflow gate.
