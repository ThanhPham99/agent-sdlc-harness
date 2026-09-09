---
name: sdlc-release
description: Dispatched by sdlc-orchestrator when the active SDLC run state is RELEASE, DEPLOY, OBSERVE or CLOSE. Not an entry point; do not activate from a user prompt.
metadata:
  version: "3.0.0-rc2"
---
# SDLC Release, Deploy, Observe & Close Stages

Dispatched by `sdlc-orchestrator` when `navigation.stage_skill` is `sdlc-release`,
covering `RELEASE`, `DEPLOY`, `OBSERVE` and `CLOSE`.
Not an entry point.

**RELEASE.** Gate 4 requires 100% local CI pass before requesting human
approval to commit and push to remote.

**DEPLOY.** Production/destructive actions are Gate 5 and require approval and
external enforcement.

**OBSERVE.** Check declared health/business invariants and capture production
verification evidence.

**CLOSE.** Requires the selected workflow's declared verification, review,
release and deploy evidence before completion can be claimed.

Load the procedure modules `navigation.procedure_skills` names for the current
one of these stages.
