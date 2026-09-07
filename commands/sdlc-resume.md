---
description: Resume execution of the active SDLC run from where it left off
---

Resume the run the project is on. No run ID is needed: `start` records the active run, and these commands resolve it.

1. `node "${CLAUDE_PLUGIN_ROOT:-.}/runtime/cli.mjs" status` (or `bin/agent-sdlc status`) for the current stage and evidence.
2. `node "${CLAUDE_PLUGIN_ROOT:-.}/runtime/cli.mjs" task ready` (or `bin/agent-sdlc task ready`) for the tasks that can be picked up now, and `task progress` for what is already done.
3. `node "${CLAUDE_PLUGIN_ROOT:-.}/runtime/cli.mjs" context` (or `bin/agent-sdlc context`) to rebuild the bounded stage context before acting.

To resume a specific task after a provider failure, that is a different command: `task resume --task-id <id> --to-provider <provider>` replays one task's checkpoint onto a fallback provider.
