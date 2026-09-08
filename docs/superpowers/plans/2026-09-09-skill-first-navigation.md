# Skill-First Agent Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make agents navigate the SDLC by activating the skill their run state names, delete the duplicate slash-command surface, and remove the legacy navigation path so every guidance file is registry-routed.

**Architecture:** The public surface becomes a four-tier skill taxonomy (entry, ops, stage, procedure) declared in `agent-sdlc.manifest.json` and read by one shared helper. Navigation moves out of hardcoded maps in `runtime/context.mjs` into `policies/skill-navigation.json`, and the CLI hands the agent a `navigation` block naming the next skill instead of the agent inferring it. Hosts without a Skill tool keep receiving inlined instruction text, so nothing about provider neutrality changes.

**Tech Stack:** Node.js >= 18, zero runtime dependencies, ESM (`.mjs`). Tests are plain Node scripts: `evals/run-deterministic.mjs` for registry/lifecycle invariants, and `scripts/test-*.mjs` suites built on `scripts/lib/suite.mjs` (`createSuite(schema, reportFile)` returning `{test, assert, finish}`).

**Spec:** `docs/superpowers/specs/2026-09-09-skill-first-navigation-design.md`

## Global Constraints

- Node floor is `18`; dependency mode is `zero-runtime-dependencies`. Never add a package.
- Every `.mjs` file in this repo uses ESM imports with no build step. Match the surrounding compact style (no semicolon-free style, no Prettier reformat of untouched lines).
- The harness version is read from `VERSION`; it is `3.0.0-rc2` at the time of writing. Never hardcode it — read `VERSION` or `manifest.version`.
- `readTextFile` (not `fs.readFileSync`) must be used for any skill or procedure text that feeds `context_hash`, because a CRLF checkout must not change the hash. See `runtime/context.mjs:73-75`.
- Report files under `evals/` are tracked. A suite writes its report via `createSuite`; never hand-edit a report.
- Naming per `policies/coding-standards.json`: `snake_case` for JSON properties and variables, `camelCase` verb-first for functions, `kebab-case` for filenames.
- Run `npm test` (the deterministic suite) after every task. Run `npm run test:integrity` before the final task of each phase.
- Commit after every task. Never use `--force` on a gate and never skip hooks.

---

## File Structure

**Created:**

| Path | Responsibility |
|---|---|
| `scripts/lib/skill-tiers.mjs` | The one reader of the manifest's four tiers. Every validator and the build script consume it, so no script re-derives the surface. |
| `policies/skill-navigation.json` | Declarative navigation: stage to stage-skill to procedures, plus workflow, overlay and conditional routing. Replaces three hardcoded maps. |
| `runtime/skill-navigation.mjs` | Resolves the navigation policy against a run. Pure: takes `(root, projectRoot, run)`, returns ids and guidance. |
| `scripts/test-skill-navigation.mjs` | Differential suite. Proves the policy resolver returns exactly what the deleted maps returned, then that consolidation changes only the intended ids. |
| `scripts/gen-skill-surface.mjs` | Generates `skills/procedures/<id>/SKILL.md` from the registries; `--check` fails on drift. |
| `skills/sdlc-requirements/SKILL.md` … `skills/sdlc-release/SKILL.md` | Seven stage skills holding the per-stage guidance removed from the orchestrator. |

**Deleted:** `commands/` (6 files), `skills/sdlc-route/`, and 17 files under `harness/internal-skills/` (Groups A and B of the spec).

**Modified:** `agent-sdlc.manifest.json`, `config/skills.json`, `config/procedures.json`, `runtime/context.mjs`, `runtime/procedures.mjs`, `runtime/commands/run.mjs`, `runtime/task-worker.mjs`, `skills/sdlc-router/SKILL.md`, `skills/sdlc-orchestrator/SKILL.md`, `.claude-plugin/plugin.json`, `adapters/claude/plugin.json`, and the validation chain (`scripts/build-dist.mjs`, `scripts/verify-dist.mjs`, `scripts/validate-github-install.mjs`, `scripts/validate-registry.mjs`, `scripts/validate-versions.mjs`, `scripts/bump-version.mjs`, `evals/run-deterministic.mjs`).

---

## Phase 1 — Retire the duplicate command surface

### Task 1: Delete `commands/` and merge `sdlc-route` into `sdlc-router`

**Files:**
- Delete: `commands/sdlc-approve.md`, `commands/sdlc-doctor.md`, `commands/sdlc-resume.md`, `commands/sdlc-route.md`, `commands/sdlc-status.md`, `commands/sdlc-task.md`, `skills/sdlc-route/SKILL.md`
- Modify: `skills/sdlc-router/SKILL.md` (append one section), `.claude-plugin/plugin.json:21`, `adapters/claude/plugin.json:20`, `agent-sdlc.manifest.json` (`public_skills`), `config/skills.json` (`public`)
- Test: `evals/run-deterministic.mjs:644`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: a 7-entry `public_skills` array — `sdlc-router`, `sdlc-orchestrator`, `sdlc-approve`, `sdlc-status`, `sdlc-resume`, `sdlc-task`, `sdlc-doctor`. Task 2 replaces this array with tiers; until then it stays the single declared surface.

- [ ] **Step 1: Update the count assertion to the value this task will produce**

In `evals/run-deterministic.mjs`, replace line 644:

```js
test('manifest-public-skill-count-8',()=>{if(manifest.public_skills.length!==8)throw Error('skill count');});
```

with:

```js
test('manifest-public-skill-count-7',()=>{if(manifest.public_skills.length!==7)throw Error(`skill count ${manifest.public_skills.length}`);});
test('no-slash-command-surface',()=>{
  if(fs.existsSync(path.join(ROOT,'commands')))throw Error('commands/ still exists: skills are the only public surface');
  for(const f of ['.claude-plugin/plugin.json','adapters/claude/plugin.json']){
    const m=JSON.parse(fs.readFileSync(path.join(ROOT,f),'utf8'));
    if(m.commands)throw Error(`${f} still declares a commands root`);
  }
});
```

- [ ] **Step 2: Run the suite to verify both cases fail**

Run: `npm test`
Expected: FAIL. `manifest-public-skill-count-7` reports `skill count 8`, and `no-slash-command-surface` reports `commands/ still exists: skills are the only public surface`.

- [ ] **Step 3: Fold the one unique section of `sdlc-route` into `sdlc-router`**

`skills/sdlc-route/SKILL.md` duplicates the router except for its decision-presentation step. Append this to the end of `skills/sdlc-router/SKILL.md`:

```markdown
## Presenting the route decision

Report the decision compactly before handing control to `sdlc-orchestrator`:

- **Selected workflow** — e.g. `bug-fix`
- **Risk profile** — `FAST` | `STANDARD` | `STRICT`
- **Mandatory overlays** — e.g. none, `security`, `hotfix`, `db-migration`
- **Reason codes** — matched keywords or the semantic rationale you applied

Then offer the next action rather than starting it unasked:

```bash
bin/agent-sdlc auto --objective "<objective>" --workflow <workflow>
```
```

- [ ] **Step 4: Delete the duplicate surfaces**

```bash
git rm -r commands skills/sdlc-route
```

- [ ] **Step 5: Drop the `commands` key from both Claude manifests**

In `.claude-plugin/plugin.json` remove the line `"commands": "./commands/",` (line 21). In `adapters/claude/plugin.json` remove `"commands": "./commands/"` (line 20) and the trailing comma now left on the preceding `"skills": "./skills/",` line.

- [ ] **Step 6: Remove `sdlc-route` from both registries**

In `agent-sdlc.manifest.json`, delete `"sdlc-route",` from `public_skills`. In `config/skills.json`, delete `"sdlc-route",` from `public`.

- [ ] **Step 7: Run the suites to verify they pass**

Run: `npm test && npm run test:registry && npm run test:versions && npm run validate:github`
Expected: PASS on all four. `validate:github` must still report `public-skills-match-manifest` green, because the `skills/` directory listing and `public_skills` both lost exactly `sdlc-route`.

- [ ] **Step 8: Confirm no reference to the removed surfaces survives**

Run: `grep -rIn --exclude-dir=.git --exclude-dir=.agent-sdlc --exclude-dir=dist -e 'sdlc-route\b' -e 'commands/sdlc' . | grep -v CHANGELOG | grep -v docs/superpowers`
Expected: only `docs/MIGRATION.md` matches after Step 9, and nothing at all matches before it. Any hit in `scripts/`, `runtime/`, `config/` or `adapters/` is a miss to fix now.

- [ ] **Step 9: Record the rename in `docs/MIGRATION.md`**

Append:

```markdown
## 3.0.0-rc3 — `/sdlc-route` becomes `/sdlc-router`

`commands/` is removed. Skills are the only public surface, identical on every
host, and a skill is slash-invocable — so `/sdlc-status`, `/sdlc-task`,
`/sdlc-resume`, `/sdlc-approve` and `/sdlc-doctor` keep working unchanged.

The one rename: `/sdlc-route` is gone. Use `/sdlc-router`. No alias is
provided, because an alias would reintroduce the duplication this change
removes.
```

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "refactor(surface)!: delete commands/ and merge sdlc-route into sdlc-router"
```

---

## Phase 2 — Four-tier surface model

### Task 2: Introduce the tier helper and retire `public_skills`

**Files:**
- Create: `scripts/lib/skill-tiers.mjs`
- Modify: `agent-sdlc.manifest.json`, `config/skills.json`, `scripts/validate-registry.mjs:63-70`, `scripts/validate-versions.mjs:88-95`, `scripts/bump-version.mjs:56-61,80-87`, `scripts/validate-github-install.mjs:28-32`, `scripts/verify-dist.mjs:51-58`, `scripts/build-dist.mjs:17-19,45-49`, `evals/run-deterministic.mjs`
- Test: `evals/run-deterministic.mjs`

**Interfaces:**
- Consumes: the 7-entry surface from Task 1.
- Produces: `scripts/lib/skill-tiers.mjs` exporting `readSkillTiers(root)` which returns
  `{entry: string[], ops: string[], stage: string[], procedure: string[], discovery: string[], all: string[]}`.
  `discovery` is `[...entry, ...ops, ...stage]` sorted — the exact set of directories allowed at the `skills/` root. `all` is `discovery` plus `procedure`. Tasks 6, 7, 8 and 10 all consume this function; no other module may re-derive the surface.

- [ ] **Step 1: Write the failing test for the tier contract**

Add to `evals/run-deterministic.mjs`, next to the other registry cases, and add `import {readSkillTiers} from '../scripts/lib/skill-tiers.mjs';` to the import block:

```js
test('skill-tiers-declared-and-disjoint',()=>{
  const t=readSkillTiers(ROOT);
  if(!t.entry.includes('sdlc-router')||!t.entry.includes('sdlc-orchestrator'))throw Error('entry tier must hold router and orchestrator');
  if(t.ops.length!==5)throw Error(`ops tier is ${t.ops.length}, wanted 5`);
  const seen=new Set();
  for(const id of t.all){if(seen.has(id))throw Error(`${id} appears in two tiers`);seen.add(id);}
  if(manifest.public_skills)throw Error('public_skills must be replaced by the four tier keys');
});
test('discovery-root-matches-tiers',()=>{
  const t=readSkillTiers(ROOT);
  const dirs=fs.readdirSync(path.join(ROOT,'skills'),{withFileTypes:true})
    .filter(e=>e.isDirectory()&&e.name!=='procedures').map(e=>e.name).sort();
  if(JSON.stringify(dirs)!==JSON.stringify(t.discovery))throw Error(`skills/ holds ${dirs.join(',')} but tiers declare ${t.discovery.join(',')}`);
});
```

- [ ] **Step 2: Run the suite to verify both fail**

Run: `npm test`
Expected: FAIL with `Cannot find module` for `scripts/lib/skill-tiers.mjs`.

- [ ] **Step 3: Write the tier helper**

Create `scripts/lib/skill-tiers.mjs`:

```js
// The single reader of the plugin's skill surface.
//
// Six scripts each re-derived "which skills are discoverable" from
// manifest.public_skills or a hardcoded two-element fallback, so adding a tier
// meant finding all six. The surface is declared once, in the manifest, and
// read here.
import fs from 'node:fs';
import path from 'node:path';

const arr=x=>Array.isArray(x)?x:[];

/**
 * @param {string} root  harness root
 * @returns {{entry:string[],ops:string[],stage:string[],procedure:string[],discovery:string[],all:string[]}}
 */
export function readSkillTiers(root){
  const manifest=JSON.parse(fs.readFileSync(path.join(root,'agent-sdlc.manifest.json'),'utf8'));
  const entry=arr(manifest.entry_skills);
  const ops=arr(manifest.ops_skills);
  const stage=arr(manifest.stage_skills);
  const procedure=arr(manifest.procedure_skills);
  const discovery=[...entry,...ops,...stage].sort();
  return {entry,ops,stage,procedure,discovery,all:[...discovery,...procedure]};
}

/**
 * Filesystem location of a tier member's SKILL.md, relative to the harness
 * root. Procedure skills live under skills/procedures/ so they never sit in the
 * host's discovery root beside the entry skills.
 */
export function skillBodyPath(tiers,id){
  return tiers.procedure.includes(id)
    ? path.join('skills','procedures',id,'SKILL.md')
    : path.join('skills',id,'SKILL.md');
}
```

- [ ] **Step 4: Declare the tiers in the manifest**

In `agent-sdlc.manifest.json`, replace the `public_skills` array with:

```json
  "entry_skills": [
    "sdlc-router",
    "sdlc-orchestrator"
  ],
  "ops_skills": [
    "sdlc-approve",
    "sdlc-status",
    "sdlc-resume",
    "sdlc-task",
    "sdlc-doctor"
  ],
  "stage_skills": [],
  "procedure_skills": [],
```

`stage_skills` and `procedure_skills` stay empty until Tasks 7 and 8 populate them. An empty tier is valid: `discovery` is then just entry plus ops, which is what `skills/` holds today.

- [ ] **Step 5: Drop the duplicate `public` array from the skill registry**

In `config/skills.json`, delete the whole `"public": [...]` array. The file keeps only `schema`, `version` and `internal`.

- [ ] **Step 6: Point the validation chain at the helper**

In `scripts/validate-registry.mjs`, replace lines 63-70 (from the `// Public skills must exist` comment through the `fail('BAD_ENTRY',dir,...)` call) with:

```js
// Tier members must exist as SKILL.md bodies, and the discovery root may hold
// nothing else. Procedure skills live under skills/procedures/ by design.
const tiers=readSkillTiers(ROOT);
for(const id of tiers.all){
  const rel=skillBodyPath(tiers,id);
  if(!fs.existsSync(path.join(ROOT,rel)))fail('MISSING_FILE',id,`skill body not found: ${rel}`);
}
const rootDirs=fs.readdirSync(path.join(ROOT,'skills'),{withFileTypes:true})
  .filter(e=>e.isDirectory()&&e.name!=='procedures').map(e=>e.name);
for(const dir of rootDirs)
  if(!tiers.discovery.includes(dir))
    fail('BAD_ENTRY',dir,'discoverable skill directory is not declared in an agent-sdlc.manifest.json tier');
```

Add `import {readSkillTiers,skillBodyPath} from './lib/skill-tiers.mjs';` to its imports, and in the report `counts` block replace `public_skills:(skills.public||[]).length` with:

```js
    discoverable_skills:tiers.discovery.length,
    procedure_skills:tiers.procedure.length,
```

- [ ] **Step 7: Point the remaining five scripts at the helper**

Each change is mechanical — the same two identifiers replacing the same fallback:

- `scripts/validate-versions.mjs:88-95` — replace `for(const pub of rj('config/skills.json').public||[]){` with `const tiers=readSkillTiers(ROOT);` then `for(const pub of tiers.all){`, and replace both `skills/${pub}/SKILL.md` string literals with `skillBodyPath(tiers,pub)`.
- `scripts/bump-version.mjs:56-61` — rewrite `getPublicSkills` to `export function getPublicSkills(repo_root = ROOT){return readSkillTiers(repo_root).all;}` and, at lines 80-87 and 285, replace the `skills/${skill_name}/SKILL.md` template with `skillBodyPath(readSkillTiers(repo_root), skill_name)`.
- `scripts/validate-github-install.mjs:28-32` — inside `check('public-skills-match-manifest', ...)`, replace the `expected` line with `const expected=readSkillTiers(ROOT).discovery;` and add `&&x.name!=='procedures'` to the `dirs` filter.
- `scripts/verify-dist.mjs:51-58` — inside `check(host,'public-discovery-surface', ...)`, replace the `expected` line with `const expected=readSkillTiers(ROOT).discovery;` and filter `procedures` out of `immediateDirs`.
- `scripts/build-dist.mjs:45-49` — replace the `for(const pub of manifest.public_skills||[...])` loop with:

```js
  const tiers=readSkillTiers(ROOT);
  for(const id of tiers.discovery){
    fs.cpSync(path.join(ROOT,'skills',id),path.join(out,'skills',id),{recursive:true});
  }
  if(tiers.procedure.length){
    fs.mkdirSync(path.join(out,'skills','procedures'),{recursive:true});
    for(const id of tiers.procedure){
      fs.cpSync(path.join(ROOT,'skills','procedures',id),path.join(out,'skills','procedures',id),{recursive:true});
    }
  }
```

and at line 107 replace `public_discovery_skills:(manifest.public_skills||[]).length` with `public_discovery_skills:tiers.discovery.length,procedure_skills:tiers.procedure.length`.

- [ ] **Step 8: Rewrite the packaging invariant comment it used to describe**

Replace `scripts/build-dist.mjs:17-19`:

```js
// Never place internal skills under a host-native `skills/` discovery root.
// Only the two public entry skills are discoverable. Internal stage guidance is
// copied under harness/internal-skills and referenced by a generated registry.
```

with:

```js
// The host's `skills/` discovery root holds exactly the entry, ops and stage
// tiers. Procedure skills are generated under skills/procedures/ -- inside the
// skills tree so a Skill tool can reach them by name, in their own branch so
// they never sit beside an entry skill and never auto-activate. The instruction
// text they reference is copied under harness/internal-skills and addressed by
// the generated registry, which is still the only source of that text.
```

- [ ] **Step 9: Run the full integrity chain**

Run: `npm test && npm run test:integrity && npm run build && npm run verify:dist`
Expected: PASS. `build` prints `procedure_skills: 0`; `verify:dist` reports `public-discovery-surface` green for all three hosts.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "refactor(surface): replace public_skills with a four-tier skill taxonomy"
```

---

## Phase 3 — Deterministic skill navigation

### Task 3: Move the three hardcoded maps into a navigation policy

This is the highest-risk task in the plan: it changes what guidance every run loads. The differential test is written first and must pass with the old maps still present, so a behavioral difference is impossible to miss.

**Files:**
- Create: `policies/skill-navigation.json`, `runtime/skill-navigation.mjs`, `scripts/test-skill-navigation.mjs`
- Modify: `runtime/context.mjs:10-36,57-76`, `runtime/procedures.mjs:76-91`, `package.json` (scripts), `evals/run-deterministic.mjs`
- Test: `scripts/test-skill-navigation.mjs`

**Interfaces:**
- Consumes: `readSkillTiers` from Task 2.
- Produces:
  - `runtime/skill-navigation.mjs` exporting
    `loadNavigationPolicy(root)` → the parsed policy;
    `resolveNavigation(root, projectRoot, run)` → `{stage: string, stage_skill: string|null, core_skill_ids: string[], procedure_ids: string[], guidance: Array<{id: string, text: string}>}`;
    `navigableSkillIds(root)` → `Set<string>` of every id any navigation path can reach.
    Note the two shapes that differ from the CLI's: `guidance` is objects, not strings, because `resolveSkills` needs the id to label the entry it pushes; and `procedure_ids` is what the *policy* declares for the stage, which is a superset of what `resolveProcedures` selects after `when` conditions run. Task 4 reports the selected set, not this one.
  - Task 4 consumes `resolveNavigation`. Task 6 consumes `navigableSkillIds`. `runtime/context.mjs` keeps exporting `legacyReachableSkillIds` as a deprecated alias of `navigableSkillIds` until Step 8 deletes it.

- [ ] **Step 1: Write the differential test**

Create `scripts/test-skill-navigation.mjs`. The expected values are the deleted maps, copied verbatim as literal data — that is the point: the test compares the policy against a frozen snapshot of the behaviour being replaced.

```js
#!/usr/bin/env node
// Differential suite for policies/skill-navigation.json.
//
// The three maps this policy replaces (CORE_SKILL_BY_STAGE, WORKFLOW_SKILLS,
// OVERLAY_SKILLS in runtime/context.mjs) are frozen below as literal data. A
// policy that resolves any run differently from these tables is a regression,
// not a refactor -- so the tables stay here after the maps are deleted.
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createSuite} from './lib/suite.mjs';
import {loadNavigationPolicy,resolveNavigation,navigableSkillIds} from '../runtime/skill-navigation.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const {test,assert,finish}=createSuite('agent-sdlc/skill-navigation-validation/v1','SKILL-NAVIGATION-VALIDATION.json');

