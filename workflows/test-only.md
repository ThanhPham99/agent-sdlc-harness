# Workflow: test-only

Default profile: **FAST**

Stages: INTAKE → REQUIREMENTS → PLAN → IMPLEMENT → VERIFY → REVIEW → CLOSE

Required overlays: none

At every stage, use the canonical state machine, stage policy, bounded context compiler, artifact handoff and evidence gates. Skipped stages are skipped because this workflow definition omits them; agents must not invent additional shortcuts.
