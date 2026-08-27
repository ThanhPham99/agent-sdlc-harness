# Execution Path Correctness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the harness's own command execution path work and tell the truth on every supported platform — so `test.run_targeted`, `test.run_full`, `build.run` and `bin/agent-sdlc` actually run on Windows, and a spawn that never started is never reported as a failing test or as a passing gate.

**Architecture:** One new module, `runtime/launcher.mjs`, owns two decisions that were previously split between a partial implementation in `runtime/provider.mjs` and none at all in `runtime/tools.mjs`: how an argv becomes something `spawnSync` can start (script hosts, Windows `.cmd`/`.bat` shims, direct binaries), and what a `spawnSync` result means before any exit code is read as a verdict. Both existing call sites delegate to it. The tool gateway then gains a third status class, `ERROR`, which is neither PASS nor FAIL, so ENOENT and wall-clock kills stop being laundered into test failures; and an unsubstituted `{selector}` is refused before a spawn rather than producing a silent exit-0 PASS that satisfies the VERIFY gate.

**Tech Stack:** Node.js ESM (`.mjs`), zero runtime dependencies. Hand-rolled suites via `scripts/lib/suite.mjs`. `node:child_process.spawnSync` only — never `shell:true`.

**Spec:** `docs/superpowers/specs/2026-08-27-harness-spike-findings.md` (findings F1, F9, F10, F11)

## Global Constraints

- Node `>=18` (`package.json` engines, `docs/INSTALLATION.md`). No syntax or API newer than Node 18.
- Zero runtime dependencies. `package.json` has no `dependencies` block and must not gain one.
- All runtime code is ESM `.mjs` using `import`, never `require`.
- Never use `spawnSync(..., {shell:true})`. Node refuses to spawn `.cmd`/`.bat` directly since CVE-2024-27980, and `shell:true` would hand model-supplied strings to the command processor. Build the command line explicitly instead.
- The CLI prints JSON or the help text on stdout and nothing else. A failure exits non-zero with `{status:'ERROR',error}`.
- Gate evidence is granted only by `recordEvidence` when `status==='PASS'` (`runtime/evidence.mjs:8-22`). Any new status must therefore be a non-`PASS` string.
- Every offline suite reachable from `npm run check` must also be run by `.github/workflows/ci.yml`; `scripts/validate-ci-coverage.mjs` enforces membership **and order**. Adding a new npm script means updating `check` and both CI jobs.
- `scripts/coverage-report.mjs` has an `ENTRIES` list and a `NOT_MEASURED` map; every suite must appear in exactly one of them, and `evals/COVERAGE-FLOOR.json` (`overall_percent: 90`) must not drop.
- `npm run check` rewrites tracked report files under `evals/`. Commit those with the task that caused them, or `git checkout -- evals/` when the content is unchanged noise.
- Do not add a test asserting "a PASS must have non-empty output". Silent success is legitimate: the deterministic fixture's own commands are `node -e process.exit(0)`.

---

### Task 1: The shared launcher

**Files:**
- Create: `runtime/launcher.mjs`
- Test: `scripts/test-provider.mjs` (append a section; that suite already owns spawn bounds and has `createSuite` plus a `fakeSpawn` helper)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces, all used by Tasks 2, 3 and 5:
  - `resolveOnPath(bin, {env, platform}) -> string|null` — absolute path of the first file on `PATH` matching `bin`, trying each `PATHEXT` extension on win32; `null` when nothing matches.
  - `resolveLaunch(argv, {env, platform}) -> {status, reason, bin, args, via, spawnOptions, detail}` — `status` is `'OK'` or `'UNLAUNCHABLE'`. On `'OK'`, `bin` and `args` are what to hand `spawnSync` and `spawnOptions` is an object to spread into its options. On `'UNLAUNCHABLE'`, `reason` is `'EMPTY_ARGV'`, `'TOOL_NOT_EXECUTABLE'` or `'ARGUMENT_NOT_SHELL_SAFE'` and `detail` names the offending argument. `via` is `'node'`, `'cmd'` or `'direct'`.
  - `describeSpawn(result) -> {status, reason, exit_code, signal}` — `status` is `'PASS'`, `'FAIL'` or `'ERROR'`; `reason` is `null` for PASS/FAIL and `'TOOL_NOT_EXECUTABLE'`, `'TIMEOUT'` or `'SPAWN_<CODE>'` for ERROR.

- [ ] **Step 1: Write the failing tests**

Add the import at the top of `scripts/test-provider.mjs`, next to the existing `../runtime/provider.mjs` import:

```javascript
import {resolveLaunch,resolveOnPath,describeSpawn} from '../runtime/launcher.mjs';
```

Then append this section after the existing sections and before the `finish(...)` call at the end of the file:

