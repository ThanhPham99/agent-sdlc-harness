# Git Delivery Integration

Use this internal module when code/config/test changes must move through a branch/worktree, PR/review, CI, merge queue, hotfix backport, release branch, revert, or post-merge reconciliation path.

## Inputs
- the current run's state (via `agent-sdlc status`);
- the `delivery-board` artifact via the artifact store, when present;
- the `coordination-board` artifact via the artifact store, when multiple work items are active;
- current branch/base/head revisions and PR/CI status when observable;
- `rules/git-delivery-policy.yaml`;
- `rules/coordination-policy.yaml` for cross-work-item ordering.

## Workspace & Worktree Isolation Detection

Before creating a worktree or modifying working trees:
1. **Detect existing isolation:**
   ```bash
   GIT_DIR=$(git rev-parse --git-dir 2>/dev/null)
   GIT_COMMON=$(git rev-parse --git-common-dir 2>/dev/null)
   ```
2. **Submodule guard:** `GIT_DIR != GIT_COMMON` is also true inside git submodules. Verify with:
   ```bash
   git rev-parse --show-superproject-working-tree 2>/dev/null
   ```
   If a path is returned, this is a submodule, NOT an isolated worktree.
3. **Directory safety:** If creating a project-local worktree directory (e.g. `.worktrees/`), MUST verify it is gitignored first (`git check-ignore -q .worktrees`). If not, add to `.gitignore` before creating.
4. **Sandbox fallback:** If `git worktree add` fails due to sandbox restrictions, notify user and safely fall back to working in-place on a dedicated branch.

## Finishing a Development Branch

When implementation is complete and verification evidence passes, guide branch completion with structured options:

### 1. Verify Tests First
Run the full test suite before presenting options. If tests fail, STOP. Do not present completion options until all failures are resolved.

### 2. Detect Environment & Workspace Provenance
```bash
GIT_DIR=$(git rev-parse --git-dir 2>/dev/null)
GIT_COMMON=$(git rev-parse --git-common-dir 2>/dev/null)
WORKTREE_PATH=$(git rev-parse --show-toplevel 2>/dev/null)
```
- If `GIT_DIR == GIT_COMMON`: standard repository checkout (no worktree to clean up).
- If `GIT_DIR != GIT_COMMON`: isolated worktree. Determine provenance before removing.

### 3. Present Exactly 4 Structured Options
```text
Implementation complete and verified. What would you like to do?
1. Merge back to <base-branch> locally
2. Push and create a Pull Request
3. Keep the branch as-is (I'll handle it later)
4. Discard this work
```

### 4. Execution Rules
- **Option 1 (Merge Locally)**:
  1. `cd` to the main repository root (`git -C "$(git rev-parse --git-common-dir)/.." rev-parse --show-toplevel`).
  2. `git checkout <base-branch> && git pull && git merge <feature-branch>`.
  3. Re-run test suite on merged tree to verify integration.
  4. Only after tests pass: cleanup worktree (step 5), then `git branch -d <feature-branch>`.
- **Option 2 (Push & Create PR)**:
  1. `git push -u origin <feature-branch>`.
  2. **Do NOT delete the worktree** — preserve it so the developer can iterate on PR review feedback.
- **Option 3 (Keep As-Is)**:
  - Preserve branch and worktree untouched.
- **Option 4 (Discard)**:
  - Require explicit typed confirmation: Prompt user to type `"discard"`. Never delete uncommitted work or branches without exact confirmation.
  - After confirmation: cleanup worktree, then force-delete branch (`git branch -D`).

### 5. Provenance-Based Worktree Cleanup
- **Check Ownership**: Only clean up worktrees located under `.worktrees/` or `worktrees/` that were created by the harness. Never delete host-managed or external workspaces.
- **CWD Safety**: Always `cd` to main repository root BEFORE executing `git worktree remove "$WORKTREE_PATH"` (running remove while CWD is inside the worktree causes silent failure).
- **Self-Healing Prune**: Always run `git worktree prune` after removal to clean up stale metadata.

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
