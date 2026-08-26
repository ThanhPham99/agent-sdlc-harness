# Coordination Analysis

Use this internal module only when two or more material work items are active in the repository, when parallel agents are requested, or when an upstream work item merges while another work item is still active.

## Inputs
- the `coordination-board` artifact via the artifact store, when one exists for this run;
- the current run's state (via `agent-sdlc status`) and its `impact-analysis` artifact;
- active work-item summaries/change claims;
- `rules/coordination-policy.yaml`;
- current project baseline revision.

## Procedure
1. Refresh the project-level coordination board if its project baseline revision is stale.
2. Derive **change claims** for each active work item. Claim only resources the work item may modify: paths/modules, public interfaces/events, data objects/schema, dependency versions, architecture nodes, security boundaries, migration slots, and shared project docs.
3. Compare claims pairwise and classify the relationship using the coordination policy.
4. Dispatch parallel writers only when the relationship is `DISJOINT` or `DOCS_RECONCILIATION`. Sharing read context is not a conflict; sharing a write scope is.
5. For `ORDERED_DEPENDENCY`, hold downstream implementation at the earliest safe checkpoint until the upstream contract/baseline required by it is stable.
6. For `SHARED_CONTRACT_CHANGE` or `HARD_CONFLICT`, reconcile semantics/ordering before both work items continue. Never let two agents independently redefine the same API/schema/security contract.
7. When an overlapping hotfix appears, checkpoint affected lower-priority work, run the hotfix path, then revalidate affected work against the new baseline. Disjoint work continues.
8. After any upstream merge, classify drift facets for still-active dependent/overlapping work: semantic drift → G2; code/verification-only drift → G5A; integration/docs-only drift → G6; unrelated drift → preserve state.
9. Serialize updates to shared project documentation after merge order is known and reconcile feature-index/architecture/decisions against the final project baseline.
10. Return a coordination result to the Orchestrator; do not mutate another feature's lifecycle state directly.

## Output contract
Return:
- active work-item IDs considered;
- pairwise classification(s);
- `PARALLEL`, `PARALLEL_WITH_DOC_RECONCILE`, `SERIALIZE_WRITE`, `SERIALIZE_ORDERED`, `SERIALIZE_RECONCILE`, `PREEMPT_AFFECTED`, or `BLOCK_RECONCILE`;
- dependency/merge ordering;
- work items requiring revalidation and their earliest gate;
- coordination-board updates;
- unresolved conflicts/questions.

## Token discipline
Read only each active work item's state plus summarized change claims first. Load another feature's full design/requirements only when a shared resource or dependency actually requires semantic reconciliation.