```javascript
// --- shared launcher -------------------------------------------------------
// runtime/tools.mjs used to spawn the project's configured command directly.
// `init` writes ["npm","test"] for every node project and npm is npm.cmd on
// Windows, so every test and build the gateway ran died there with ENOENT.

const WIN={platform:'win32',env:{PATH:'C:\\bin',PATHEXT:'.COM;.EXE;.BAT;.CMD',ComSpec:'C:\\Windows\\System32\\cmd.exe'}};
const NIX={platform:'linux',env:{PATH:'/usr/bin'}};

test('launcher-script-host-runs-under-node',()=>{
  const l=resolveLaunch(['runtime/cli.mjs','doctor'],NIX);
  assert(l.status==='OK','expected OK');
  assert(l.bin===process.execPath,`expected node, got ${l.bin}`);
  assert(l.args[0]==='runtime/cli.mjs'&&l.args[1]==='doctor',JSON.stringify(l.args));
  assert(l.via==='node',l.via);
});

test('launcher-empty-argv-is-unlaunchable',()=>{
  const l=resolveLaunch([],NIX);
  assert(l.status==='UNLAUNCHABLE'&&l.reason==='EMPTY_ARGV',JSON.stringify(l));
});

test('launcher-posix-unresolved-passes-through',()=>{
  // On POSIX the spawn itself reports ENOENT accurately, so an unresolved name
  // is still attempted rather than pre-judged.
  const l=resolveLaunch(['definitely-not-on-path','x'],NIX);
  assert(l.status==='OK'&&l.bin==='definitely-not-on-path',JSON.stringify(l));
  assert(l.via==='direct',l.via);
});

test('launcher-windows-unresolved-is-tool-not-executable',()=>{
  const l=resolveLaunch(['definitely-not-on-path'],WIN);
  assert(l.status==='UNLAUNCHABLE'&&l.reason==='TOOL_NOT_EXECUTABLE',JSON.stringify(l));
});

test('launcher-windows-cmd-shim-goes-through-comspec',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'agent-sdlc-launch-'));
  fs.writeFileSync(path.join(dir,'npm.cmd'),'@echo off\n');
  const env={...WIN.env,PATH:dir};
  const l=resolveLaunch(['npm','test'],{platform:'win32',env});
  fs.rmSync(dir,{recursive:true,force:true});
  assert(l.status==='OK',JSON.stringify(l));
  assert(l.bin===env.ComSpec,l.bin);
  assert(l.args[0]==='/d'&&l.args[1]==='/s'&&l.args[2]==='/c',JSON.stringify(l.args));
  // cmd.exe with /s /c strips one outer quote pair from the whole remainder, so
  // the line itself has to be wrapped in a second pair or the first token loses
  // its quoting and a path with a space breaks.
  assert(l.args[3].startsWith('""')&&l.args[3].endsWith('""'),l.args[3]);
  assert(l.args[3].includes('npm.cmd')&&l.args[3].includes('"test"'),l.args[3]);
  assert(l.spawnOptions.windowsVerbatimArguments===true,JSON.stringify(l.spawnOptions));
  assert(l.via==='cmd',l.via);
});

test('launcher-windows-shim-rejects-cmd-metacharacters',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'agent-sdlc-launch-'));
  fs.writeFileSync(path.join(dir,'npm.cmd'),'@echo off\n');
  const l=resolveLaunch(['npm','test','--','a&calc.exe'],{platform:'win32',env:{...WIN.env,PATH:dir}});
  fs.rmSync(dir,{recursive:true,force:true});
  assert(l.status==='UNLAUNCHABLE'&&l.reason==='ARGUMENT_NOT_SHELL_SAFE',JSON.stringify(l));
  assert(l.detail==='a&calc.exe',String(l.detail));
});

test('launcher-resolve-on-path-tries-pathext',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'agent-sdlc-launch-'));
  fs.writeFileSync(path.join(dir,'thing.CMD'),'@echo off\n');
  const got=resolveOnPath('thing',{platform:'win32',env:{PATH:dir,PATHEXT:'.EXE;.CMD'}});
  fs.rmSync(dir,{recursive:true,force:true});
  assert(got&&got.toLowerCase().endsWith('thing.cmd'),String(got));
});

test('describe-spawn-enoent-is-error-not-fail',()=>{
  const d=describeSpawn({status:null,signal:null,error:{code:'ENOENT'},stdout:'',stderr:''});
  assert(d.status==='ERROR'&&d.reason==='TOOL_NOT_EXECUTABLE',JSON.stringify(d));
  assert(d.exit_code===null,JSON.stringify(d));
});

test('describe-spawn-timeout-is-error-not-fail',()=>{
  const d=describeSpawn({status:null,signal:'SIGTERM',error:{code:'ETIMEDOUT'},stdout:'',stderr:''});
  assert(d.status==='ERROR'&&d.reason==='TIMEOUT'&&d.signal==='SIGTERM',JSON.stringify(d));
});

test('describe-spawn-kill-without-errno-is-timeout',()=>{
  const d=describeSpawn({status:null,signal:'SIGKILL',stdout:'',stderr:''});
  assert(d.status==='ERROR'&&d.reason==='TIMEOUT',JSON.stringify(d));
});

test('describe-spawn-real-exit-codes-are-verdicts',()=>{
  const ok=describeSpawn({status:0,signal:null,stdout:'',stderr:''});
  const bad=describeSpawn({status:3,signal:null,stdout:'',stderr:''});
  assert(ok.status==='PASS'&&ok.exit_code===0&&ok.reason===null,JSON.stringify(ok));
  assert(bad.status==='FAIL'&&bad.exit_code===3,JSON.stringify(bad));
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node scripts/test-provider.mjs`
Expected: the process fails before any case runs, with `Cannot find module ... runtime/launcher.mjs`.

- [ ] **Step 3: Write the implementation**

Create `runtime/launcher.mjs`:

```javascript
// How an argv becomes something spawnSync can actually start, and what a failed
// spawn means.
//
// Two call sites needed this and neither had all of it. runtime/provider.mjs
// knew a `.mjs` host has to run under process.execPath; runtime/tools.mjs knew
// nothing, so ["npm","test"] -- the command `init` writes for every node
// project -- died with ENOENT on Windows, where npm is npm.cmd. And a spawn that
// never started returned {status:null,stdout:null}, which the caller read as
// "the tests failed with no output".
//
// Node refuses to spawn .cmd/.bat directly (CVE-2024-27980), so a shim has to go
// through the command processor. The command line is built explicitly rather
// than by handing `shell:true` a model-supplied selector.
import fs from 'node:fs';
import path from 'node:path';

const SCRIPT_HOST=/\.(mjs|cjs|js)$/i;
const WINDOWS_SHIM=/\.(cmd|bat)$/i;
// Characters cmd.exe interprets rather than passes through. An argument holding
// one is refused; quoting correctly for every cmd.exe parsing mode is not
// something to be clever about on a path that carries model-supplied input.
const CMD_METACHARACTERS=/[&|<>^"%!\r\n]/;

/**
 * The first file on PATH that `bin` names, trying each PATHEXT extension on
 * win32. Absolute and relative paths are checked directly. null when nothing
 * matches; the caller decides whether that is fatal.
 */
export function resolveOnPath(bin,{env=process.env,platform=process.platform}={}){
  const raw=String(bin||'');
  if(!raw)return null;
  const exts=platform==='win32'
    ?String(env.PATHEXT||'.COM;.EXE;.BAT;.CMD').split(';').map(e=>e.trim()).filter(Boolean)
    :[];
  const candidates=[];
  const push=p=>{candidates.push(p);for(const e of exts)candidates.push(p+e);};
  if(raw.includes('/')||raw.includes('\\'))push(path.resolve(raw));
  else for(const dir of String(env.PATH||env.Path||'').split(path.delimiter).filter(Boolean))push(path.join(dir,raw));
  for(const c of candidates){
    try{if(fs.statSync(c).isFile())return c;}catch{/* next candidate */}
  }
  return null;
}

/**
 * argv -> what to hand spawnSync, or why it cannot be handed anything.
 * `spawnOptions` is always an object so callers can spread it unconditionally.
 */
export function resolveLaunch(argv,{env=process.env,platform=process.platform}={}){
  const list=(argv||[]).map(String);
  if(!list.length)return {status:'UNLAUNCHABLE',reason:'EMPTY_ARGV',bin:null,args:[],via:null,spawnOptions:{},detail:null};
  const [bin,...rest]=list;
  const ok=(b,a,via,spawnOptions={})=>({status:'OK',reason:null,bin:b,args:a,via,spawnOptions,detail:null});
  // A script path needs no PATH lookup, and asking for one would fail on a
  // relative path that is correct against the child's cwd rather than ours.
  if(SCRIPT_HOST.test(bin))return ok(process.execPath,[bin,...rest],'node');
  const resolved=resolveOnPath(bin,{env,platform});
  if(platform==='win32'&&!resolved){
    return {status:'UNLAUNCHABLE',reason:'TOOL_NOT_EXECUTABLE',bin,args:rest,via:null,spawnOptions:{},detail:bin};
  }
  if(resolved&&SCRIPT_HOST.test(resolved))return ok(process.execPath,[resolved,...rest],'node');
  if(resolved&&WINDOWS_SHIM.test(resolved)){
    const offending=[resolved,...rest].find(a=>CMD_METACHARACTERS.test(a));
    if(offending!==undefined){
      return {status:'UNLAUNCHABLE',reason:'ARGUMENT_NOT_SHELL_SAFE',bin,args:rest,via:null,spawnOptions:{},detail:offending};
    }
    // cmd.exe /s /c strips one outer quote pair from the entire remainder, so
    // the whole line is wrapped in a second pair. windowsVerbatimArguments
    // stops libuv from re-quoting what we just quoted.
    const line=[resolved,...rest].map(a=>`"${a}"`).join(' ');
    return ok(env.ComSpec||'cmd.exe',['/d','/s','/c',`"${line}"`],'cmd',{windowsVerbatimArguments:true});
  }
  return ok(resolved||bin,rest,'direct');
}

/**
 * What a spawnSync result means, before any exit code is read as a verdict.
 * ENOENT and a wall-clock kill are not failures of the thing being measured,
 * and reporting them as FAIL discards the only fact that explains them.
 */
export function describeSpawn(result){
  const r=result||{};
  const code=r.error?.code||null;
  if(code==='ENOENT')return {status:'ERROR',reason:'TOOL_NOT_EXECUTABLE',exit_code:null,signal:null};
  if(code==='ETIMEDOUT'||(r.status===null&&r.signal))return {status:'ERROR',reason:'TIMEOUT',exit_code:null,signal:r.signal||null};
  if(code)return {status:'ERROR',reason:`SPAWN_${code}`,exit_code:null,signal:r.signal||null};
  return {status:r.status===0?'PASS':'FAIL',reason:null,exit_code:r.status??1,signal:r.signal||null};
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node scripts/test-provider.mjs`
Expected: `"results": "all-pass"`, `failures: 0`, and `checks` up by 12 from before.

