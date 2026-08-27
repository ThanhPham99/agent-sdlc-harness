#!/usr/bin/env node
// Host provider suite.
//
// runtime/provider.mjs decides which binary runs, with which argv, under which
// sandbox. Everything it touches is outside the harness's control, and the
// coverage report put it at 39%. The parts that matter are the bounds: a host
// that never answers must not stop the harness, an argv that cannot be spawned
// must be reported rather than attempted, and a wall-clock timeout must be
// distinguishable from a host that ran and failed.
//
// spawn is injected for those contracts so they hold on every platform; the
// real-binary checks need an executable shebang script and run on POSIX only.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {probeBin,probe,resetProbeCache,capabilities,buildInvocation,runHost,argvLimitProblem,DEFAULT_MAX_WALL_MS} from '../runtime/provider.mjs';
import {resolveLaunch,resolveOnPath,describeSpawn} from '../runtime/launcher.mjs';
import {createSuite} from './lib/suite.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const POSIX=process.platform!=='win32';
const {test,assert,finish}=createSuite('agent-sdlc/provider-validation/v1','PROVIDER-VALIDATION.json');

const CLAUDE_HELP='-p --print --output-format --json-schema --max-turns --model --mcp-config --permission-mode';
const CODEX_HELP='exec --json --ephemeral --sandbox --output-schema --model';
const AGY_HELP='--sandbox --print -p --print-timeout --output-format --json-schema --model --effort';

// probeBin/probe/buildInvocation/runHost now take an injectable `launch`
// (defaulting to the real resolveLaunch) alongside the injectable `spawn`, the
// same way tools.mjs's gateway can be tested without touching the real PATH.
// The hermetic tests below inject a `launch` that resolves against a fake,
// empty POSIX-shaped environment -- never the real PATH -- so a candidate name
// like 'x' or 'claude' is handed straight to `spawn` unresolved, exactly as
// resolveLaunch itself already does for an unresolved name on POSIX. That
// keeps these tests independent of whatever host CLIs are actually installed.
const POSIX_LAUNCH=argv=>resolveLaunch(argv,{platform:'linux',env:{PATH:''}});

/** A scripted spawn: records every call and answers from a table. */
function fakeSpawn(answers){
  const calls=[];
  const spawn=(bin,args,opts)=>{
    calls.push({bin,args,opts});
    const key=`${bin} ${args[0]}`;
    const answer=answers[key]??answers[bin]??answers.default;
    if(typeof answer==='function')return answer(bin,args,opts);
    return answer??{status:1,stdout:'',stderr:''};
  };
  spawn.calls=calls;
  return spawn;
}
const ok=(stdout)=>({status:0,stdout,stderr:''});
const timeout=()=>({status:null,signal:'SIGTERM',stdout:'',stderr:'',error:{code:'ETIMEDOUT'}});
const missing=()=>({status:null,stdout:'',stderr:'',error:{code:'ENOENT'}});

