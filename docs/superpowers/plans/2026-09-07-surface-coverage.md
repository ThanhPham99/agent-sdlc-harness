# Surface Coverage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the local gate and CI cover everything the plugin actually ships — every registered CLI command documented, `typecheck` run, and the Windows leg at parity with ubuntu.

**Architecture:** Three additions to existing gates, no new subsystems. `validate-cli-surface.mjs` gains a documentation-coverage assertion and `docs/USAGE.md` gains the nine missing commands; `typecheck` joins the offline stage of `check-plan.mjs` and the matching CI step; the Windows job gains the four suites it lacks. The documentation gate is what stops F4 recurring, so it lands before the documentation it demands.

**Tech Stack:** Node >=18 ESM, no runtime dependencies. GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-09-07-remaining-plugin-audit-findings.md` (F4, F6, F7)

## Global Constraints

- Node `>=18`; `"type": "module"`; **zero runtime dependencies**.
- `scripts/lib/check-plan.mjs` and `.github/workflows/ci.yml` are checked against each other by `scripts/validate-ci-coverage.mjs`, which asserts membership **and stage order**. Change both or the gate fails.
- `evals/*.json` reports go through `writeReport` and carry a `version` from `agent-sdlc.manifest.json`.
- `npm run check` (46 suites, rising to 47 in Task 2) must be green before each commit.

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `scripts/validate-cli-surface.mjs` | Registry ↔ handlers ↔ help parity | Add docs-coverage assertion |
| `docs/USAGE.md` | The agent- and operator-facing command reference | Add sections for the nine undocumented commands |
| `scripts/lib/check-plan.mjs` | The local gate, as data | Add `typecheck` to the offline stage |
| `.github/workflows/ci.yml` | CI | Add the typecheck step; bring `windows-validation` to parity |

---

### Task 1: Fail the CLI-surface gate on an undocumented command

**Files:**
- Modify: `scripts/validate-cli-surface.mjs` (after the entry-point parity block, before the `report` object at ~line 117)
- Test: the suite is its own test — it fails on the nine commands that are currently undocumented.

**Interfaces:**
- Consumes: `COMMAND_NAMES` from `runtime/commands/index.mjs`, already imported at line 22.
- Produces: `problems` entries of the form ``command `X` is registered but appears in no file under docs/``, and a `documented`/`undocumented` pair on the report object.

Doing this before Task 2 is deliberate: the gate is what keeps F4 from happening again, and writing the docs first would leave nothing proving they stay.

- [ ] **Step 1: Add the assertion**

```js
// --- registry vs the documentation -----------------------------------------
// Nine top-level commands shipped with no mention anywhere in docs/ -- `auto`
// and `ci-check` among them, which are the headline of the release they shipped
// in. Nothing caught it because this suite checked the registry against the
// code and the generated help, and never against the reference an operator
// actually reads. A command is documented when some file under docs/ mentions
// it as `agent-sdlc <name>`: that is the form every existing section uses, and
// it is specific enough that a passing mention of the bare word does not count.
const docsDir=path.join(ROOT,'docs');
const docFiles=[];
(function walk(dir){
  for(const e of fs.readdirSync(dir,{withFileTypes:true})){
    const p=path.join(dir,e.name);
    if(e.isDirectory())walk(p);
    else if(e.name.endsWith('.md'))docFiles.push(p);
  }
})(docsDir);
const docsText=docFiles.map(f=>fs.readFileSync(f,'utf8')).join('\n');
const documented=[];const undocumented=[];
for(const name of COMMAND_NAMES){
  (new RegExp(`agent-sdlc\\s+${name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}\\b`).test(docsText)?documented:undocumented).push(name);
}
for(const name of undocumented){
  problems.push(`command \`${name}\` is registered but appears in no file under docs/ as \`agent-sdlc ${name}\``);
}
```

Add to the `report` object, next to `command_count`:

```js
  documented_count:documented.length,
  undocumented:undocumented.sort(),
```

- [ ] **Step 2: Run it and confirm it fails with exactly the expected list**

Run: `npm run test:cli-surface`
Expected: FAIL, naming `auto`, `auto-task`, `ci-check`, `rewind`, `serve`, `dashboard`, `webhook`, `completion`, `review`.

If the list differs from those nine, the spec's F4 count is stale — trust this output, not the spec, and note the difference in the commit message.

- [ ] **Step 3: Commit the gate, red**

Do not commit a red gate to `master`. Commit it on the working branch only, and let Task 2 turn it green in the same branch before the branch merges.

```bash
git add scripts/validate-cli-surface.mjs
git commit -m "test(cli): fail the surface gate on a command absent from docs/"
```

---

### Task 2: Document the nine commands

**Files:**
- Modify: `docs/USAGE.md` (append sections after the existing section 11)
- Test: `scripts/validate-cli-surface.mjs` (from Task 1)

**Interfaces:**
- Consumes: the gate from Task 1.
- Produces: nothing other code reads.

- [ ] **Step 1: Read the real flags before writing a word**

Run: `node runtime/cli.mjs help`
Then, for each of the nine, read its handler in `runtime/commands/` to get the actual flags. `runtime/commands/index.mjs` maps command → group. Do not document a flag you have not seen parsed — this whole task exists because the docs said things the code did not.

- [ ] **Step 2: Write the sections**

Append to `docs/USAGE.md`, continuing the existing numbering (the file currently ends at `## 11.`):

```markdown
## 12. Autonomous execution (v3.0.0-rc1)

`agent-sdlc auto --run-id <id>` drives the stage machine until the run completes
or reaches a human gate. `agent-sdlc auto-task --run-id <id>` runs only the
scheduling / verification / review loop inside IMPLEMENT.

Both return `status: "PAUSED"` with a `pause_gate` at the five human gates:
scope and architecture sign-off; escalation after repeated verification failure;
a security or compliance exception; pre-commit and push approval; a privileged
production action. A pause is not an error — it is where the runner stops
deciding for you.

`agent-sdlc ci-check --run-id <id>` runs the project's configured local CI
commands and records the result. Gate 4 requires it to pass before asking for
commit and push approval.

## 13. Operating a run

`agent-sdlc dashboard` renders run and task status. `agent-sdlc serve` starts the
built-in live dashboard with an SSE event stream. `agent-sdlc webhook list` and
`agent-sdlc webhook test` inspect and exercise notification endpoints.
`agent-sdlc rewind` returns a run to an earlier checkpoint.
`agent-sdlc review audit` reports the review evidence attached to a run.
`agent-sdlc completion` emits a shell completion script.
```

Then fill each paragraph out with the flags you read in Step 1. The block above is the section skeleton and the framing; it is not a substitute for the flag list.

- [ ] **Step 3: Run the gate**

Run: `npm run test:cli-surface`
Expected: PASS, `undocumented: []`.

- [ ] **Step 4: Run the full gate**

Run: `npm run check`
Expected: 46/46 PASS.

- [ ] **Step 5: Commit**

```bash
git add docs/USAGE.md evals/CLI-SURFACE-VALIDATION.json
git commit -m "docs(usage): document auto, ci-check and the seven other undocumented commands"
```

---

### Task 3: Run `typecheck` in the local gate and in CI

**Files:**
- Modify: `scripts/lib/check-plan.mjs` (the `offline` stage's `parallel` array)
- Modify: `.github/workflows/ci.yml` (`offline-validation` job)

**Interfaces:**
- Consumes: the existing `typecheck` script in `package.json` (`node scripts/validate-types.mjs`), which passes today.
- Produces: nothing; this is wiring.

- [ ] **Step 1: Add it to the plan**

In `scripts/lib/check-plan.mjs`, append `'typecheck'` to the `offline` stage's `parallel` array. It reads only `types/` and writes only its own report, so it is safe alongside the rest.

- [ ] **Step 2: Add the matching CI step**

In `.github/workflows/ci.yml`, in `offline-validation`, in the offline block (before `- name: Build provider distributions`):

```yaml
      - name: TypeScript definition validation
        run: npm run typecheck
```

`scripts/validate-ci-coverage.mjs` asserts stage order, so it must sit among the offline steps, not after `build`.

- [ ] **Step 3: Run the coverage gate**

Run: `npm run test:ci-coverage`
Expected: PASS. A failure here names the mismatch precisely — fix the file it names rather than relaxing the assertion.

- [ ] **Step 4: Run the full gate**

Run: `npm run check`
Expected: 47 suites, all PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/check-plan.mjs .github/workflows/ci.yml evals/CI-COVERAGE-VALIDATION.json
git commit -m "ci: run typecheck in the local gate and on CI"
```

---

### Task 4: Bring the Windows CI leg to parity

**Files:**
- Modify: `.github/workflows/ci.yml` (`windows-validation` job)

**Interfaces:** none.

The Windows job stops at `test:simulator`. The four suites it omits include `test:autonomous-runner`, which is where F1 lived — and Windows is this project's primary development platform.

- [ ] **Step 1: Add the four steps**

In `windows-validation`, after the `Predictive budgeting and pre-flight cost simulator` step and before `Build provider distributions`:

```yaml
      - name: Expanded commands, rewind engine, and webhook edge cases
        run: npm run test:commands-expansion
      - name: Built-in Live Web Dashboard and SSE Streaming Server
        run: npm run test:web-dashboard
      - name: End-to-end full 10-stage lifecycle dogfooding simulation
        run: npm run test:simulate-e2e
      - name: Autonomous SDLC runner and human confirmation gates
        run: npm run test:autonomous-runner
```

Step names are copied verbatim from the `offline-validation` job so the two legs read as the same list.

- [ ] **Step 2: Check whether the coverage gate constrains this job**

Run: `npm run test:ci-coverage`
Expected: PASS. Read `scripts/validate-ci-coverage.mjs` first: if it asserts the Windows job's contents at all, this change must satisfy that assertion; if it only checks `offline-validation` and the `coverage-floor` alternate job, this change is invisible to it and that is fine.

- [ ] **Step 3: Verify the four suites actually pass on Windows locally**

Run: `npm run test:commands-expansion && npm run test:web-dashboard && npm run test:simulate-e2e && npm run test:autonomous-runner`
Expected: PASS. If one fails on Windows, that is a real finding — a suite ubuntu-only by accident. Stop and report it rather than dropping the step from the job.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci(windows): run the four suites the windows leg was missing"
```

---

## Self-Review Notes

- **Spec coverage:** F4 → Tasks 1–2. F6 → Task 3. F7 → Task 4.
- **Ordering:** Task 1 must precede Task 2 (gate before the content it demands), and the two must land on the same branch so `master` never carries a red gate. Tasks 3 and 4 are independent of both and of each other.
- **Task 2 is the one that can go wrong quietly.** The gate only checks that the string `agent-sdlc <name>` appears somewhere under `docs/`; it cannot tell a real section from a mention. Writing a one-line stub to satisfy it would pass the gate and defeat the point.
