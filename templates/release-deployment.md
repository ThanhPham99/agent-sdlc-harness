# Release / Production Delivery

## Scope and completion target

- Release/work items:
- Exact source revision(s):
- Completion target: `RELEASE_READY | DEPLOYED | PRODUCTION_VERIFIED`
- Target environment(s):

## Release strategy

- Strategy: `ROLLING | CANARY | BLUE_GREEN | FLAG_GATED | BIG_BANG`
- Why this strategy is appropriate:
- Expected blast radius:
- Promotion stages / traffic or population boundaries:

## Prerequisites

- Required CI/review evidence:
- Dependency/release-train ordering:
- Configuration and secret **references** (never secret values):
- Environment/config drift check:
- Observability readiness:

## Feature flags

For each material flag record key, owner, safe default, targeting/rollout plan, health signal, recovery/disable path, and cleanup condition.

## Database / data migration

If applicable use expand-contract ordering:

1. EXPAND
2. COMPATIBILITY
3. BACKFILL
4. VERIFY
5. CONTRACT

Record compatibility constraints, old-consumer drain criteria, data verification, and recovery implications.

## Deployment / rollout procedure

## Success criteria

## Abort conditions

## Post-deployment verification

Include relevant technical health and business invariants. Unknown required health is not PASS.

## Recovery

- Last known good revision/environment:
- Rollback available and data-compatible?:
- Roll-forward option:
- Feature-flag disable option:
- Traffic-shift-back option:
- Selected recovery mode / approval when needed:

## Incident / feedback linkage

Record material production failures and route feedback into a linked bug/hotfix/security/performance/change/requirement workflow rather than silently changing confirmed requirements.

## Approvals / coordination
