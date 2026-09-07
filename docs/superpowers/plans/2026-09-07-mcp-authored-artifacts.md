# MCP Authored Artifacts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an MCP-only host clear the DESIGN and PLAN gates with an artifact the agent authored, instead of only through the scaffold-driven `pipeline` op.

**Architecture:** Two new tools mirroring the CLI's `design` and `plan` groups, and one new `op` on the existing unified task tool. They wrap the same `runtime/orchestrator.mjs` functions the CLI calls, so the gate semantics are identical by construction — no second implementation of the gate. `agent_sdlc_task` also gains a `plan` argument so `op: "pipeline"` can carry a caller-authored plan into `runAutoPipeline`'s existing `customPlan` option.

**Tech Stack:** Node >=18 ESM, no runtime dependencies. JSON-RPC over stdio; tools declared in `toolDefs` and dispatched in `execute` in `runtime/mcp-server.mjs`.

**Spec:** `docs/superpowers/specs/2026-09-07-remaining-plugin-audit-findings.md` (F5)

**Status:** Complete — all tasks landed. Covers F5. The suite count is 47 as of `f75e8c5` — verification steps below that say "46/46" mean "all suites".

## Global Constraints

- Node `>=18`; `"type": "module"`; **zero runtime dependencies**.
- `runtime/mcp-server.mjs` must not reimplement gate logic. Every new tool delegates to the same function the CLI handler calls.
- No tool may take a `force`, `approval` or bypass argument. `agent_sdlc_transition` already refuses `force`/`approval` with a named error; the new tools inherit that stance by simply not having such an argument.
- `evals/*.json` reports go through `writeReport` and carry a `version` from `agent-sdlc.manifest.json`.
- `npm run check` must be green before each commit.

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `runtime/mcp-server.mjs` | The MCP surface: `toolDefs`, `execute` dispatch | Add `agent_sdlc_design`, `agent_sdlc_plan`; add `materialize` op and `plan` argument to `agent_sdlc_task` |
| `scripts/test-mcp.mjs` | MCP transport and profile enforcement suite | New cases for both tools and the new op |

---

### Task 1: `agent_sdlc_design` — mode, scaffold, validate, record

**Files:**
- Modify: `runtime/mcp-server.mjs` (imports; `toolDefs` after `agent_sdlc_gate_status`; `execute` after the `agent_sdlc_gate_status` branch)
- Test: `scripts/test-mcp.mjs`

**Interfaces:**
- Consumes: `selectDesignDiscoveryMode({profile,objective})`, `scaffoldDesignDecision(selection,{objective})`, `validateDesignDecision(decision)` from `runtime/design-discovery.mjs`; `recordDesignDecision(root,projectRoot,run,decision,{approvals})` from `runtime/orchestrator.mjs`; `activeCapabilities(root,run)` from `runtime/approvals.mjs`.
- Produces: tool `agent_sdlc_design` with `op` ∈ `mode | scaffold | validate | record`. Task 3's test uses `op: "record"`.

- [x] **Step 1: Write the failing test**

Add to `scripts/test-mcp.mjs`, following the shape of the existing `mcp-route-call` case:

```js
await test('mcp-design-tool-scaffolds-validates-and-records',async ()=>{
  const d=fixture('mcp-design');
  const started=await call('agent_sdlc_start',{project_root:d,objective:'Add a caching layer'});
  const runId=started.run_id;
  await call('agent_sdlc_transition',{project_root:d,run_id:runId,to:'REQUIREMENTS'});
  await call('agent_sdlc_transition',{project_root:d,run_id:runId,to:'DESIGN',evidence:['requirements_confirmed']});

  const mode=await call('agent_sdlc_design',{project_root:d,run_id:runId,op:'mode'});
  assert(mode.schema==='agent-sdlc/design-discovery-decision/v1','mode returns a discovery decision');

  const scaffold=await call('agent_sdlc_design',{project_root:d,run_id:runId,op:'scaffold'});
  assert(scaffold.draft&&scaffold.draft.schema==='agent-sdlc/design-decision/v1','scaffold returns a draft');

  const rec=await call('agent_sdlc_design',{project_root:d,run_id:runId,op:'record',decision:scaffold.draft});
  assert(rec.recorded===true,`a valid decision records over MCP, got ${JSON.stringify(rec.validation&&rec.validation.errors)}`);
});
```

