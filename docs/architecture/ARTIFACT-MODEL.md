# Artifact and Handoff Model

Artifacts are content-addressed under `.agent-sdlc/artifacts`. Requirements, specs, designs, ADRs, plans, test evidence, security reports, release evidence, deployment receipts, production verification and handoffs are the durable source of truth.

A stage handoff contains: objective, decisions, affected files/symbols, contracts, tests/evidence, risks/unknowns and exactly one next action. This externalizes memory so the next context does not need conversation history.

## Standard Lifecycle Artifacts

1. **Intent Proto-Spec (`.agent-sdlc/intent/*.md`)**:
   - Initial human or autonomous trigger artifact capturing: problem, proposed outcome, affected systems, constraints, open questions.
   - Non-technical contributors or monitoring alerts commit intent without touching implementation code.

2. **Design Decision (`agent-sdlc/design-decision/v1`)**:
   - Captures options, tradeoffs, affected interfaces, and **flagged policy concerns**.
   - Contradictory policies or high-risk constraints are explicitly flagged for human resolution before entering PLAN.

3. **Task Plan (`agent-sdlc/task-plan/v1`) & Review Policy (`REVIEW.md`)**:
   - Task graph with bounded scopes, declared dependencies, and proof obligations.
   - Repository-level `REVIEW.md` governing 3 passes: Bugs/Correctness, Security/Operability, Compliance/Traceability, with Nit Capping (max 5 nits).

4. **Statistical Control Bands (`templates/bands.yaml`, `policies/control-bands.json`)**:
   - Stage 6: Maintain closed-loop monitoring.
   - Evaluates production/CI metrics against rolling baselines; $\ge 3\sigma$ breaches auto-emit `intent.md` to trigger Stage 1 remediation.

## Source of Truth Coexistence Models

Organizations transitioning to an AI-Native SDLC frequently have existing investments in Jira, ServiceNow, Linear, or Figma. The harness supports three coexistence configurations configured via `source_of_truth_mode` in `.agent-sdlc/project.json`:

1. **Repo as Source of Truth (`repo_authoritative`, default)**:
   - Version-controlled markdown artifacts (`intent.md`, `spec.md`, `plan.md`) are the authoritative record.
   - External issue trackers hold reference links or commit SHAs.

2. **Legacy System as Source of Truth (`legacy_authoritative`)**:
   - Jira or ServiceNow holds the master record.
   - Agent reads ticket metadata during intake via MCP connectors and writes execution receipts back to the legacy system. Local markdown files act as working copies.

3. **Bidirectional Linkage (`bidirectional_linkage`)**:
   - Both systems coexist as peers.
   - All harness feature and intake bundles store `external_tracker: { system, issue_id, url }` and external systems store Git commit SHAs and artifact digests.
