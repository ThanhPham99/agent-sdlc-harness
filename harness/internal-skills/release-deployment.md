# Workflow Module: release-deployment

> Internal orchestrator module. This is not a public Agent Skill and must not be independently discovered or invoked by the host. Load it only when release/production delivery is selected. Return control to `sdlc-orchestrator`; never mark the global workflow COMPLETE yourself.

# Release & Production Lifecycle

Use this module for release readiness, environment promotion, progressive rollout, feature flags, production migrations, deployment recovery, post-deploy verification, incident linkage, and production feedback.

## Inputs
- current feature `state.yaml`;
- `release-deployment.md` when applicable;
- `.ai-workflow/project/delivery-board.yaml` for source delivery state;
- `.ai-workflow/project/release-board.yaml` for release/environment state;
- coordination board when multiple work items/release-train dependencies exist;
- current release candidate revision and environment evidence;
- `rules/production-lifecycle-policy.yaml` and `rules/failure-recovery-policy.yaml`.

## Procedure
1. Read the configured completion target. For `RELEASE_READY`, stop before production deployment. For `DEPLOYED` or `PRODUCTION_VERIFIED`, require a release board and exact release revision.
2. Freeze the release candidate to an exact immutable source revision. If code/config changes materially after the freeze, rebuild the candidate and invalidate affected release evidence.
3. Validate promotion prerequisites: current CI/review, declared dependencies, environment/config references, migration compatibility, observability readiness, and at least one realistic recovery path.
4. Select the smallest-risk strategy appropriate to the change: rolling, canary, blue/green, flag-gated, or explicitly approved big-bang for eligible scope. Do not choose a deployment mechanism solely because a tool supports it.
5. For progressive rollout, define stage boundaries, success criteria, abort conditions, and health signals before promotion. Unknown required health means HOLD, never automatic promotion.
6. For feature-flagged delivery, record owner, safe default, targeting/stages, observability, disable/kill-switch path when relied on for recovery, and cleanup obligation. Code deployed behind a disabled flag is not evidence that enabled behavior is production-verified.
7. For schema/data change, enforce expand-contract ordering: EXPAND → COMPATIBILITY → BACKFILL → VERIFY → CONTRACT. CONTRACT is forbidden until old consumers are drained/compatible and backfill/new path are verified.
8. Deploy/promote only through authorized tooling. Never expose credentials or secret values in workflow artifacts. Record identifiers/status/evidence, not secrets.
9. After each progressive stage, evaluate current health and business invariants. Regression → halt and recover; unavailable required metrics → hold; PASS → promote only to the next configured stage.
10. Distinguish recovery modes: source revert, deployment rollback, feature flag off, traffic shift back, and roll-forward. If rollback is incompatible with current data state, do not claim it is available; choose roll-forward or request an authorized recovery decision.
11. For `PRODUCTION_VERIFIED`, write/update `deployment-verification.md` with exact release revision, stage/environment, technical checks, relevant business invariants, migration/flag state, and final PASS evidence.
12. A material production failure creates/links a new work item (bug/hotfix/security/performance as appropriate); it does not rewrite the completed feature history. Changed expected behavior routes through change/requirement workflow.
13. For a release train, preserve dependency order and shared-contract compatibility. Production promotion of a dependent candidate waits until required predecessors reach the configured verified point.
14. Return release status and blockers to the Orchestrator. G6 alone determines whether the configured completion target is satisfied.

## Output contract
Return:
- release ID and exact source revision;
- target environment and release strategy;
- release-train dependencies/status;
- rollout stages/current stage and health evidence;
- feature flags and safe/recovery state;
- migration phase and compatibility state;
- post-deploy verification status;
- selected/available recovery modes;
- incident and feedback links;
- completion target and whether it is currently satisfied;
- unresolved blockers.

## Token discipline
Use compact release/CI/environment/metric metadata first. Do not reload full requirements/design unless a production signal contradicts expected semantics or requires re-impact. Reuse verified release context by revision; do not treat stale rollout evidence as current.