Use whatever `call` / `fixture` helpers `scripts/test-mcp.mjs` already defines; do not invent new ones. Read the top of that file first.

- [x] **Step 2: Run it and confirm it fails**

Run: `npm run test:mcp`
Expected: FAIL — unknown tool `agent_sdlc_design`.

- [x] **Step 3: Add the imports**

In `runtime/mcp-server.mjs`:

```js
import {selectDesignDiscoveryMode,scaffoldDesignDecision,validateDesignDecision} from './design-discovery.mjs';
import {recordDesignDecision,recordTaskPlan,materializeRunTasks} from './orchestrator.mjs';
import {validateTaskPlan} from './plan-validator.mjs';
import {activeCapabilities} from './approvals.mjs';
```

`newRun,transition,nextState` are already imported from `./orchestrator.mjs` at line 11 — extend that existing import rather than adding a second one from the same module.

- [x] **Step 4: Declare the tool**

Add to `toolDefs`, after the `agent_sdlc_gate_status` entry:

```js
  // The DESIGN gate is machine-checked, and sdlc-orchestrator tells an agent to
  // fall back to "the corresponding MCP tools" when the CLI is unavailable.
  // There was no corresponding tool: the only MCP route through this gate was
  // the scaffold the `pipeline` op records for you.
  {name:'agent_sdlc_design',description:'Design gate: read the required discovery depth, scaffold a correctly shaped decision, validate one, or record an authored decision. Recording enforces the same structural gate as the CLI; there is no bypass.',inputSchema:{type:'object',required:['run_id','op'],properties:{project_root:{type:'string'},run_id:{type:'string'},op:{type:'string',enum:['mode','scaffold','validate','record']},decision:{type:'object'}}}},
```

- [x] **Step 5: Dispatch it**

Add to `execute`, after the `agent_sdlc_gate_status` line:

```js
  if(name==='agent_sdlc_design'){
    const selection=selectDesignDiscoveryMode({profile:run.profile,objective:run.objective});
    if(a.op==='mode')return selection;
    if(a.op==='scaffold'){
      const draft=scaffoldDesignDecision(selection,{objective:run.objective});
      return {schema:'agent-sdlc/design-decision-scaffold/v1',selection,draft,validation:validateDesignDecision(draft)};
    }
    if(!a.decision||typeof a.decision!=='object')throw new Error('agent_sdlc_design op requires a `decision` object');
    if(a.op==='validate')return validateDesignDecision(a.decision);
    return recordDesignDecision(ROOT,projectRoot,run,a.decision,{approvals:activeCapabilities(ROOT,run)});
  }
```

- [x] **Step 6: Run the suite**

Run: `npm run test:mcp`
Expected: PASS.

Note: if the gate-honesty plan's Task 1 has already landed, a FULL-mode scaffold will not record and this test's fixture must use a STANDARD-profile objective whose design mode is SKIP or COMPACT. `Add a caching layer` routes to `new-feature`/STANDARD, which is why it is the fixture objective here.

- [x] **Step 7: Commit**

```bash
git add runtime/mcp-server.mjs scripts/test-mcp.mjs
git commit -m "feat(mcp): expose the design gate so an MCP host can record an authored decision"
```

---

### Task 2: `agent_sdlc_plan` — validate, record, graph

**Files:**
- Modify: `runtime/mcp-server.mjs` (`toolDefs` and `execute`, directly after the design tool)
- Test: `scripts/test-mcp.mjs`

**Interfaces:**
- Consumes: `validateTaskPlan(plan)`, `recordTaskPlan(root,projectRoot,run,plan)`, `computeTaskGraph(plan)`.
- Produces: tool `agent_sdlc_plan` with `op` ∈ `validate | record | graph`.

- [x] **Step 1: Write the failing test**

