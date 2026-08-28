# Gate Signal Correctness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the harness's remaining verification signals tell the truth — a secret scanner that stops crying wolf on its own fixtures and on ordinary identifiers, a repo-wide guard that cannot be broken by a worktree or by its own output, and the task-engine execution path routed through the shared launcher so it stops repeating the three bugs the previous plan fixed everywhere else.

**Architecture:** Three independent corrections plus a gate run. The secret scanner moves its patterns and a path allowlist into `policies/security-policy.json`, and its patterns become value-shaped so a match means "a credential-looking value is assigned here", not "the word token appears". The `.ai-workflow` legacy guard gains the directory exclusions its walk was missing and stops scanning the report file it writes. `runtime/task-verification.mjs` — a second consumer of the same project command config that the previous plan never touched — routes through `runtime/launcher.mjs` and `describeSpawn`, and substitutes `{selector}` from the task's own `verification.targeted_tests` instead of passing the literal placeholder to the test runner.

**Tech Stack:** Node.js ESM (`.mjs`), zero runtime dependencies. Hand-rolled suites; `scripts/lib/suite.mjs` for the ones that use it. `node:child_process.spawnSync` only — never `shell:true`.

**Spec:** `docs/superpowers/specs/2026-08-27-harness-spike-findings.md` (findings F12 and F15, plus two defects found while merging the previous branch)

## Global Constraints

- Node `>=18` (`package.json` engines). No syntax or API newer than Node 18.
- Zero runtime dependencies. `package.json` has no `dependencies` block and must not gain one.
- All runtime code is ESM `.mjs` using `import`, never `require`.
- Never `spawnSync(..., {shell:true})`. Route every process launch through `resolveLaunch` from `runtime/launcher.mjs`, which exports `resolveLaunch(argv,{env,platform}) -> {status,reason,bin,args,via,spawnOptions,detail}` (`spawnOptions` is ALWAYS an object) and `describeSpawn(result) -> {status,reason,exit_code,signal}` where `status` is `'PASS'`, `'FAIL'` or `'ERROR'`.
- Gate evidence is granted only by `recordEvidence` when `status==='PASS'` (`runtime/evidence.mjs`), and only for tokens whose `evidence_authority` entry in `policies/stage-policy.json` is `'runtime'`. `no_new_high_security_findings` is ABSENT from that map, so it is operator-assertable — the secret scanner informs a human judgement, it does not gate anything by itself. Do not change that.
- Every offline suite reachable from `npm run check` must also be run by `.github/workflows/ci.yml`; `scripts/validate-ci-coverage.mjs` enforces membership AND order.
- `evals/COVERAGE-FLOOR.json` currently records `overall_percent: 90` deliberately: the last measurement of 91.1 was taken on Windows and CI also measures on ubuntu where several cases SKIP. Do not ratchet it from a Windows-only run.
- `npm run check` rewrites tracked report files under `evals/`. Commit those with the task that caused them.
- The previous branch is merged; `runtime/launcher.mjs`, `runtime/provider.mjs`, `runtime/tools.mjs`, `runtime/commands/tools.mjs`, `bin/agent-sdlc.cmd` and `bin/agent-sdlc.ps1` are all current. Do not revisit their behaviour.

---

### Task 1: Stop the legacy guard breaking on a worktree, or on its own output

**Files:**
- Modify: `evals/run-deterministic.mjs` — the `no-active-ai-workflow-references-outside-the-legacy-allowlist` case (around line 118)
- Test: `evals/run-deterministic.mjs` (the case is its own test; add one more)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: nothing other tasks consume. This task is self-contained.

Two defects, both found while merging the previous branch into master:

1. `skipDirs` is `new Set(['.git','node_modules','dist','.agent-sdlc'])`. It omits `.claude`, which is where this repo's own harness-native worktree tool creates worktrees (`.claude/worktrees/<name>`). A worktree inside the checkout therefore makes the guard walk a full second copy of the repo and fail with every allowlisted file reported under a `.claude/worktrees/...` prefix. Observed verbatim: `active .ai-workflow reference(s) outside the legacy allowlist: .claude/worktrees/exec-path-correctness/docs/MIGRATION.md, ...`. `release` and `.superpowers` are missing for the same reason — both are gitignored scratch that can hold copies.
2. The guard writes its own failure message, naming the needle, into `evals/DETERMINISTIC-VALIDATION.json`, and `evals/` is walked with `.json` matching `textFile`. So one failure poisons the next run: the second run fails with `active .ai-workflow reference(s) outside the legacy allowlist: evals/DETERMINISTIC-VALIDATION.json` — a different, self-inflicted reason. Observed verbatim, and it cost a false "merged result is red" verdict until `git checkout -- evals/` cleared it.

- [x] **Step 1: Write the failing test**

Add this case immediately after the existing `no-active-ai-workflow-references-outside-the-legacy-allowlist` case in `evals/run-deterministic.mjs`:

