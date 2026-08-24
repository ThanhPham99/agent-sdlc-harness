# Git Delivery Integration

Use this internal module when code/config/test changes must move through a branch/worktree, PR/review, CI, merge queue, hotfix backport, release branch, revert, or post-merge reconciliation path.

## Inputs
- current feature `state.yaml`;
- `.ai-workflow/project/delivery-board.yaml` when present;
- `.ai-workflow/project/coordination-board.yaml` when multiple work items are active;
- current branch/base/head revisions and PR/CI status when observable;
- `rules/git-delivery-policy.yaml`;
- `rules/coordination-policy.yaml` for cross-work-item ordering.

## Procedure
1. Identify the configured `completion_target`: `PR_READY`, `MERGED`, or `RELEASE_READY`. Never use plain `COMPLETE` as a substitute for this distinction.
2. Ensure the work item owns a bounded branch/worktree. Do not dispatch multiple writer agents onto the same mutable branch unless an explicit project policy overrides the default.
3. For stacked work, record explicit PR/work-item dependencies. Downstream work targets the upstream branch until that dependency lands, then retarget/rebase and revalidate.
4. Before declaring PR-ready, compare the current target base with the last validated base. Classify drift facets: semantic → G2; code/verification → G5A; integration/docs → G6; irrelevant → preserve current state.
5. Treat required CI as evidence. A deterministic failure requires diagnosis/repair; do not blind-retry. A proven flaky check may receive the one bounded retry allowed by failure policy.
6. Any new material commit after required CI/review invalidates affected evidence. Re-run/revalidate only the affected checks/review scope.
7. Enter a merge queue only when required checks/review are valid on a current base and all declared upstream dependencies/coordination conflicts are resolved. Queue-base drift triggers refresh/revalidation.
8. For an overlapping hotfix, checkpoint affected work only. If the hotfix lands on a release branch, explicitly track required backport/forward-port targets and revalidate each target.
9. Treat `git revert` as a new change with traceability; never rewrite shared history to erase an already-delivered change. Distinguish source revert from operational deployment rollback.
10. After final merge order is known, reconcile shared project documentation once against the resulting baseline rather than having multiple feature agents race on the same project docs.
11. Return delivery status to the Orchestrator. This module never marks global workflow `COMPLETE`; G6 evaluates whether the configured completion target was actually reached.

## Output contract
Return:
- branch/worktree strategy and current base revision;
- PR identity/base/head/draft/review status if applicable;
- declared PR/work-item dependencies;
- required CI checks and revision they verified;
- drift classification and earliest affected gate, if any;
- merge-queue status;
- hotfix backport/forward-port obligations;
- post-merge documentation reconciliation status;
- `completion_target` and whether it is currently satisfied;
- unresolved delivery blockers.

## Token discipline
Use branch/PR/check metadata and compact change claims first. Do not reload full feature requirements/design solely to inspect CI or merge state. Load semantic artifacts only when a base/head drift actually intersects semantic facets.
