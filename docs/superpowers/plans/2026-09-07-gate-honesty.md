# Gate Honesty Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the DESIGN, PLAN and VERIFY security gates rest on content that was actually written and tools that actually ran, instead of placeholders, unmarked machine guesses, and caller assertions.

**Architecture:** Three independent tightenings that share one rule — a gate token is only as trustworthy as what produced it. `validateDesignDecision` gains a placeholder guard so a scaffold is invalid until filled; `scaffoldTaskPlan` stamps provenance so a reader can tell a guess from a decision; `security.sast` becomes a builtin backed by the shipped linter, and `no_new_high_security_findings` becomes runtime-derived at the same site that already derives `targeted_verification_pass`. Where a tightening would make `runAutoPipeline` throw, it pauses at Gate 1 instead, following the pattern established in `709ca04`.

**Tech Stack:** Node >=18 ESM, no runtime dependencies. Suites are plain `.mjs` scripts using `scripts/lib/suite.mjs` and `scripts/lib/report-io.mjs`.

**Spec:** `docs/superpowers/specs/2026-09-07-remaining-plugin-audit-findings.md` (F2, F3, F10)

## Global Constraints

- Node `>=18`; `"type": "module"`; **zero runtime dependencies**.
- Any new npm test script must be added to BOTH `scripts/lib/check-plan.mjs` and `.github/workflows/ci.yml`; `scripts/validate-ci-coverage.mjs` asserts membership and stage order.
- Tracked `evals/*.json` reports go through `writeReport` from `scripts/lib/report-io.mjs` and carry a `version` from `agent-sdlc.manifest.json`.
- Comments state WHY. A comment that overclaims what the code does is a defect.
- `npm run check` (46 suites) must be green before each commit.
- Do not add a `--force` or bypass path to any gate. A blocked gate is fixed by producing evidence.

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `runtime/design-discovery.mjs` | Design-mode selection, scaffold, structural validation | Add placeholder detection to `validateDesignDecision` |
| `runtime/autonomous-runner.mjs` | The `auto` pipeline and its human gates | Pause at Gate 1 when a scaffolded design decision cannot be recorded; stamp plan provenance |
| `runtime/plan-validator.mjs` | Deterministic plan-quality gate | Warn on a scaffolded plan |
| `runtime/tools.mjs` | Tool dispatch, output bounding, evidence derivation | Implement `security.sast` as builtin; derive the security gate token |
| `config/tools.json` | Tool registry | `security.sast` → `"implementation": "builtin"` |
| `policies/stage-policy.json` | Gate requirements and evidence authority | `no_new_high_security_findings` → `"runtime"` |
| `evals/run-deterministic.mjs` | Deterministic regression suite | New cases for all three |

---

### Task 1: Reject unreplaced placeholders in a design decision

**Files:**
- Modify: `runtime/design-discovery.mjs` (inside `validateDesignDecision`, near the FULL-mode option loop at ~line 217)
- Test: `evals/run-deterministic.mjs`

**Interfaces:**
- Consumes: `scaffoldDesignDecision(selection, {objective})`, `validateDesignDecision(decision)` — both already exported.
- Produces: error strings of the form `PLACEHOLDER_TEXT_NOT_REPLACED:<field>`. Task 2 matches on this exact prefix.

- [ ] **Step 1: Write the failing test**

Add to `evals/run-deterministic.mjs`, next to the existing `design-scaffold-full-mode-*` case:

```js
test('a-full-design-decision-of-placeholders-does-not-pass-the-gate',()=>{
  const selection=selectDesignDiscoveryMode({profile:'STRICT',objective:'database schema migration with backfill'});
  const draft=scaffoldDesignDecision(selection,{objective:'database schema migration with backfill'});
  const v=validateDesignDecision(draft);
  // The scaffold is shaped right and says TODO in every field that needs
  // judgement. Structure is not content: it must not emit gate evidence.
  if(v.valid)throw Error('a scaffold of TODOs validated');
  if(!v.errors.some(e=>e.startsWith('PLACEHOLDER_TEXT_NOT_REPLACED:')))throw Error(JSON.stringify(v.errors));
  if(v.gate_evidence.length)throw Error(`emitted gate evidence anyway: ${JSON.stringify(v.gate_evidence)}`);

  // Filling the fields in is all it takes to pass.
  const filled={...draft,
    decision:'Backfill in batches behind a feature flag.',
    options:draft.options.map((o,i)=>({...o,summary:`Option ${i}`,benefits:['ships incrementally'],tradeoffs:['slower']}))};
  const v2=validateDesignDecision(filled);
  if(v2.errors.some(e=>e.startsWith('PLACEHOLDER_TEXT_NOT_REPLACED:')))throw Error(JSON.stringify(v2.errors));
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npm test`
Expected: FAIL on `a-full-design-decision-of-placeholders-does-not-pass-the-gate` with `a scaffold of TODOs validated`.

- [ ] **Step 3: Add the guard**

In `runtime/design-discovery.mjs`, above `validateDesignDecision`:

```js
// A scaffold hands back `TODO` in every free-text field a FULL decision needs,
// and validation only ever asked whether those fields were non-empty -- so the
// scaffold validated, emitted full_design_approved_or_policy_auto, and the gate
// passed on text nobody had written. Anchored at the start: prose that merely
// mentions a TODO elsewhere in a sentence is not a placeholder.
const PLACEHOLDER=/^\s*TODO\b/i;
const isPlaceholder=(v)=>typeof v==='string'&&PLACEHOLDER.test(v);
```

Inside `validateDesignDecision`, add to the FULL-mode option loop:

```js
    for(const o of options){
      if(!o.id)errors.push('OPTION_MISSING_ID');
      if(!o.summary)errors.push(`OPTION_MISSING_SUMMARY:${o.id||'?'}`);
      else if(isPlaceholder(o.summary))errors.push(`PLACEHOLDER_TEXT_NOT_REPLACED:options[${o.id||'?'}].summary`);
      if(!(o.benefits||[]).length)errors.push(`OPTION_MISSING_BENEFITS:${o.id||'?'}`);
      else if((o.benefits||[]).some(isPlaceholder))errors.push(`PLACEHOLDER_TEXT_NOT_REPLACED:options[${o.id||'?'}].benefits`);
      if(!(o.tradeoffs||[]).length)errors.push(`OPTION_MISSING_TRADEOFFS:${o.id||'?'}`);
      else if((o.tradeoffs||[]).some(isPlaceholder))errors.push(`PLACEHOLDER_TEXT_NOT_REPLACED:options[${o.id||'?'}].tradeoffs`);
    }
```

and, immediately after the existing `MISSING_DECISION_STATEMENT` check:

```js
    if(d.decision&&isPlaceholder(d.decision))errors.push('PLACEHOLDER_TEXT_NOT_REPLACED:decision');
```

and once for every mode, next to the `MISSING_OBJECTIVE` check:

```js
  if(d.objective&&isPlaceholder(d.objective))errors.push('PLACEHOLDER_TEXT_NOT_REPLACED:objective');
```

- [ ] **Step 4: Run the test and the neighbouring scaffold cases**

Run: `npm test`
Expected: PASS. `design-scaffold-full-mode-is-correctly-shaped-but-still-needs-content` must still pass — it asserts only the absence of `FULL_MODE_WITHOUT_OPTIONS`, `MISSING_RECOMMENDED_OPTION`, `MISSING_DECISION_STATEMENT` and `OPTION_MISSING*`, none of which this adds. `design-scaffold-skip-mode-*` and `design-scaffold-compact-mode-*` assert validity and contain no placeholders, so they are unaffected.

- [ ] **Step 5: Commit**

```bash
git add runtime/design-discovery.mjs evals/run-deterministic.mjs
git commit -m "fix(design): refuse a design decision whose required text is still TODO"
```

---

### Task 2: Pause at Gate 1 instead of throwing when the scaffolded decision is unfillable