```javascript
// The guard above walks the working tree. Two things it must not trip over:
// a worktree created inside the checkout (this repo's own tooling puts them in
// .claude/worktrees/), and the report file the guard itself writes -- a failure
// message names the needle, so one red run used to make the next run red for a
// different, self-inflicted reason.
test('legacy-guard-ignores-scratch-dirs-and-its-own-report',()=>{
  const src=fs.readFileSync(path.join(ROOT,'evals','run-deterministic.mjs'),'utf8');
  const m=src.match(/const skipDirs=new Set\(\[([^\]]*)\]\)/);
  if(!m)throw Error('could not find the guard skipDirs literal');
  const skipped=m[1].split(',').map(s=>s.trim().replace(/^'|'$/g,'')).filter(Boolean);
  for(const required of ['.git','node_modules','dist','.agent-sdlc','.claude','release','.superpowers']){
    if(!skipped.includes(required))throw Error(`skipDirs is missing ${required}: ${JSON.stringify(skipped)}`);
  }
  // And the guard must not read its own report back in.
  const reportRel='evals/DETERMINISTIC-VALIDATION.json';
  const report=path.join(ROOT,reportRel);
  if(!fs.existsSync(report))throw Error(`${reportRel} should exist by the time this case runs`);
  const needle='.'+'ai-workflow';
  fs.writeFileSync(report,JSON.stringify({poisoned:`a prior failure mentioned ${needle} here`},null,2));
  try{
    const offenders=legacyReferenceOffenders();
    if(offenders.includes(reportRel))throw Error('the guard read its own report back in');
  }finally{
    // Leave the report where the suite's own tail will rewrite it.
    fs.writeFileSync(report,JSON.stringify({schema:'agent-sdlc/deterministic-validation/v1',note:'rewritten by the suite tail'},null,2));
  }
});
```

That case calls `legacyReferenceOffenders()`, which does not exist yet — the guard's walk is currently inline. Step 3 extracts it.

- [x] **Step 2: Run the test to verify it fails**

Run: `node evals/run-deterministic.mjs`
Expected: FAIL on `legacy-guard-ignores-scratch-dirs-and-its-own-report` with `skipDirs is missing .claude` (the assertion runs before the `legacyReferenceOffenders` call, so that is the message you see first).

- [x] **Step 3: Write the implementation**

In `evals/run-deterministic.mjs`, replace the guard case with an extracted walk plus the case that uses it. Find the existing case, which begins:

```javascript
test('no-active-ai-workflow-references-outside-the-legacy-allowlist',()=>{
  const allowlist=new Set([
```

and ends with its `offenders` assertion. Replace the whole case with:

```javascript
// Extracted so a second case can call the same walk. The walk is the thing
// under test in both.
function legacyReferenceOffenders(){
  const allowlist=new Set([
    'docs/MIGRATION.md',
    'runtime/compat.mjs',
    'harness/internal-skills/workflow-maintenance.md',
    'templates/decision-index.yaml',
    'templates/knowledge-index.yaml',
    'templates/workflow-meta.yaml',
    'scripts/test-compat.mjs', // fixture: creates a fake legacy dir to test detection
    'evals/run-deterministic.mjs' // this guard names the legacy path itself
  ]);
  const needle='.'+'ai-workflow';
  // Gitignored scratch that can hold a whole second copy of the repo. `.claude`
  // is where this repo's own worktree tooling puts worktrees, so a worktree
  // inside the checkout used to make this guard report every allowlisted file
  // again under a .claude/worktrees/... prefix.
  const skipDirs=new Set(['.git','node_modules','dist','.agent-sdlc','.claude','release','.superpowers']);
  // The guard writes its own failure message -- which names the needle -- into
  // this report, and `evals/` is walked. Reading it back made one red run turn
  // the next run red for a different, self-inflicted reason.
  const selfReports=new Set(['evals/DETERMINISTIC-VALIDATION.json']);
  const textFile=/\.(md|mjs|js|json|yaml|yml)$/;
  const offenders=[];
  (function walk(dir){
    for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
      if(entry.isDirectory()){if(!skipDirs.has(entry.name))walk(path.join(dir,entry.name));continue;}
      if(!textFile.test(entry.name))continue;
      const full=path.join(dir,entry.name);
      const rel=path.relative(ROOT,full).split(path.sep).join('/');
      if(allowlist.has(rel)||selfReports.has(rel))continue;
      if(fs.readFileSync(full,'utf8').includes(needle))offenders.push(rel);
    }
  })(ROOT);
  return offenders;
}

test('no-active-ai-workflow-references-outside-the-legacy-allowlist',()=>{
  const offenders=legacyReferenceOffenders();
  if(offenders.length)throw Error(`active .ai-workflow reference(s) outside the legacy allowlist: ${offenders.join(', ')}`);
});
```

Read the existing case before replacing it and preserve its allowlist entries and their comments exactly — the list above reproduces what is there today, but if the file has drifted, the file wins and you carry its entries over rather than the ones written here.

- [x] **Step 4: Run the tests to verify they pass**

Run: `node evals/run-deterministic.mjs`
Expected: `"results": "all-pass"`, checks up by 1.

Then prove defect 1 is really fixed, not just asserted, by reproducing the condition that caused it:

```bash
git worktree add .claude/worktrees/guard-probe -b guard-probe
node evals/run-deterministic.mjs
git worktree remove .claude/worktrees/guard-probe
git branch -D guard-probe
```

Expected: `all-pass` with the worktree present. Before this task the same sequence fails with offenders reported under `.claude/worktrees/guard-probe/...`. Record the actual output of both the passing run and, if you want the red evidence, a run with the walk's `.claude` entry temporarily removed.

- [x] **Step 5: Commit**

```bash
git add evals/run-deterministic.mjs evals/DETERMINISTIC-VALIDATION.json
git commit -m "fix(evals): the legacy guard no longer trips on a worktree or its own report"
```

---

### Task 2: A secret scanner whose findings mean something

**Files:**
- Modify: `policies/security-policy.json` — add a `secret_scan` block
- Modify: `runtime/tools.mjs` — the `secretScan()` function (around line 14)
- Modify: `docs/superpowers/specs/2026-08-27-harness-spike-findings.md` — correct F12's severity claim
- Test: `evals/run-deterministic.mjs`

**Interfaces:**
- Consumes: `resolveLaunch` and `describeSpawn` from `runtime/launcher.mjs` (already present on this branch).
- Produces: `policies/security-policy.json` gains `secret_scan: {patterns:[{id,regex}], allowlist_paths:[glob]}`. Task 3 reads the same `patterns` array so the two scanners stop carrying separate regexes.

