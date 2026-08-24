# Workflow Module: knowledge-maintenance

> Internal orchestrator module. This is not a public Agent Skill. Load it only when G0/G6 or a freshness/supersession/debt/deprecation trigger requires project-knowledge maintenance. Return control to `sdlc-orchestrator`; never own the feature lifecycle.

# Knowledge Maintenance

Maintain the smallest accurate **current project view** without loading or rewriting the full project history.

## Read first

1. `rules/knowledge-evolution-policy.yaml`.
2. `.ai-workflow/project/knowledge-index.yaml` when present.
3. Only affected current project artifacts and the concrete change/evidence that triggered maintenance.
4. `decision-index.yaml`, debt/deprecation registers, or cold shards only when the affected scope requires them.

## Responsibilities

- Refresh current entries whose source revision, dependency fingerprint, or affected facets changed.
- Mark uncertain current entries `NEEDS_REVIEW` or `UNKNOWN`; never silently keep them current.
- Maintain accepted/superseded/deprecated decision links without erasing history.
- Move closed/unrelated history out of the hot root index when compaction thresholds are exceeded.
- Preserve source refs, digests/revisions, authority class, and supersession links during compaction.
- Keep technical debt and deprecation status scoped and current; do not inject unrelated debt/deprecations into feature context.
- Update only affected knowledge. Never perform a whole-repository rescan solely because the project is old.

## Summary rules

A generated current-view summary is a navigation/cache artifact, **not a new source of truth**. It must point back to its sources and may not upgrade `INFERRED` or `UNVERIFIED` material to `CONFIRMED/AUTHORITATIVE`.

If two authoritative sources conflict, stop with `NEEDS_CONFIRMATION`; do not compact the conflict away.

## Completion result

Return:
- entries refreshed/invalidated;
- entries moved to cold shards;
- decisions superseded/deprecated;
- debt/deprecation status changes;
- provenance preserved;
- whether active context or any feature must re-enter a gate.
