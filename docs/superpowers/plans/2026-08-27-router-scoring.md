# Router Scoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the router picking a workflow by array position. When an objective's words satisfy more than one rule — an assessment verb next to a change-workflow noun, e.g. "investigate optimization opportunities" — the router must score every matching rule and pick the one the objective actually asked for, surface every match it considered (not just the winner) so a human can see the competing read, and flag the routing decision as ambiguous when the two intents genuinely conflict.

**Architecture:** One function changes: `runtime/router.mjs`'s `route()` moves from "return the first rule with any keyword hit" to "score every rule that has a hit, then take the top score". A rule's score is `sum over its matched keywords of (keyword word count × rule priority)`. Priority is `2` for a `STRICT` rule (a misread security/incident/db-migration objective is the worse mistake, so it should win a tie against everything), `1.5` for a rule tagged `"intent": "investigate"` (only `technical-spike` today — an assessment verb usually governs the whole sentence, so it should outweigh an equal-weight "change" hit), and `1` otherwise. Ties are broken deterministically: STRICT first, then original declaration order. A new `foldVerbNounFamily` step in `normalize()` folds the regular `-ation` noun form to its `-ate` verb form (`investigation` → `investigate`) so the noun form of an already-listed keyword is not invisible to the matcher. `reason_codes` now lists every matching rule's hits, not just the winner's, and a new `AMBIGUOUS_ROUTE` risk flag fires when the top two candidates tie, belong to different intent classes, or are within half a point of each other.

**Tech Stack:** Node.js ESM (`.mjs`), zero runtime dependencies. Hand-rolled `test()` suite in `evals/run-deterministic.mjs`.

**Spec:** `docs/superpowers/specs/2026-08-27-harness-spike-findings.md`, finding F2.

## Global Constraints

- Node `>=18`. No syntax or API newer than Node 18.
- Zero runtime dependencies.
- `runtime/router.mjs` has no other consumers than `evals/run-deterministic.mjs` and the orchestrator's `route()` call in `runtime/orchestrator.mjs` — neither reads internals, both just call `route(root, objective, explicitWorkflow?, explicitProfile?)` and read `.workflow`/`.profile`/`.overlays`/`.reason_codes`/`.risk_flags`. The return shape must not change.
- `config/router-rules.json` has no schema validator outside `runtime/router.mjs` itself (checked: `grep -rln router-rules scripts/ runtime/` returns only `runtime/router.mjs`), so an added `"intent"` key on one rule object is safe.
- Every offline suite reachable from `npm run check` must also be run by `.github/workflows/ci.yml`; `scripts/validate-ci-coverage.mjs` enforces membership and order. This plan adds cases to an existing suite (`evals/run-deterministic.mjs`) and creates no new npm script, so CI coverage does not change.
- `evals/COVERAGE-FLOOR.json` records `overall_percent: 90`; do not lower it.
- Do not touch `runtime/launcher.mjs`, `runtime/task-verification.mjs`, or the secret-scan policy — those are settled by the execution-path-correctness and gate-signal-correctness plans and are out of scope here.

---

### Task 1: Score every matching rule instead of returning the first hit

**Files:**
- Modify: `config/router-rules.json` — tag the `technical-spike` rule with `"intent": "investigate"`
- Modify: `runtime/router.mjs` — `normalize()` and `route()`
- Test: `evals/run-deterministic.mjs`

**Interfaces:**
- Consumes: nothing from another plan.
- Produces: `route()`'s return shape is unchanged (`{workflow,profile,overlays,reason_codes,risk_flags}`); `reason_codes` and `risk_flags` can now contain more entries than before for a multi-rule-match objective. No other file's behavior depends on the previous entry count.

The reproduction table from the spec (all five need `technical-spike`, all four mixed-intent rows currently miss it):

| objective | got (before) | needed |
|---|---|---|
| investigate optimization opportunities | performance/STANDARD | technical-spike |
| assess whether we can optimize the plugin | performance/STANDARD | technical-spike |
| read-only investigation of slow startup | performance/STANDARD | technical-spike |
| nang cap va toi uu plugin, chi dieu tra | performance/STANDARD | technical-spike |
| investigation of the plugin | new-feature/STANDARD (DEFAULT) | technical-spike |