**Files:**
- Modify: `runtime/autonomous-runner.mjs` (DESIGN stage, the `recordDesignDecision` failure branch at ~line 292)
- Test: `scripts/test-autonomous-runner.mjs`

**Interfaces:**
- Consumes: `PLACEHOLDER_TEXT_NOT_REPLACED:` error prefix from Task 1; `HUMAN_GATES.GATE_1_SCOPE_AND_ARCHITECTURE`.
- Produces: a `PAUSED` result at `current_stage: 'DESIGN'` carrying `validation_errors`.

Task 1 makes a FULL scaffold invalid. `runAutoPipeline` records that scaffold after a human grants design approval, and today an unrecordable decision throws. That would turn Task 1 into a crash for exactly the STRICT runs it is meant to protect.

- [ ] **Step 1: Write the failing test**

Add to `scripts/test-autonomous-runner.mjs`:

```js
await test('an-unfillable-scaffolded-design-decision-pauses-rather-than-throwing',async ()=>{
  // Gate 1 clears on approval, then the FULL scaffold still has TODOs in it.
  // Throwing there would punish the operator for approving; asking again is
  // the honest move, and the errors say which fields need writing.
  const d=fixture('auto-design-placeholder');
  const r=route(ROOT,'Fix high severity CVE security vulnerability in auth module');
  const run=newRun(ROOT,d,{objective:'Fix high severity CVE security vulnerability in auth module',route:r});
  const ticket=requestApprovalTicket(ROOT,d,run,{capability:GATE_CAPABILITIES.DESIGN_HUMAN_APPROVED});
  grantApprovalTicket(ROOT,d,run,{ticketId:ticket.ticket_id,actor:'operator'});

  let threw=null;let res=null;
  try{res=runAutoPipeline(ROOT,d,loadRun(d,run.run_id));}catch(e){threw=e;}
  assert(threw===null,`must not throw, got: ${threw&&threw.message}`);
  assert(res.status==='PAUSED','an unfillable scaffold must pause');
  assert(res.current_stage==='DESIGN','paused stage must be DESIGN');
  assert(res.pause_gate===HUMAN_GATES.GATE_1_SCOPE_AND_ARCHITECTURE,'paused gate must be GATE_1_SCOPE_AND_ARCHITECTURE');
  assert(Array.isArray(res.validation_errors)&&res.validation_errors.some(e=>String(e).startsWith('PLACEHOLDER_TEXT_NOT_REPLACED:')),
    `the pause must name the unwritten fields, got ${JSON.stringify(res.validation_errors)}`);
});
```

Add `GATE_CAPABILITIES` to the existing `runtime/approvals.mjs` import at the top of the file if it is not already imported.

- [ ] **Step 2: Run it and confirm it fails**

Run: `npm run test:autonomous-runner`
Expected: FAIL — `must not throw, got: Failed to record design decision: [...]`.

- [ ] **Step 3: Replace the throw with a pause**

In `runtime/autonomous-runner.mjs`, replace the `if(!rec.recorded){ throw ... }` block in the DESIGN stage:

```js
      const rec=recordDesignDecision(root,projectRoot,currentRun,decision,{approvals:activeCapabilities(root,currentRun)});
      if(!rec.recorded){
        // The scaffold is a shape, not a decision: FULL mode leaves TODOs where
        // real judgement has to go, and validation now refuses them. Throwing
        // would punish the operator for having approved the direction; asking
        // again, with the field names, is the same answer Gate 1 already gives
        // for "no safe automatic answer".
        return {
          status:'PAUSED',
          current_stage:'DESIGN',
          pause_gate:HUMAN_GATES.GATE_1_SCOPE_AND_ARCHITECTURE,
          run:currentRun,
          stage_steps:stageSteps,
          mode_result:modeResult,
          validation_errors:rec.validation.errors,
          message:'The auto-scaffolded design decision still has unwritten fields. Author it and record it: `agent-sdlc design scaffold --run-id <id> > decision.json`, fill the TODO fields, then `agent-sdlc design record --run-id <id> --file decision.json`. `agent-sdlc auto` resumes from there.'
        };
      }
```