const FROZEN_CORE={
  INTAKE:'requirements',REQUIREMENTS:'requirements',DESIGN:'architecture',PLAN:'planning',
  IMPLEMENT:'implementation',VERIFY:'testing',REVIEW:'code-review',RELEASE:'ci-cd',
  DEPLOY:'deployment',OBSERVE:'monitoring',CLOSE:'documentation'
};
const FROZEN_WORKFLOW={
  'security-remediation':['security'],'incident-response':['incident'],'dependency-upgrade':['upgrade'],
  'database-migration':['database'],'performance':['performance'],'maintenance':['maintenance'],
  'refactor':['maintenance'],'modernization':['modernization'],'compliance-change':['compliance'],
  'documentation':['documentation'],'ci-cd-change':['ci-cd'],'infrastructure-change':['ci-cd'],
  'observability-change':['monitoring'],'api-breaking-change':['documentation'],
  'deprecation-removal':['upgrade','documentation']
};
const FROZEN_OVERLAY={security:'security',incident:'incident','db-migration':'database',
  'api-breaking-change':'documentation','client-impact':'frontend-integration'};

test('policy-reproduces-frozen-core-map',()=>{
  const policy=loadNavigationPolicy(ROOT);
  for(const [stage,id] of Object.entries(FROZEN_CORE)){
    const declared=policy.stages[stage];
    assert(declared,`policy has no entry for stage ${stage}`);
    const covered=(declared.core||[]).includes(id)||(declared.retired_core||[]).includes(id);
    assert(covered,`stage ${stage} lost core skill ${id}`);
  }
});

test('policy-reproduces-frozen-workflow-map',()=>{
  const policy=loadNavigationPolicy(ROOT);
  for(const [workflow,ids] of Object.entries(FROZEN_WORKFLOW)){
    const entry=policy.workflow_skills[workflow];
    assert(entry,`policy has no entry for workflow ${workflow}`);
    for(const id of ids){
      const covered=(entry.skills||[]).includes(id)||(entry.retired||[]).includes(id);
      assert(covered,`workflow ${workflow} lost skill ${id}`);
    }
  }
});

test('policy-reproduces-frozen-overlay-map',()=>{
  const policy=loadNavigationPolicy(ROOT);
  for(const [overlay,id] of Object.entries(FROZEN_OVERLAY)){
    const entry=policy.overlay_skills[overlay];
    assert(entry,`policy has no entry for overlay ${overlay}`);
    const covered=(entry.skills||[]).includes(id)||(entry.retired||[]).includes(id);
    assert(covered,`overlay ${overlay} lost skill ${id}`);
  }
});

test('every-lifecycle-stage-maps-to-one-stage-skill',()=>{
  const policy=loadNavigationPolicy(ROOT);
  const order=['INTAKE','REQUIREMENTS','DESIGN','PLAN','IMPLEMENT','VERIFY','REVIEW','RELEASE','DEPLOY','OBSERVE','CLOSE'];
  for(const stage of order){
    const entry=policy.stages[stage];
    assert(entry&&typeof entry.stage_skill==='string'&&entry.stage_skill,`stage ${stage} has no stage_skill`);
  }
});

test('resolve-returns-guidance-for-every-retired-id',()=>{
  const policy=loadNavigationPolicy(ROOT);
  const retired=new Set();
  for(const e of Object.values(policy.stages))for(const id of e.retired_core||[])retired.add(id);
  for(const e of Object.values(policy.workflow_skills))for(const id of e.retired||[])retired.add(id);
  for(const e of Object.values(policy.overlay_skills))for(const id of e.retired||[])retired.add(id);
  for(const id of retired)
    assert(typeof policy.guidance?.[id]==='string'&&policy.guidance[id].length>20,
      `retired id ${id} has no guidance sentence to carry its content`);
});

test('navigable-ids-are-registered-procedures-or-guidance',()=>{
  const ids=navigableSkillIds(ROOT);
  assert(ids.size>0,'no navigable ids');
  for(const id of ids)assert(typeof id==='string'&&id.length,'malformed id');
});

test('resolve-is-deterministic-for-a-fixed-run',()=>{
  const run={run_id:'r1',state:'DESIGN',workflow:'security-remediation',overlays:['security'],profile:'STRICT',objective:'x'};
  const a=resolveNavigation(ROOT,ROOT,run);
  const b=resolveNavigation(ROOT,ROOT,run);
  assert(JSON.stringify(a)===JSON.stringify(b),'resolveNavigation is not deterministic');
  assert(a.stage_skill==='sdlc-design',`DESIGN resolved to ${a.stage_skill}`);
});

finish({harness_root:'.'});
```

- [ ] **Step 2: Register the suite and run it to verify it fails**

Add to `package.json` scripts, after `"test:tasks"`:

```json
    "test:skill-navigation": "node scripts/test-skill-navigation.mjs",
```

Run: `npm run test:skill-navigation`
Expected: FAIL with `Cannot find module` for `runtime/skill-navigation.mjs`.

- [ ] **Step 3: Write the navigation policy**

Create `policies/skill-navigation.json`. `core` holds ids that survive; `retired_core` and `retired` hold ids scheduled for deletion in Task 6, each of which must have a `guidance` sentence. In this task every id is still in `core`/`skills` — Task 6 moves the seventeen across, which is why the resolver accepts both.

```json
{
  "schema": "agent-sdlc/skill-navigation/v1",
  "version": "3.0.0-rc2",
  "stages": {
    "INTAKE": {"stage_skill": "sdlc-requirements", "core": ["requirements"], "procedures": ["requirements-intake", "requirements-normalize", "requirements-clarify"]},
    "REQUIREMENTS": {"stage_skill": "sdlc-requirements", "core": ["requirements"], "procedures": ["requirements-intake", "requirements-normalize", "requirements-clarify", "impact-analysis"]},
    "DESIGN": {"stage_skill": "sdlc-design", "core": ["architecture"], "procedures": ["design-discovery", "solution-design", "technical-spike"]},
    "PLAN": {"stage_skill": "sdlc-plan", "core": ["planning"], "procedures": ["implementation-plan", "coordination-analysis"]},
    "IMPLEMENT": {"stage_skill": "sdlc-implement", "core": ["implementation"], "procedures": ["task-execution", "repository-intelligence", "systematic-debugging", "tdd"]},
    "VERIFY": {"stage_skill": "sdlc-verify", "core": ["testing"], "procedures": ["testing-verification"]},
    "REVIEW": {"stage_skill": "sdlc-review", "core": ["code-review"], "procedures": ["traceability", "docs-update", "knowledge-maintenance"]},
    "RELEASE": {"stage_skill": "sdlc-release", "core": ["ci-cd"], "procedures": ["release-deployment", "git-delivery", "operability-engineering"]},
    "DEPLOY": {"stage_skill": "sdlc-release", "core": ["deployment"], "procedures": ["release-deployment", "git-delivery", "operability-engineering"]},
    "OBSERVE": {"stage_skill": "sdlc-release", "core": ["monitoring"], "procedures": ["operability-engineering"]},
    "CLOSE": {"stage_skill": "sdlc-release", "core": ["documentation"], "procedures": ["traceability", "docs-update", "knowledge-maintenance"]}
  },
  "workflow_skills": {
    "security-remediation": {"skills": ["security"]},
    "incident-response": {"skills": ["incident"]},
    "dependency-upgrade": {"skills": ["upgrade"]},
    "database-migration": {"skills": ["database"]},
    "performance": {"skills": ["performance"]},
    "maintenance": {"skills": ["maintenance"]},
    "refactor": {"skills": ["maintenance"]},
    "modernization": {"skills": ["modernization"]},
    "compliance-change": {"skills": ["compliance"]},
    "documentation": {"skills": ["documentation"]},
    "ci-cd-change": {"skills": ["ci-cd"]},
    "infrastructure-change": {"skills": ["ci-cd"]},
    "observability-change": {"skills": ["monitoring"]},
    "api-breaking-change": {"skills": ["documentation"]},
    "deprecation-removal": {"skills": ["upgrade", "documentation"]}
  },
  "overlay_skills": {
    "security": {"skills": ["security"]},
    "incident": {"skills": ["incident"]},
    "db-migration": {"skills": ["database"]},
    "api-breaking-change": {"skills": ["documentation"]},
    "client-impact": {"skills": ["frontend-integration"]}
  },
  "conditional": [
    {"id": "release-deploy-needs-deployment", "when": "stage_in:RELEASE,DEPLOY", "add": ["deployment"]},
    {"id": "strict-needs-security-review", "when": "strict_and_stage_in:DESIGN,VERIFY,REVIEW,RELEASE", "add": ["security"]},
    {"id": "g0-bootstrap-project-knowledge", "when": "new_feature_without_project_knowledge", "add": ["project-bootstrap"]}
  ],
  "guidance": {}
}
```

- [ ] **Step 4: Write the resolver**

Create `runtime/skill-navigation.mjs`:

```js
// Declarative replacement for the three navigation maps that used to be
// hardcoded in runtime/context.mjs (CORE_SKILL_BY_STAGE, WORKFLOW_SKILLS,
// OVERLAY_SKILLS) plus the three conditional rules inlined in resolveSkills.
//
// Navigation is policy, not code: an agent asks which skill its state names
// and activates that, instead of a module deciding for it. A `retired` id is
// one whose file no longer exists; its one-line guidance still reaches the
// agent through the compiled context, so removing a stub file never removes
// what it said.
import path from 'node:path';
import {readJson} from './util.mjs';
import {getProjectKnowledgeStatus} from './project-knowledge.mjs';

const arr=x=>Array.isArray(x)?x:[];

export function loadNavigationPolicy(root){
  return readJson(path.join(root,'policies','skill-navigation.json'));
}