Each row already has both keywords present verbatim in `config/router-rules.json` except two: `read-only investigation of slow startup` and `investigation of the plugin` need `investigation` to reach the `investigate` keyword, which first-match-wins never required because a general stemmer was never added — the finding's fix explicitly scopes this to "the -ate/-ation family" (`investigate`/`investigation`, `evaluate`/`evaluation`), not a general stemmer, to avoid unrelated false matches elsewhere in the 21-rule keyword table (e.g. `migration`, a literal keyword, folds to `migrate` symmetrically on both the text and the keyword side, so it keeps matching itself — verified below).

- [x] **Step 1: Write the failing tests**

Add to `evals/run-deterministic.mjs`, immediately after the existing `router-ignores-untrusted-quoted-tool-keywords` case:

```javascript
// F2: first-match-wins used to pick whichever rule sat earlier in
// config/router-rules.json, so an assessment verb sharing a sentence with a
// change-workflow keyword lost to the change every time -- "investigate
// optimization opportunities" routed to performance/STANDARD, not the
// read-only spike it actually asked for.
test('router-mixed-intent-favours-the-assessment-verb',()=>{
  for(const objective of [
    'investigate optimization opportunities',
    'assess whether we can optimize the plugin',
    'read-only investigation of slow startup',
    'nang cap va toi uu plugin, chi dieu tra'
  ]){
    const r=route(ROOT,objective);
    if(r.workflow!=='technical-spike')throw Error(`${objective} -> ${r.workflow}`);
    if(!r.risk_flags.includes('AMBIGUOUS_ROUTE'))throw Error(`${objective}: no AMBIGUOUS_ROUTE flag, got ${JSON.stringify(r.risk_flags)}`);
  }
});
// -ate/-ation folding: "investigation" alone (no competing keyword) must reach
// the "investigate" keyword too, not just the verb form.
test('router-ation-noun-folds-to-the-ate-verb-keyword',()=>{
  const r=route(ROOT,'investigation of the plugin');
  if(r.workflow!=='technical-spike')throw Error(JSON.stringify(r));
});
test('router-reason-codes-list-every-matching-rule-not-just-the-winner',()=>{
  const r=route(ROOT,'investigate optimization opportunities');
  if(!r.reason_codes.some(c=>c==='KEYWORD:investigate'))throw Error(JSON.stringify(r.reason_codes));
  if(!r.reason_codes.some(c=>c==='KEYWORD:optimization'))throw Error(JSON.stringify(r.reason_codes));
});
// A tie between a STRICT rule and a non-STRICT rule must resolve to STRICT --
// misreading a security/incident objective as lower-scrutiny is the worse
// mistake, so the safety-relevant interpretation wins ties it doesn't outright win on score.
test('router-tied-score-prefers-strict-profile',()=>{
  const r=route(ROOT,'outage test coverage');
  if(r.workflow!=='incident-response'||r.profile!=='STRICT')throw Error(JSON.stringify(r));
});
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `node evals/run-deterministic.mjs`

Expected: `router-mixed-intent-favours-the-assessment-verb` FAILs on the first objective (`performance`, not `technical-spike`) — first-match-wins hits the `performance` rule's `optimization` keyword before ever considering `technical-spike`'s `investigate`, since `performance` sits earlier in `config/router-rules.json`. `router-ation-noun-folds-to-the-ate-verb-keyword` FAILs (`new-feature`, the DEFAULT) because `investigation` is not `investigate` and no other rule matches. `router-tied-score-prefers-strict-profile` and `router-reason-codes-list-every-matching-rule-not-just-the-winner` also fail against the unmodified `route()`.

Confirmed: this exact failure set was reproduced against the pre-change tree before writing Step 3.

- [x] **Step 3: Write the implementation**

In `config/router-rules.json`, find the `technical-spike` rule (its `keywords` array starts with `"assess"`, `"đánh giá"`, `"điều tra"`...) and add an `intent` key:

```json
      "workflow": "technical-spike",
      "profile": "FAST",
      "overlays": [],
      "intent": "investigate"
    },