- [ ] **Step 4: Run the suite**

Run: `npm run test:autonomous-runner`
Expected: PASS, and every pre-existing case still passes — the STRICT fixtures pause at Gate 1 *before* this branch, so they never reach it.

- [ ] **Step 5: Verify the recovery the message names actually works**

Add a second case driving it, mirroring `the-gate-1-scope-pause-names-a-recovery-that-actually-works`:

```js
await test('an-authored-design-decision-clears-the-placeholder-pause',async ()=>{
  const {recordDesignDecision}=await import('../runtime/orchestrator.mjs');
  const {scaffoldDesignDecision,selectDesignDiscoveryMode}=await import('../runtime/design-discovery.mjs');
  const d=fixture('auto-design-authored');
  const r=route(ROOT,'Fix high severity CVE security vulnerability in auth module');
  let run=newRun(ROOT,d,{objective:'Fix high severity CVE security vulnerability in auth module',route:r});
  const ticket=requestApprovalTicket(ROOT,d,run,{capability:GATE_CAPABILITIES.DESIGN_HUMAN_APPROVED});
  grantApprovalTicket(ROOT,d,run,{ticketId:ticket.ticket_id,actor:'operator'});
  run=loadRun(d,run.run_id);
  const paused=runAutoPipeline(ROOT,d,run);
  assert(paused.current_stage==='DESIGN','precondition: paused in DESIGN');

  const selection=selectDesignDiscoveryMode({profile:run.profile,objective:run.objective});
  const draft=scaffoldDesignDecision(selection,{objective:run.objective});
  const authored={...draft,
    decision:'Patch the dependency and add a regression test for the CVE path.',
    options:draft.options.map((o,i)=>({...o,summary:`Option ${i}`,benefits:['closes the CVE'],tradeoffs:['touches auth']}))};
  run=loadRun(d,run.run_id);
  const rec=recordDesignDecision(ROOT,d,run,authored,{approvals:[GATE_CAPABILITIES.DESIGN_HUMAN_APPROVED]});
  assert(rec.recorded===true,`an authored decision must be accepted, got ${JSON.stringify(rec.validation&&rec.validation.errors)}`);
});
```

