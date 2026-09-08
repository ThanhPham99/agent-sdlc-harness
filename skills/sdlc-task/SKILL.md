---
name: sdlc-task
description: Manage, view, and inspect the persistent SDLC task graph and execution progress.
metadata:
  version: "3.0.0-rc2"
---
# SDLC Task Skill

When this skill is activated (via `/sdlc-task` or when inspecting task readiness and progress):

## Instructions for the Agent

1. **Execute Task Inspection:**
   Run the appropriate task inspection command based on user intent:
   - To inspect overall task progress:
     ```bash
     bin/agent-sdlc task progress
     ```
   - To view all tasks in the persistent graph:
     ```bash
     bin/agent-sdlc task list
     ```
   - To check tasks that are ready for implementation:
     ```bash
     bin/agent-sdlc task ready
     ```
   - To inspect a specific task ID:
     ```bash
     bin/agent-sdlc task inspect --task-id <id>
     ```

2. **Parse Task Graph State:**
   - Parse the returned JSON task array or progress summary.
   - For each task, check: `task_id`, `title`, `status` (`TODO`, `READY`, `IN_PROGRESS`, `DONE`, `FAILED`), and attempt count.
   - Check verification gates (`verification_evidence`) and review status (`spec_review`, `quality_review`).
   - Flag any tasks that have failed multiple attempts (> 1 retry) as potential blockers requiring human escalation.

3. **Format & Present to User:**
   Do NOT dump raw JSON. Render a structured Markdown table:
   - **Task Status Overview**: Total tasks, Done, In Progress, Blocked.
   - **Task Details Table**: Columns for `Task ID`, `Title`, `Status`, `Attempts`, and `Review`.
   - **Action Guidance**: Highlight which task is ready to execute next or if automated workers are currently scheduled.
