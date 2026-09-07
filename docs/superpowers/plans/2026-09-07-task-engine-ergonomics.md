# Task Engine Ergonomics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove three ways the task engine makes an operator guess: an orphan task that blocks completion with no route out, a recorded review that `advance` ignores, and a verdict vocabulary that exists only inside the validator.

**Architecture:** All three are cases where the engine holds the answer and does not surface it. Re-planning learns to retire tasks the new plan dropped; `advanceTask` learns to read the reviews already bound to the task instead of only its own arguments; the shipped reviewer agent learns to state the contract it is expected to satisfy. No gate is loosened — a task with bound work is still never silently retired, and a review still has to validate.

**Tech Stack:** Node >=18 ESM, no runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-09-07-remaining-plugin-audit-findings.md` (E1, E2, E3)

**Status:** Complete — all tasks landed. Covers E1, E2, E3. The suite count is 47 as of `f75e8c5` — verification steps below that say "46/46" mean "all suites".

## Global Constraints

- Node `>=18`; `"type": "module"`; **zero runtime dependencies**.
- A task carrying bound work — a captured diff, recorded evidence, a review, or any status past READY — must never have its definition rewritten or its status changed without the operator asking. `hasBoundWork` in `runtime/task-engine.mjs` is the existing predicate for this; reuse it, do not restate it.
- `npm run check` must be green before each commit.
- No `--force` path may be added or widened.

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `runtime/task-engine.mjs` | Task graph materialization, readiness, state transitions | Retire tasks the new plan dropped |
| `runtime/task-runner.mjs` | The advance loop: verify → spec review → quality review → done | Fall back to reviews already recorded |
| `runtime/task-review.mjs` | Review validation and recording | Expose the accepted verdicts as data |
| `agents/independent-reviewer/agent.md` + `adapters/common-independent-reviewer.md` | The shipped reviewer agent | State the review contract |
| `scripts/validate-task-engine.mjs` | Task engine suite | New cases for E1 and E2 |

---

### Task 1: Retire tasks a new plan revision dropped

**Files:**
- Modify: `runtime/task-engine.mjs` (`materializeTaskGraph`, after the per-planned-task loop at ~line 148)
- Test: `scripts/validate-task-engine.mjs`

**Interfaces:**
- Consumes: `listTasks(projectRoot,runId)`, `hasBoundWork(task)`, `saveTask`, `emitTaskEvent` — all already in this module.
- Produces: `retired` and `orphaned` arrays on the `agent-sdlc/task-graph-record/v1` result, alongside the existing `created`/`preserved`/`updated`/`conflicts`.

A task present in an older plan revision and absent from the new one stays in the graph. `task implementation-complete` then answers `TASKS_NOT_DONE:TASK-002(BLOCKED)` and nothing retires it. The operator's only route today is `task transition --to SUPERSEDED --force`, which is a force flag used to clean up after the engine.

- [x] **Step 1: Write the failing test**

Add to `scripts/validate-task-engine.mjs`:

```js
test('a-task-the-new-plan-dropped-is-retired-not-left-blocking',()=>{
  const tmp=fixtureRunAtPlan();      // match the helper the neighbouring cases use
  const run=loadRun(tmp,RUN_ID);
  const two={schema:'agent-sdlc/task-plan/v1',plan_id:'p1',objective:'o',profile:'STANDARD',
    tasks:[mkTask('TASK-001'),mkTask('TASK-002')]};
  materializeTaskGraph(ROOT,tmp,run,two);

  // TASK-002 is dropped by the revision. It has no bound work, so nothing is
  // lost by retiring it -- and leaving it BLOCKED would stall
  // implementation-complete with no route out but --force.
  const one={...two,plan_id:'p2',tasks:[mkTask('TASK-001')]};
  const out=materializeTaskGraph(ROOT,tmp,run,one);
  if(!out.retired.includes('TASK-002'))throw Error(`expected TASK-002 retired, got ${JSON.stringify(out)}`);
  if(loadTask(tmp,RUN_ID,'TASK-002').status!=='SUPERSEDED')throw Error('the dropped task should be SUPERSEDED');
  if(loadTask(tmp,RUN_ID,'TASK-001').status==='SUPERSEDED')throw Error('a task still in the plan must not be retired');
});