The current pattern is `(AKIA[0-9A-Z]{16}|BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY|api[_-]?key\s*[:=]|secret\s*[:=]|token\s*[:=])`. The last three alternatives match a NAME followed by punctuation, with no requirement that a credential-shaped value follows. Measured against this repo today it reports four files, of which every one is a false positive:

```
runtime/telemetry.mjs:74   const token={input_tokens:0,cached_input_tokens:0,...}
evals/alpha6-runtime.mjs   the scanner's own leak fixtures (AKIA..., api_key = "sk-...")
evals/run-deterministic.mjs the scanner's own test fixtures
docs/superpowers/specs/...  this spec, which quotes the pattern
```

A value-shaped pattern was measured against the same tree and drops `runtime/telemetry.mjs` and the spec while still catching the scanner's own positive fixture `api_key=SUPERSECRET`, leaving only the two `evals/` fixture files for the allowlist to handle:

```
(AKIA[0-9A-Z]{16}|BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY|(api[_-]?key|secret|token|password|passwd)["']?[[:space:]]*[:=][[:space:]]*["']?[A-Za-z0-9_./+-]{8,})
```

Note `[[:space:]]` rather than `\s`: this string is handed to `git grep -E`, which uses POSIX ERE where `\s` is not portable.

ALSO correct the spec. F12 currently claims the false positives make `no_new_high_security_findings` impossible to produce and therefore block the VERIFY gate. That is wrong: `no_new_high_security_findings` is absent from `evidence_authority` in `policies/stage-policy.json`, and `guardEvidenceAuthority` (`runtime/orchestrator.mjs:25-34`) throws only when a token's authority is `'runtime'`, so the token is operator-assertable. The finding is real but its severity is Medium, not blocking: a scanner that fires on `const token={` and on its own fixtures trains an operator to assert past it, which is worse than a scanner that stays quiet.

- [x] **Step 1: Write the failing tests**

Add to `evals/run-deterministic.mjs`, next to the existing `secret-scan-clean-is-pass` and `secret-scan-finding-redacts-value` cases:

```javascript
// The scanner used to match a NAME followed by punctuation, with no requirement
// that a credential-shaped value follow. On this repo it reported four files and
// every one was a false positive -- including `const token={input_tokens:0,...}`
// in runtime/telemetry.mjs and the scanner's own fixtures. A scanner that cries
// wolf trains an operator to assert past it.
test('secret-scan-ignores-an-identifier-named-token',()=>{
  const d=fs.mkdtempSync(path.join(os.tmpdir(),'agent-sdlc-secret-'));
  execFileSync('git',['init','-q'],{cwd:d});
  initProject(d,{schema:'agent-sdlc/project/v1',project:'idents',commands:{test_targeted:['node','-e','process.exit(0)']},providers:{preferred:['claude']}});
  fs.writeFileSync(path.join(d,'telemetry.js'),'const token={input_tokens:0,output_tokens:0};\nlet secret = {};\nexport const api_key = null;\n');
  execFileSync('git',['add','telemetry.js'],{cwd:d});
  const r=newRun(ROOT,d,{objective:'x',route:route(ROOT,'Add fixture feature')});
  transition(ROOT,d,r,'REQUIREMENTS');
  transition(ROOT,d,r,'DESIGN',{evidence:['requirements_confirmed']});
  transition(ROOT,d,r,'PLAN',{evidence:['design_or_skip_decision'],internal:true});
  transition(ROOT,d,r,'IMPLEMENT',{evidence:planGateEvidence(),internal:true});
  const out=invokeTool(ROOT,d,r,'security.secret_scan',{});
  if(out.status!=='PASS')throw Error(`identifiers named token/secret/api_key must not be findings: ${JSON.stringify(out)}`);
});

test('secret-scan-still-catches-an-assigned-credential',()=>{
  const d=fs.mkdtempSync(path.join(os.tmpdir(),'agent-sdlc-secret2-'));
  execFileSync('git',['init','-q'],{cwd:d});
  initProject(d,{schema:'agent-sdlc/project/v1',project:'leaky',commands:{test_targeted:['node','-e','process.exit(0)']},providers:{preferred:['claude']}});
  fs.writeFileSync(path.join(d,'conf.js'),'api_key = "sk-abcdefghijklmnopqrstuv"\n');
  execFileSync('git',['add','conf.js'],{cwd:d});
  const r=newRun(ROOT,d,{objective:'x',route:route(ROOT,'Add fixture feature')});
  transition(ROOT,d,r,'REQUIREMENTS');
  transition(ROOT,d,r,'DESIGN',{evidence:['requirements_confirmed']});
  transition(ROOT,d,r,'PLAN',{evidence:['design_or_skip_decision'],internal:true});
  transition(ROOT,d,r,'IMPLEMENT',{evidence:planGateEvidence(),internal:true});
  const out=invokeTool(ROOT,d,r,'security.secret_scan',{});
  if(out.status!=='FAIL')throw Error(`an assigned credential must still be a finding: ${JSON.stringify(out)}`);
  if(out.summary.includes('sk-abcdefghijklmnopqrstuv'))throw Error('the value leaked into the summary');
});

test('secret-scan-honours-the-policy-allowlist',()=>{
  const d=fs.mkdtempSync(path.join(os.tmpdir(),'agent-sdlc-secret3-'));
  execFileSync('git',['init','-q'],{cwd:d});
  initProject(d,{schema:'agent-sdlc/project/v1',project:'fixtures',commands:{test_targeted:['node','-e','process.exit(0)']},providers:{preferred:['claude']}});
  fs.mkdirSync(path.join(d,'evals'),{recursive:true});
  fs.writeFileSync(path.join(d,'evals','leak-fixture.js'),'api_key = "sk-abcdefghijklmnopqrstuv"\n');
  execFileSync('git',['add','-A'],{cwd:d});
  const r=newRun(ROOT,d,{objective:'x',route:route(ROOT,'Add fixture feature')});
  transition(ROOT,d,r,'REQUIREMENTS');
  transition(ROOT,d,r,'DESIGN',{evidence:['requirements_confirmed']});
  transition(ROOT,d,r,'PLAN',{evidence:['design_or_skip_decision'],internal:true});
  transition(ROOT,d,r,'IMPLEMENT',{evidence:planGateEvidence(),internal:true});
  const out=invokeTool(ROOT,d,r,'security.secret_scan',{});
  if(out.status!=='PASS')throw Error(`an allowlisted path must not be a finding: ${JSON.stringify(out)}`);
});

test('secret-scan-reports-a-missing-git-as-error-not-fail',()=>{
  // A scanner that cannot run is not a clean scan and is not a finding either.
  // Before the launcher change, a missing git surfaced as FAIL with git's stderr.
  const d=fs.mkdtempSync(path.join(os.tmpdir(),'agent-sdlc-secret4-'));
  execFileSync('git',['init','-q'],{cwd:d});
  initProject(d,{schema:'agent-sdlc/project/v1',project:'nogit',commands:{test_targeted:['node','-e','process.exit(0)']},providers:{preferred:['claude']}});
  const policy=JSON.parse(fs.readFileSync(path.join(ROOT,'policies','security-policy.json'),'utf8'));
  if(!policy.secret_scan?.patterns?.length)throw Error('policies/security-policy.json has no secret_scan.patterns');
  if(!Array.isArray(policy.secret_scan.allowlist_paths))throw Error('secret_scan.allowlist_paths must be an array');
});
```