// --- probe bounds ----------------------------------------------------------
test('every-probe-spawn-is-bounded',()=>{
  const spawn=fakeSpawn({'x --version':ok('1.0'),'x --help':ok(CLAUDE_HELP)});
  probeBin(['x'],{spawn,launch:POSIX_LAUNCH});
  assert(spawn.calls.length===2,`expected two probe calls, got ${spawn.calls.length}`);
  for(const c of spawn.calls){
    assert(Number.isFinite(c.opts?.timeout)&&c.opts.timeout>0,`unbounded probe: ${c.args[0]} has no timeout`);
    assert(c.opts.timeout<=15000,`probe timeout too generous: ${c.opts.timeout}ms`);
    assert(Number.isFinite(c.opts?.maxBuffer)&&c.opts.maxBuffer>1024*1024,'probe output is not capped above the 1 MB default');
  }
});
test('a-host-that-never-answers-is-treated-as-unavailable',()=>{
  const spawn=fakeSpawn({default:timeout()});
  assert(probeBin(['hangs'],{spawn,launch:POSIX_LAUNCH})===null,'a timed-out probe reported an available host');
});
test('probe-falls-through-to-the-next-candidate',()=>{
  const spawn=fakeSpawn({'first --version':missing(),'second --version':ok('2.0'),'second --help':ok(CODEX_HELP)});
  const p=probeBin(['first','second'],{spawn,launch:POSIX_LAUNCH});
  assert(p?.binary==='second',JSON.stringify(p));
  assert(p.version==='2.0',p.version);
});
test('a-failing-help-call-degrades-capabilities-instead-of-the-probe',()=>{
  const spawn=fakeSpawn({'x --version':ok('1.0'),'x --help':timeout()});
  const p=probeBin(['x'],{spawn,launch:POSIX_LAUNCH});
  assert(p!==null,'probe was lost because --help failed');
  const cap=capabilities('claude',p);
  assert(cap.available===true,'host reported unavailable');
  assert(cap.structured_output===false&&cap.sandbox===false,'capabilities were invented without help output');
});
test('empty-candidate-names-are-skipped',()=>{
  const spawn=fakeSpawn({'real --version':ok('1'),'real --help':ok('')});
  const p=probeBin([undefined,'',null,'real'],{spawn,launch:POSIX_LAUNCH});
  assert(p?.binary==='real',JSON.stringify(p));
  assert(spawn.calls.every(c=>c.bin==='real'),'an empty binary name was spawned');
});
test('a-pinned-binary-does-not-fall-through-to-path',()=>{
  // Regression: HOST_CANDIDATES listed the pin and the PATH name together, so a
  // pinned binary that hung or could not report --version silently resolved to
  // whatever `claude` happened to be installed. On a developer machine with a
  // real host CLI this turned two suites red; in qualification it would have
  // attributed evidence to the wrong binary. Hermetic so it also holds on CI,
  // where no host CLI exists.
  resetProbeCache();
  const spawn=fakeSpawn({'/pinned/claude --version':missing(),'claude --version':ok('9.9'),'claude --help':ok(CLAUDE_HELP)});
  process.env.AI_SDLC_CLAUDE_BIN='/pinned/claude';
  const p=probe('claude',{spawn,launch:POSIX_LAUNCH,cache:false});
  delete process.env.AI_SDLC_CLAUDE_BIN;
  resetProbeCache();
  assert(p===null,`a broken pin resolved to ${p?.binary}`);
  assert(spawn.calls.every(c=>c.bin==='/pinned/claude'),'a PATH binary was probed while a pin was set');
});
test('an-unknown-host-is-rejected',()=>{
  let threw=false;
  try{probe('not-a-host',{spawn:fakeSpawn({})});}catch(e){threw=/unknown host/.test(e.message);}
  assert(threw,'an unknown host was probed');
});
test('probe-results-are-memoized-per-process',()=>{
  resetProbeCache();
  const spawn=fakeSpawn({default:missing()});
  probe('claude',{spawn,launch:POSIX_LAUNCH});
  const afterFirst=spawn.calls.length;
  probe('claude',{spawn,launch:POSIX_LAUNCH});
  assert(spawn.calls.length===afterFirst,`probe re-spawned: ${afterFirst} -> ${spawn.calls.length}`);
  resetProbeCache();
  probe('claude',{spawn,launch:POSIX_LAUNCH});
  assert(spawn.calls.length>afterFirst,'resetProbeCache did not clear the memo');
  resetProbeCache();
});

// --- capability detection --------------------------------------------------
test('capabilities-are-read-from-help-output-only',()=>{
  const rich=capabilities('claude',{version:'1',help:'--json-schema --resume --sandbox mcp'});
  assert(rich.structured_output&&rich.resumable&&rich.sandbox&&rich.mcp,JSON.stringify(rich));
  const bare=capabilities('claude',{version:'1',help:'--model'});
  assert(!bare.structured_output&&!bare.resumable&&!bare.sandbox&&!bare.mcp,JSON.stringify(bare));
  const absent=capabilities('claude',null);
  assert(absent.available===false&&absent.version===null,JSON.stringify(absent));
});

