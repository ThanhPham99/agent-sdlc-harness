---
name: sdlc-route
description: Route a software task into the canonical SDLC workflow without model inference.
metadata:
  version: "3.0.0-rc2"
---
# SDLC Route Skill

When this skill is activated (via `/sdlc-route` or when determining the workflow for a software objective):

## Instructions for the Agent

1. **Extract Objective:**
   Determine the objective string from the user prompt or skill arguments. If the objective is not provided, prompt the user for the task objective.

2. **Execute Deterministic Router:**
   Run the router command directly using your terminal execution tool:
   ```bash
   bin/agent-sdlc route --objective "<objective>"
   ```
   *(Or `node "${CLAUDE_PLUGIN_ROOT:-${PLUGIN_ROOT:-.}}/runtime/cli.mjs" route --objective "<objective>"`).*

3. **Evaluate Routing Result:**
   - Parse JSON output fields: `workflow`, `profile` (`FAST`, `STANDARD`, `STRICT`), `overlays`, `reason_codes`, and `route_flags`.
   - **Semantic Classification & Agent Discretion**:
     - If `route_flags` includes `AMBIGUOUS_ROUTE` or `agent_discretion` is true, use contextual semantic reasoning to confirm or adjust the workflow:
       * Pure exploratory spike / assessment $\rightarrow$ `technical-spike` (FAST)
       * Refactoring without behavior changes $\rightarrow$ `refactor` (STANDARD)
       * Routine chores / tech debt $\rightarrow$ `maintenance` (FAST) or `dependency-upgrade` (STANDARD)
       * Concrete bug or error fix $\rightarrow$ `bug-fix` (STANDARD)
       * Brand new capability $\rightarrow$ `new-feature` (STANDARD)
     - **Safety Invariant**: NEVER downgrade genuine security, database schema, infrastructure, or breaking API changes away from `STRICT`.

4. **Present Decision & Next Step:**
   Present a clear summary table:
   - **Selected Workflow**: e.g., `bug-fix`
   - **Risk Profile**: `FAST` | `STANDARD` | `STRICT`
   - **Mandatory Overlays**: e.g., none, `security`, `hotfix`, `db-migration`
   - **Reason Codes**: Matched keywords or semantic rationale
   - **Next Action**: Offer to immediately launch the workflow:
     ```bash
     bin/agent-sdlc auto --objective "<objective>" --workflow <workflow>
     ```