Note the last case asserts the policy block exists rather than shadowing `git`; shadowing PATH inside a shared suite process is the mistake a previous task in this repo already made and had to undo.

- [x] **Step 2: Run the tests to verify they fail**

Run: `node evals/run-deterministic.mjs`
Expected: FAIL on `secret-scan-ignores-an-identifier-named-token` (the old pattern matches `const token={`), on `secret-scan-honours-the-policy-allowlist` (no allowlist exists), and on `secret-scan-reports-a-missing-git-as-error-not-fail` (no policy block). `secret-scan-still-catches-an-assigned-credential` should already pass — it fences the behaviour that must survive.

- [x] **Step 3: Write the implementation**

First add the policy block. In `policies/security-policy.json`, add a `secret_scan` key beside the existing `secret_policy` string (leave `secret_policy` exactly as it is — it is prose and other readers may depend on it):

```json
  "secret_scan": {
    "note": "A finding must be a credential-shaped VALUE, not a name followed by punctuation. Regexes are POSIX ERE: they are handed to `git grep -E`, where \\s is not portable.",
    "patterns": [
      {"id": "AWS_ACCESS_KEY_ID", "regex": "AKIA[0-9A-Z]{16}"},
      {"id": "PRIVATE_KEY_BLOCK", "regex": "BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY"},
      {"id": "ASSIGNED_CREDENTIAL", "regex": "(api[_-]?key|secret|token|password|passwd)[\"']?[[:space:]]*[:=][[:space:]]*[\"']?[A-Za-z0-9_./+-]{8,}"}
    ],
    "allowlist_paths": [
      "evals/**",
      "docs/superpowers/specs/**"
    ]
  },
```

The two allowlist entries are this repository's own scanner fixtures and the spec that quotes the patterns. A project adopting the harness will want its own list; the shape is a path glob matched against the repo-relative path.

Then replace `secretScan()` in `runtime/tools.mjs`:

```javascript
function secretScan(projectRoot){
  const pattern='(AKIA[0-9A-Z]{16}|BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY|api[_-]?key\\s*[:=]|secret\\s*[:=]|token\\s*[:=])';
  const r=spawnSync('git',['grep','-l','-E',pattern],{cwd:projectRoot,encoding:'utf8',timeout:120000,maxBuffer:4*1024*1024});
  if(r.status===1)return {status:'PASS',exit_code:0,summary:'No tracked files matched the built-in secret patterns.',truncated:false,raw:''};
  if(r.status===0){const files=(r.stdout||'').split('\n').filter(Boolean).slice(0,200);return {status:'FAIL',exit_code:1,summary:`Potential secret patterns detected in tracked files (values redacted):\n${files.join('\n')}`,truncated:false,raw:''};}
  return {status:'FAIL',exit_code:r.status??1,summary:(r.stderr||'secret scan failed').slice(0,24000),truncated:false,raw:''};
}
```

with:

```javascript
/** Repo-relative path globs -> a matcher. Same glob dialect as sensitivePath. */
function pathAllowed(globs,rel){
  const p=String(rel||'').replaceAll('\\','/');
  return (globs||[]).some(g=>{
    const re='^'+g.replace(/[.+^${}()|[\]\\]/g,'\\$&').replaceAll('**','.*').replaceAll('*','[^/]*')+'$';
    return new RegExp(re).test(p);
  });
}

// A finding has to be a credential-shaped VALUE. The previous pattern matched a
// name followed by punctuation, so on this very repository it reported four
// files and all four were false positives -- `const token={input_tokens:0,...}`
// among them. A scanner that cries wolf teaches an operator to assert past it,
// which is worse than one that stays quiet. Patterns and the fixture allowlist
// now live in policies/security-policy.json so a project can own both.
function secretScan(root,projectRoot){
  const cfg=readJson(path.join(root,'policies','security-policy.json')).secret_scan||{};
  const patterns=(cfg.patterns||[]).map(p=>p.regex).filter(Boolean);
  if(!patterns.length){
    return {status:'ERROR',reason:'NO_SECRET_PATTERNS_CONFIGURED',exit_code:null,
      summary:'policies/security-policy.json declares no secret_scan.patterns; refusing to report a clean scan.',truncated:false,raw:''};
  }
  const argv=['git','grep','-l','-E',`(${patterns.join('|')})`];
  const launch=resolveLaunch(argv);
  if(launch.status!=='OK'){
    return {status:'ERROR',reason:launch.reason,exit_code:null,
      summary:`${launch.reason}: cannot launch ${argv.join(' ')}`,truncated:false,raw:''};
  }
  const r=spawnSync(launch.bin,launch.args,{cwd:projectRoot,encoding:'utf8',timeout:120000,maxBuffer:4*1024*1024,...launch.spawnOptions});
  // `git grep -l` exits 1 when nothing matched, which is the clean outcome, so
  // describeSpawn's FAIL/PASS split does not apply -- only its ERROR class does.
  const d=describeSpawn(r);
  if(d.status==='ERROR'){
    return {status:'ERROR',reason:d.reason,exit_code:null,
      summary:`${d.reason}: ${argv.join(' ')}${d.signal?` (killed by ${d.signal})`:''}`,truncated:false,raw:''};
  }
  if(r.status===1)return {status:'PASS',exit_code:0,summary:'No tracked files matched the configured secret patterns.',truncated:false,raw:''};
  if(r.status===0){
    const all=(r.stdout||'').split('\n').filter(Boolean);
    const files=all.filter(f=>!pathAllowed(cfg.allowlist_paths,f)).slice(0,200);
    const skipped=all.length-files.length;
    if(!files.length){
      return {status:'PASS',exit_code:0,
        summary:`No findings outside the configured allowlist (${skipped} allowlisted path(s) matched).`,truncated:false,raw:''};
    }
    const note=skipped?`\n(${skipped} further match(es) are allowlisted in policies/security-policy.json)`:'';
    return {status:'FAIL',exit_code:1,
      summary:`Potential secret patterns detected in tracked files (values redacted):\n${files.join('\n')}${note}`,truncated:false,raw:''};
  }
  return {status:'FAIL',exit_code:r.status??1,summary:(r.stderr||'secret scan failed').slice(0,24000),truncated:false,raw:''};
}
```

`secretScan` gained a `root` parameter, so update its single call site in `invokeTool` from `secretScan(projectRoot)` to `secretScan(root,projectRoot)` — grep for `secretScan(` to find it and confirm there is exactly one.

Confirm `resolveLaunch` and `describeSpawn` are already imported at the top of `runtime/tools.mjs` (the previous plan added them) and that `readJson` and `path` are too; add nothing that is already there.

Finally correct the spec. In `docs/superpowers/specs/2026-08-27-harness-spike-findings.md`, find the F12 finding and replace its severity claim. It currently asserts the false positives make `no_new_high_security_findings` unproducible and this spike's VERIFY gate blocked. Replace that claim with the truth: `no_new_high_security_findings` is absent from `evidence_authority` in `policies/stage-policy.json`, and `guardEvidenceAuthority` (`runtime/orchestrator.mjs:25-34`) throws only for tokens whose authority is `'runtime'`, so the token is operator-assertable and the scanner gates nothing on its own. Restate the severity as Medium and the harm as signal quality: a scanner that fires on `const token={` and on its own fixtures trains an operator to assert past it. Keep the finding's file/line evidence and its Fix line; wrap any version literal in backticks.

- [x] **Step 4: Run the tests to verify they pass**

Run: `node evals/run-deterministic.mjs`
Expected: `"results": "all-pass"`.

Then check the scanner against this repository itself, which is the case that started all of this:

```bash
node -e "const{invokeTool}=require('./runtime/tools.mjs')" 2>/dev/null || true
node runtime/cli.mjs start --objective "check the scanner against this repo" --workflow test-only
```

Take the `run_id` that prints, then walk it to a stage where `security.secret_scan` is allowed and invoke it. If walking the gates is more work than the check is worth, instead run the underlying command directly and confirm the file list is empty or contains only allowlisted paths:

```bash
git grep -l -E "(AKIA[0-9A-Z]{16}|BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY|(api[_-]?key|secret|token|password|passwd)[\"']?[[:space:]]*[:=][[:space:]]*[\"']?[A-Za-z0-9_./+-]{8,})"
```

Expected: only `evals/alpha6-runtime.mjs` and `evals/run-deterministic.mjs`, both covered by the `evals/**` allowlist, so the tool reports PASS. Record the actual file list.

Run: `node scripts/test-mcp.mjs`
Expected: `"results": "all-pass"` — `agent_sdlc_tool_run` returns this document.

Run: `node scripts/validate-versions.mjs`
Expected: `"status": "PASS"` — the spec edit must not introduce a bare version literal.

- [x] **Step 5: Commit**

```bash
git add policies/security-policy.json runtime/tools.mjs docs/superpowers/specs/2026-08-27-harness-spike-findings.md evals/run-deterministic.mjs evals/DETERMINISTIC-VALIDATION.json
git commit -m "fix(security): value-shaped secret patterns and a policy allowlist"
```

---

### Task 3: Route the task-engine verification path through the launcher (F15)

**Files:**
- Modify: `runtime/task-verification.mjs` — `plannedCommands()` (around line 34) and the command loop inside the verification runner (around line 82)
- Test: `evals/task-runtime.mjs` (the suite `scripts/validate-task-engine.mjs` aggregates)