// --- invocation building --------------------------------------------------
const schema=path.join(ROOT,'protocol','schemas','StageResult.schema.json');
function inv(host,help,prompt='do the thing',budget={}){
  resetProbeCache();
  const bin={claude:'claude',codex:'codex',antigravity:'agy'}[host];
  const spawn=fakeSpawn({[`${bin} --version`]:ok('1.0'),[`${bin} --help`]:ok(help)});
  return buildInvocation(host,prompt,schema,budget,{spawn,launch:POSIX_LAUNCH});
}
test('claude-invocation-carries-the-prompt-and-structured-output',()=>{
  const out=inv('claude',CLAUDE_HELP,'do the thing',{maxTurns:8});
  assert(out.status==='READY',JSON.stringify(out));
  assert(out.argv[0]==='claude'&&out.argv[1]==='-p'&&out.argv[2]==='do the thing',JSON.stringify(out.argv));
  assert(out.argv.includes('--json-schema')&&out.argv.includes(schema),'schema not passed');
  assert(out.argv[out.argv.indexOf('--max-turns')+1]==='8','turn budget not passed');
});
test('flags-absent-from-help-are-not-passed',()=>{
  const out=inv('claude','-p --output-format');
  assert(out.status==='READY',JSON.stringify(out));
  assert(!out.argv.includes('--json-schema'),'passed a flag the host does not support');
  assert(!out.argv.includes('--max-turns'),'passed a flag the host does not support');
});
test('codex-sandbox-follows-the-stage',()=>{
  for(const [stage,expected] of [['IMPLEMENT','workspace-write'],['VERIFY','workspace-write'],['DESIGN','read-only'],[undefined,'read-only']]){
    const out=inv('codex',CODEX_HELP,'p',{stage});
    const got=out.argv[out.argv.indexOf('--sandbox')+1];
    assert(got===expected,`stage ${stage} -> ${got}, expected ${expected}`);
  }
});
test('codex-prompt-is-the-final-argument',()=>{
  const out=inv('codex',CODEX_HELP,'the prompt');
  assert(out.argv.at(-1)==='the prompt',JSON.stringify(out.argv));
  assert(out.argv[1]==='exec','codex is not invoked in exec mode');
});
test('every-invocation-reports-the-budget-it-was-built-with',()=>{
  // provider-command hands this document to a caller who may run the argv
  // themselves, and on Claude and Codex nothing in the argv says when to give
  // up. Leaving the bound implicit in the spawn made the printed command look
  // unbounded, so the budget is reported whether or not a flag carries it.
  const explicit=inv('claude',CLAUDE_HELP,'p',{maxWallMs:1234,maxTurns:8});
  assert(explicit.max_wall_ms===1234&&explicit.max_turns===8,JSON.stringify(explicit));
  const fallback=inv('claude',CLAUDE_HELP,'p');
  assert(fallback.max_wall_ms===DEFAULT_MAX_WALL_MS,`no default budget: ${fallback.max_wall_ms}`);
  // A refusal is still bounded: the caller learns the budget that would apply.
  const tooBig=inv('claude',CLAUDE_HELP,'x'.repeat(300000),{maxWallMs:1234});
  assert(tooBig.status==='PENDING'&&tooBig.max_wall_ms===1234,JSON.stringify({s:tooBig.status,b:tooBig.max_wall_ms}));
});
test('a-host-with-an-in-band-timeout-gets-the-same-budget-as-the-spawn',()=>{
  // Regression: antigravity bounds print mode itself and defaults to 5m, and the
  // flag was never passed. The host gave up at its own default while the harness
  // waited out a 15m spawn timeout, so a budget overrun surfaced as a host FAIL
  // rather than a clean timeout. scripts/qualify-host.mjs already passed this
  // flag; the runtime did not.
  const out=inv('antigravity',AGY_HELP,'p',{maxWallMs:120000});
  assert(out.argv[out.argv.indexOf('--print-timeout')+1]==='120s',JSON.stringify(out.argv));
  assert(out.max_wall_ms===120000,JSON.stringify(out));
  // Claude and Codex advertise no such flag, so nothing is invented for them.
  for(const [host,help] of [['claude',CLAUDE_HELP],['codex',CODEX_HELP]]){
    assert(!inv(host,help,'p',{maxWallMs:120000}).argv.includes('--print-timeout'),`${host} was given a flag it does not support`);
  }
});
test('the-in-band-bound-and-the-spawn-bound-cannot-diverge',()=>{
  resetProbeCache();
  const spawn=fakeSpawn({'agy --version':ok('1.0'),'agy --help':ok(AGY_HELP),'agy --print':ok('')});
  runHost('antigravity','p',schema,{maxWallMs:45000},{spawn,launch:POSIX_LAUNCH});
  const run=spawn.calls.at(-1);
  assert(run.opts.timeout===45000,`spawn bound ${run.opts.timeout}`);
  assert(run.args[run.args.indexOf('--print-timeout')+1]==='45s',JSON.stringify(run.args));
});
test('a-missing-host-is-pending-not-an-exception',()=>{
  resetProbeCache();
  const out=buildInvocation('claude','p',schema,{},{spawn:fakeSpawn({default:missing()}),launch:POSIX_LAUNCH});
  assert(out.status==='PENDING'&&out.reason==='HOST_CLI_NOT_FOUND',JSON.stringify(out));
  assert(out.argv===null,'an argv was produced for a host that is not installed');
});

