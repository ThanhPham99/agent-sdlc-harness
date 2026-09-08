---
name: sdlc-resume
description: Resume execution of the active SDLC run from where it left off.
metadata:
  version: "3.0.0-rc2"
---
# SDLC Resume Skill

When this skill is activated (via `/sdlc-resume` or when continuing an interrupted SDLC run):

## Instructions for the Agent

1. **Inspect Active Run State:**
   Check the current status and phase of the active run:
   ```bash
   bin/agent-sdlc status
   ```
   *(Or `node "${CLAUDE_PLUGIN_ROOT:-${PLUGIN_ROOT:-.}}/runtime/cli.mjs" status`).*

2. **Evaluate Run Status:**
   - If `status: "PAUSED"` with a pending approval ticket:
     - Inform the user that the pipeline is currently paused at a Human Confirmation Gate.
     - Present the ticket details and suggest running `/sdlc-approve`.
   - If the run is ready to continue execution:
     - Resume autonomous runner directly:
       ```bash
       bin/agent-sdlc auto
       ```
   - If a specific task failed and needs fallback replay across providers:
     ```bash
     bin/agent-sdlc task resume --task-id <id> --to-provider <provider>
     ```

3. **Report Execution Progress:**
   Inform the user of the current stage being executed and summarize the newly advanced tasks or gate transitions.
