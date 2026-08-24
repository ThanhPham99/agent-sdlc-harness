# Workflow Module: systematic-debugging

> Internal orchestrator module. This is not a public Agent Skill and must not be independently discovered or invoked by the host. Load it only when the canonical workflow state selects this module. Return control to `sdlc-orchestrator`; never mark the global workflow COMPLETE yourself.

# Systematic Debugging

## Workflow preflight

If an active `.ai-workflow/features/<id>/state.yaml` exists, verify that the current state/gate authorizes this skill before changing project artifacts or code. If invoked out of order, return `BLOCKED` with the required next logical skill; do not bypass the orchestrator. Load only the artifacts required for this step.


Reproduce or establish reliable evidence, minimize the failure, inspect recent/relevant changes, form explicit hypotheses, test one hypothesis at a time, and identify root cause before choosing a fix.

Separate symptom, trigger, root cause, and contributing factors. Add regression evidence before/with the fix whenever feasible. Avoid random patching or repeated speculative edits.