// --- argv limits ----------------------------------------------------------
test('argv-limits-are-platform-specific',()=>{
  const small=['bin','-p','short'];
  assert(argvLimitProblem(small,'win32')===null,'a short command line was refused on win32');
  assert(argvLimitProblem(small,'linux')===null,'a short command line was refused on linux');
  // 40 000 characters: over the Windows command-line cap, under the POSIX
  // per-argument cap.
  const mid=['bin','-p','x'.repeat(40000)];
  const win=argvLimitProblem(mid,'win32');
  assert(win?.reason==='PROMPT_EXCEEDS_ARGV_LIMIT'&&win.scope==='command_line',JSON.stringify(win));
  assert(argvLimitProblem(mid,'linux')===null,'a 40 KB argument was refused on linux');
  const big=['bin','-p','x'.repeat(200000)];
  const posix=argvLimitProblem(big,'linux');
  assert(posix?.reason==='PROMPT_EXCEEDS_ARGV_LIMIT'&&posix.scope==='single_argument',JSON.stringify(posix));
  assert(posix.bytes>posix.limit,'the report does not show the overrun');
});
test('an-unspawnable-prompt-is-reported-not-attempted',()=>{
  // 300 KB is over every platform's limit; spawn would fail with E2BIG.
  const out=inv('claude',CLAUDE_HELP,'x'.repeat(300000));
  assert(out.status==='PENDING'&&out.reason==='PROMPT_EXCEEDS_ARGV_LIMIT',JSON.stringify({status:out.status,reason:out.reason}));
  assert(out.argv===null,'an unspawnable argv was returned as READY');
  assert(out.bytes>out.limit,JSON.stringify({bytes:out.bytes,limit:out.limit}));
});
test('runHost-does-not-spawn-an-invocation-that-is-not-ready',()=>{
  resetProbeCache();
  const spawn=fakeSpawn({default:missing()});
  const out=runHost('claude','p',schema,{},{spawn,launch:POSIX_LAUNCH});
  assert(out.status==='PENDING',JSON.stringify(out));
  // Only the probe calls; no host run.
  assert(spawn.calls.every(c=>['--version','--help'].includes(c.args[0])),'a host was run despite an unusable invocation');
});