test('a-dropped-task-with-bound-work-is-reported-not-retired',()=>{
  const tmp=fixtureRunAtPlan();
  const run=loadRun(tmp,RUN_ID);
  const two={schema:'agent-sdlc/task-plan/v1',plan_id:'p1',objective:'o',profile:'STANDARD',
    tasks:[mkTask('TASK-001'),mkTask('TASK-002')]};
  materializeTaskGraph(ROOT,tmp,run,two);
  const t=loadTask(tmp,RUN_ID,'TASK-002');
  saveTask(tmp,{...t,status:'RUNNING',diff_hash:'abc',attempt:1});

  // Retiring this one would discard work the engine is holding evidence for.
  const one={...two,plan_id:'p2',tasks:[mkTask('TASK-001')]};
  const out=materializeTaskGraph(ROOT,tmp,run,one);
  if(out.retired.includes('TASK-002'))throw Error('a task with bound work must not be retired silently');
  if(!out.orphaned.some(o=>o.task_id==='TASK-002'))throw Error(`expected TASK-002 reported as orphaned, got ${JSON.stringify(out.orphaned)}`);
  if(loadTask(tmp,RUN_ID,'TASK-002').status!=='RUNNING')throw Error('its status must be untouched');
});
```

Read the surrounding cases first and reuse their fixture and task-building helpers rather than inventing `fixtureRunAtPlan`/`mkTask` if equivalents already exist.

- [x] **Step 2: Run and confirm both fail**

Run: `npm run test:tasks`
Expected: FAIL — `out.retired` is undefined.

- [x] **Step 3: Implement retirement**

In `runtime/task-engine.mjs`, after the loop over `plan.tasks` and before the `graph` object is built:

```js
  // A task the new revision dropped used to sit in the graph forever: it never
  // matched a planned id again, so nothing touched it, and
  // implementation-complete stalled on `TASKS_NOT_DONE` with no route out but a
  // --force transition. Dropping a task from a plan IS the decision to retire
  // it -- but only where nothing is bound to it. Anything the engine holds
  // evidence for is reported instead, because retiring it would make that
  // evidence describe a task that no longer exists.
  const planned=new Set(arr(plan.tasks).map(t=>t?.task_id).filter(Boolean));
  const retired=[];const orphaned=[];
  for(const existing of listTasks(projectRoot,run.run_id)){
    if(planned.has(existing.task_id))continue;
    if(existing.status==='SUPERSEDED'||existing.status==='DONE')continue;
    if(hasBoundWork(existing)){
      orphaned.push({task_id:existing.task_id,status:existing.status,reason:'DROPPED_FROM_PLAN_BUT_WORK_ALREADY_BOUND'});
      continue;
    }
    const gone={...existing,status:'SUPERSEDED',plan_id:planId,updated_at:now()};
    saveTask(projectRoot,gone);
    emitTaskEvent(projectRoot,gone,{type:'task.superseded',payload:{plan_id:planId,from_status:existing.status,reason:'DROPPED_FROM_PLAN'}});
    retired.push(existing.task_id);
  }
```

and add both to the return:

```js
  return {schema:'agent-sdlc/task-graph-record/v1',materialized:true,validation,graph,created,preserved,updated,conflicts,retired,orphaned};
