---
name: sdlc-approve
description: Grant approval for a paused SDLC human gate ticket and immediately resume pipeline execution.
metadata:
  version: "3.0.0-rc2"
---
# SDLC Approve Skill

When this skill is activated (via `/sdlc-approve` or when the user approves a pending Human Confirmation Gate in chat):

Not an entry point: invoked by a human typing the slash command or dispatched by `sdlc-orchestrator`, never auto-activated from a prompt.

## Instructions for the Agent

1. **Verify Pending Gate Ticket:**
   Run status to inspect the pending approval ticket:
   ```bash
   bin/agent-sdlc status
   ```
   *(Or `node "${CLAUDE_PLUGIN_ROOT:-${PLUGIN_ROOT:-.}}/runtime/cli.mjs" status`).*
   Confirm there is an active run with a pending Human Gate approval ticket (`approval_ticket: { ticket_id, capability, reason }`).

2. **Execute One-Step Approval & Resume:**
   Grant the approval ticket and immediately resume autonomous execution:
   ```bash
   bin/agent-sdlc auto --approve
   ```
   *(If a specific ticket ID was passed as an argument, you may alternatively execute `bin/agent-sdlc approval grant-ticket --ticket-id <ticket_id>` followed by `bin/agent-sdlc auto`).*

3. **Parse Execution Result:**
   - Check the output from the autonomous runner.
   - If execution completed: Summarize the final outcome, generated artifacts, and verification evidence.
   - If execution paused at another gate: Present the new Human Gate ticket to the user.
   - If execution is currently running: Report that approval has been granted and autonomous tasks are advancing.

4. **Confirm to User:**
   Notify the user that the gate ticket has been successfully approved and report the next active stage or completed deliverable.