// --- run outcomes ---------------------------------------------------------
function hostRun(answer,budget={}){
  resetProbeCache();
  const spawn=fakeSpawn({'claude --version':ok('1.0'),'claude --help':ok(CLAUDE_HELP),'claude -p':answer});
  return runHost('claude','p',schema,budget,{spawn,launch:POSIX_LAUNCH});
}
test('a-successful-host-run-is-pass',()=>{
  const out=hostRun(ok('{"ok":true}'));
  assert(out.status==='PASS'&&out.exit_code===0,JSON.stringify(out));
  assert(out.stdout==='{"ok":true}','stdout lost');
  assert(out.timed_out===false&&out.error===null,JSON.stringify(out));
});
test('a-failing-host-run-keeps-its-exit-code',()=>{
  const out=hostRun({status:3,stdout:'',stderr:'boom'});
  assert(out.status==='FAIL'&&out.exit_code===3,JSON.stringify(out));
  assert(out.stderr==='boom','stderr lost');
  assert(out.timed_out===false,'a plain failure was reported as a timeout');
});
test('a-timeout-is-distinguishable-from-a-failed-run',()=>{
  // Regression: exit_code was forced to 1 and the spawn error discarded, so the
  // fallback policy could not tell a wall-clock timeout from a host that ran
  // and returned 1.
  const out=hostRun(timeout(),{maxWallMs:1000});
  assert(out.status==='FAIL',out.status);
  assert(out.timed_out===true,'timeout not reported');
  assert(out.error==='ETIMEDOUT',`error not surfaced: ${out.error}`);
  assert(out.exit_code===null,`a timeout was given exit code ${out.exit_code}`);
});
test('the-wall-clock-budget-reaches-spawn',()=>{
  resetProbeCache();
  const spawn=fakeSpawn({'claude --version':ok('1.0'),'claude --help':ok(CLAUDE_HELP),'claude -p':ok('')});
  runHost('claude','p',schema,{maxWallMs:1234},{spawn,launch:POSIX_LAUNCH});
  const run=spawn.calls.at(-1);
  assert(run.opts.timeout===1234,`budget not applied: ${run.opts.timeout}`);
  assert(run.opts.maxBuffer>1024*1024,'host output is not capped above the default');
});

// --- real binaries (POSIX only: Node cannot spawn a shebang script on Windows)
function shebang(name,body){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'agent-sdlc-provider-'));
  const p=path.join(dir,name);
  fs.writeFileSync(p,body,{mode:0o755});
  return p;
}
test('a-real-hanging-binary-is-bounded-by-the-probe-timeout',()=>{
  if(!POSIX)return 'SKIP';
  // A binary that never answers `--version`. Without a probe timeout this call
  // blocks for the full 60 seconds, which is what used to happen.
  process.env.AI_SDLC_CLAUDE_BIN=shebang('claude','#!/bin/sh\nsleep 60\n');
  resetProbeCache();
  const started=Date.now();
  const hung=probe('claude',{cache:false});
  const took=Date.now()-started;
  delete process.env.AI_SDLC_CLAUDE_BIN;
  resetProbeCache();
  assert(hung===null,'a hanging binary was reported as an available host');
  assert(took<15000,`probe took ${took}ms; it is not bounded`);
});
test('a-real-binary-that-fails-version-is-unavailable',()=>{
  if(!POSIX)return 'SKIP';
  const bin=shebang('claude','#!/bin/sh\nexit 127\n');
  process.env.AI_SDLC_CLAUDE_BIN=bin;
  resetProbeCache();
  const p=probe('claude',{cache:false});
  delete process.env.AI_SDLC_CLAUDE_BIN;
  resetProbeCache();
  assert(p===null,'a binary that cannot report its version was accepted');
});
test('a-real-binary-round-trips-through-runHost',()=>{
  if(!POSIX)return 'SKIP';
  const bin=shebang('claude',
    '#!/bin/sh\nif [ "$1" = "--version" ]; then echo 9.9; exit 0; fi\n'+
    'if [ "$1" = "--help" ]; then echo "-p --output-format --json-schema"; exit 0; fi\n'+
    'echo "{\\"seen\\":\\"$2\\"}"\nexit 0\n');
  process.env.AI_SDLC_CLAUDE_BIN=bin;
  resetProbeCache();
  const out=runHost('claude','carried through',schema,{maxWallMs:10000});
  delete process.env.AI_SDLC_CLAUDE_BIN;
  resetProbeCache();
  assert(out.status==='PASS',JSON.stringify(out));
  assert(out.stdout.includes('carried through'),`prompt did not reach the host: ${out.stdout}`);
});