- [ ] **Step 5: Commit**

```bash
git add runtime/launcher.mjs scripts/test-provider.mjs evals/PROVIDER-VALIDATION.json
git commit -m "feat(launcher): one shared spawn resolver and spawn-result reader"
```

---

### Task 2: Route the provider through it

**Files:**
- Modify: `runtime/provider.mjs` — the `launcher()` and `spawnHost()` pair (around lines 44-53)
- Test: `scripts/test-provider.mjs`

**Interfaces:**
- Consumes: `resolveLaunch` from Task 1.
- Produces: no new exported names. `probeBin`, `probe`, `capabilities`, `buildInvocation` and `runHost` keep their current signatures and behaviour; they only gain Windows shim support.

- [ ] **Step 1: Write the failing test**

Append to the launcher section of `scripts/test-provider.mjs`:

```javascript
test('provider-probes-a-windows-shim-host',()=>{
  // A host CLI installed as claude.cmd used to be invisible to the probe on
  // Windows: spawnSync('claude') is ENOENT, so the host reported unavailable.
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'agent-sdlc-shim-'));
  fs.writeFileSync(path.join(dir,'claude.cmd'),'@echo off\n');
  const seen=[];
  const spawn=(bin,args)=>{seen.push({bin,args});return {status:0,stdout:'2.0.0 (Claude Code)',stderr:''};};
  const prev={PATH:process.env.PATH,PATHEXT:process.env.PATHEXT};
  try{
    process.env.PATH=dir;process.env.PATHEXT='.EXE;.CMD';
    resetProbeCache();
    const p=probeBin(['claude'],{spawn});
    assert(p!==null,'shim host was not probed');
    if(process.platform==='win32'){
      assert(/cmd\.exe$/i.test(seen[0].bin),seen[0].bin);
      assert(seen[0].args[0]==='/d',JSON.stringify(seen[0].args));
    }
  }finally{
    process.env.PATH=prev.PATH;
    if(prev.PATHEXT===undefined)delete process.env.PATHEXT;else process.env.PATHEXT=prev.PATHEXT;
    resetProbeCache();
    fs.rmSync(dir,{recursive:true,force:true});
  }
});

test('provider-script-host-still-runs-under-node',()=>{
  const seen=[];
  const spawn=(bin,args)=>{seen.push({bin,args});return {status:0,stdout:'1.0.0',stderr:''};};
  resetProbeCache();
  const p=probeBin(['/opt/hosts/fake-host.mjs'],{spawn});
  assert(p!==null,'script host was not probed');
  assert(seen[0].bin===process.execPath,seen[0].bin);
  assert(seen[0].args[0]==='/opt/hosts/fake-host.mjs',JSON.stringify(seen[0].args));
  resetProbeCache();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node scripts/test-provider.mjs`
Expected: on Windows, `provider-probes-a-windows-shim-host` FAILs with `shim host was not probed`. On POSIX that case passes trivially — the `.cmd` branch is unreachable there — but `provider-script-host-still-runs-under-node` must pass on both platforms; it is the regression fence for the behaviour this task must not break.

- [ ] **Step 3: Write the implementation**

Add to the imports at the top of `runtime/provider.mjs`:

```javascript
import {resolveLaunch} from './launcher.mjs';
```

Replace this pair:

```javascript
function launcher(bin){
  return /\.(mjs|cjs|js)$/i.test(String(bin||''))
    ? {bin:process.execPath,prefix:[String(bin)]}
    : {bin:String(bin),prefix:[]};
}

function spawnHost(spawn,bin,args,opts){
  const l=launcher(bin);
  return spawn(l.bin,[...l.prefix,...args],opts);
}
```

with:

```javascript
// Host resolution moved to runtime/launcher.mjs so the tool gateway gets the
// same rules. This kept the .mjs/.cjs/.js case and gained the one it was
// missing: a host installed as a Windows .cmd shim, which spawnSync refuses to
// start directly and which therefore reported as "host not installed".
function spawnHost(spawn,bin,args,opts){
  const l=resolveLaunch([String(bin),...args]);
  // An unlaunchable candidate is reported the way an unanswered probe already
  // was, so probeBin moves to the next name instead of throwing.
  if(l.status!=='OK')return {status:null,stdout:'',stderr:'',error:{code:'ENOENT'}};
  return spawn(l.bin,l.args,{...opts,...l.spawnOptions});
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node scripts/test-provider.mjs`
Expected: `"results": "all-pass"`.

Then confirm nothing else regressed, because `runHost` and `doctor` share this path:

Run: `node runtime/cli.mjs doctor`
Expected: JSON where the `providers` array still reports the hosts installed on this machine with a non-null `version` — on the development machine, `claude` and `antigravity` available, `codex` not.

- [ ] **Step 5: Commit**

```bash
git add runtime/provider.mjs scripts/test-provider.mjs evals/PROVIDER-VALIDATION.json
git commit -m "fix(provider): resolve host binaries through the shared launcher"
```

---

### Task 3: Stop the gateway laundering spawn failures into test failures

**Files:**
- Modify: `runtime/tools.mjs:10` — the `exec()` helper
- Modify: `runtime/tools.mjs:87-92` — the result assembly at the end of `invokeTool`
- Test: `evals/run-deterministic.mjs`