```

Confirm `task.superseded` is an accepted event type; if `runtime/store.mjs` or the task state machine constrains event names, use the existing one for this transition rather than adding a type.

- [x] **Step 4: Run the suite**

Run: `npm run test:tasks`
Expected: PASS.

- [x] **Step 5: Surface it in the CLI output**

`runtime/commands/task.mjs`'s `materialize` handler prints the record. Confirm `retired` and `orphaned` appear in that output — a retirement the operator cannot see is the same class of defect as the silent `preserved` this replaces.

- [x] **Step 6: Run the full gate**

Run: `npm run check`
Expected: 46/46 PASS.

- [x] **Step 7: Commit**

```bash
git add runtime/task-engine.mjs scripts/validate-task-engine.mjs
git commit -m "fix(tasks): retire a task the new plan dropped, and report one that holds work"
```

---

### Task 2: Let `advance` use the reviews already recorded

**Files:**
- Modify: `runtime/task-runner.mjs` (`advanceTask`, the `SPEC_REVIEW` and `QUALITY_REVIEW` branches at lines 134-155)
- Test: `scripts/validate-task-engine.mjs`

**Interfaces:**
- Consumes: `task.review_refs` (artifact ids, set by `recordTaskReview` in `runtime/task-review.mjs:151`), `readArtifact`-equivalent from `runtime/store.mjs`.
- Produces: no signature change. `advanceTask`'s `specReview`/`qualityReview` options keep priority; the recorded artifact is the fallback.

`task review --kind spec --file r.json` validates the review, stores it as an artifact, attaches it to `task.review_refs`, and emits `task.spec_reviewed`. `task advance` then still answers `awaiting: SPEC_COMPLIANCE_REVIEW`, because `advanceTask` reads only its own arguments. Two commands that look like they compose do not.

- [x] **Step 1: Write the failing test**

```js
test('advance-uses-a-review-that-was-already-recorded',()=>{
  const tmp=fixtureTaskAtSpecReview();   // a task in SPEC_REVIEW with a captured diff
  const run=loadRun(tmp,RUN_ID);
  const task=loadTask(tmp,RUN_ID,'TASK-001');
  const review={schema:'agent-sdlc/spec-compliance-review/v1',task_id:task.task_id,attempt:task.attempt,
    diff_hash:task.diff_hash,base_revision:task.base_revision,reviewer:'reviewer:test',
    verdict:'COMPLIANT',acceptance_criteria_checked:task.acceptance_criteria||[],findings:[]};
  const rec=recordTaskReview(tmp,run,task,review,{kind:'spec'});
  if(!rec.validation.clean)throw Error(JSON.stringify(rec.validation.errors));

  // Recording it attached it to the task. Advancing should not ask for it again.
  const out=advanceTask(ROOT,tmp,run,'TASK-001',{});
  if(out.awaiting==='SPEC_COMPLIANCE_REVIEW')throw Error('advance ignored a review it already holds');
});
```

- [x] **Step 2: Run it and confirm it fails**

Run: `npm run test:tasks`
Expected: FAIL — `advance ignored a review it already holds`.

- [x] **Step 3: Add the fallback**

In `runtime/task-runner.mjs`, above the `SPEC_REVIEW` branch:

```js
  // `task review --kind spec --file r.json` validates a review, stores it, and
  // binds it to the task -- and advance then asked for it again, because it read
  // only its own arguments. The two commands look like they compose. They should.
  // An inline review still wins: it is the newer statement of the same thing.
  const recorded=(kind)=>{
    const want=kind==='spec'?'agent-sdlc/spec-compliance-review/v1':'agent-sdlc/code-quality-review/v1';
    for(const ref of [...(task.review_refs||[])].reverse()){
      let doc;try{doc=JSON.parse(readArtifactContent(projectRoot,ref));}catch{continue;}
      // Bound to THIS attempt and THIS diff, or it is a review of something else.
      if(doc?.schema===want&&doc.attempt===task.attempt&&doc.diff_hash===task.diff_hash)return doc;
    }
    return null;
  };
