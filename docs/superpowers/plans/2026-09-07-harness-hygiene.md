# Harness Hygiene Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the harness from tripping over its own footprint — an unignored file it writes into the tree it polices, a hook path that is never exercised, raw logs where structured summaries were promised, and a report-rewrite cycle that invalidates the evidence it was just used to produce.

**Architecture:** Four independent corrections plus two housekeeping items. Nothing here changes gate semantics; each one removes a way the harness misleads its own operator.

**Tech Stack:** Node >=18 ESM, no runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-09-07-remaining-plugin-audit-findings.md` (F8, F9, F11, E4, Housekeeping)

**Status:** Not started. Covers F8, F9, F11, E4 and the housekeeping items. The suite count is 47 as of `f75e8c5` — verification steps below that say "46/46" mean "all suites".

## Global Constraints

- Node `>=18`; `"type": "module"`; **zero runtime dependencies**.
- Files mirrored between `adapters/` and the repository root are byte-for-byte copies checked by `scripts/validate-root-sync.mjs`. **Edit the `adapters/` copy**, then run `npm run sync:root`. Editing the root copy directly fails the gate.
- `evals/*.json` reports go through `writeReport` from `scripts/lib/report-io.mjs`.
- `npm run check` must be green before each commit.

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `runtime/store.mjs` | Project state directory layout, run persistence | Stop leaving `REVIEW.md` untracked in the tree |
| `runtime/init.mjs` | Project detection and `.gitignore` handling | Add the ignore entry |
| `adapters/antigravity/hooks.json` | Antigravity hook manifest (mirrored to `hooks.json`) | Resolve the hook by plugin root, not CWD |
| `scripts/test-antigravity-bootstrap-hook.mjs` | Antigravity bootstrap suite | Exercise the manifest's command string |
| `runtime/tools.mjs` | Tool dispatch and output bounding | Structured summary for recognised report output |
| `docs/runbooks/FAILURE-RECOVERY.md` | Operator runbook | Document the report/evidence ordering |

---

### Task 1: Stop `init` from dirtying the tree it polices

**Files:**
- Modify: `runtime/store.mjs:16-18` (the `REVIEW.md` copy) or `runtime/init.mjs` (whichever owns `.gitignore` writing — read both first)
- Test: `scripts/test-project-detection.mjs`

**Interfaces:**
- Consumes: `initProject(projectRoot,config)` from `runtime/store.mjs`.
- Produces: no new exports.

`initProject` copies `templates/REVIEW.md` into the project root. It is ignored by nothing, so the harness's own initialization leaves an untracked file in the working tree whose cleanliness the task scope audit depends on — the audit that flagged it during F1's own delivery.

- [ ] **Step 1: Decide where it belongs, and say why in the commit**

Two defensible answers. Pick one before writing code:

**(a) Ignore it.** `REVIEW.md` is harness working state, like `.agent-sdlc/`. Append it to the project's `.gitignore` the way `.agent-sdlc/` is handled.

**(b) Move it.** Write it to `.agent-sdlc/REVIEW.md`, which is already ignored, and leave the project root untouched.

(b) is the smaller blast radius and needs no write to a file the harness does not own — prefer it unless reading `templates/REVIEW.md` shows it is meant for humans to edit and commit, in which case (a) is right. Read the template before choosing.

- [ ] **Step 2: Write the failing test**

Add to `scripts/test-project-detection.mjs`:

```js
await test('init-does-not-leave-an-untracked-file-in-the-project-root',async ()=>{
  const d=makeTempDir('agent-sdlc-init-clean-');
  execFileSync('git',['init','-q'],{cwd:d});
  fs.writeFileSync(path.join(d,'README.md'),'# fixture\n');
  execFileSync('git',['add','.'],{cwd:d});
  execFileSync('git',['-c','user.email=t@t.local','-c','user.name=t','commit','-qm','init'],{cwd:d});

  initProject(d,detectProject(d));

  // The harness's own scope audit treats a dirty tree as a scope violation, so
  // initialization must not create one.
  const status=execFileSync('git',['status','--porcelain'],{cwd:d,encoding:'utf8'}).trim();
  assert(status==='',`init left the tree dirty:\n${status}`);
});
```

- [ ] **Step 3: Run it and confirm it fails**

Run: `npm run test:detection`
Expected: FAIL — `init left the tree dirty:  ?? REVIEW.md`.

- [ ] **Step 4: Implement the choice from Step 1**

For (b), in `runtime/store.mjs`:

```js
  // REVIEW.md used to land in the project root, ignored by nothing. The harness
  // treats a dirty tree as a scope violation during task verification, so its
  // own initialization was manufacturing the condition it polices. It is
  // harness state; it lives with the rest of it.
  const reviewTemplate=path.join(ROOT,'templates','REVIEW.md');
  const targetReview=path.join(d,'REVIEW.md');
```

`d` is already the `.agent-sdlc` state directory at that point in `initProject` — confirm that by reading the surrounding lines, since the existing code writes `project.json` into `d` two lines later.

- [ ] **Step 5: Run the test and the suites that read REVIEW.md**

Run: `npm run test:detection && grep -rn "REVIEW.md" --include=*.mjs runtime scripts`
Expected: the test passes, and every remaining reference resolves to the new location. `runtime/commands/project.mjs:18-19` has its own copy of this path — update it to match or the two disagree.

- [ ] **Step 6: Run the full gate**

Run: `npm run check`
Expected: 46/46 PASS.

- [ ] **Step 7: Commit**

```bash
git add runtime/store.mjs runtime/commands/project.mjs scripts/test-project-detection.mjs
git commit -m "fix(init): keep REVIEW.md out of the project working tree"
```

---

### Task 2: Exercise the Antigravity hook the way its manifest invokes it

**Files:**
- Modify: `adapters/antigravity/hooks.json` (then `npm run sync:root`)
- Modify: `scripts/test-antigravity-bootstrap-hook.mjs`

**Interfaces:**
- Consumes: `hooks/antigravity-preinvocation.mjs`.
- Produces: no new exports.

The manifest runs `node ./hooks/antigravity-preinvocation.mjs` — relative to whatever the host's working directory happens to be. The Claude adapter uses `${CLAUDE_PLUGIN_ROOT}`. The suite spawns the hook by absolute path, so the manifest's actual command string has never run.

- [ ] **Step 1: Write the failing test**

Add to `scripts/test-antigravity-bootstrap-hook.mjs`:

```js
await test('the-manifest-command-runs-from-a-foreign-working-directory',async ()=>{
  // The host chooses the working directory, not us. Running the manifest's own
  // command string from somewhere else is the only way to find out whether the
  // hook resolves -- spawning it by absolute path proves nothing about the
  // string the host will actually execute.
  const manifest=JSON.parse(fs.readFileSync(path.join(ROOT,'adapters','antigravity','hooks.json'),'utf8'));
  const command=manifest['agent-sdlc-context-reminder'].PreInvocation[0].command;
  const elsewhere=makeTempDir('agent-sdlc-foreign-cwd-');
  const resolved=command.replaceAll('${AGENT_SDLC_PLUGIN_ROOT}',ROOT);
  const r=spawnSync(resolved,{cwd:elsewhere,shell:true,input:JSON.stringify({}),encoding:'utf8',timeout:10000,
    env:{...process.env,AGENT_SDLC_PLUGIN_ROOT:ROOT}});
  assert(r.status===0,`the manifest command failed from a foreign cwd: ${r.stderr||r.stdout}`);
  assert((r.stdout||'').includes('sdlc-router'),`the hook must still emit the bootstrap, got: ${r.stdout}`);
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npm run test:antigravity-bootstrap`
Expected: FAIL — `Cannot find module ...\hooks\antigravity-preinvocation.mjs`, because `./hooks/...` resolved against the temp directory.

- [ ] **Step 3: Check what variable the host actually provides**

Read `docs/AUTO-ACTIVATION.md` and `adapters/antigravity/plugin.json` for the plugin-root variable Antigravity sets. **Do not invent one.** If Antigravity provides no such variable, the correct fix is different: keep the relative path and document the working-directory requirement, and change the test to assert the documented contract instead. Decide from the documentation, not from symmetry with Claude.

- [ ] **Step 4: Apply the fix**

If a plugin-root variable exists, in `adapters/antigravity/hooks.json`:

```json
        "command": "node \"${AGENT_SDLC_PLUGIN_ROOT}/hooks/antigravity-preinvocation.mjs\"",
```

substituting the real variable name from Step 3, and update the test's `replaceAll` to match.

- [ ] **Step 5: Mirror to the root copy**

Run: `npm run sync:root`
Then: `npm run test:root-sync`
Expected: PASS. `hooks.json` at the repository root is a byte-for-byte mirror; editing it directly instead fails this gate.

- [ ] **Step 6: Run the activation suites**

Run: `npm run test:activation`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add adapters/antigravity/hooks.json hooks.json scripts/test-antigravity-bootstrap-hook.mjs
git commit -m "fix(antigravity): resolve the preinvocation hook by plugin root, and test the manifest's own command"
```

---

### Task 3: Return a structured summary for recognised test output

**Files:**
- Modify: `runtime/tools.mjs` (the `invokeTool` result assembly around lines 262-269)
- Test: `scripts/test-cli-contract.mjs` or a new case in `evals/run-deterministic.mjs` — put it wherever `test.run_targeted`'s existing cases live (`targeted-test-built-in-pass` is in `evals/run-deterministic.mjs`).

**Interfaces:**
- Consumes: the existing `result.raw` and `result.summary`.
- Produces: `result.summary` becomes a compact structured string when the tool's stdout ends in a JSON object carrying `checks`/`failures` or `passes`; `full_log_artifact` is unchanged and still carries everything.

The harness's own invariant is "tool output is bounded; store raw logs as artifacts and pass structured summaries". Today a passing run returns roughly 24 KB of PASS lines — the least informative bytes available — and the caller pays for them in context.

- [ ] **Step 1: Write the failing test**

```js
test('a-recognised-test-report-is-summarised-not-pasted',()=>{
  // The suites in this repository, and any project whose test command prints a
  // JSON report, end their stdout with one object. Returning its counts beats
  // returning the first 24000 bytes of the pass list.
  // Mirror `targeted-test-built-in-pass` in this same file: it already builds a
  // project fixture and drives a run to a stage where test.run_targeted is
  // allowed. Copy its setup verbatim rather than inventing a second one.
  const tmp=mkProjectFixture();
  const r=route(ROOT,'Fix calculation bug in helper');
  const run=transition(ROOT,tmp,newRun(ROOT,tmp,{objective:'Fix calculation bug in helper',route:r}),'REQUIREMENTS',{});
  const out=invokeTool(ROOT,tmp,run,'test.run_targeted',{selector:'x'});
  if(out.summary.length>2000)throw Error(`summary should be compact, got ${out.summary.length} bytes`);
  if(!/checks/.test(out.summary))throw Error(`summary should carry the counts, got: ${out.summary}`);
  if(!out.full_log_artifact)throw Error('the full log must still be stored');
});
```

Configure the fixture's `test_targeted` command to print a small JSON report, e.g.
`['node','-e','console.log(JSON.stringify({schema:"x/v1",checks:3,passes:3,failures:0,results:[]}))']`.

- [ ] **Step 2: Run it and confirm it fails**

Run: `npm test`
Expected: FAIL on the compactness assertion (today the whole document is the summary).

- [ ] **Step 3: Summarise recognised output**

In `runtime/tools.mjs`, before the result object is assembled:

```js
// "Bounded output, structured summaries" was half true: output was bounded and
// the summary was the first 24 KB of the log. For a passing run that is a list
// of PASS lines -- the least informative bytes available -- and the caller pays
// for them in context. A trailing JSON report is the shape every suite here and
// most project runners emit; when we recognise one, send its counts and the
// names that failed. The raw log is already an artifact either way.
function summariseReport(raw){
  const start=raw.lastIndexOf('\n{');
  const text=start>=0?raw.slice(start+1):raw.trimStart().startsWith('{')?raw:null;
  if(!text)return null;
  let doc;try{doc=JSON.parse(text);}catch{return null;}
  if(typeof doc!=='object'||doc===null)return null;
  if(doc.checks===undefined&&doc.failures===undefined&&doc.passes===undefined)return null;
  const failed=Array.isArray(doc.results)?doc.results.filter(r=>r&&r.status==='FAIL').map(r=>r.name??'?'):[];
  const head=`${doc.schema??'report'}: ${doc.checks??'?'} checks, ${doc.passes??'?'} passes, ${doc.failures??'?'} failures`;
  return failed.length?`${head}\nfailed: ${failed.join(', ')}`:head;
}
```

and apply it where the result is finalised:

```js
  const structured=result.raw?summariseReport(result.raw):null;
  const out={tool,status:result.status,reason:result.reason??null,exit_code:result.exit_code,
    summary:structured??result.summary,failures:[],full_log_artifact:full,truncated:structured?false:result.truncated};
```

Keep `full` computed as it is today — a passing run whose summary is now compact still deserves its log, so widen that condition to store the artifact whenever `structured` is non-null as well.

- [ ] **Step 4: Run the affected suites**

Run: `npm test && npm run test:cli-contract && npm run test:mcp`
Expected: PASS. Any case asserting on the old raw-text summary is a case that was pinning the defect — update it and say so in the commit.

- [ ] **Step 5: Run the full gate**

Run: `npm run check`
Expected: 46/46 PASS.

- [ ] **Step 6: Commit**

```bash
git add runtime/tools.mjs evals/run-deterministic.mjs
git commit -m "feat(tools): summarise a recognised test report instead of pasting its log"
```

---

### Task 4: Document the report / evidence ordering

**Files:**
- Modify: `docs/runbooks/FAILURE-RECOVERY.md`

**Interfaces:** none. This task ships prose.

Every suite rewrites its own tracked `evals/*.json`, so `tool-run` leaves the tree dirty. Restoring those reports *after* gate evidence is recorded changes the workspace and marks the evidence stale — `gate blocked at VERIFY; stale evidence (workspace changed since it was recorded)`. The working order is: restore first, run the tool, transition without touching the tree. Nothing says so, and the failure reads like a harness bug.

- [ ] **Step 1: Add the section**

```markdown
## "Stale evidence (workspace changed since it was recorded)"

Gate evidence is bound to the workspace state at the moment the tool ran. Any
change to the tree afterwards — including restoring a file — invalidates it.

This bites most often with the tracked reports under `evals/`. Every suite
rewrites its own report, so `agent-sdlc tool-run --tool test.run_targeted`
leaves the tree dirty; restoring those reports before transitioning is what
makes the evidence stale.

The order that works:

1. Restore any tracked reports a previous run dirtied (`npm run check` does this
   in its `hygiene` stage; `git checkout -- evals/` does it directly).
2. Run the tool that produces the evidence.
3. Transition immediately, without touching the tree in between.

Restoring the reports afterwards is fine — the transition has already happened.
```

- [ ] **Step 2: Commit**

```bash
git add docs/runbooks/FAILURE-RECOVERY.md
git commit -m "docs(runbook): explain stale gate evidence and the tracked-report cycle"
```

---

### Task 5: Housekeeping

**Files:** none tracked.

- [ ] **Step 1: Reword the F1 commit message**

`709ca04` carries a harness-generated message: `chore(sdlc): commit changes for TASK-010 [<the entire goal sentence>]`. It is on `master` and unpushed, so amending is safe and local.

```bash
git commit --amend -m "fix(auto): bound the auto-scaffolded write scope and pause when it cannot be bounded

detectWriteScope claimed every top-level directory plus '*.*', which put the
single scaffolded task over plan-validator's giant_task_write_scope_threshold
with no scope_justification -- so \`agent-sdlc auto\` threw at the PLAN gate on
any repository of ordinary size.

It now prefers recognised source directories, falls back to the directories that
actually exist rather than a fixed list that may name none of them, and routes
the unrecognised-and-too-wide case to a Gate 1 pause instead of throwing or
self-issuing a justification for a scope it cannot bound."
```

Confirm nothing has been pushed first: `git log origin/master..master --oneline` should show the commit as unpushed, or error because no such remote ref exists.

- [ ] **Step 2: Remove the stale worktrees**

Two remain under `.agent-sdlc/workspaces/`: one from the superseded `TASK-001` of run `4d2c9237`, one from run `add72e05`.

```bash
git worktree list
git worktree remove .agent-sdlc/workspaces/run_4d2c9237-72f8-40c1-8b03-6e11dbb22d57/TASK-001-tree
git worktree remove .agent-sdlc/workspaces/run_add72e05-475c-40f2-8325-dacd93b713fa/TASK-001-tree
git worktree prune
```

Check each for uncommitted work before removing it — `git -C <path> status --porcelain` must be empty. `agent-sdlc task workspace-clean` is the harness's own route to the same outcome; prefer it if it handles both.

- [ ] **Step 3: Confirm the tree is clean**

Run: `git status --porcelain && git worktree list`
Expected: no output from the first, and only the main worktree from the second.

---

## Self-Review Notes

- **Spec coverage:** F8 → Task 1. F9 → Task 2. F11 → Task 3. E4 → Task 4. Housekeeping → Task 5.
- **Task 1 and Task 2 both have a real decision inside them** (where `REVIEW.md` belongs; whether Antigravity provides a plugin-root variable). Both steps say to read before choosing, because guessing produces a change that passes its own test and is still wrong.
- **Task 3 is the one with regression risk.** `summariseReport` changes what every caller of `tool-run` sees. The test suites that assert on summary text are the safety net; if none of them fails when this lands, that is a signal the summary is under-tested, not that the change is safe.