test('a-node-script-binary-probes-and-runs-across-platforms',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'agent-sdlc-provider-script-'));
  const bin=path.join(dir,'fake-host.mjs');
  fs.writeFileSync(bin,
    'const args=process.argv.slice(2);\n'+
    'if(args.includes("--version")){console.log("script-host 1.0");process.exit(0);}\n'+
    'if(args.includes("--help")){console.log("-p --output-format --json-schema");process.exit(0);}\n'+
    'console.log(JSON.stringify({structured_output:{ok:true},usage:{input_tokens:10,output_tokens:5}}));\n'+
    'process.exit(0);\n');
  process.env.AI_SDLC_CLAUDE_BIN=bin;
  resetProbeCache();
  const p=probe('claude',{cache:false});
  assert(p!==null,'a node script binary was not detected');
  assert(p.version==='script-host 1.0',`unexpected version: ${p.version}`);
  const out=runHost('claude','test prompt',null,{maxWallMs:10000});
  delete process.env.AI_SDLC_CLAUDE_BIN;
  resetProbeCache();
  assert(out.status==='PASS',JSON.stringify(out));
});

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

test('launcher-posix-symlinked-script-stays-direct',()=>{
  // Many POSIX toolchains install as a PATH entry symlinked to a .js target
  // (Debian npm, nvm, Homebrew shims). Resolving through the symlink's real
  // target must not flip `via` from 'direct' to 'node' -- callers spawn the
  // PATH entry itself, not the interpreter plus its resolved script path.
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'agent-sdlc-launch-'));
  const target=path.join(dir,'real-target.js');
  fs.writeFileSync(target,'#!/usr/bin/env node\n');
  const link=path.join(dir,'thing');
  try{fs.symlinkSync(target,link);}catch{fs.rmSync(dir,{recursive:true,force:true});return 'SKIP';}
  const l=resolveLaunch(['thing','x'],{platform:'linux',env:{PATH:dir}});
  fs.rmSync(dir,{recursive:true,force:true});
  assert(l.status==='OK',JSON.stringify(l));
  assert(l.via==='direct',l.via);
  assert(l.bin===link,`expected the PATH entry ${link}, got ${l.bin}`);
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

test('provider-probes-a-windows-shim-host',()=>{
  // A host CLI installed as claude.cmd used to be invisible to the probe on
  // Windows: spawnSync('claude') is ENOENT, so the host reported unavailable.
  // The launch step is injected against a fake win32 environment (a real
  // directory holding one real claude.cmd file, but a synthetic PATH/PATHEXT/
  // ComSpec) rather than the real PATH, so this is pinned on every platform
  // the suite runs on -- including POSIX CI -- not only on a real win32 box.
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'agent-sdlc-shim-'));
  fs.writeFileSync(path.join(dir,'claude.cmd'),'@echo off\n');
  const seen=[];
  const spawn=(bin,args)=>{seen.push({bin,args});return {status:0,stdout:'2.0.0 (Claude Code)',stderr:''};};
  const launch=argv=>resolveLaunch(argv,{platform:'win32',env:{PATH:dir,PATHEXT:'.EXE;.CMD',ComSpec:'cmd.exe'}});
  const p=probeBin(['claude'],{spawn,launch});
  fs.rmSync(dir,{recursive:true,force:true});
  assert(p!==null,'shim host was not probed');
  assert(/cmd\.exe$/i.test(seen[0].bin),seen[0].bin);
  assert(seen[0].args[0]==='/d',JSON.stringify(seen[0].args));
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

finish({platform:process.platform,real_binary_checks:POSIX});