**Interfaces:**
- Consumes: `resolveLaunch` and `describeSpawn` from Task 1.
- Produces: `invokeTool` results gain a `reason` field (`null` unless `status==='ERROR'`) and a third `status` value, `'ERROR'`, alongside the existing `'PASS'`, `'FAIL'`, `'DENY'` and `'APPROVAL_REQUIRED'`. Task 4 relies on `exec` already returning `status:'ERROR'` for an unlaunchable argv.

- [ ] **Step 1: Write the failing tests**

Add to `evals/run-deterministic.mjs`, immediately after the existing `test('targeted-test-built-in-pass',...)` line:

```javascript
// A spawn that never started is not a test that failed. ENOENT used to arrive
// as {status:'FAIL',exit_code:1,summary:'',full_log_artifact:null} and was
// recorded as targeted_verification_pass:FAIL, so an operator read "the suite
// failed" when the truth was "npm is not spawnable here".
test('gateway-missing-binary-is-error-not-fail',()=>{
  const d=fs.mkdtempSync(path.join(os.tmpdir(),'agent-sdlc-enoent-'));
  execFileSync('git',['init','-q'],{cwd:d});
  initProject(d,{schema:'agent-sdlc/project/v1',project:'enoent',commands:{
    test_targeted:['definitely-not-a-real-binary-9f3','{selector}'],
    test_full:['definitely-not-a-real-binary-9f3'],
    build:['definitely-not-a-real-binary-9f3']
  },providers:{preferred:['claude']}});
  const r=newRun(ROOT,d,{objective:'x',route:route(ROOT,'Add fixture feature')});
  transition(ROOT,d,r,'REQUIREMENTS');
  transition(ROOT,d,r,'DESIGN',{evidence:['requirements_confirmed']});
  transition(ROOT,d,r,'PLAN',{evidence:['design_or_skip_decision'],internal:true});
  transition(ROOT,d,r,'IMPLEMENT',{evidence:planGateEvidence(),internal:true});
  const out=invokeTool(ROOT,d,r,'test.run_targeted',{selector:'anything'});
  if(out.status!=='ERROR')throw Error(`expected ERROR, got ${JSON.stringify(out)}`);
  if(out.reason!=='TOOL_NOT_EXECUTABLE')throw Error(JSON.stringify(out));
  if(out.exit_code!==null)throw Error(JSON.stringify(out));
  if(!out.summary.includes('definitely-not-a-real-binary-9f3'))throw Error(JSON.stringify(out));
  // And it must not grant the gate token.
  if((r.evidence.IMPLEMENT||[]).includes('targeted_verification_pass'))throw Error('ERROR granted evidence');
});

test('gateway-timeout-is-error-not-fail',()=>{
  const d=fs.mkdtempSync(path.join(os.tmpdir(),'agent-sdlc-timeout-'));
  execFileSync('git',['init','-q'],{cwd:d});
  initProject(d,{schema:'agent-sdlc/project/v1',project:'slow',commands:{
    test_targeted:['node','-e','setTimeout(()=>{},60000)'],
    test_full:['node','-e','process.exit(0)'],
    build:['node','-e','process.exit(0)']
  },providers:{preferred:['claude']}});
  const r=newRun(ROOT,d,{objective:'x',route:route(ROOT,'Add fixture feature')});
  transition(ROOT,d,r,'REQUIREMENTS');
  transition(ROOT,d,r,'DESIGN',{evidence:['requirements_confirmed']});
  transition(ROOT,d,r,'PLAN',{evidence:['design_or_skip_decision'],internal:true});
  transition(ROOT,d,r,'IMPLEMENT',{evidence:planGateEvidence(),internal:true});
  const out=invokeTool(ROOT,d,r,'test.run_targeted',{timeout_ms:1200});
  if(out.status!=='ERROR'||out.reason!=='TIMEOUT')throw Error(JSON.stringify(out));
  if(!out.summary.includes('TIMEOUT'))throw Error(JSON.stringify(out));
});

test('gateway-real-failure-keeps-its-log',()=>{
  const d=fs.mkdtempSync(path.join(os.tmpdir(),'agent-sdlc-realfail-'));
  execFileSync('git',['init','-q'],{cwd:d});
  initProject(d,{schema:'agent-sdlc/project/v1',project:'failing',commands:{
    test_targeted:['node','-e','console.log("2 passed, 1 failed");process.exit(1)'],
    test_full:['node','-e','process.exit(0)'],
    build:['node','-e','process.exit(0)']
  },providers:{preferred:['claude']}});
  const r=newRun(ROOT,d,{objective:'x',route:route(ROOT,'Add fixture feature')});
  transition(ROOT,d,r,'REQUIREMENTS');
  transition(ROOT,d,r,'DESIGN',{evidence:['requirements_confirmed']});
  transition(ROOT,d,r,'PLAN',{evidence:['design_or_skip_decision'],internal:true});
  transition(ROOT,d,r,'IMPLEMENT',{evidence:planGateEvidence(),internal:true});
  const out=invokeTool(ROOT,d,r,'test.run_targeted',{});
  if(out.status!=='FAIL'||out.exit_code!==1)throw Error(JSON.stringify(out));
  if(!out.summary.includes('2 passed, 1 failed'))throw Error(JSON.stringify(out));
  if(!out.full_log_artifact)throw Error('a real failure must keep its full log');
  if(out.reason!==null)throw Error(JSON.stringify(out));
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node evals/run-deterministic.mjs`
Expected: FAIL rows for `gateway-missing-binary-is-error-not-fail` (`expected ERROR, got {"status":"FAIL"...}`) and `gateway-timeout-is-error-not-fail`. `gateway-real-failure-keeps-its-log` should already pass — it fences the behaviour that must survive.

- [ ] **Step 3: Write the implementation**

Add to the imports at the top of `runtime/tools.mjs`:

```javascript
import {resolveLaunch,describeSpawn} from './launcher.mjs';
```

Replace `exec()`:

```javascript
function exec(argv,cwd,timeout,maxBytes){const r=spawnSync(argv[0],argv.slice(1),{cwd,encoding:'utf8',timeout,maxBuffer:20*1024*1024});const raw=(r.stdout||'')+(r.stderr||'');const t=truncateUtf8(raw,maxBytes);return {status:(r.status===0?'PASS':'FAIL'),exit_code:r.status??1,summary:t.text,truncated:t.truncated,raw};}
```

with:

```javascript
// A command the harness was told to run, resolved the same way host binaries
// are, and a result that distinguishes "it ran and failed" from "it never ran".
function exec(argv,cwd,timeout,maxBytes){
  const launch=resolveLaunch(argv);
  if(launch.status!=='OK'){
    const detail=launch.detail?` (${launch.detail})`:'';
    return {status:'ERROR',reason:launch.reason,exit_code:null,
      summary:`${launch.reason}${detail}: cannot launch ${argv.join(' ')}`,
      truncated:false,raw:''};
  }
  const r=spawnSync(launch.bin,launch.args,{cwd,encoding:'utf8',timeout,maxBuffer:20*1024*1024,...launch.spawnOptions});
  const d=describeSpawn(r);
  const raw=(r.stdout||'')+(r.stderr||'');
  const t=truncateUtf8(raw,maxBytes);
  // On ERROR the child's own output is usually empty and the errno is the only
  // fact there is, so it leads the summary instead of being dropped.
  const summary=d.status==='ERROR'
    ? [`${d.reason}: ${argv.join(' ')}`,d.signal?`killed by ${d.signal}`:null,t.text||null].filter(Boolean).join('\n')
    : t.text;
  return {status:d.status,reason:d.reason,exit_code:d.exit_code,summary,truncated:t.truncated,raw};
}
```