```

In `runtime/router.mjs`, replace:

```javascript
function normalize(s){return foldDiacritics(stripEmbeddedData(s)).toLowerCase().replace(/[^a-z0-9]+/g,' ').replace(/\s+/g,' ').trim();}
function keywordMatch(text,keyword){const t=` ${normalize(text)} `;const k=normalize(keyword);return k? t.includes(` ${k} `):false;}

export function route(root,objective,explicitWorkflow=null,explicitProfile=null){
  const wf=readJson(path.join(root,'config','workflows.json')).workflows;
  if(explicitWorkflow){if(!wf[explicitWorkflow])throw new Error(`unknown workflow: ${explicitWorkflow}`);return {workflow:explicitWorkflow,profile:explicitProfile||wf[explicitWorkflow].default_profile,overlays:wf[explicitWorkflow].required_overlays||[],reason_codes:['EXPLICIT_WORKFLOW'],risk_flags:[]};}
  const rules=readJson(path.join(root,'config','router-rules.json'));
  for(const r of rules.rules){const hits=r.keywords.filter(k=>keywordMatch(objective,k));if(hits.length)return {workflow:r.workflow,profile:explicitProfile||r.profile,overlays:r.overlays||[],reason_codes:hits.map(x=>`KEYWORD:${x}`),risk_flags:r.profile==='STRICT'?['HIGH_RISK_ROUTE']:[]};}
  return {...rules.default,profile:explicitProfile||rules.default.profile,reason_codes:['DEFAULT_NEW_FEATURE'],risk_flags:[]};
}
```

with:

```javascript
// The -ate/-ation family (investigate/investigation, evaluate/evaluation, ...)
// forms its noun regularly, so folding this one suffix pair lets "a security
// investigation" reach the "investigate" keyword without a general stemmer
// that would risk unrelated false matches elsewhere in the keyword table.
function foldVerbNounFamily(s){return s.split(' ').map(w=>w.length>6&&w.endsWith('ation')?w.slice(0,-5)+'ate':w).join(' ');}
function normalize(s){return foldVerbNounFamily(foldDiacritics(stripEmbeddedData(s)).toLowerCase().replace(/[^a-z0-9]+/g,' ').replace(/\s+/g,' ').trim());}
function keywordMatch(text,keyword){const t=` ${normalize(text)} `;const k=normalize(keyword);return k? t.includes(` ${k} `):false;}
const keywordWords=k=>normalize(k).split(' ').filter(Boolean).length;
// STRICT rules outrank everything else on a tie, since misreading a
// security/incident/db-migration objective as something lower-scrutiny is the
// worse mistake. Below that, "investigate" intent outranks a same-weight
// "change" hit, because an assessment verb usually governs the whole request
// ("investigate optimization opportunities" is a spike about optimization, not
// an optimization change) -- this is what let first-match-wins pick whichever
// rule happened to sit earlier in config/router-rules.json.
const rulePriority=r=>r.profile==='STRICT'?2:(r.intent==='investigate'?1.5:1);
const intentOf=r=>r.intent||'change';

