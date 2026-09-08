---
name: sdlc-doctor
description: Run diagnostic health check on the SDLC harness, inspect providers, git hygiene, and fix detected issues.
metadata:
  version: "3.0.0-rc2"
---
# SDLC Doctor Skill

When this skill is activated (via `/sdlc-doctor` or when diagnosing environment/setup issues):

## Instructions for the Agent

1. **Execute Diagnostic:**
   Run the doctor command directly using your terminal execution tool:
   ```bash
   bin/agent-sdlc doctor
   ```
   *(Or `node "${CLAUDE_PLUGIN_ROOT:-${PLUGIN_ROOT:-.}}/runtime/cli.mjs" doctor` if running via Node).*

2. **Parse & Evaluate Output:**
   - Parse the JSON response returned by the CLI.
   - **Environment Health**: Verify `node` version (must be `>= 18`) and project status (`project: "READY"`).
   - **Provider Availability**: Inspect `providers` array. Confirm which hosts (`claude`, `codex`, `antigravity`) are detected as `available: true`.
   - **Auto-Activation**: Check `auto_activation` array to ensure bootstrap assets and hook delivery modes are active.
   - **Git & Temp Hygiene**: If the output reports missing `.tmp/` in `.gitignore` or git tracking issues:
     - Automatically apply fixes by executing:
       ```bash
       bin/agent-sdlc doctor --fix
       ```

3. **Report to User:**
   Do NOT dump raw JSON. Present a clean, structured Markdown status report:
   - **System Health**: 🟢 Ready / 🟡 Degraded / 🔴 Action Required.
   - **AI Providers**: Table of detected hosts, versions, and capabilities (`structured_output`, `sandbox`, `mcp`).
   - **Fixes Applied**: Summarize any automated fixes applied via `--fix`.
   - **Action Items**: Clearly instruct the user if manual interventions (e.g. Node upgrade, git commit) are required.