```

Then in each branch:

```js
  if(task.status==='SPEC_REVIEW'){
    const review=specReview??recorded('spec');
    if(!review)return {schema:'agent-sdlc/task-advance/v1',advanced:false,task,steps,
      awaiting:'SPEC_COMPLIANCE_REVIEW',verification,
      review_contract:'agent-sdlc/spec-compliance-review/v1'};
    const rec=recordTaskReview(projectRoot,run,task,review,{kind:'spec'});
```

and the same shape for `QUALITY_REVIEW` with `'agent-sdlc/code-quality-review/v1'`.

Find the real artifact-reading helper in `runtime/store.mjs` — the name `readArtifactContent` above is a placeholder for whatever `putArtifact`'s counterpart is actually called. Read the module and use the real one.

- [x] **Step 4: Run the suite**

Run: `npm run test:tasks && npm run test:cli-contract`
Expected: PASS. Any case asserting `awaiting: SPEC_COMPLIANCE_REVIEW` after a recorded review was pinning this defect; update it.

- [x] **Step 5: Commit**

```bash
git add runtime/task-runner.mjs scripts/validate-task-engine.mjs
git commit -m "fix(tasks): advance on a review that was already recorded"
```

---

### Task 3: State the review contract in the reviewer agent

**Files:**
- Modify: `runtime/task-review.mjs` (export the vocabularies)
- Modify: `agents/independent-reviewer/agent.md`
- Modify: `adapters/common-independent-reviewer.md`
- Test: `evals/run-deterministic.mjs`

**Interfaces:**
- Produces: `SPEC_VERDICTS` and `QUALITY_VERDICTS` exported from `runtime/task-review.mjs`.

`validateCodeQualityReview` requires `ACCEPTED` / `CHANGES_REQUIRED` / `PENDING`; `validateSpecComplianceReview` requires `COMPLIANT` / `NON_COMPLIANT` / `PENDING`. Neither appears in the agent that ships to produce these documents, so a caller dispatching it gets `INVALID_VERDICT` and has to read the validator to find out why. `.claude-plugin/plugin.json` loads the `adapters/` copy; both files must say the same thing.

- [x] **Step 1: Export the vocabularies**

In `runtime/task-review.mjs`, replace the inline arrays with named exports and use them in both validators:

```js
// Exported because the agent that produces these documents has to be told what
// they are. An undocumented enum is a contract only the validator knows.
export const SPEC_VERDICTS=['COMPLIANT','NON_COMPLIANT','PENDING'];
export const QUALITY_VERDICTS=['ACCEPTED','CHANGES_REQUIRED','PENDING'];
```

- [x] **Step 2: Write the drift test**

In `evals/run-deterministic.mjs`:

```js
test('the-reviewer-agent-states-the-verdicts-the-validator-accepts',()=>{
  const files=['agents/independent-reviewer/agent.md','adapters/common-independent-reviewer.md'];
  for(const f of files){
    const text=fs.readFileSync(path.join(ROOT,f),'utf8');
    for(const v of [...SPEC_VERDICTS,...QUALITY_VERDICTS]){
      if(!text.includes(v))throw Error(`${f} does not mention the verdict ${v}`);
    }
    for(const s of ['agent-sdlc/spec-compliance-review/v1','agent-sdlc/code-quality-review/v1']){
      if(!text.includes(s))throw Error(`${f} does not name the schema ${s}`);
    }
  }
});
```

- [x] **Step 3: Run it and confirm it fails**

Run: `npm test`
Expected: FAIL — the agent file does not mention `COMPLIANT`.

- [x] **Step 4: Document the contract in both agent files**

Append to each:

```markdown
## Review contract

When asked for a spec-compliance review, return one
`agent-sdlc/spec-compliance-review/v1` object and nothing else:
`verdict` is `COMPLIANT`, `NON_COMPLIANT` or `PENDING`; `NON_COMPLIANT` requires
at least one finding; every acceptance criterion the task owns must appear in
`acceptance_criteria_checked`.

When asked for a code-quality review, return one
`agent-sdlc/code-quality-review/v1` object: `verdict` is `ACCEPTED`,
`CHANGES_REQUIRED` or `PENDING`; `CHANGES_REQUIRED` requires at least one
finding, and `ACCEPTED` requires none that are blocking.

Both bind to the work under review: `task_id`, `attempt` and `diff_hash` must
match the task as it stands, or the review is refused as describing something
else. Every finding needs an `evidence` field. Record independence honestly in
`independence` — claiming `achieved: true` while reporting a shared context is
the one thing that contract exists to prevent.
```

- [x] **Step 5: Run the suite**

Run: `npm test && npm run test:registry && npm run test:root-sync`
Expected: PASS. If `validate-root-sync.mjs` mirrors these two files, edit the `adapters/` copy and run `npm run sync:root` rather than editing both by hand.

- [x] **Step 6: Raise the reviewer's turn budget**

`agents/independent-reviewer/agent.md` sets `maxTurns: 20`. A review asked to read a diff, check acceptance criteria and run a suite exhausts that and returns a partial result — observed during F1's own review round, where a reviewer stopped mid-investigation and had to be resumed.

Raise it to `40` in both files, or leave it and document in the agent body that the reviewer should not run test suites and should be given measured results in the prompt. Pick one and say which in the commit message; do not do neither.

- [x] **Step 7: Commit**

```bash
git add runtime/task-review.mjs agents/independent-reviewer/agent.md adapters/common-independent-reviewer.md evals/run-deterministic.mjs
git commit -m "docs(reviewer): state the review contract the validator enforces"
```

---

## Self-Review Notes

- **Spec coverage:** E1 → Task 1. E2 → Task 2. E3 → Task 3.
- **Task 1 is the one that can destroy work if done carelessly.** The `hasBoundWork` guard is the whole safety argument; the second test exists specifically to pin it. Do not simplify the two branches into one.
- **Task 2 names a helper that may not exist.** `readArtifactContent` is a stand-in for whatever `runtime/store.mjs` actually exports next to `putArtifact`. Read the module before writing the code.
- **Not in scope:** making `advance` re-verify when the diff moved. It already binds reviews to `attempt` and `diff_hash`, so a stale review is refused rather than accepted — that behaviour is correct and untouched.
