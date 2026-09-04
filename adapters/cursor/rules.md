# Agent SDLC Rule for Cursor

Apply this configuration to `.cursorrules` or `.cursor/rules/sdlc.mdc` at the root of any repository where Agent SDLC Harness is enabled.

```markdown
# Agent SDLC Harness Rule

Agent SDLC auto-activation: for any request that changes, investigates, operates on, or ships a real software repository or system, you MUST use `sdlc-router` first to classify the objective, then follow `sdlc-orchestrator`. Generic programming Q&A does not activate the workflow.

## Operational Invariants
- **Deterministic First**: Always run tests, symbol index, search, and diff before making model assumptions.
- **Evidence Before Claims**: Never claim a task, stage, or bugfix is complete without running the verification command and inspecting the output.
- **Bounded Context**: Keep context minimal. Avoid dumping whole logs or large files into conversation memory.
- **Security & Safety**: Never bypass gates with `--force`. Production/destructive changes require explicit human approval.

## Available MCP & CLI Tools
When the Agent SDLC MCP server is configured:
- `agent_sdlc_route`: Classify objective into canonical workflow.
- `agent_sdlc_start`: Initialize and start an SDLC run.
- `agent_sdlc_status`: Inspect current run and gate requirements.
- `agent_sdlc_transition`: Advance run only when gate evidence is satisfied.
- `agent_sdlc_task`: Manage DAG tasks, schedule ready set, compile task context, and record verification.
```