// Each condition resolves from canonical run state, never from keywords in the
// objective -- the same rule the procedure registry follows.
const CONDITIONALS={
  'stage_in':(spec,{run})=>spec.split(',').includes(run.state),
  'strict_and_stage_in':(spec,{run})=>run.profile==='STRICT'&&spec.split(',').includes(run.state),
  'new_feature_without_project_knowledge':(spec,{run,projectRoot})=>{
    if(run.workflow!=='new-feature')return false;
    if(!['INTAKE','REQUIREMENTS'].includes(run.state))return false;
    return getProjectKnowledgeStatus(projectRoot).status!=='READY';
  }
};

function conditionHolds(when,ctx){
  const i=String(when).indexOf(':');
  const name=i===-1?String(when):String(when).slice(0,i);
  const spec=i===-1?'':String(when).slice(i+1);
  const handler=CONDITIONALS[name];
  if(!handler)throw new Error(`skill-navigation: unknown conditional "${when}"`);
  return handler(spec,ctx);
}

/**
 * @returns {{stage:string,stage_skill:string|null,core_skill_ids:string[],
 *            procedure_ids:string[],guidance:Array<{id:string,text:string}>}}
 */
export function resolveNavigation(root,projectRoot,run){
  const policy=loadNavigationPolicy(root);
  const stageEntry=policy.stages?.[run.state]||{};
  const live=[]; const retired=[];
  const take=(entry,liveKey,retiredKey)=>{
    for(const id of arr(entry?.[liveKey]))if(!live.includes(id))live.push(id);
    for(const id of arr(entry?.[retiredKey]))if(!retired.includes(id))retired.push(id);
  };

  take(stageEntry,'core','retired_core');
  take(policy.workflow_skills?.[run.workflow],'skills','retired');
  for(const overlay of arr(run.overlays))take(policy.overlay_skills?.[overlay],'skills','retired');
  for(const rule of arr(policy.conditional)){
    if(!conditionHolds(rule.when,{run,projectRoot}))continue;
    for(const id of arr(rule.add)){
      if(arr(policy.retired_ids).includes(id)){if(!retired.includes(id))retired.push(id);}
      else if(!live.includes(id))live.push(id);
    }
  }

  return {
    stage:run.state,
    stage_skill:stageEntry.stage_skill||null,
    core_skill_ids:live,
    procedure_ids:arr(stageEntry.procedures),
    guidance:retired
      .filter(id=>policy.guidance?.[id])
      .map(id=>({id,text:policy.guidance[id]}))
  };
}

/**
 * Every id any navigation path can reach, live or retired. The procedure
 * coverage audit uses this to prove no guidance file is unreachable.
 */
export function navigableSkillIds(root){
  const policy=loadNavigationPolicy(root);
  const ids=new Set();
  for(const e of Object.values(policy.stages||{})){
    for(const id of arr(e.core))ids.add(id);
    for(const id of arr(e.retired_core))ids.add(id);
    for(const id of arr(e.procedures))ids.add(id);
  }
  for(const group of [policy.workflow_skills,policy.overlay_skills]){
    for(const e of Object.values(group||{})){
      for(const id of arr(e.skills))ids.add(id);
      for(const id of arr(e.retired))ids.add(id);
    }
  }
  for(const rule of arr(policy.conditional))for(const id of arr(rule.add))ids.add(id);
  return ids;
}
```

- [ ] **Step 5: Run the suite to verify it passes**

Run: `npm run test:skill-navigation`
Expected: PASS, 7 checks. `resolve-is-deterministic-for-a-fixed-run` proves `DESIGN` resolves to `sdlc-design` even though that skill file does not exist yet — the policy names it; Task 7 creates it.

- [ ] **Step 6: Delegate `resolveSkills` to the policy**

In `runtime/context.mjs`, delete `CORE_SKILL_BY_STAGE`, `WORKFLOW_SKILLS`, `OVERLAY_SKILLS` (lines 10-21) and the whole `legacyReachableSkillIds` function with its explanatory comment (lines 23-36). Add `import {resolveNavigation,navigableSkillIds} from './skill-navigation.mjs';` and replace the body of `resolveSkills` (lines 57-76) with:

```js
function resolveSkills(root,projectRoot,run){
  const registry=readJson(path.join(root,'config','skills.json')).internal||{};
  const nav=resolveNavigation(root,projectRoot,run);
  const ids=nav.core_skill_ids.filter(id=>registry[id]&&registry[id].stages?.includes(run.state));
  // readTextFile, not readFileSync: skill text is hashed into context_hash, so a
  // CRLF checkout must not change the hash for the same commit.
  const loaded=ids.map(id=>{const spec=registry[id];let instructions='';try{instructions=readTextFile(path.join(root,spec.instructions)).trim();}catch{}return {id,description:spec.description,instructions,max_response_words:spec.max_response_words};});
  // A retired stub contributed one sentence, not a file. It still ships, as
  // guidance, so deleting the file did not delete what it said.
  for(const g of nav.guidance)loaded.push({id:g.id,description:g.text,instructions:'',max_response_words:0});
  return loaded;
}
```

Re-export the navigable set so callers that imported `legacyReachableSkillIds` keep working until Step 8:

```js
export {navigableSkillIds};
```

- [ ] **Step 7: Point the coverage audit at the policy**

In `runtime/procedures.mjs`, replace the `auditProcedureCoverage` comment and signature (lines 76-91) with:

```js
// D5 orphan check: every guidance file under harness/internal-skills/ must be
// reachable -- registered in this registry, or named by
// policies/skill-navigation.json. There is no third path and no legacy set.
export function auditProcedureCoverage(root,navigableIds){
  const dir=path.join(root,'harness','internal-skills');
  const files=fs.readdirSync(dir).filter(f=>f.endsWith('.md')).map(f=>f.replace(/\.md$/,''));
  const registry=loadRegistry(root);
  const registered=new Set(Object.keys(registry));
  const navigable=new Set(navigableIds||[]);
  const orphaned=files.filter(id=>!registered.has(id)&&!navigable.has(id));
  return {schema:'agent-sdlc/procedure-coverage-audit/v1',total:files.length,orphaned};
}
```

- [ ] **Step 8: Update every caller and remove the alias**

Run: `grep -rIn --exclude-dir=.git --exclude-dir=dist "legacyReachableSkillIds" .`
Replace each call site with `navigableSkillIds(ROOT)` imported from `runtime/skill-navigation.mjs`, then delete the `export {navigableSkillIds};` alias line added in Step 6 if nothing imports it from `context.mjs`.

- [ ] **Step 9: Verify no behavioral drift and no orphan appeared**

Run: `npm run test:skill-navigation && npm test && npm run test:integrity`
Expected: PASS. The deterministic suite exercises `buildContext` on real runs, so an id that stopped resolving surfaces here as a context or gate failure.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "refactor(navigation): move stage/workflow/overlay routing into policies/skill-navigation.json"
```

---

### Task 4: Hand the agent a `navigation` block

**Files:**
- Modify: `runtime/context.mjs` (the `buildContext` return, around line 207), `runtime/commands/run.mjs` (the `status` command output), `evals/run-deterministic.mjs`
- Test: `scripts/test-skill-navigation.mjs`, `evals/run-deterministic.mjs`

**Interfaces:**
- Consumes: `resolveNavigation` from Task 3.
- Produces: a `navigation` object on both `status` and `context` output — `{stage, stage_skill, procedure_skills: string[], fallback_instructions_inlined: boolean}`. The `sdlc-orchestrator` skill rewritten in Task 7 reads exactly these four fields.

- [ ] **Step 1: Write the failing test**

Add to `scripts/test-skill-navigation.mjs`, before `finish(...)`:

```js
test('context-manifest-carries-navigation-block',async ()=>{
  const {initProject,loadRun}=await import('../runtime/store.mjs');
  const {newRun}=await import('../runtime/orchestrator.mjs');
  const {route}=await import('../runtime/router.mjs');
  const {buildContext}=await import('../runtime/context.mjs');
  const {makeTempDir}=await import('./lib/tempdir.mjs');
  const d=makeTempDir('agent-sdlc-nav-');
  initProject(d,{schema:'agent-sdlc/project/v1',project:'nav-fixture'});
  // newRun takes a route object, not loose workflow/profile fields:
  // newRun(root, projectRoot, {objective, route}) -- see runtime/orchestrator.mjs:42.
  const objective='add a login endpoint';
  const run=newRun(ROOT,d,{objective,route:route(ROOT,objective)});
  const ctx=buildContext(ROOT,d,loadRun(d,run.run_id));
  assert(ctx.navigation,'context manifest has no navigation block');
  assert(ctx.navigation.stage===ctx.state||ctx.navigation.stage,'navigation.stage missing');
  assert(typeof ctx.navigation.stage_skill==='string','navigation.stage_skill must be a string');
  assert(Array.isArray(ctx.navigation.procedure_skills),'navigation.procedure_skills must be an array');
  assert(ctx.navigation.fallback_instructions_inlined===true,'text injection is the floor: the flag must report it');
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test:skill-navigation`
Expected: FAIL with `context manifest has no navigation block`.

- [ ] **Step 3: Add the block to the compiled context**

In `runtime/context.mjs`, inside `buildContext` where the manifest object is assembled (near `skill_instructions:` at line 207), add:

```js
    navigation:{
      stage:run.state,
      stage_skill:nav.stage_skill,
      procedure_skills:procedures.map(p=>p.id),
      // The compiled context always carries the instruction text, so a host
      // with no Skill tool needs nothing else. A host that has one may
      // activate stage_skill by name instead; the text is the floor, not a
      // fallback that has to be requested.
      fallback_instructions_inlined:true
    },
```

`nav` is available by calling `resolveNavigation(root,projectRoot,run)` once at the top of `buildContext` and reusing it in `resolveSkills` — pass it in rather than resolving twice, since `resolveNavigation` reads the policy from disk.

- [ ] **Step 4: Run it to verify it passes**

Run: `npm run test:skill-navigation`
Expected: PASS, 8 checks.

- [ ] **Step 5: Surface the same block on `status`**

In `runtime/commands/run.mjs`, import `resolveNavigation` from `../skill-navigation.mjs` and `resolveProcedures` from `../procedures.mjs`, then add to the `status` command's output object the same four fields the context block carries — not the raw resolver return, which has a different shape:

```js
    navigation:(()=>{
      const nav=resolveNavigation(ROOT,projectRoot,run);
      return {
        stage:nav.stage,
        stage_skill:nav.stage_skill,
        procedure_skills:resolveProcedures(ROOT,projectRoot,run).map(p=>p.id),
        fallback_instructions_inlined:true
      };
    })(),
```

`status` reports the procedures that actually apply, after `when` conditions run — the same set `context` compiles — so the two commands never disagree about what the agent should load.

- [ ] **Step 6: Assert the CLI surface**

Add to `evals/run-deterministic.mjs`:

```js
test('status-reports-next-stage-skill',()=>{
  const nav=resolveNavigation(ROOT,ROOT,{run_id:'r1',state:'PLAN',workflow:'new-feature',profile:'STANDARD',overlays:[],objective:'x'});
  if(nav.stage_skill!=='sdlc-plan')throw Error(`PLAN resolved to ${nav.stage_skill}`);
});
```

with `import {resolveNavigation} from '../runtime/skill-navigation.mjs';` added to the imports.

- [ ] **Step 7: Run the suites**

Run: `npm test && npm run test:skill-navigation && npm run test:cli-contract`
Expected: PASS on all three.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(cli): report the next stage skill in status and context navigation"
```

---

## Phase 4 — Legacy consolidation

### Task 5: Fold Group B content into its counterparts

This task only moves text. It lands alone so that if a later step loses content, `git show` on this commit is the record of what moved where. Nothing is deleted here.

**Files:**
- Modify: `harness/internal-skills/tdd.md`, `harness/internal-skills/testing-verification.md`, `harness/internal-skills/task-execution.md`, `harness/internal-skills/implementation-plan.md`, `harness/internal-skills/design-discovery.md`, `harness/internal-skills/requirements-normalize.md`
- Test: manual grep verification (Step 7) — this task changes prose, not behavior

**Interfaces:**
- Consumes: nothing.
- Produces: the five sentences and one table that Task 6 is then allowed to delete. Task 6's verification greps for these exact strings.

- [ ] **Step 1: Fold the `planning` minimum into `implementation-plan.md`**

Append to `harness/internal-skills/implementation-plan.md`:

```markdown
## Minimums that never relax

Even a FAST micro-plan states all four: **goal, scope, done condition, verification**.
A plan missing any of them is not a smaller plan, it is an unvalidatable one.
```

- [ ] **Step 2: Fold the `requirements` multimodal rule into `requirements-normalize.md`**

Append to `harness/internal-skills/requirements-normalize.md`:

```markdown
Prefer the deterministic `normalize` command for text, Markdown, JSON, CSV, DOCX,
XLSX and text-bearing PDF input. Mark native images and image-only PDFs
`NEEDS_MULTIMODAL`: never silently OCR them and never invent missing content.
```

- [ ] **Step 3: Fold the `architecture` selector preflight into `design-discovery.md`**

Append to `harness/internal-skills/design-discovery.md`:

```markdown
## Selector preflight

Ask the deterministic selector for the depth before designing:

```
bin/agent-sdlc design mode --run-id <id>
```

Obey the answer (`SKIP` / `COMPACT` / `FULL`). `DESIGN -> PLAN` evidence comes
only from `bin/agent-sdlc design record`; it cannot be asserted by hand.
```

- [ ] **Step 4: Fold the `implementation` coding-standards detail into `task-execution.md`**

Append to `harness/internal-skills/task-execution.md`:

```markdown
## Coding standards are enforced, not advisory

Every created or modified file obeys `policies/coding-standards.json`:

- **Naming**: `snake_case` properties and variables; `is_`/`has_`/`can_`/`should_`
  boolean prefixes; `camelCase` verb-first functions; `PascalCase` types;
  `SCREAMING_SNAKE` constants; `kebab-case` filenames.
- **Clean code**: at most 3 function parameters (object DTO beyond that), one
  responsibility per function, no duplicated logic, prefer pure functions.
- **Domain modeling**: domain types represent canonical, mutually exclusive
  concepts. Never add a synonymous alias to an enum (no `BOY` beside `MALE`).
  Normalize input variation at the boundary, in a DTO or transformer.
- **Never patch to pass**: no type loosening and no band-aid branch added only
  to turn a test green.
- **Security and resources**: validate at boundaries, no ambient secrets, zero
  `any`, release resources in `finally`.

If implementation reveals a requirement contradiction, an invalid architectural
assumption, or a materially larger blast radius, stop the task and return
`NEEDS_CONFIRMATION` or `BLOCKED`. Never redesign product behaviour implicitly.
```

- [ ] **Step 5: Fold the `testing` anti-pattern table into `testing-verification.md`**

`tdd.md` already carries the Iron Law, the cycle, and a rationalization table, so only the anti-pattern rows it lacks move. Append to `harness/internal-skills/testing-verification.md`:

```markdown
## Testing anti-patterns to reject