In `invokeTool`, replace the artifact line:

```javascript
  let full=null;if((result.truncated||result.status==='FAIL')&&result.raw){const a=putArtifact(projectRoot,{kind:'tool-log',content:result.raw,runId:run.run_id,stage:run.state,filename:`${tool}.log`});full=a.artifact_id;}
```

with:

```javascript
  // Anything that is not a clean pass is worth keeping the raw log for, ERROR
  // included; the previous condition named FAIL only.
  let full=null;if((result.truncated||result.status!=='PASS')&&result.raw){const a=putArtifact(projectRoot,{kind:'tool-log',content:result.raw,runId:run.run_id,stage:run.state,filename:`${tool}.log`});full=a.artifact_id;}
```

and replace the `const out={...}` line:

```javascript
  const out={tool,status:result.status,exit_code:result.exit_code,summary:result.summary,failures:[],full_log_artifact:full,truncated:result.truncated};emit(projectRoot,run,{type:'tool.completed',payload:{tool,status:out.status,exit_code:out.exit_code,truncated:out.truncated},artifact_refs:full?[full]:[]});return out;
```

with:

```javascript
  const out={tool,status:result.status,reason:result.reason??null,exit_code:result.exit_code,summary:result.summary,failures:[],full_log_artifact:full,truncated:result.truncated};emit(projectRoot,run,{type:'tool.completed',payload:{tool,status:out.status,reason:out.reason,exit_code:out.exit_code,truncated:out.truncated},artifact_refs:full?[full]:[]});return out;
```

The built-in branches (`input.normalize`, `repo.read`, `web.search`, …) build their own `result` objects without a `reason` key; `result.reason??null` is why none of them needs an edit.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node evals/run-deterministic.mjs`
Expected: `"results": "all-pass"`.

Run: `node scripts/test-mcp.mjs`
Expected: `"results": "all-pass"` — `agent_sdlc_tool_run` returns this document over MCP, so the added field must not break the transport contract.

- [ ] **Step 5: Commit**

```bash
git add runtime/tools.mjs evals/run-deterministic.mjs evals/DETERMINISTIC-VALIDATION.json
git commit -m "fix(tools): report an unstartable or killed command as ERROR, not as a failing test"
```

---

### Task 4: Refuse an unsubstituted selector, and read `--selector`

**Files:**
- Modify: `runtime/tools.mjs` — `projectCommand()` (line ~43)
- Modify: `runtime/commands/tools.mjs:17-23` — the `tool-run` handler
- Modify: `evals/run-deterministic.mjs` — the `fixture()` command template, so selector substitution becomes observable
- Test: `evals/run-deterministic.mjs`, `scripts/test-cli-contract.mjs`

**Interfaces:**
- Consumes: the `status:'ERROR'` contract from Task 3.
- Produces: `projectCommand` throws `Error` with message `project command <key> requires a selector; none was provided` when the template contains `{selector}` and the selector is missing or blank. `tool-run` accepts `--selector <value>` and `--timeout-ms <n>` as sugar for the same keys inside `--args`; an explicit `--args` value wins on conflict.

- [ ] **Step 1: Write the failing tests**

First change the shared fixture in `evals/run-deterministic.mjs` so the selector reaches the child at all. Replace the `commands:` object inside `fixture()`:

```javascript
commands:{test_targeted:['node','-e','process.exit(0)'],test_full:['node','-e','process.exit(0)'],build:['node','-e','process.exit(0)']},
```

with:

```javascript
// test_targeted takes the selector, so a case can observe that it was really
// substituted. The old template ignored it, which is why an empty selector
// producing `node ''` -- exit 0, no output, recorded as
// targeted_verification_pass -- went unnoticed.
commands:{test_targeted:['node','-e','if(!process.argv[1])process.exit(3);console.log("ran "+process.argv[1]);','{selector}'],test_full:['node','-e','process.exit(0)'],build:['node','-e','process.exit(0)']},
```

Then add these cases beside the other gateway cases in `evals/run-deterministic.mjs`:

```javascript
test('targeted-test-substitutes-the-selector',()=>{
  const out=invokeTool(ROOT,tmp,toolRun,'test.run_targeted',{selector:'tests/refund.test.js'});
  if(out.status!=='PASS')throw Error(JSON.stringify(out));
  if(!out.summary.includes('ran tests/refund.test.js'))throw Error(JSON.stringify(out));
});

// A missing selector used to substitute the empty string, so the gateway ran
// `node ''`, got exit 0 with no output, and recorded targeted_verification_pass.
// A flag typo was enough to satisfy the VERIFY gate.
test('targeted-test-refuses-an-empty-selector',()=>{
  for(const args of [{},{selector:''},{selector:'   '}]){
    let message=null;
    try{invokeTool(ROOT,tmp,toolRun,'test.run_targeted',args);}catch(e){message=e.message;}
    if(!message||!/requires a selector/.test(message))throw Error(`selector ${JSON.stringify(args)} accepted: ${message}`);
  }
});