```js
await test('mcp-plan-tool-validates-and-records-an-authored-plan',async ()=>{
  const d=fixture('mcp-plan');
  const started=await call('agent_sdlc_start',{project_root:d,objective:'Add a caching layer'});
  const runId=started.run_id;
  await call('agent_sdlc_transition',{project_root:d,run_id:runId,to:'REQUIREMENTS'});
  await call('agent_sdlc_transition',{project_root:d,run_id:runId,to:'PLAN',evidence:['requirements_confirmed']});

  const plan={
    schema:'agent-sdlc/task-plan/v1',plan_id:'plan_mcp_authored',objective:'Add a caching layer',profile:'STANDARD',
    requirements:['AC-1'],
    tasks:[{task_id:'TASK-001',title:'Add the cache',goal:'Add an in-process cache to the lookup path',
      done_conditions:['Lookups hit the cache on the second call'],category:'implementation',depends_on:[],
      acceptance_criteria:['AC-1'],write_scope:['src/**'],
      verification:{targeted_tests:['test/cache.test.js'],expected_behavior:['Second lookup does not hit the backend']}}]
  };

  const invalid=await call('agent_sdlc_plan',{project_root:d,run_id:runId,op:'validate',plan:{...plan,tasks:[]}});
  assert(invalid.valid===false,'an empty plan must not validate');

  const v=await call('agent_sdlc_plan',{project_root:d,run_id:runId,op:'validate',plan});
  assert(v.valid===true,`the authored plan must validate, got ${JSON.stringify(v.errors)}`);

  const rec=await call('agent_sdlc_plan',{project_root:d,run_id:runId,op:'record',plan});
  assert(rec.recorded===true,'a valid authored plan records over MCP');
});
```

- [x] **Step 2: Run it and confirm it fails**

Run: `npm run test:mcp`
Expected: FAIL — unknown tool `agent_sdlc_plan`.

- [x] **Step 3: Declare the tool**

```js
  {name:'agent_sdlc_plan',description:'Plan gate: validate a task plan, record a validated one, or read its derived task graph. Recording runs the same deterministic plan-quality gate as the CLI; an invalid plan is refused, not forced.',inputSchema:{type:'object',required:['run_id','op'],properties:{project_root:{type:'string'},run_id:{type:'string'},op:{type:'string',enum:['validate','record','graph']},plan:{type:'object'}}}},
```

- [x] **Step 4: Dispatch it**

```js
  if(name==='agent_sdlc_plan'){
    if(!a.plan||typeof a.plan!=='object')throw new Error('agent_sdlc_plan op requires a `plan` object');
    if(a.op==='validate')return validateTaskPlan(a.plan,{profile:a.plan.profile||run.profile});
    if(a.op==='graph')return computeTaskGraph(a.plan);
    return recordTaskPlan(ROOT,projectRoot,run,a.plan);
  }
```

Add `computeTaskGraph` to the `./plan-validator.mjs` import from Task 1 Step 3.

- [x] **Step 5: Run the suite**

Run: `npm run test:mcp`
Expected: PASS.

- [x] **Step 6: Commit**

```bash
git add runtime/mcp-server.mjs scripts/test-mcp.mjs
git commit -m "feat(mcp): expose the plan gate for an authored task plan"
```

---

### Task 3: Materialize over MCP, and carry an authored plan into the pipeline

**Files:**
- Modify: `runtime/mcp-server.mjs` (`agent_sdlc_task` tool definition and dispatch)
- Test: `scripts/test-mcp.mjs`

**Interfaces:**
- Consumes: `materializeRunTasks(root,projectRoot,run,plan)`; `runAutoPipeline(root,projectRoot,run,{customPlan,skipCiCheck})` — `customPlan` already exists and is reachable from nowhere.
- Produces: `op: 'materialize'` and a `plan` argument on `agent_sdlc_task`.

- [x] **Step 1: Write the failing test**