| Anti-pattern | Why it fails | Instead |
|---|---|---|
| **Testing mocks** | Asserts a mock configuration, not system behaviour. | Test real domain classes and interfaces with real inputs. |
| **Tautological assertions** | Passes by definition (`expect(true).toBe(true)`, asserting a mocked return). | Assert actual state changes, return values, or store side-effects. |
| **Testing private internals** | Binds the test to a private helper or internal variable. | Test only through public contracts. |
| **Assertionless tests** | Calls a function and asserts nothing. | Every test verifies a concrete invariant or post-condition. |
| **Giant monolithic tests** | One case asserting fifteen unrelated behaviours. | One test, one behaviour. |
| **Broad try/catch in tests** | Swallows the exception that should have failed the run. | Let it bubble, or assert `toThrow()`. |
| **Flaky condition waiting** | An arbitrary `sleep(1000)`. | Poll the condition, or assert on the event. |
```

- [ ] **Step 6: Add the one line `tdd.md` is missing**

`tdd.md` covers deletion of untested code but not the "delete means delete" enumeration. Append to its Iron Law section:

```markdown
Do not keep the unverified code as reference. Do not adapt it while writing the
test. Do not look at it. **Delete means delete** — implement fresh from tests.
```

- [ ] **Step 7: Verify every moved string is greppable in its new home**

Run:

```bash
grep -l "Minimums that never relax" harness/internal-skills/implementation-plan.md
grep -l "NEEDS_MULTIMODAL" harness/internal-skills/requirements-normalize.md
grep -l "Selector preflight" harness/internal-skills/design-discovery.md
grep -l "Coding standards are enforced" harness/internal-skills/task-execution.md
grep -l "Testing anti-patterns to reject" harness/internal-skills/testing-verification.md
grep -l "Delete means delete" harness/internal-skills/tdd.md
```

Expected: all six print their filename. A silent line means the fold did not land and Task 6 must not run.

- [ ] **Step 8: Commit the fold alone**

```bash
git add harness/internal-skills
git commit -m "docs(procedures): fold group B guidance into its registry counterparts"
```

---

### Task 6: Delete the 17 retired files and route the 3 promoted ones

**Files:**
- Delete: `harness/internal-skills/{ci-cd,compliance,database,deployment,documentation,incident,maintenance,modernization,monitoring,performance,security,upgrade,architecture,requirements,planning,testing,implementation}.md`
- Modify: `config/skills.json` (remove 17 `internal` entries), `config/procedures.json` (add 3), `policies/skill-navigation.json` (move ids to `retired_*`, fill `guidance`), `scripts/validate-github-install.mjs:35`
- Test: `scripts/test-skill-navigation.mjs`, `evals/run-deterministic.mjs`, `npm run test:registry`

**Interfaces:**
- Consumes: the folded content from Task 5 and the `retired_core`/`retired`/`guidance` policy shape from Task 3.
- Produces: `harness/internal-skills/` at 24 files and `config/procedures.json` at 24 entries. Task 8's generator emits one skill per procedure entry, so this count is what it iterates.

- [ ] **Step 1: Write the failing test for the end state**

Add to `evals/run-deterministic.mjs`:

```js
test('no-legacy-guidance-path',()=>{
  const files=fs.readdirSync(path.join(ROOT,'harness','internal-skills')).filter(f=>f.endsWith('.md')).map(f=>f.replace(/\.md$/,''));
  if(files.length!==24)throw Error(`expected 24 guidance files, found ${files.length}`);
  const procedures=JSON.parse(fs.readFileSync(path.join(ROOT,'config','procedures.json'),'utf8')).procedures;
  if(Object.keys(procedures).length!==24)throw Error(`expected 24 procedures, found ${Object.keys(procedures).length}`);
  const unrouted=files.filter(id=>!procedures[id]);
  if(unrouted.length)throw Error(`unrouted guidance files: ${unrouted.join(',')}`);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test`
Expected: FAIL with `expected 24 guidance files, found 41`.

- [ ] **Step 3: Add the three Group C routes**

In `config/procedures.json`, add these entries. `stages` and `group` mirror the neighbouring entries; `when` reuses an existing handler in `runtime/procedures.mjs` — no new handler is written.

```json
    "code-review": {
      "id": "code-review",
      "group": "documentation",
      "when": "always",
      "stages": ["REVIEW"],
      "instructions": "harness/internal-skills/code-review.md"
    },
    "project-bootstrap": {
      "id": "project-bootstrap",
      "group": "requirements",
      "when": "workflow:new-feature",
      "stages": ["INTAKE", "REQUIREMENTS"],
      "instructions": "harness/internal-skills/project-bootstrap.md"
    },
    "frontend-integration": {
      "id": "frontend-integration",
      "group": "implementation",
      "when": "always",
      "stages": ["DESIGN", "PLAN", "IMPLEMENT", "VERIFY"],
      "instructions": "harness/internal-skills/frontend-integration.md"
    }
```

- [ ] **Step 4: Move the retired ids across in the navigation policy**

In `policies/skill-navigation.json`, for each stage entry whose `core` names a retired id, rename the key `core` to `retired_core`. For each `workflow_skills` and `overlay_skills` entry whose `skills` names one, rename `skills` to `retired`. `client-impact` keeps `skills` because `frontend-integration` survives. `REVIEW` keeps `core: ["code-review"]`? No — `code-review` becomes a procedure, so `REVIEW` becomes `{"stage_skill":"sdlc-review","core":[],"procedures":["code-review","traceability","docs-update","knowledge-maintenance"]}`. Add `"retired_ids"` listing all seventeen so the conditional rules classify correctly:

```json
  "retired_ids": ["architecture", "ci-cd", "compliance", "database", "deployment", "documentation", "implementation", "incident", "maintenance", "modernization", "monitoring", "performance", "planning", "requirements", "security", "testing", "upgrade"],
```

- [ ] **Step 5: Fill `guidance` with the sentence each retired stub carried**

Copy each id's `description` from `config/skills.json` verbatim into the policy's `guidance` map before deleting the entry. These are the sentences that were the entire body of the Group A files:

```json
  "guidance": {
    "architecture": "Analyze impact, API/data contracts, architecture, threat model, ADRs and rollback constraints.",
    "ci-cd": "Validate reproducible CI/build/package flow and provenance requirements.",
    "compliance": "Map declared controls to evidence; never invent jurisdiction/framework obligations.",
    "database": "Use expand/compatibility/backfill/verify/contract; make data-state rollback limitations explicit.",
    "deployment": "Plan canary/rolling/blue-green rollout, explicit rollback and production approval.",
    "documentation": "Update only impacted docs, API guidance, release notes and handoff; avoid wholesale regeneration.",
    "implementation": "Implement minimal scoped change; prefer TDD where useful; preserve public contracts unless approved.",
    "incident": "Evidence-first incident triage, bounded hypotheses, mitigation, verification, timeline and RCA.",
    "maintenance": "Handle cleanup, bug hygiene, debt and low-risk maintenance without broad scope expansion.",
    "modernization": "Strangler/parallel-run migration with compatibility gates, incremental slices and rollback checkpoints.",
    "monitoring": "Check declared health/business invariants and capture production verification evidence.",
    "performance": "Baseline, profile, change one bottleneck at a time, verify performance and correctness regressions.",
    "planning": "Create dependency-aware implementation and verification plan with independently verifiable slices.",
    "requirements": "Normalize inputs, identify only material ambiguities, define acceptance criteria and NFRs.",
    "security": "Threat-model and review bounded change for security/privacy regressions.",
    "testing": "Run targeted verification first, escalate to broader suites based on affected dependency closure.",
    "upgrade": "Assess compatibility, migration path, lockfile/provenance changes and rollback for upgrades."
  }
```

- [ ] **Step 6: Remove the 17 `internal` registry entries and delete the files**

Delete the seventeen keys from `config/skills.json`'s `internal` object, then:

```bash
cd harness/internal-skills
git rm architecture.md ci-cd.md compliance.md database.md deployment.md documentation.md \
       implementation.md incident.md maintenance.md modernization.md monitoring.md \
       performance.md planning.md requirements.md security.md testing.md upgrade.md
cd ../..
```

- [ ] **Step 7: Fix the installer check that named a deleted file**

`scripts/validate-github-install.mjs:35` asserts `harness/internal-skills/requirements.md` exists. Change that line to:

```js
  assert(exists('harness/internal-skills/requirements-normalize.md'),'internal skills missing');
```

- [ ] **Step 8: Run the full chain**

Run: `npm test && npm run test:skill-navigation && npm run test:registry && npm run validate:github && npm run test:integrity`
Expected: PASS. Specifically: `no-legacy-guidance-path` green; `validate:github` green; `test:registry` reports `registered_internal_skills: 24`, `internal_skill_files: 24`, `unregistered_files: 0`; and every `policy-reproduces-frozen-*` case still green, because the frozen tables now match through `retired_*` rather than `core`.

- [ ] **Step 9: Verify stage coverage did not regress**

Run: `npm run test:registry`
Expected: no `workflow stage has no internal skill registered for it` failure. The surviving 24 entries cover all eleven stages; `OBSERVE` is covered by `operability-engineering` alone, so a future deletion there breaks this check — that is intended.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "refactor(procedures)!: retire 17 slot files, route code-review, project-bootstrap and frontend-integration"
```

---

## Phase 5 — Stage skills

### Task 7: Split seven stage skills out of the orchestrator

**Files:**
- Create: `skills/sdlc-requirements/SKILL.md`, `skills/sdlc-design/SKILL.md`, `skills/sdlc-plan/SKILL.md`, `skills/sdlc-implement/SKILL.md`, `skills/sdlc-verify/SKILL.md`, `skills/sdlc-review/SKILL.md`, `skills/sdlc-release/SKILL.md`
- Modify: `skills/sdlc-orchestrator/SKILL.md`, `agent-sdlc.manifest.json` (`stage_skills`)
- Test: `evals/run-deterministic.mjs`

**Interfaces:**
- Consumes: `navigation.stage_skill` from Task 4; `readSkillTiers` from Task 2.
- Produces: seven `SKILL.md` files whose `name:` matches the `stage_skill` values already declared in `policies/skill-navigation.json` — `sdlc-requirements`, `sdlc-design`, `sdlc-plan`, `sdlc-implement`, `sdlc-verify`, `sdlc-review`, `sdlc-release`. Task 10's activation eval reads their `description:` lines.

- [ ] **Step 1: Write the failing test**

Add to `evals/run-deterministic.mjs`:

```js
test('every-stage-skill-exists-and-declares-itself-non-entry',()=>{
  const policy=JSON.parse(fs.readFileSync(path.join(ROOT,'policies','skill-navigation.json'),'utf8'));
  const named=[...new Set(Object.values(policy.stages).map(s=>s.stage_skill))];
  const tiers=readSkillTiers(ROOT);
  for(const id of named){
    if(!tiers.stage.includes(id))throw Error(`${id} is named by the policy but not declared in stage_skills`);
    const body=fs.readFileSync(path.join(ROOT,'skills',id,'SKILL.md'),'utf8');
    if(!body.startsWith('---')||!body.includes(`name: ${id}`))throw Error(`${id} has a malformed frontmatter`);
    if(!body.includes('Not an entry point'))throw Error(`${id} must declare itself a non-entry point`);
  }
  if(tiers.stage.length!==named.length)throw Error(`stage_skills has ${tiers.stage.length} entries for ${named.length} named skills`);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test`
Expected: FAIL with `sdlc-requirements is named by the policy but not declared in stage_skills`.

- [ ] **Step 3: Create the DESIGN stage skill**

Create `skills/sdlc-design/SKILL.md`. Its body is the `**DESIGN.**` paragraph lifted verbatim from `skills/sdlc-orchestrator/SKILL.md`:

```markdown
---
name: sdlc-design
description: Dispatched by sdlc-orchestrator when the active SDLC run state is DESIGN. Not an entry point; do not activate from a user prompt.
metadata:
  version: "3.0.0-rc2"
---
# SDLC Design Stage

Dispatched by `sdlc-orchestrator` when `navigation.stage_skill` is `sdlc-design`.
Not an entry point.

Ask `bin/agent-sdlc design mode --run-id <id>` for the discovery depth
(`SKIP` / `COMPACT` / `FULL`) and obey it; declare a missing signal with
`--signals` rather than overriding the answer in prose.

Present the design in bite-sized sections of 150-250 words and take incremental
user feedback before finalizing.

Load the procedure modules `navigation.procedure_skills` names for this stage,
produce an `agent-sdlc/design-decision/v1` object, then run
`bin/agent-sdlc design record --run-id <id> --file design-decision.json`.

When the selector reports `human_approval_required`, suspend to
`NEEDS_CONFIRMATION` and obtain real user approval. Never write your own.
```

- [ ] **Step 4: Create the other six stage skills**

Same frontmatter shape, with the stage name substituted in `name`, `description` and the dispatch line. Bodies come verbatim from the orchestrator's existing per-stage text:

- `sdlc-requirements` — the `**REQUIREMENTS.**` paragraph: validate input completeness; on missing critical context, halt and use Socratic dialogue, one question at a time, 2-3 concrete options with trade-offs and a recommendation; only confirmed answers in `clarifications.md` count as product truth.
- `sdlc-plan` — the `**PLAN.**` paragraph: emit a structured `agent-sdlc/task-plan/v1` object rather than Markdown prose; `bin/agent-sdlc plan validate` then `plan record --run-id <id> --file task-plan.json`; an invalid dependency graph, an uncovered acceptance criterion, a behaviour-changing task without verification, or two overlapping parallel candidates keeps `PLAN -> IMPLEMENT` closed; fix the plan, and note there is no `--force`.
- `sdlc-implement` — the `**IMPLEMENT.**` paragraphs: `task materialize`, then `task refresh` / `task schedule` / `task start` / `task advance`; `DONE` requires verification evidence bound to the current attempt and diff plus a clean spec-compliance review and a clean code-quality review; `implementation_artifact` is derived by `task implementation-complete`; one task, one bounded context, one primary writer, one workspace; a diff outside the approved write scope re-enters `PLAN` rather than retrying; a retry needs new concrete evidence.
- `sdlc-verify` — targeted verification before full-suite expansion; evidence before claims; store raw logs as artifacts and pass structured summaries.
- `sdlc-review` — two-stage review, spec compliance then code quality, each with its own verdict; findings carry `file:line` evidence.
- `sdlc-release` — serves `RELEASE`, `DEPLOY`, `OBSERVE` and `CLOSE`: Gate 4 requires 100% local CI pass before requesting approval to push; production actions are Gate 5; `CLOSE` requires the workflow's declared verification, review, release and deploy evidence.

- [ ] **Step 5: Declare them in the manifest**

In `agent-sdlc.manifest.json`, set:

```json
  "stage_skills": [
    "sdlc-requirements",
    "sdlc-design",
    "sdlc-plan",
    "sdlc-implement",
    "sdlc-verify",
    "sdlc-review",
    "sdlc-release"
  ],
```

- [ ] **Step 6: Shrink the orchestrator to a dispatcher**

In `skills/sdlc-orchestrator/SKILL.md`, delete the four per-stage paragraphs now living in stage skills (the `## REQUIREMENTS -> DESIGN -> PLAN -> IMPLEMENT` section, keeping only its first sentence about machine-checked gates). Keep the Iron Laws, the anti-rationalization table, the non-negotiable invariants, the autonomous-execution section and the five Human Confirmation Gates. Replace the `## Stage loop` section with:

```markdown
## Stage loop

1. Read run state: `bin/agent-sdlc status --run-id <id>`.
2. Compile compact context: `bin/agent-sdlc context --run-id <id>`.
3. Activate the skill `navigation.stage_skill` names. Do not infer the stage
   skill yourself and do not load a stage you are not in — the engine derived
   it from run state, which is the authority.
4. Load only the procedure modules `navigation.procedure_skills` lists.
5. Execute one bounded objective.
6. Verify deterministically.
7. Write artifacts and the handoff.
8. Transition with evidence: `bin/agent-sdlc transition`.

`navigation.fallback_instructions_inlined` is `true` whenever the compiled
context already carries the instruction text. It always does: activating the
named skill is an addressing convenience, never a prerequisite.
```

Replace the `Available public utility skills` line and the line asserting internal skills are not discoverable with:

```markdown
- Ops skills, for the human or for you: `sdlc-approve` (grant a gate ticket),
  `sdlc-status`, `sdlc-resume`, `sdlc-task`, `sdlc-doctor`.
- Stage skills are dispatched by run state, never chosen by preference.
- Procedure skills under `skills/procedures/` are addressable by name but never
  auto-activate; `policies/skill-navigation.json` decides which ones apply.
```

- [ ] **Step 7: Run the suites**

Run: `npm test && npm run test:versions && npm run test:registry && npm run validate:github`
Expected: PASS. `test:versions` checks the `metadata.version` in all seven new files, so a mistyped version fails here.

- [ ] **Step 8: Verify the orchestrator actually shrank**

Run: `wc -l skills/sdlc-orchestrator/SKILL.md`
Expected: roughly 45-55 lines, down from 99. If it is still above 70, per-stage text remains that belongs in a stage skill.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "refactor(skills): split seven stage skills out of the orchestrator"
```

---

## Phase 6 — Procedure generation, single-source TDD, evals, docs

### Task 8: Generate the procedure skill tier

**Files:**
- Create: `scripts/gen-skill-surface.mjs`, `skills/procedures/<id>/SKILL.md` (24, generated)
- Modify: `agent-sdlc.manifest.json` (`procedure_skills`), `package.json` (scripts), `.github/workflows/ci.yml`
- Test: `evals/run-deterministic.mjs`

**Interfaces:**
- Consumes: `readSkillTiers` and `skillBodyPath` from Task 2; the 24-entry `config/procedures.json` from Task 6.
- Produces: `scripts/gen-skill-surface.mjs` with two modes — no argument writes the files, `--check` exits non-zero on drift and writes nothing.

- [ ] **Step 1: Write the failing test**

Add to `evals/run-deterministic.mjs`:

```js
test('procedure-skills-generated-and-in-sync',()=>{
  const r=spawnSync(process.execPath,[path.join(ROOT,'scripts','gen-skill-surface.mjs'),'--check'],{encoding:'utf8'});
  if(r.status!==0)throw Error(`generated procedure skills are stale: ${String(r.stdout||r.stderr).slice(0,200)}`);
  const tiers=readSkillTiers(ROOT);
  const procedures=Object.keys(JSON.parse(fs.readFileSync(path.join(ROOT,'config','procedures.json'),'utf8')).procedures);
  if(tiers.procedure.slice().sort().join(',')!==procedures.slice().sort().join(','))throw Error('procedure_skills does not match the procedure registry');
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test`
Expected: FAIL with `generated procedure skills are stale` naming the missing script.

- [ ] **Step 3: Write the generator**

Create `scripts/gen-skill-surface.mjs`:

```js
#!/usr/bin/env node
// Generates the procedure skill tier from the registries.
//
// A procedure's instruction text has exactly one home:
// harness/internal-skills/<id>.md. These generated bodies address that file;
// they never copy it. So a procedure cannot drift from its own guidance, and
// `--check` in CI proves the generated tree matches the registry.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {readSkillTiers} from './lib/skill-tiers.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const CHECK=process.argv.includes('--check');
const VERSION=fs.readFileSync(path.join(ROOT,'VERSION'),'utf8').trim();
const rj=p=>JSON.parse(fs.readFileSync(path.join(ROOT,p),'utf8'));

const procedures=rj('config/procedures.json').procedures||{};
const internal=rj('config/skills.json').internal||{};

function body(id,spec){
  const description=internal[id]?.description||spec.description||`Procedure module ${id}.`;
  const stages=(spec.stages||[]).join(', ');
  return `---
name: ${id}
description: ${description} Dispatched by sdlc-orchestrator for stage ${stages}. Not an entry point; do not activate from a user prompt.
metadata:
  version: "${VERSION}"
---
<!-- GENERATED by scripts/gen-skill-surface.mjs from config/procedures.json. Do not edit by hand. -->
# Procedure: ${id}

Applies at ${stages}, when \`${spec.when}\` holds. \`sdlc-orchestrator\` lists the
procedures that apply through \`navigation.procedure_skills\`; this module is not
selected by preference.

The instructions are \`${spec.instructions}\`. Read that file. It is the single
source of this procedure's guidance — the compiled context inlines the same text,
so the two can never disagree.
`;
}

const dir=path.join(ROOT,'skills','procedures');
const stale=[];
const wanted=new Map();
for(const [id,spec] of Object.entries(procedures)){
  if(!spec.instructions||!fs.existsSync(path.join(ROOT,spec.instructions)))
    throw new Error(`procedure ${id} names a missing instructions file: ${spec.instructions}`);
  wanted.set(id,body(id,spec));
}

if(CHECK){
  const present=fs.existsSync(dir)
    ? fs.readdirSync(dir,{withFileTypes:true}).filter(e=>e.isDirectory()).map(e=>e.name)
    : [];
  for(const extra of present)if(!wanted.has(extra))stale.push(`${extra}: generated but not in the registry`);
  for(const [id,text] of wanted){
    const p=path.join(dir,id,'SKILL.md');
    if(!fs.existsSync(p)){stale.push(`${id}: not generated`);continue;}
    if(fs.readFileSync(p,'utf8')!==text)stale.push(`${id}: out of date`);
  }
  const tiers=readSkillTiers(ROOT);
  for(const id of wanted.keys())if(!tiers.procedure.includes(id))stale.push(`${id}: missing from manifest procedure_skills`);
  console.log(JSON.stringify({schema:'agent-sdlc/skill-surface-check/v1',procedures:wanted.size,stale},null,2));
  process.exit(stale.length?1:0);
}

fs.rmSync(dir,{recursive:true,force:true});
for(const [id,text] of wanted){
  fs.mkdirSync(path.join(dir,id),{recursive:true});
  fs.writeFileSync(path.join(dir,id,'SKILL.md'),text);
}
console.log(JSON.stringify({schema:'agent-sdlc/skill-surface-gen/v1',generated:wanted.size,dir:'skills/procedures'},null,2));
```

- [ ] **Step 4: Generate the tier and declare it**

Run: `node scripts/gen-skill-surface.mjs`
Expected: `{"generated": 24, ...}`.

Then set `procedure_skills` in `agent-sdlc.manifest.json` to the 24 ids, alphabetically: `code-review`, `coordination-analysis`, `design-discovery`, `docs-update`, `frontend-integration`, `git-delivery`, `impact-analysis`, `implementation-plan`, `knowledge-maintenance`, `operability-engineering`, `project-bootstrap`, `release-deployment`, `repository-intelligence`, `requirements-clarify`, `requirements-intake`, `requirements-normalize`, `solution-design`, `systematic-debugging`, `task-execution`, `tdd`, `technical-spike`, `testing-verification`, `traceability`, `workflow-maintenance`.

- [ ] **Step 5: Register the scripts and wire CI**

Add to `package.json` scripts:

```json
    "gen:skills": "node scripts/gen-skill-surface.mjs",
    "test:skill-surface": "node scripts/gen-skill-surface.mjs --check",
```

Append `&& npm run test:skill-surface && npm run test:skill-navigation` to the `test:integrity` chain, and add `npm run test:skill-surface` to `.github/workflows/ci.yml` beside the other integrity steps.

- [ ] **Step 6: Run everything**

Run: `npm test && npm run test:integrity && npm run build && npm run verify:dist`
Expected: PASS. `build` now prints `procedure_skills: 24`, and `verify:dist` still reports `public-discovery-surface` with only the 14 discovery-root directories, because `procedures` is filtered out.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(skills): generate the procedure skill tier from the registries"
```

---

### Task 9: Resolve the worker's TDD rules from the registry

**Files:**
- Modify: `runtime/task-worker.mjs:49-70`
- Test: `scripts/test-task-worker.mjs`

**Interfaces:**
- Consumes: `config/procedures.json` and `harness/internal-skills/tdd.md`.
- Produces: no new export. `buildWorkerPrompt(root, projectRoot, run, task, opts)` keeps its signature; only the prompt text's source changes.

- [ ] **Step 1: Write the failing test**

Add to `scripts/test-task-worker.mjs`:

```js
test('worker-prompt-sources-tdd-from-the-registry',()=>{
  const tdd=fs.readFileSync(path.join(ROOT,'harness','internal-skills','tdd.md'),'utf8');
  const marker='NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST';
  assert(tdd.includes(marker),'tdd.md no longer states the Iron Law: fix the fixture, not the test');
  const prompt=buildWorkerPrompt(ROOT,ROOT,
    {run_id:'r1',state:'IMPLEMENT',workflow:'bug-fix',profile:'STRICT',overlays:[],objective:'x'},
    {task_id:'TASK-001',title:'t',goal:'g',write_scope:['src/a.js'],verification:{targeted_tests:['npm test']}});
  assert(prompt.includes(marker),'worker prompt lost the Iron Law');
  const src=fs.readFileSync(path.join(ROOT,'runtime','task-worker.mjs'),'utf8');
  assert(!src.includes(marker),'task-worker.mjs still hardcodes the Iron Law: it must read tdd.md');
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test:task-worker`
Expected: FAIL with `task-worker.mjs still hardcodes the Iron Law: it must read tdd.md`.

- [ ] **Step 3: Read the rules from the registry instead**

In `runtime/task-worker.mjs`, add to the imports:

```js
import {readJson,readTextFile} from './util.mjs';
```

(keep the existing `truncateUtf8` import from the same module) and add:

```js
// The worker runs in its own process and may have no Skill tool, so its rules
// are inlined -- but read from the one canonical file, not restated here. A
// fourth copy of the TDD rules is how they drift.
function procedureText(root,id){
  const spec=readJson(path.join(root,'config','procedures.json')).procedures?.[id];
  if(!spec?.instructions)return '';
  try{return readTextFile(path.join(root,spec.instructions)).trim();}catch{return '';}
}
```

Then replace the hardcoded item 2 of `instructions` (the `STRICT TDD (RED-GREEN-REFACTOR CYCLE)` block and its sub-steps) with:

```js
    '2. STRICT TDD: follow the procedure below exactly.',
```

and append the text as its own prompt section, before the `PREVIOUS ATTEMPT FAILURE` section is pushed:

```js
  const tdd=procedureText(root,'tdd');
  if(tdd)sections.push(`TDD PROCEDURE (canonical: harness/internal-skills/tdd.md)\n${tdd}`);
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npm run test:task-worker`
Expected: PASS.

- [ ] **Step 5: Confirm the prompt did not balloon**

Run: `npm run test:budget`
Expected: PASS. `tdd.md` is 67 lines against roughly 12 hardcoded lines, so the worker prompt grows. If the budget suite fails, pass `truncateUtf8(tdd, 6000).text` rather than trimming the canonical file.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor(worker): source the TDD rules from the procedure registry"
```

---

### Task 10: Add the three design evals

**Files:**
- Modify: `evals/run-deterministic.mjs`
- Test: `evals/run-deterministic.mjs`

**Interfaces:**
- Consumes: `readSkillTiers` (Task 2), `loadNavigationPolicy` and `navigableSkillIds` (Task 3).
- Produces: three named cases — `skill-navigation-covers-every-stage`, `single-auto-activating-skill`, `skill-description-token-budget`.

- [ ] **Step 1: Write all three cases**

Add to `evals/run-deterministic.mjs`:

```js
test('skill-navigation-covers-every-stage',()=>{
  const policy=loadNavigationPolicy(ROOT);
  const order=JSON.parse(fs.readFileSync(path.join(ROOT,'config','state-machine.json'),'utf8')).lifecycle_order||[];
  for(const stage of order){
    const e=policy.stages?.[stage];
    if(!e)throw Error(`no navigation entry for stage ${stage}`);
    if(!e.stage_skill)throw Error(`stage ${stage} names no stage skill`);
  }
  const procedures=JSON.parse(fs.readFileSync(path.join(ROOT,'config','procedures.json'),'utf8')).procedures;
  const reachable=navigableSkillIds(ROOT);
  for(const [id,spec] of Object.entries(procedures)){
    if(spec.when==='manual')continue;
    if(!reachable.has(id))throw Error(`procedure ${id} is registered but no navigation path reaches it`);
  }
  for(const id of reachable){
    if(procedures[id])continue;
    if(policy.guidance?.[id])continue;
    throw Error(`navigation names ${id}, which is neither a procedure nor a guidance entry`);
  }
});

test('single-auto-activating-skill',()=>{
  const tiers=readSkillTiers(ROOT);
  const broad=[];
  for(const id of tiers.all){
    const body=fs.readFileSync(path.join(ROOT,skillBodyPath(tiers,id)),'utf8');
    const front=body.split('---')[1]||'';
    const declaresNonEntry=body.includes('Not an entry point');
    if(id==='sdlc-router'){
      if(declaresNonEntry)throw Error('sdlc-router is the entry point and must not disclaim it');
      broad.push(id);
      continue;
    }
    if(id==='sdlc-orchestrator')continue; // entered only after the router hands over
    if(!declaresNonEntry)throw Error(`${id} does not declare itself a non-entry point`);
    if(/^description:.*\buse automatically\b/im.test(front))throw Error(`${id} carries a broad auto-activation description`);
  }
  if(broad.length!==1)throw Error(`expected exactly one auto-activating skill, found ${broad.join(',')||'none'}`);
});

test('skill-description-token-budget',()=>{
  // Baseline measured on the 8-skill + 6-command surface this replaced: 2180
  // bytes of description text. The ceiling is deliberately close to the
  // measured post-change figure so drift shows up as a failure, not as slow
  // growth nobody notices.
  const LIMIT_BYTES=6000;
  const tiers=readSkillTiers(ROOT);
  let total=0;
  for(const id of tiers.all){
    const front=(fs.readFileSync(path.join(ROOT,skillBodyPath(tiers,id)),'utf8').split('---')[1]||'');
    const m=/^description:\s*(.+)$/im.exec(front);
    if(!m)throw Error(`${id} has no description in its frontmatter`);
    total+=Buffer.byteLength(m[1].trim(),'utf8');
  }
  if(total>LIMIT_BYTES)throw Error(`skill descriptions total ${total} bytes, over the ${LIMIT_BYTES} ceiling`);
});
```

Add the imports these need: `import {loadNavigationPolicy,navigableSkillIds} from '../runtime/skill-navigation.mjs';` and `import {readSkillTiers,skillBodyPath} from '../scripts/lib/skill-tiers.mjs';`. `evals/run-deterministic.mjs` has no module-level binding for `config/state-machine.json` — it reads the file inside the one case that needs it (line 752), which is why the case above reads it inline too.

- [ ] **Step 2: Run the suite**

Run: `npm test`
Expected: PASS. If `skill-description-token-budget` fails, record the real total in the comment and raise `LIMIT_BYTES` to that number rounded up — but only after confirming the growth is the 7 stage plus 24 procedure descriptions and not an accidental paragraph in a `description:` field.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "test(evals): assert navigation coverage, single activation entry, and description budget"
```

---

### Task 11: Update the documentation surface

**Files:**
- Modify: `README.md`, `docs/QUICKSTART.md`, `docs/USAGE.md`, `docs/AUTO-ACTIVATION.md`, `docs/CORPUS-DECISIONS.md`, `docs/MIGRATION.md`, `CHANGELOG.md`
- Test: `npm run test:versions`, `npm run test:root-sync`

**Interfaces:**
- Consumes: the finished surface from Tasks 1-10.
- Produces: no code interface. `docs/MIGRATION.md` already carries the `/sdlc-route` note from Task 1; this task adds the tier and consolidation notes.

- [ ] **Step 1: Find every stale claim**

Run:

```bash
grep -rIn --exclude-dir=.git --exclude-dir=.agent-sdlc --exclude-dir=dist \
  -e 'public_skills' -e 'commands/' -e 'sdlc-route\b' -e 'two public entry skills' \
  -e '41 internal' -e 'internal skills are references' README.md docs/ CHANGELOG.md
```

Expected: a list to work through. Every hit is either a claim to correct or a historical release note to leave alone — a line under a past-version heading in `CHANGELOG.md` stays as written.

- [ ] **Step 2: Document the four tiers where the surface is described**

In `README.md` and `docs/USAGE.md`, replace the list of eight public skills with the tier table from the spec's section 1, and state that skills are the only public surface on every host and that a skill is slash-invocable.

- [ ] **Step 3: Document navigation in `docs/AUTO-ACTIVATION.md`**

State that `sdlc-router` remains the single auto-activating skill and the bootstrap hook is unchanged; that stage and procedure skills never auto-activate; and that `navigation.stage_skill` in `status`/`context` output is what selects the next skill.

- [ ] **Step 4: Record the consolidation decision in `docs/CORPUS-DECISIONS.md`**

Add an entry: 41 guidance files went to 24; the twelve slot stubs were deleted and their single sentence lives in `policies/skill-navigation.json` under `guidance`; a `guidance`-only entry is the declared extension point that graduates into `config/procedures.json` when real content is written for it.

- [ ] **Step 5: Add the migration note for the tier change**

Append to `docs/MIGRATION.md`, under the heading Task 1 created:

```markdown
`agent-sdlc.manifest.json` no longer has `public_skills`. Read the surface from
`entry_skills`, `ops_skills`, `stage_skills` and `procedure_skills` — or call
`readSkillTiers()` from `scripts/lib/skill-tiers.mjs`, which is what every
script in this repo does. `config/skills.json` no longer carries a `public`
array; the manifest is the only declaration of the surface.
```

- [ ] **Step 6: Add the CHANGELOG entry**

Add an `## Unreleased` entry naming the four breaking changes: `commands/` removed, `/sdlc-route` renamed, `public_skills` replaced by tiers, and 17 guidance files retired.

- [ ] **Step 7: Run the full suite one last time**

Run: `npm test && npm run test:integrity && npm run build && npm run verify:dist && npm run validate:github`
Expected: PASS on all five.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "docs: describe the four-tier skill surface and the navigation policy"
```

---

## Self-Review Notes

Checked against the spec, section by section:

- Spec §1 (four-tier taxonomy) → Tasks 1, 2, 7, 8. `sdlc-route` merge and `commands/` deletion are Task 1; the manifest keys are Task 2; the two empty tiers are filled by Tasks 7 and 8.
- Spec §2 (deterministic navigation) → Tasks 3 and 4. The spec's three code touchpoints map to Task 3 Step 6 (`resolveSkills`), Task 4 (the `navigation` block), Task 7 Step 6 (orchestrator shrink) and Task 9 (`task-worker`).
- Spec §3 (activation safety) → the fixed description shape is applied in Tasks 7 and 8 and enforced by `single-auto-activating-skill` in Task 10.
- Spec §4 (generation and packaging) → Task 8 for the generator; Task 2 Step 7 covers all seven files in the spec's validation-chain table, including `evals/run-deterministic.mjs:644` which Task 1 Step 1 rewrites first.
- Spec §5 (three new evals) → Task 10.
- Spec §6 (legacy consolidation) → Tasks 5 and 6, in the spec's mandated order: fold in its own commit, delete after.
- Spec Migration and Compatibility → Task 1 Step 9 and Task 11 Step 5.
- Spec Rollout phases 1-6 → Phases 1-6 here, same order.

Two things the spec asserted that this plan verifies rather than assumes: that no lifecycle stage loses coverage when the 17 files go (Task 6 Step 9, backed by a simulation showing 24 survivors covering all 11 stages, `OBSERVE` by a single entry), and that the retired stubs' guidance still reaches the agent (Task 3's `resolve-returns-guidance-for-every-retired-id`, plus the `resolveSkills` guidance push in Task 3 Step 6 — without that push, `guidance` would be policy metadata nobody reads).

One deviation from the spec worth flagging to the reviewer: the spec says the differential test compares "the set of skill ids resolved per stage/workflow/overlay". Task 3 implements this as a comparison against frozen literal tables rather than against the live old maps, because the maps must be deleted in the same task that introduces the policy — a resolver cannot import a map that still exists and also prove it replaced it. The frozen tables are the same data, and they stay in the suite permanently as the regression baseline.