test('selectorless-command-is-unaffected',()=>{
  // build has no {selector} in its template, so it must not start demanding one.
  const out=invokeTool(ROOT,tmp,toolRun,'build.run',{});
  if(out.status!=='PASS')throw Error(JSON.stringify(out));
});
```

Now add the CLI-level case to `scripts/test-cli-contract.mjs`. That suite already has everything this needs: `json(args)` expects success and returns the parsed stdout, `failure(args)` expects a non-zero exit and returns the parsed `{status:'ERROR',error}` document, `PROJECT` is the shared fixture, and `runToImplement(objective)` drives a fresh run from INTAKE to IMPLEMENT through the real gates and returns its `['--run-id', id]` pair. `test.run_targeted` is allowed at `IMPLEMENT` and `VERIFY` only (`policies/stage-policy.json`), which is why the walk is required.

Place this case immediately after the existing `test('tool-run-passes-and-binds-its-evidence-to-the-revision',...)`, and note that it saves and restores `PROJECT`'s command config, because later cases in the file run against the same fixture:

```javascript
// --selector was never read: tool-run built its args from --args JSON only, and
// parseArgs keeps unknown flags silently, so `--selector X` looked accepted,
// substituted the empty string, ran `node ''`, and exited 0 with no output --
// which was then recorded as targeted_verification_pass. The case above proves
// --args substitutes; this one proves the flag form works and that a missing
// selector is refused rather than silently satisfying the gate.
test('tool-run-reads-the-selector-flag-and-refuses-an-empty-one',()=>{
  const cfgPath=path.join(PROJECT,'.agent-sdlc','project.json');
  const before=fs.readFileSync(cfgPath,'utf8');
  try{
    const cfg=JSON.parse(before);
    // The selector is its own argv element here, so an empty one really would
    // run `node ''` -- exit 0, no output -- if nothing refused it.
    cfg.commands={...(cfg.commands||{}),test_targeted:[process.execPath,'-e','if(!process.argv[1])process.exit(0);console.log("ran "+process.argv[1]);','{selector}']};
    fs.writeFileSync(cfgPath,JSON.stringify(cfg,null,2));

    const at=runToImplement('Fix incorrect refund rounding');
    const out=json(['tool-run',...at,'--tool','test.run_targeted','--selector','tests/refund.test.js']);
    if(out.status!=='PASS')throw new Error(JSON.stringify(out));
    if(!/ran tests\/refund\.test\.js/.test(out.summary))throw new Error(`--selector was dropped: ${JSON.stringify(out.summary)}`);

    const err=failure(['tool-run',...at,'--tool','test.run_targeted']);
    if(!/requires a selector/.test(err.error))throw new Error(JSON.stringify(err));
  }finally{
    fs.writeFileSync(cfgPath,before);
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node evals/run-deterministic.mjs`
Expected: FAIL on `targeted-test-refuses-an-empty-selector` with `selector {} accepted: null`. `targeted-test-substitutes-the-selector` passes once the fixture is changed.

Run: `node scripts/test-cli-contract.mjs`
Expected: FAIL on `tool-run-reads-the-selector-flag-and-refuses-an-empty-one` with `--selector was dropped: ""` — the flag is ignored, so the child receives an empty selector and prints nothing.

- [ ] **Step 3: Write the implementation**

In `runtime/tools.mjs`, replace `projectCommand()`:

```javascript
function projectCommand(cfg,key,args){const tmpl=cfg.commands?.[key];if(!Array.isArray(tmpl)||!tmpl.length)throw new Error(`project command ${key} not configured`);return tmpl.map(x=>String(x).replaceAll('{selector}',args.selector||''));}
```

with:

```javascript
function projectCommand(cfg,key,args){
  const tmpl=cfg.commands?.[key];
  if(!Array.isArray(tmpl)||!tmpl.length)throw new Error(`project command ${key} not configured`);
  const selector=args.selector===undefined||args.selector===null?'':String(args.selector);
  // An unsubstituted placeholder used to become the empty string, which turned
  // `node {selector}` into `node ''`: exit 0, no output, recorded as
  // targeted_verification_pass. A command that asks for a selector gets one or
  // does not run.
  if(tmpl.some(x=>String(x).includes('{selector}'))&&!selector.trim()){
    throw new Error(`project command ${key} requires a selector; none was provided`);
  }
  return tmpl.map(x=>String(x).replaceAll('{selector}',selector));
}
```

In `runtime/commands/tools.mjs`, replace these two lines of the `'tool-run'` handler:

```javascript
    const a=args.args?JSON.parse(args.args):{};
    print(invokeTool(ROOT,projectRoot,run,tool,a));
```

with:

```javascript
    // --args is the general form; --selector and --timeout-ms are the two flags
    // callers actually reach for. They used to be accepted silently and dropped,
    // because parseArgs keeps unknown flags and nothing read them.
    const a=args.args?JSON.parse(args.args):{};
    if(a.selector===undefined&&args.selector!==undefined&&args.selector!==true)a.selector=String(args.selector);
    if(a.timeout_ms===undefined&&args['timeout-ms']!==undefined&&args['timeout-ms']!==true)a.timeout_ms=Number(args['timeout-ms']);
    print(invokeTool(ROOT,projectRoot,run,tool,a));
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node evals/run-deterministic.mjs`
Expected: `"results": "all-pass"`.

Run: `node scripts/test-cli-contract.mjs`
Expected: `"results": "all-pass"`.

Run: `node scripts/validate-task-engine.mjs`
Expected: `"results": "all-pass"`.

Run: `node scripts/validate-alpha6.mjs`
Expected: `"results": "all-pass"` — this and the task-engine suite drive `test.run_targeted` through the task engine and would break if the selector guard fired on a legitimate call.

- [ ] **Step 5: Commit**

```bash
git add runtime/tools.mjs runtime/commands/tools.mjs evals/run-deterministic.mjs scripts/test-cli-contract.mjs evals/DETERMINISTIC-VALIDATION.json evals/CLI-CONTRACT-VALIDATION.json
git commit -m "fix(tools): refuse an unsubstituted selector and read --selector on tool-run"
```

---

### Task 5: Honour the per-tool limits `config/tools.json` already declares

**Files:**
- Modify: `runtime/tools.mjs:44` — the `maxBytes` and `timeout` constants inside `invokeTool`
- Test: `evals/run-deterministic.mjs`

**Interfaces:**
- Consumes: the `status:'ERROR'`/`reason:'TIMEOUT'` contract from Task 3.
- Produces: no new names. `invokeTool` reads `default_timeout_ms` and `max_return_bytes` from the tool's entry in `config/tools.json` (an object keyed by tool name), still falling back to 120000 and 24000.

- [ ] **Step 1: Write the failing test**

Add to `evals/run-deterministic.mjs`, near the other gateway cases:

```javascript
// config/tools.json declares default_timeout_ms and max_return_bytes per tool.
// invokeTool hardcoded 120000 and 24000 and never read either, so tightening a
// tool's budget in config had no effect at all.
test('gateway-honours-per-tool-return-limit',()=>{
  const registry=JSON.parse(fs.readFileSync(path.join(ROOT,'config','tools.json'),'utf8'));
  if(registry.tools['test.run_targeted'].max_return_bytes!==24000)throw Error('fixture assumption changed');
  const d=fs.mkdtempSync(path.join(os.tmpdir(),'agent-sdlc-limits-'));
  execFileSync('git',['init','-q'],{cwd:d});
  initProject(d,{schema:'agent-sdlc/project/v1',project:'chatty',commands:{
    test_targeted:['node','-e','console.log("x".repeat(40000));','{selector}'],
    test_full:['node','-e','process.exit(0)'],
    build:['node','-e','process.exit(0)']
  },providers:{preferred:['claude']}});
  const r=newRun(ROOT,d,{objective:'x',route:route(ROOT,'Add fixture feature')});
  transition(ROOT,d,r,'REQUIREMENTS');
  transition(ROOT,d,r,'DESIGN',{evidence:['requirements_confirmed']});
  transition(ROOT,d,r,'PLAN',{evidence:['design_or_skip_decision'],internal:true});
  transition(ROOT,d,r,'IMPLEMENT',{evidence:planGateEvidence(),internal:true});
  const out=invokeTool(ROOT,d,r,'test.run_targeted',{selector:'all'});
  if(!out.truncated)throw Error('40000 bytes should exceed the declared 24000');
  if(Buffer.byteLength(out.summary)>24000)throw Error(`summary is ${Buffer.byteLength(out.summary)} bytes`);
  if(!out.full_log_artifact)throw Error('a truncated result must keep its full log');
});

test('gateway-caller-timeout-still-wins-when-larger',()=>{
  // args.timeout_ms raising the ceiling is existing behaviour (Math.max);
  // reading the registry must not remove it.
  const d=fs.mkdtempSync(path.join(os.tmpdir(),'agent-sdlc-tmo-'));
  execFileSync('git',['init','-q'],{cwd:d});
  initProject(d,{schema:'agent-sdlc/project/v1',project:'brief',commands:{
    test_targeted:['node','-e','console.log("done");','{selector}'],
    test_full:['node','-e','process.exit(0)'],
    build:['node','-e','process.exit(0)']
  },providers:{preferred:['claude']}});
  const r=newRun(ROOT,d,{objective:'x',route:route(ROOT,'Add fixture feature')});
  transition(ROOT,d,r,'REQUIREMENTS');
  transition(ROOT,d,r,'DESIGN',{evidence:['requirements_confirmed']});
  transition(ROOT,d,r,'PLAN',{evidence:['design_or_skip_decision'],internal:true});
  transition(ROOT,d,r,'IMPLEMENT',{evidence:planGateEvidence(),internal:true});
  const out=invokeTool(ROOT,d,r,'test.run_targeted',{selector:'all',timeout_ms:300000});
  if(out.status!=='PASS'||!out.summary.includes('done'))throw Error(JSON.stringify(out));
});
```

- [ ] **Step 2: Run the tests and prove the wiring is not a coincidence**

Run: `node evals/run-deterministic.mjs`
Expected: both new cases pass today, because the hardcoded constants happen to equal the declared ones. That is not evidence, so prove the config is unread before changing code: set `max_return_bytes` for `test.run_targeted` in `config/tools.json` to `500`, re-run, and confirm `gateway-honours-per-tool-return-limit` FAILs on its `fixture assumption changed` guard while the 24000-byte truncation behaviour is unchanged.

Then: `git checkout -- config/tools.json`

- [ ] **Step 3: Write the implementation**

In `runtime/tools.mjs`, inside `invokeTool`, replace:

```javascript
let result;const maxBytes=24000;const timeout=120000;
```

with:

```javascript
let result;
// config/tools.json declares these per tool and nothing read them, so a budget
// tightened in config had no effect. The literals stay as the fallback for a
// tool the registry does not size.
const spec=readJson(path.join(root,'config','tools.json')).tools?.[tool]||{};
const maxBytes=spec.max_return_bytes||24000;const timeout=spec.default_timeout_ms||120000;
```

`readJson` is already imported in `runtime/tools.mjs` — `sensitivePath` and `sanitizeWebQuery` use it — so no import change is needed.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node evals/run-deterministic.mjs`
Expected: `"results": "all-pass"`.

Now prove the wiring is real: set `max_return_bytes` for `test.run_targeted` to `500` in `config/tools.json`, run `node evals/run-deterministic.mjs`, and confirm `gateway-honours-per-tool-return-limit` FAILs on its `fixture assumption changed` guard — the registry is being read. Restore with `git checkout -- config/tools.json` and re-run to `all-pass`.

- [ ] **Step 5: Commit**

```bash
git add runtime/tools.mjs evals/run-deterministic.mjs evals/DETERMINISTIC-VALIDATION.json
git commit -m "fix(tools): read the per-tool timeout and return limit from the registry"
```

---

### Task 6: A `bin/agent-sdlc` that runs on Windows

**Files:**
- Create: `bin/agent-sdlc.cmd`
- Create: `bin/agent-sdlc.ps1`
- Modify: `scripts/validate-cli-surface.mjs` — add an entry-point parity section before the `const report={` assembly
- Modify: `scripts/verify-dist.mjs:28-33` — the `cli()` helper, so the packaged Windows shim is exercised instead of bypassed
- Modify: `docs/USAGE.md`, `docs/INSTALLATION.md`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: two new entry points that exec `runtime/cli.mjs` with the same argv and propagate the same exit code as `bin/agent-sdlc`. No JavaScript API.

- [ ] **Step 1: Write the failing test**

Add to `scripts/validate-cli-surface.mjs`, immediately before the `const report={` assembly:

```javascript
// --- entry-point parity -----------------------------------------------------
// The skills and docs tell the agent to run `bin/agent-sdlc` in ~120 places and
// the only shim was `#!/usr/bin/env sh`. In PowerShell that is "Cannot run a
// document in the middle of a pipeline" and in cmd.exe it is "not recognized",
// so the documented entry point did not exist for a whole supported platform.
// scripts/verify-dist.mjs had already worked around this privately.
const SHIMS=['agent-sdlc','agent-sdlc.cmd','agent-sdlc.ps1'];
for(const name of SHIMS){
  const p=path.join(ROOT,'bin',name);
  if(!fs.existsSync(p)){problems.push(`bin/${name} is missing; the documented entry point must exist on every supported platform`);continue;}
  if(!fs.readFileSync(p,'utf8').includes('runtime/cli.mjs')&&!fs.readFileSync(p,'utf8').includes('cli.mjs')){
    problems.push(`bin/${name} does not exec runtime/cli.mjs`);
  }
}
const shimBody=name=>{const p=path.join(ROOT,'bin',name);return fs.existsSync(p)?fs.readFileSync(p,'utf8'):'';};
const cmdBody=shimBody('agent-sdlc.cmd');
if(cmdBody&&!/%\*/.test(cmdBody))problems.push('bin/agent-sdlc.cmd does not forward its arguments (%*)');
if(cmdBody&&!/exit \/b/i.test(cmdBody))problems.push('bin/agent-sdlc.cmd does not propagate the exit code');
const ps1Body=shimBody('agent-sdlc.ps1');
if(ps1Body&&!/\$args/.test(ps1Body))problems.push('bin/agent-sdlc.ps1 does not forward its arguments ($args)');
if(ps1Body&&!/LASTEXITCODE/.test(ps1Body))problems.push('bin/agent-sdlc.ps1 does not propagate the exit code');
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node scripts/validate-cli-surface.mjs`
Expected: exit 1, with `problems` naming `bin/agent-sdlc.cmd is missing` and `bin/agent-sdlc.ps1 is missing`.

- [ ] **Step 3: Write the implementation**

Create `bin/agent-sdlc.cmd`:

```bat
@echo off
rem The cmd.exe entry point. `bin/agent-sdlc` is a POSIX sh script, which both
rem cmd.exe and PowerShell refuse to run, so the entry point the skills and docs
rem name did not exist on Windows at all.
setlocal
node "%~dp0..\runtime\cli.mjs" %*
exit /b %ERRORLEVEL%
```

Create `bin/agent-sdlc.ps1`:

```powershell
# The PowerShell entry point. See bin/agent-sdlc.cmd for why these exist.
# $LASTEXITCODE is propagated because every caller reads the exit code: 0 is
# success, 2 is an unknown command, non-zero is a structured error.
$cli = Join-Path $PSScriptRoot '..\runtime\cli.mjs'
& node $cli @args
exit $LASTEXITCODE
```

Then make `scripts/verify-dist.mjs` exercise the packaged Windows shim rather than routing around it. Replace:

```javascript
// The POSIX shell entrypoint is not executable on Windows; fall back to the same
// CLI module the entrypoint execs so the packaged tree is verifiable everywhere.
function cli(root,args,cwd){
  return process.platform==='win32'
    ? jsonCmd(process.execPath,[path.join(root,'runtime','cli.mjs'),...args],cwd)
    : jsonCmd(path.join(root,'bin','agent-sdlc'),args,cwd);
}
```

with:

```javascript
// Each platform's own entry point, so the packaged shim is what gets verified.
// This used to run runtime/cli.mjs directly on Windows, which meant the shipped
// Windows entry point was never executed by any suite -- and for a long while
// there was not one to execute.
function cli(root,args,cwd){
  if(process.platform!=='win32')return jsonCmd(path.join(root,'bin','agent-sdlc'),args,cwd);
  // Already quoted for cmd.exe, so libuv must not re-quote it.
  const line=[path.join(root,'bin','agent-sdlc.cmd'),...args].map(a=>`"${a}"`).join(' ');
  return jsonCmd(process.env.ComSpec||'cmd.exe',['/d','/s','/c',`"${line}"`],cwd,{windowsVerbatimArguments:true});
}
```

`jsonCmd` in that file takes `(bin,args,cwd)` and passes a fixed options object to `spawnSync`, so give it the fourth parameter the call above uses. Replace:

```javascript
function jsonCmd(bin,args,cwd){
  const r=spawnSync(bin,args,{cwd,encoding:'utf8',timeout:15000,maxBuffer:5*1024*1024});
```

with:

```javascript
function jsonCmd(bin,args,cwd,extra={}){
  const r=spawnSync(bin,args,{cwd,encoding:'utf8',timeout:15000,maxBuffer:5*1024*1024,...extra});
```

Finally, document it. In both `docs/INSTALLATION.md` and `docs/USAGE.md`, where the CLI is first introduced with `./bin/agent-sdlc`, add:

```markdown
On Windows use `bin\agent-sdlc.cmd` (cmd.exe) or `bin\agent-sdlc.ps1`
(PowerShell); `bin/agent-sdlc` is a POSIX `sh` script and neither shell will run
it. `node runtime/cli.mjs <command>` works everywhere and is what all three
shims exec.
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node scripts/validate-cli-surface.mjs`
Expected: `"status": "PASS"`, `problems: []`.

Run in PowerShell on Windows — this is the exact invocation that failed before:

```powershell
& ".\bin\agent-sdlc.ps1" route --objective "fix bug"
```

Expected: the router's JSON decision document, exit 0.

Run in cmd.exe on Windows:

```
bin\agent-sdlc.cmd route --objective "fix bug"
```

Expected: the same JSON, exit 0.

Run: `npm run build`
Expected: exit 0.

Run: `npm run verify:dist`
Expected: exit 0, now driving the packaged `.cmd` on Windows.

- [ ] **Step 5: Commit**

```bash
git add bin/agent-sdlc.cmd bin/agent-sdlc.ps1 scripts/validate-cli-surface.mjs scripts/verify-dist.mjs docs/USAGE.md docs/INSTALLATION.md evals/CLI-SURFACE-VALIDATION.json
git commit -m "feat(bin): ship cmd.exe and PowerShell entry points and verify all three"
```

---

### Task 7: Full gate, and the coverage floor

**Files:**
- Modify: `evals/COVERAGE-FLOOR.json` (only if coverage rose)
- Modify: `.github/workflows/ci.yml` (only if `test:ci-coverage` reports a missing step)

**Interfaces:**
- Consumes: everything from Tasks 1-6.
- Produces: a green `npm run check` at a coverage floor no lower than 90.

- [ ] **Step 1: Restore the local config the spike changed**

The spike that produced this plan's spec edited `.agent-sdlc/project.json` to work around the ENOENT that Task 3 now fixes properly. Put it back so the fix is verified against the real generated config:

```bash
mv .agent-sdlc/project.json.bak .agent-sdlc/project.json
node -e "console.log(JSON.parse(require('fs').readFileSync('.agent-sdlc/project.json','utf8')).commands.test_targeted.join(' '))"
```

Expected: `npm test -- {selector}`.

- [ ] **Step 2: Prove the Windows launcher fix against that config**

Start a throwaway run and drive the gateway through it:

```bash
node runtime/cli.mjs start --objective "verify the launcher fix" --workflow test-only
node runtime/cli.mjs tool-run --run-id <the run_id printed above> --tool test.run_targeted --selector scripts/validate-cli-surface.mjs
```

Expected: `"status": "PASS"` with the validator's JSON in `summary` — on Windows, via `cmd.exe` and `npm.cmd`. Before this plan the same command returned `{"status":"FAIL","exit_code":1,"summary":""}`.

- [ ] **Step 3: Run the whole gate**

Run: `npm run check`
Expected: exit 0. Every suite prints `"results": "all-pass"` or `"status": "PASS"`.

This plan adds no new npm script, so a `test:ci-coverage` failure would mean unrelated drift. If it fails, read the reported script name and add a step for it to the `offline-validation` job of `.github/workflows/ci.yml`, in the position the `check` chain implies.

- [ ] **Step 4: Check whether coverage moved, and ratchet it**

Run: `node scripts/coverage-report.mjs`
Expected: `"status": "PASS"`. Confirm `runtime/launcher.mjs` appears in the `modules` array of `evals/COVERAGE.json` and that `never_loaded` is still `[]`. It is measured with no change to `scripts/coverage-report.mjs`, because `scripts/test-provider.mjs` is already in that file's `ENTRIES` list.

If `overall_percent` is now above 90:

Run: `node scripts/coverage-report.mjs --update`

Then confirm `evals/COVERAGE-FLOOR.json` `overall_percent` is the new measured value and `never_loaded` is still `[]`.

- [ ] **Step 5: Re-run the gate and commit**

Run: `npm run check`
Expected: exit 0.

```bash
git add evals/
git commit -m "chore(evals): record the reports and coverage floor for the execution-path fixes"
```

---

## What this plan deliberately does not do

- **No "a PASS must have output" rule.** Silent success is legitimate — the deterministic fixture's own commands exit 0 without printing. Task 4's selector guard closes the vacuous-PASS hole at its cause instead.
- **No CLI-wide unknown-flag rejection.** `parseArgs` keeping unknown keys is relied on across 46 commands; making it strict is its own change with its own blast radius. Task 4 fixes the two flags that were silently dropped on the one command where it produced a false gate token.
- **No change to what `init` writes into `.agent-sdlc/project.json`.** `["npm","test"]` is the right command for a node project; the launcher was what was wrong.
- **Findings F2 (router scoring) and F3-F8, F12-F14 (gate hygiene)** belong to the other two plans named in the spec. In particular the secret-scan false positives (F12) are why this repository's own VERIFY gate is currently blocked, and that is not fixed here.