**Interfaces:**
- Consumes: `resolveLaunch` and `describeSpawn` from `runtime/launcher.mjs`; the `secret_scan.patterns` array Task 2 added to `policies/security-policy.json`.
- Produces: `plannedCommands(projectRoot,task,strategy,{root})` gains an options argument carrying `root` so it can read the policy patterns, and each returned entry may now carry `unsatisfied_selector:true`. Executed entries may carry `reason`.

This is spec finding F15. `plannedCommands` reads the same `.agent-sdlc/project.json` command arrays the tool gateway reads and passes them VERBATIM to a bare `spawnSync(c.command[0],c.command.slice(1),…)`. So on this path all three of the previous plan's findings are still live:

- `npm` is `npm.cmd` on Windows, so every configured test and build command is ENOENT (F9).
- `r.status??1` turns that ENOENT into `exit_code:1` and `allPassed=false`, i.e. "the tests failed" (F10).
- The literal string `{selector}` is handed to the test runner, because nothing substitutes it (F11's mechanism).

The selector source here is the task's own `task.verification.targeted_tests` array. Substituting it as a single space-joined string would be wrong — the runner would receive one argument `"a b c"` — so the `{selector}` element is SPLICED, one argv element per targeted test.

A task whose `test_targeted` template needs a selector but which declares no `targeted_tests` must NOT silently skip its targeted verification: that is how a task reaches DONE without having run anything. It is recorded as an unexecuted command with a reason, which fails the verification record.

- [x] **Step 1: Write the failing tests**

The cases go in `evals/task-runtime.mjs`, not in `scripts/validate-task-engine.mjs` — the latter is a report aggregator that calls `runTaskRuntimeSuite(root)` and writes evidence files; the cases live in the suite. Add them inside the existing `verification_review` block, the one that opens `{ const t=group('verification_review');`. That block's idiom is `t('name',()=>{ … if(bad)fail('message'); })` — there is no `assert`; `fail(m)` throws. Available fixtures in that file: `makeFixture(opts)`, `runAtImplement(root,projectRoot)`, `startTask`, `writeInWorkspace`, `advanceTask`, `requireTask`.

First extend the fixture so a case can choose the command config. In `evals/task-runtime.mjs`, change `makeFixture`'s signature and its `commands` block:

```javascript
export function makeFixture({failingTests=false}={}){
```

becomes

```javascript
export function makeFixture({failingTests=false,commands=null}={}){
```

and inside its `initProject(d,{...})` call, replace the `commands:{…}` object with:

```javascript
    commands:commands||{
      test_targeted:['node','-e',failingTests?'process.exit(1)':'process.exit(0)'],
      test_full:['node','-e','process.exit(0)'],
      build:['node','-e','process.exit(0)']
    },
```

Add `plannedCommands` to that file's existing import from `../runtime/task-verification.mjs`, which currently reads `import {verifyTask,scopeAudit,verificationStrategy} from '../runtime/task-verification.mjs';`.

Then add these cases:

```javascript
    // F15: this module reads the same project command config the tool gateway
    // does and used to hand it straight to spawnSync -- so `npm` was ENOENT on
    // Windows, that ENOENT read as "the tests failed", and the literal string
    // "{selector}" reached the test runner.
    const SELECTOR_CMDS={
      test_targeted:['node','-e','if(!process.argv[1])process.exit(3);console.log("ran "+process.argv.slice(1).join(","));','{selector}'],
      test_full:['node','-e','process.exit(0)'],
      build:['node','-e','process.exit(0)']
    };

    t('planned-commands-splices-the-task-targeted-tests',()=>{
      const projectRoot=makeFixture({commands:SELECTOR_CMDS});
      const task={task_id:'TASK-001',verification:{targeted_tests:['tests/a.test.js','tests/b.test.js']}};
      const cmds=plannedCommands(projectRoot,task,'TARGETED',{root});
      const targeted=cmds.find(c=>c.kind==='test_targeted');
      if(!targeted)fail('no test_targeted command planned');
      if(targeted.command.some(x=>String(x).includes('{selector}')))fail(`placeholder survived: ${JSON.stringify(targeted.command)}`);
      if(!targeted.command.includes('tests/a.test.js')||!targeted.command.includes('tests/b.test.js'))fail(JSON.stringify(targeted.command));
      if(targeted.unsatisfied_selector)fail('a task with targeted_tests must not be marked unsatisfied');
    });

    t('planned-commands-refuses-a-selector-template-with-no-targeted-tests',()=>{
      const projectRoot=makeFixture({commands:SELECTOR_CMDS});
      const cmds=plannedCommands(projectRoot,{task_id:'TASK-002',verification:{targeted_tests:[]}},'TARGETED',{root});
      const targeted=cmds.find(c=>c.kind==='test_targeted');
      if(!targeted)fail('the command must still be planned, so the refusal is visible');
      if(targeted.unsatisfied_selector!==true)fail('must be marked unsatisfied rather than silently skipped');
    });

    t('planned-commands-leaves-a-selectorless-template-alone',()=>{
      const projectRoot=makeFixture({commands:SELECTOR_CMDS});
      const cmds=plannedCommands(projectRoot,{task_id:'TASK-003',verification:{targeted_tests:[]}},'BROAD_SUITE',{root});
      const full=cmds.find(c=>c.kind==='test_full');
      if(!full)fail('no test_full command planned');
      if(full.unsatisfied_selector)fail('test_full has no {selector} and must not be marked unsatisfied');
    });

    t('task-verification-reports-an-unstartable-command-as-error',()=>{
      // Not "the tests failed". The previous behaviour was exit_code 1 with an
      // empty summary and no artifact, indistinguishable from a real failure.
      const projectRoot=makeFixture({commands:{
        test_targeted:['definitely-not-a-real-binary-9f3','{selector}'],
        test_full:['node','-e','process.exit(0)'],
        build:['node','-e','process.exit(0)']
      }});
      const {run}=runAtImplement(root,projectRoot);
      startTask(root,projectRoot,run,'TASK-001',{writer:'writer-a'});
      writeInWorkspace(projectRoot,run,'TASK-001','src/auth/token-store.js','export const store=new Map();\n// touched\n');
      const out=advanceTask(root,projectRoot,run,'TASK-001');
      if(out.advanced)fail('advanced despite a command that never started');
      const executed=(out.verification?.executed||[]).find(e=>e.kind==='test_targeted');
      if(!executed)fail(`no test_targeted entry recorded: ${JSON.stringify(out.verification?.executed)}`);
      if(executed.reason!=='TOOL_NOT_EXECUTABLE')fail(`expected TOOL_NOT_EXECUTABLE, got ${JSON.stringify(executed)}`);
      if(executed.exit_code!==null)fail(JSON.stringify(executed));
      if(out.verification?.status==='PASS')fail('an unstartable command must not verify a task');
    });
```

The fourth case relies on the fixture's `TASK-001` declaring `verification.targeted_tests` — the file's `TASK()` factory already sets `verification:{targeted_tests:['tests/auth/token-store.test.js'],…}`, so the selector is satisfied and the failure under test is the launch, not the selector. Confirm that before running, and if the factory has drifted, pass the targeted test explicitly rather than changing the factory.

- [x] **Step 2: Run the tests to verify they fail**

Run: `node scripts/validate-task-engine.mjs`
Expected: `planned-commands-splices-the-task-targeted-tests` FAILs with `placeholder survived: ["npm","test","--","{selector}"]`, and `planned-commands-refuses-a-selector-template-with-no-targeted-tests` FAILs because nothing sets the flag. On Windows `task-verification-reports-an-unstartable-command-as-error` FAILs reporting `exit_code:1` with no `reason`.

- [x] **Step 3: Write the implementation**

In `runtime/task-verification.mjs`, add to the imports at the top:

```javascript
import {resolveLaunch,describeSpawn} from './launcher.mjs';
```

Replace `plannedCommands`:

```javascript
/** Which project commands a strategy runs, in order. */
export function plannedCommands(projectRoot,task,strategy){
  const cfg=readJson(path.join(projectRoot,'.agent-sdlc','project.json'),{});
  const out=[];
  const targeted=arr(cfg.commands?.test_targeted);
  const full=arr(cfg.commands?.test_full);
  const build=arr(cfg.commands?.build);
  if(targeted.length)out.push({kind:'test_targeted',command:targeted});
  if(strategy!=='TARGETED'&&build.length)out.push({kind:'build',command:build});
  if(strategy==='BROAD_SUITE'&&full.length)out.push({kind:'test_full',command:full});
  if((task.risk?.security==='HIGH'||arr(task.scope?.interfaces).length)&&strategy!=='TARGETED'){
    out.push({kind:'security_secret_scan',command:['git','grep','-l','-E','(AKIA[0-9A-Z]{16}|BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY)']});
  }
  return out;
}
```

with:

```javascript
/**
 * `{selector}` is spliced, not joined: one argv element per targeted test, so a
 * runner receives N paths rather than one argument containing spaces. A template
 * that asks for a selector when the task declares no targeted tests is marked
 * `unsatisfied_selector` rather than run with the placeholder or quietly
 * dropped -- a task must not reach DONE because its verification was skipped.
 */
function substituteSelector(command,selectors){
  if(!command.some(x=>String(x).includes('{selector}')))return {command,unsatisfied_selector:false};
  if(!selectors.length)return {command,unsatisfied_selector:true};
  const out=[];
  for(const el of command){
    const s=String(el);
    if(s==='{selector}'){out.push(...selectors);continue;}
    if(s.includes('{selector}')){out.push(...selectors.map(v=>s.replaceAll('{selector}',v)));continue;}
    out.push(s);
  }
  return {command:out,unsatisfied_selector:false};
}

/** Which project commands a strategy runs, in order. */
export function plannedCommands(projectRoot,task,strategy,{root=null}={}){
  const cfg=readJson(path.join(projectRoot,'.agent-sdlc','project.json'),{});
  const out=[];
  const selectors=arr(task.verification?.targeted_tests).map(String);
  const push=(kind,command)=>{
    if(!command.length)return;
    out.push({kind,...substituteSelector(command,selectors)});
  };
  push('test_targeted',arr(cfg.commands?.test_targeted));
  if(strategy!=='TARGETED')push('build',arr(cfg.commands?.build));
  if(strategy==='BROAD_SUITE')push('test_full',arr(cfg.commands?.test_full));
  if((task.risk?.security==='HIGH'||arr(task.scope?.interfaces).length)&&strategy!=='TARGETED'){
    // Patterns come from the same policy the tool gateway's scanner reads, so
    // the two cannot drift apart. This path stays narrow on purpose: it is a
    // per-task check, not the repository-wide scan.
    const declared=root?(readJson(path.join(root,'policies','security-policy.json'),{}).secret_scan?.patterns||[]):[];
    const regexes=declared.map(p=>p.regex).filter(Boolean);
    const pattern=regexes.length?`(${regexes.join('|')})`:'(AKIA[0-9A-Z]{16}|BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY)';
    out.push({kind:'security_secret_scan',command:['git','grep','-l','-E',pattern],unsatisfied_selector:false});
  }
  return out;
}
```

Then the command loop. Replace this block:

```javascript
  for(const c of planned){
    if(dryRun){executed.push({...c,exit_code:null,duration_ms:0,log_ref:null,summary:'DRY_RUN'});continue;}
    const start=Date.now();
    const r=spawnSync(c.command[0],c.command.slice(1),{cwd,encoding:'utf8',timeout:timeoutMs,maxBuffer:20*1024*1024});
    const raw=(r.stdout||'')+(r.stderr||'');
```

with:

```javascript
  for(const c of planned){
    if(dryRun){executed.push({...c,exit_code:null,duration_ms:0,log_ref:null,summary:'DRY_RUN'});continue;}
    // A template that wanted a selector the task never declared: refused, not
    // run with the placeholder and not silently dropped.
    if(c.unsatisfied_selector){
      allPassed=false;
      executed.push({kind:c.kind,command:c.command,exit_code:null,reason:'SELECTOR_REQUIRED_BUT_TASK_DECLARES_NO_TARGETED_TESTS',duration_ms:0,log_ref:null,summary:null});
      continue;
    }
    const start=Date.now();
    // Same resolution the tool gateway uses: `npm` is npm.cmd on Windows, and a
    // command that never started is not a test that failed.
    const launch=resolveLaunch(c.command);
    if(launch.status!=='OK'){
      allPassed=false;
      executed.push({kind:c.kind,command:c.command,exit_code:null,reason:launch.reason,duration_ms:Date.now()-start,log_ref:null,
        summary:`${launch.reason}: cannot launch ${c.command.join(' ')}`});
      continue;
    }
    const r=spawnSync(launch.bin,launch.args,{cwd,encoding:'utf8',timeout:timeoutMs,maxBuffer:20*1024*1024,...launch.spawnOptions});
    const spawned=describeSpawn(r);
    if(spawned.status==='ERROR'){
      allPassed=false;
      const detail=(r.stdout||'')+(r.stderr||'');
      executed.push({kind:c.kind,command:c.command,exit_code:null,reason:spawned.reason,duration_ms:Date.now()-start,log_ref:null,
        summary:`${spawned.reason}: ${c.command.join(' ')}${spawned.signal?` (killed by ${spawned.signal})`:''}${detail?`\n${truncateUtf8(detail,4000).text}`:''}`});
      continue;
    }
    const raw=(r.stdout||'')+(r.stderr||'');
```

The rest of the loop — the `security_secret_scan` exit remapping, the truncation, the artifact, the `allPassed` update and the `executed.push` — stays exactly as it is. Read it before editing and leave every line you are not replacing untouched.

The runner calls `plannedCommands` somewhere above this loop; find that call and pass the root through so the secret-scan patterns resolve — grep for `plannedCommands(` in `runtime/task-verification.mjs` and in `runtime/` generally, and update every call site to pass `{root}` where a root is in scope. If a call site has no root available, leave it as `plannedCommands(projectRoot,task,strategy)` — the default keeps the narrow built-in pattern, which is the documented fallback.

- [x] **Step 4: Run the tests to verify they pass**

Run: `node scripts/validate-task-engine.mjs`
Expected: `"results": "all-pass"`.

Run: `node scripts/validate-alpha6.mjs`
Expected: `"results": "all-pass"` — it drives the task runtime.

Run: `node evals/run-deterministic.mjs`
Expected: `"results": "all-pass"`.

Then prove F15 is really closed on Windows, which is the point of the task. Generate a real config and inspect what the module now plans:

```bash
node runtime/cli.mjs init
node -e "const{plannedCommands}=await import('./runtime/task-verification.mjs');console.log(JSON.stringify(plannedCommands(process.cwd(),{task_id:'T',verification:{targeted_tests:['scripts/validate-cli-surface.mjs']}},'TARGETED',{root:process.cwd()}),null,1))" --input-type=module
```

Expected: the `test_targeted` command with `{selector}` replaced by `scripts/validate-cli-surface.mjs` and no placeholder anywhere. Record the actual output. If that inline `node -e` form fights the shell, write the two lines to a temporary `.mjs` file under the SDD workspace, run it, and delete it.

- [x] **Step 5: Commit**

```bash
git add runtime/task-verification.mjs scripts/validate-task-engine.mjs evals/TASK-ENGINE-VALIDATION.json
git commit -m "fix(task-verification): route the second execution path through the launcher"
```

---

### Task 4: Full gate

**Files:**
- Modify: report files under `evals/` only

**Interfaces:**
- Consumes: everything from Tasks 1-3.
- Produces: a green `npm run check` with the floor unchanged at 90.

- [x] **Step 1: Run the whole gate**

Run: `npm run check`
Expected: exit 0. This is a chain of about 25 suites and the coverage step re-runs 16 of them under `NODE_V8_COVERAGE`, so expect many minutes. Do not kill it early.

- [x] **Step 2: Confirm the coverage floor is untouched**

Run: `node scripts/coverage-report.mjs`
Expected: `"status": "PASS"`. Read `overall_percent` and record it.

Do NOT run `--update`. The floor stays at 90 by decision: the last measurement above it was taken on Windows, and CI also measures on ubuntu where several cases record SKIP. Confirm `evals/COVERAGE-FLOOR.json` still reads `overall_percent: 90` with `never_loaded: []`.

- [x] **Step 3: Commit the reports**

```bash
git add evals/
git commit -m "chore(evals): record the reports for the gate-signal fixes"
```

---

## What this plan deliberately does not do

- **Does not make the secret scanner gate anything.** `no_new_high_security_findings` is operator-assertable by design and stays that way; this plan only makes the signal the operator reads worth reading.
- **Does not widen the task-engine's per-task secret scan** into the repository-wide scan. It stays narrow — it is a per-task check — and now shares its patterns with the gateway's scanner rather than carrying a second copy.
- **Does not touch F2 (router scoring) or F3-F8, F13, F14** — those belong to the two other plans named in the spec.
