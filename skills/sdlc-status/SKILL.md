---
name: sdlc-status
description: Read the current SDLC run state, inspect stage progression, pending gate approvals, and task progress.
metadata:
  version: "3.0.0-rc2"
---
# SDLC Status Skill

When this skill is activated (via `/sdlc-status` or when checking pipeline progress):

Not an entry point: invoked by a human typing the slash command or dispatched by `sdlc-orchestrator`, never auto-activated from a prompt.

## Instructions for the Agent

1. **Execute Status Query:**
   Run the status command directly using your terminal execution tool:
   ```bash
   bin/agent-sdlc status
   ```
   *(Or `node "${CLAUDE_PLUGIN_ROOT:-${PLUGIN_ROOT:-.}}/runtime/cli.mjs" status`).*

2. **Parse Run State:**
   - Extract `run_id`, `objective`, `workflow`, and `profile`.
   - Identify `state` (current stage) and compare against the full `stages` progression array.
   - Check `suspended_from` and `approvals`:
     - If the run is in state `PAUSED` or `NEEDS_CONFIRMATION`, extract the pending `approval_ticket` (`ticket_id`, `capability`, `reason`).
   - If current stage is `PLAN`, `IMPLEMENT`, or `VERIFY`, also inspect task progress:
     ```bash
     bin/agent-sdlc task progress
     ```

3. **Format & Present Status Report:**
   Do NOT dump raw JSON. Render a readable summary containing:
   - **Pipeline Header**: Run ID, Active Workflow, Profile (`FAST`, `STANDARD`, or `STRICT`), and Objective.
   - **Stage Progression**: A visual pipeline flow showing completed, current, and upcoming stages:
     `INTAKE (✔) -> REQUIREMENTS (✔) -> PLAN (⏳ CURRENT) -> IMPLEMENT -> ... -> CLOSE`
   - **Pending Human Gate Ticket** (if paused): Clearly highlight the ticket ID and approval reason, and inform the user they can approve by running `/sdlc-approve` or confirming in chat.
   - **Task Breakdown** (if in `IMPLEMENT`): Summary of tasks completed vs remaining.