```js
await test('mcp-task-tool-materializes-an-authored-plan',async ()=>{
  // Continue from the plan recorded in the previous case's shape: record, then
  // materialize, then confirm the graph holds the authored task rather than a
  // scaffolded one.
  const d=fixture('mcp-materialize');
  const started=await call('agent_sdlc_start',{project_root:d,objective:'Add a caching layer'});
  const runId=started.run_id;
  await call('agent_sdlc_transition',{project_root:d,run_id:runId,to:'REQUIREMENTS'});
  await call('agent_sdlc_transition',{project_root:d,run_id:runId,to:'PLAN',evidence:['requirements_confirmed']});
  const plan={
    schema:'agent-sdlc/task-plan/v1',plan_id:'plan_mcp_materialize',objective:'Add a caching layer',profile:'STANDARD',
    requirements:['AC-1'],
    tasks:[{task_id:'TASK-042',title:'Add the cache',goal:'Add an in-process cache to the lookup path',
      done_conditions:['Lookups hit the cache on the second call'],category:'implementation',depends_on:[],
      acceptance_criteria:['AC-1'],write_scope:['src/**'],
      verification:{targeted_tests:['test/cache.test.js'],expected_behavior:['Second lookup does not hit the backend']}}]
  };
  await call('agent_sdlc_plan',{project_root:d,run_id:runId,op:'record',plan});
  const mat=await call('agent_sdlc_task',{project_root:d,run_id:runId,op:'materialize',plan});
  assert(mat.materialized===true,`materialize must succeed, got ${JSON.stringify(mat.validation&&mat.validation.errors)}`);
  const list=await call('agent_sdlc_task',{project_root:d,run_id:runId,op:'list'});
  assert(JSON.stringify(list).includes('TASK-042'),'the authored task id reached the graph');
});
```

- [x] **Step 2: Run it and confirm it fails**

Run: `npm run test:mcp`
Expected: FAIL — `materialize` is not in the `op` enum.

- [x] **Step 3: Extend the tool definition**

In the `agent_sdlc_task` entry: add `'materialize'` to the `op` enum, add `plan:{type:'object'}` to `properties`, and update the description to name the new op and the plan argument.

- [x] **Step 4: Dispatch it**

In the `agent_sdlc_task` branch of `execute`, before the existing `op` checks:

```js
    if(a.op==='materialize'){
      if(!a.plan||typeof a.plan!=='object')throw new Error("agent_sdlc_task op 'materialize' requires a `plan` object");
      return materializeRunTasks(ROOT,projectRoot,run,a.plan);
    }
```

and change the `pipeline` branch so an authored plan can reach it:

```js
    // runAutoPipeline has always accepted customPlan and nothing could pass one,
    // so every MCP pipeline run used the scaffold. An authored plan is the whole
    // point of the plan tool above.
    if(a.op==='pipeline')return runAutoPipeline(ROOT,projectRoot,run,{skipCiCheck:!!a.skip_ci,customPlan:a.plan||null});
```

- [x] **Step 5: Run the suite**

Run: `npm run test:mcp`
Expected: PASS.

- [x] **Step 6: Run the full gate**

Run: `npm run check`
Expected: 46/46 PASS (47 if the surface-coverage plan's Task 3 has landed).

- [x] **Step 7: Commit**

```bash
git add runtime/mcp-server.mjs scripts/test-mcp.mjs
git commit -m "feat(mcp): materialize an authored plan and carry one into the auto pipeline"
```

---

## Self-Review Notes

- **Spec coverage:** F5 → Tasks 1–3.
- **Deliberately not included:** `task start` / `advance` over MCP. Those dispatch work and bind evidence to a workspace; exposing them is a larger design question than the gate parity F5 asks for, and `op: 'auto'` already drives that loop.
- **Interaction with the gate-honesty plan:** if that plan's Task 1 lands first, a FULL-mode scaffold no longer records. Task 1 Step 6 above names the consequence and picks a fixture objective that avoids it. If gate-honesty has *not* landed, the tests still pass.
- **Check before writing tests:** `scripts/test-mcp.mjs`'s existing helper names (`call`, `fixture`) are assumed from the suite's shape, not read. Read the file first and use whatever it actually defines.