export function route(root,objective,explicitWorkflow=null,explicitProfile=null){
  const wf=readJson(path.join(root,'config','workflows.json')).workflows;
  if(explicitWorkflow){if(!wf[explicitWorkflow])throw new Error(`unknown workflow: ${explicitWorkflow}`);return {workflow:explicitWorkflow,profile:explicitProfile||wf[explicitWorkflow].default_profile,overlays:wf[explicitWorkflow].required_overlays||[],reason_codes:['EXPLICIT_WORKFLOW'],risk_flags:[]};}
  const rules=readJson(path.join(root,'config','router-rules.json'));
  const candidates=rules.rules.map((rule,idx)=>{
    const hits=rule.keywords.filter(k=>keywordMatch(objective,k));
    const score=hits.reduce((sum,k)=>sum+keywordWords(k)*rulePriority(rule),0);
    return {rule,idx,hits,score};
  }).filter(c=>c.hits.length>0);
  if(!candidates.length)return {...rules.default,profile:explicitProfile||rules.default.profile,reason_codes:['DEFAULT_NEW_FEATURE'],risk_flags:[]};
  // Stable score-desc order; a genuine tie prefers STRICT, then declaration
  // order, so the outcome is deterministic rather than array-position luck.
  candidates.sort((a,b)=>b.score-a.score||(a.rule.profile==='STRICT'?0:1)-(b.rule.profile==='STRICT'?0:1)||a.idx-b.idx);
  const [top,second]=candidates;
  const risk_flags=[];
  if(top.rule.profile==='STRICT')risk_flags.push('HIGH_RISK_ROUTE');
  // Every match is reported, not just the winner's, so a human or the
  // orchestrator can see the competing interpretation that was scored down.
  const reason_codes=candidates.flatMap(c=>c.hits.map(h=>`KEYWORD:${h}`));
  if(second&&(second.score===top.score||intentOf(second.rule)!==intentOf(top.rule)||second.score>=top.score*0.5)){
    risk_flags.push('AMBIGUOUS_ROUTE');
  }
  return {workflow:top.rule.workflow,profile:explicitProfile||top.rule.profile,overlays:top.rule.overlays||[],reason_codes,risk_flags};
}
```

Why the `-ation` fold cannot regress an existing keyword: `normalize()` is applied identically to the objective text and to every keyword inside `keywordMatch`, so a keyword that happens to already end in `-ation` (e.g. `migration`, used verbatim in the `database-migration` rule) folds to `migrate` on **both** sides and still matches itself. The fold only adds new cross-matches between a word's `-ate` and `-ation` forms; it cannot break a match that worked before, because whatever the keyword becomes, the text becomes the same thing.

Why `AMBIGUOUS_ROUTE`'s third condition (`second.score>=top.score*0.5`) does not fire in every multi-keyword-hit case: it only evaluates when a **second, distinct rule** also matched (`candidates[1]` must exist) — an objective with several keyword hits inside the *same* rule (e.g. "reduce API latency and improve throughput", two `performance` keywords) produces exactly one candidate, so `second` is `undefined` and no flag is added.

- [x] **Step 4: Run the tests to verify they pass**

Run: `node evals/run-deterministic.mjs`

Result: `315` pre-existing checks plus the `4` new cases all pass, `319/319`, zero failures. Every previously-passing router case (`router-security-strict`, `router-optimization-routes-to-performance`, `router-assessment-verbs-route-to-spike`, all Vietnamese cases, the diacritic-folding and quoted-keyword cases) still passes unchanged — verified by re-running the full suite, not by inspection alone.

Manually re-verified the full F2 reproduction table plus the STRICT-tie and same-intent-tie scenarios against the implemented `route()`:

```
investigate optimization opportunities          -> technical-spike (AMBIGUOUS_ROUTE)
assess whether we can optimize the plugin       -> technical-spike (AMBIGUOUS_ROUTE)
read-only investigation of slow startup         -> technical-spike (AMBIGUOUS_ROUTE)
nang cap va toi uu plugin, chi dieu tra          -> technical-spike (AMBIGUOUS_ROUTE)
investigation of the plugin                     -> technical-spike (no flag: only one rule matched)
outage test coverage                            -> incident-response/STRICT (tie broken toward STRICT)
security incident                               -> security-remediation/STRICT (STRICT/STRICT tie, declaration order)
```

Run: `npm run check`

Expected and observed: exit 0, all offline suites pass.

Run: `node scripts/coverage-report.mjs`

Expected and observed: `"status": "PASS"`, floor unchanged at `90`.

- [x] **Step 5: Commit**

```bash
git add config/router-rules.json runtime/router.mjs evals/run-deterministic.mjs evals/DETERMINISTIC-VALIDATION.json evals/COVERAGE.json
git commit -m "fix(router): score every matching rule instead of first-match-wins (F2)"
```

---

## What this plan deliberately does not do

- **Does not add a general stemmer.** Only the `-ate`/`-ation` pair is folded, per the finding's explicit scope; a broader stemmer risks new false matches across a 21-rule, two-language keyword table with no eval coverage to catch them.
- **Does not change what `AMBIGUOUS_ROUTE` does downstream.** No consumer reads it yet outside the eval suite; wiring it into orchestrator behavior (e.g. requiring confirmation on an ambiguous route) is a separate, unscoped decision.
- **Does not touch F1, F3-F14** — those belong to the execution-path-correctness and gate-hygiene plans.