Run: `npm run test:autonomous-runner`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add runtime/autonomous-runner.mjs scripts/test-autonomous-runner.mjs
git commit -m "fix(auto): pause for an authored design decision instead of throwing on the scaffold"
```

---

### Task 3: Stamp provenance on a scaffolded plan

**Files:**
- Modify: `runtime/autonomous-runner.mjs` (`scaffoldTaskPlan`)
- Modify: `runtime/plan-validator.mjs` (`validateTaskPlan`, warnings section)
- Test: `scripts/test-autonomous-runner.mjs`, `evals/run-deterministic.mjs`

**Interfaces:**
- Produces: `plan.generated_by === 'auto-scaffold'` on scaffolded plans, and warning code `SCAFFOLDED_PLAN_NOT_AUTHORED` from `validateTaskPlan`.

This must be a **warning**, never an error: `auto` depends on scaffolded plans validating.

- [ ] **Step 1: Write the failing tests**

In `scripts/test-autonomous-runner.mjs`:

```js
await test('a-scaffolded-plan-says-so-and-an-authored-one-does-not',async ()=>{
  const {scaffoldTaskPlan}=await import('../runtime/autonomous-runner.mjs');
  const d=fixture('auto-plan-provenance');
  fs.mkdirSync(path.join(d,'src'),{recursive:true});
  const plan=scaffoldTaskPlan({objective:'Add payment endpoint',profile:'STANDARD'},d);
  assert(plan.generated_by==='auto-scaffold','a scaffolded plan records its provenance');
  const v=validateTaskPlan(plan);
  assert(v.valid===true,'provenance must not make the plan invalid; auto depends on it validating');
  assert(v.warnings.some(w=>w.code==='SCAFFOLDED_PLAN_NOT_AUTHORED'),
    `a scaffolded plan must be surfaced as a warning, got ${JSON.stringify(v.warnings)}`);

  const authored={...plan};delete authored.generated_by;
  const v2=validateTaskPlan(authored);
  assert(!v2.warnings.some(w=>w.code==='SCAFFOLDED_PLAN_NOT_AUTHORED'),'an authored plan carries no such warning');
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npm run test:autonomous-runner`
Expected: FAIL — `a scaffolded plan records its provenance`.

- [ ] **Step 3: Stamp it and warn on it**

In `runtime/autonomous-runner.mjs`, in the object `scaffoldTaskPlan` returns, next to `plan_id`:

```js
    // A guess and a decision are the same shape, which is how a scaffolded plan
    // came to look like something a person had thought about. Provenance is one
    // field, and plan-validator turns it into a warning a reader will see.
    generated_by:'auto-scaffold',
```

In `runtime/plan-validator.mjs`, before the `return`:

```js
  if(p.generated_by==='auto-scaffold')warn('SCAFFOLDED_PLAN_NOT_AUTHORED',{plan_id:p.plan_id??null});
```

- [ ] **Step 4: Run both suites**

Run: `npm run test:autonomous-runner && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add runtime/autonomous-runner.mjs runtime/plan-validator.mjs scripts/test-autonomous-runner.mjs
git commit -m "feat(plan): record that an auto-scaffolded plan was not authored"
```

---

### Task 4: Back `security.sast` with the shipped linter

**Files:**
- Modify: `runtime/tools.mjs` (add a `sastScan` builtin next to `secretScan` at ~line 117; dispatch it)
- Modify: `config/tools.json` (`security.sast` → `"implementation": "builtin"`)
- Test: `scripts/test-security-linter.mjs`

**Interfaces:**
- Consumes: `lintSecurityRisks(codeString,{filename})` from `runtime/security-linter.mjs` — the only export of that module.
- Produces: a tool result of the same shape `secretScan` returns: `{status,reason,exit_code,summary,truncated,raw}`. Task 5 derives evidence from `status`.

- [ ] **Step 1: Write the failing test**

Append to `scripts/test-security-linter.mjs`:

```js
await test('security-sast-runs-the-shipped-linter-over-changed-files',async ()=>{
  const {invokeTool}=await import('../runtime/tools.mjs');
  const d=fixture('sast-tool');           // reuse this suite's existing fixture helper
  fs.mkdirSync(path.join(d,'src'),{recursive:true});
  fs.writeFileSync(path.join(d,'src','risky.js'),'const q = "SELECT * FROM t WHERE id=" + userInput;\neval(userInput);\n');
  const run=newRun(ROOT,d,{objective:'Add lookup',route:route(ROOT,'Add lookup endpoint')});
  const res=invokeTool(ROOT,d,run,'security.sast',{});
  assert(res.status!=='ERROR',`sast must be builtin now, got ${res.status}: ${JSON.stringify(res.summary)}`);
  assert(res.status==='FAIL','a file with eval() and string-built SQL must not pass');
  assert(String(res.summary).includes('src/risky.js'),`the summary must name the file, got ${res.summary}`);
});

await test('security-sast-passes-a-clean-tree',async ()=>{
  const {invokeTool}=await import('../runtime/tools.mjs');
  const d=fixture('sast-clean');
  fs.mkdirSync(path.join(d,'src'),{recursive:true});
  fs.writeFileSync(path.join(d,'src','clean.js'),'export const add=(a,b)=>a+b;\n');
  const run=newRun(ROOT,d,{objective:'Add sum',route:route(ROOT,'Add sum helper')});
  const res=invokeTool(ROOT,d,run,'security.sast',{});
  assert(res.status==='PASS',`a clean tree must pass, got ${res.status}: ${res.summary}`);
});
```

If `scripts/test-security-linter.mjs` has no `fixture` helper, copy the one from `scripts/test-autonomous-runner.mjs:19-37` verbatim into it — it is nine lines and duplicating it keeps the suite standalone, which is how every other suite here is written.

- [ ] **Step 2: Run it and confirm it fails**

Run: `npm run test:security-linter`
Expected: FAIL — `sast must be builtin now, got ERROR: tool security.sast requires host/MCP/external implementation`.

- [ ] **Step 3: Implement the builtin**

In `runtime/tools.mjs`, next to `secretScan`:

```js
// security.sast was registered as `external`, so `tool-run security.sast`
// answered "requires host/MCP/external implementation" -- while
// runtime/security-linter.mjs shipped a working deterministic linter with its
// own suite and no caller. The same `--untracked` argument as secretScan:
// a file an implementation task just wrote is the file most worth scanning.
function sastScan(root,projectRoot,maxBytes){
  const argv=['git','ls-files','--cached','--others','--exclude-standard'];
  const launch=resolveLaunch(argv);
  if(launch.status!=='OK'){
    return {status:'ERROR',reason:launch.reason,exit_code:null,
      summary:`${launch.reason}: cannot launch ${argv.join(' ')}`,truncated:false,raw:''};
  }
  const r=spawnSync(launch.bin,launch.args,{cwd:projectRoot,encoding:'utf8',timeout:120000,maxBuffer:4*1024*1024,...launch.spawnOptions});
  const d=describeSpawn(r);
  if(d.status==='ERROR'){
    return {status:'ERROR',reason:d.reason,exit_code:null,
      summary:`${d.reason}: ${argv.join(' ')}`,truncated:false,raw:''};
  }
  const files=(r.stdout||'').split('\n').filter(f=>/\.(js|mjs|cjs|jsx|ts|tsx)$/.test(f));
  const findings=[];
  for(const rel of files){
    let code;
    try{code=fs.readFileSync(path.join(projectRoot,rel),'utf8');}catch{continue;}
    for(const f of lintSecurityRisks(code,{filename:rel})){
      findings.push(`${rel}:${f.line??'?'} ${f.severity??'?'} ${f.rule??f.id??'?'} ${f.message??''}`.trim());
    }
  }
  if(!findings.length){
    return {status:'PASS',exit_code:0,summary:`No security findings in ${files.length} scanned source file(s).`,truncated:false,raw:''};
  }
  const raw=findings.join('\n');
  const t=truncateUtf8(raw,maxBytes);
  return {status:'FAIL',exit_code:1,summary:`${findings.length} security finding(s):\n${t.text}`,truncated:t.truncated,raw};
}
```

Add the import at the top of `runtime/tools.mjs`:

```js
import {lintSecurityRisks} from './security-linter.mjs';
```

Dispatch it beside the `security.secret_scan` branch:

```js
  else if(tool==='security.sast'){result=sastScan(root,projectRoot,maxBytes);}
```

- [ ] **Step 4: Flip the registry entry**

In `config/tools.json`, `security.sast`:

```json
    "implementation": "builtin",
```

Leave `security.sca` as `external` — this plan does not implement a dependency scanner, and claiming otherwise would be the same defect in a new place.

- [ ] **Step 5: Confirm the finding shape matches the linter**

Run: `node -e "import('./runtime/security-linter.mjs').then(m=>console.log(JSON.stringify(m.lintSecurityRisks('eval(x);',{filename:'a.js'}),null,1)))"`
Read the actual field names and, if they differ from `line`/`severity`/`rule`/`message`, correct the template string in Step 3 to match. Do not guess.

- [ ] **Step 6: Run the suite**

Run: `npm run test:security-linter`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add runtime/tools.mjs config/tools.json scripts/test-security-linter.mjs
git commit -m "feat(tools): implement security.sast with the shipped deterministic linter"
```

---

### Task 5: Derive `no_new_high_security_findings` instead of accepting it

**Files:**
- Modify: `runtime/tools.mjs:268` (the evidence derivation site)
- Modify: `policies/stage-policy.json` (`evidence_authority`)
- Test: `evals/run-deterministic.mjs`

**Interfaces:**
- Consumes: the `security.sast` builtin from Task 4.
- Produces: the token `no_new_high_security_findings` with `runtime` authority, so `guardEvidenceAuthority` refuses it as a hand-asserted `--evidence` value.

- [ ] **Step 1: Write the failing test**

Add to `evals/run-deterministic.mjs`, next to `caller-cannot-assert-verify-evidence-directly`:

```js
test('caller-cannot-assert-the-security-gate-either',()=>{
  const tmp=mkFixtureAtVerify();   // reuse the helper the neighbouring verify cases use
  const r=loadRun(tmp,RUN_ID);
  let threw=null;
  try{transition(ROOT,tmp,r,'REVIEW',{evidence:['no_new_high_security_findings']});}catch(e){threw=e;}
  if(!threw)throw Error('the security gate token was accepted as a bare assertion');
  if(!/must be produced by the deterministic validator/.test(threw.message))throw Error(threw.message);
});
```

Match the surrounding cases' fixture helper exactly; if they build the run inline rather than through a helper, do the same here rather than inventing one.

- [ ] **Step 2: Run it and confirm it fails**

Run: `npm test`
Expected: FAIL — `the security gate token was accepted as a bare assertion`.

- [ ] **Step 3: Give the token runtime authority**

In `policies/stage-policy.json`, in `evidence_authority`, after `"targeted_verification_pass": "runtime"`:

```json
    "no_new_high_security_findings": "runtime"
```

- [ ] **Step 4: Derive it from the scan**

In `runtime/tools.mjs`, extend the derivation at line 268:

```js
  // A gate token is only as trustworthy as what wrote it. Binding it to the
  // deterministic tool run that produced it, instead of letting a caller assert
  // the same string, is what makes it evidence rather than a claim.
  if(tool==='test.run_targeted')recordEvidence(projectRoot,run,{stage:run.state,claim:'targeted_verification_pass',status:result.status,tool,exitCode:result.exit_code,artifactRef:full});
  if(tool==='security.sast'||tool==='security.secret_scan'){
    recordEvidence(projectRoot,run,{stage:run.state,claim:'no_new_high_security_findings',status:result.status,tool,exitCode:result.exit_code,artifactRef:full});
  }
```

- [ ] **Step 5: Update the runner, which asserts the token today**

`runtime/autonomous-runner.mjs:468` lists `no_new_high_security_findings` in the evidence array it passes to `transition`. With runtime authority that call now throws. Replace the assertion with a real scan before the transition:

```js
      // The token is derived from the scan now, not asserted alongside the test
      // result, so the scan has to actually run here.
      invokeTool(root,projectRoot,currentRun,'security.sast',{});
      const ev=['targeted_verification_pass'];
```

`invokeTool` is already imported in this module.

- [ ] **Step 6: Run everything that touches the VERIFY gate**

Run: `npm test && npm run test:autonomous-runner && npm run test:gates && npm run test:simulate-e2e`
Expected: PASS. `scripts/simulate-e2e-run.mjs:175` also passes this token in an evidence array — if it fails, make it run the scan the same way rather than reinstating the assertion.

- [ ] **Step 7: Run the full gate**

Run: `npm run check`
Expected: 46/46 PASS.

- [ ] **Step 8: Commit**

```bash
git add runtime/tools.mjs runtime/autonomous-runner.mjs policies/stage-policy.json evals/run-deterministic.mjs scripts/simulate-e2e-run.mjs
git commit -m "fix(gates): derive no_new_high_security_findings from a real scan"
```

---

## Self-Review Notes

- **Spec coverage:** F2 → Tasks 1–2. F3 → Task 3. F10 → Tasks 4–5. No other spec item is claimed by this plan.
- **Known risk, Task 5:** giving a token runtime authority breaks every existing caller that asserts it. Two are known (`runtime/autonomous-runner.mjs:468`, `scripts/simulate-e2e-run.mjs:175`) and are handled in Steps 5–6. Before starting, run `grep -rn "no_new_high_security_findings" --include=*.mjs .` and handle anything the grep finds that this plan does not name.
- **Known risk, Task 4:** the finding object's field names are asserted from the plan author's reading, not measured. Step 5 of that task exists to check them before the code is trusted.
