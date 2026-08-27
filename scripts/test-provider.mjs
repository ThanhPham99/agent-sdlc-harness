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
import {createSuite} from './lib/suite.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const POSIX=process.platform!=='win32';
const {test,assert,finish}=createSuite('agent-sdlc/provider-validation/v1','PROVIDER-VALIDATION.json');

const CLAUDE_HELP='-p --print --output-format --json-schema --max-turns --model --mcp-config --permission-mode';
const CODEX_HELP='exec --json --ephemeral --sandbox --output-schema --model';
const AGY_HELP='--sandbox --print -p --print-timeout --output-format --json-schema --model --effort';

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
  probeBin(['x'],{spawn});
  assert(spawn.calls.length===2,`expected two probe calls, got ${spawn.calls.length}`);
  for(const c of spawn.calls){
    assert(Number.isFinite(c.opts?.timeout)&&c.opts.timeout>0,`unbounded probe: ${c.args[0]} has no timeout`);
    assert(c.opts.timeout<=15000,`probe timeout too generous: ${c.opts.timeout}ms`);
    assert(Number.isFinite(c.opts?.maxBuffer)&&c.opts.maxBuffer>1024*1024,'probe output is not capped above the 1 MB default');
  }
});
test('a-host-that-never-answers-is-treated-as-unavailable',()=>{
  const spawn=fakeSpawn({default:timeout()});
  assert(probeBin(['hangs'],{spawn})===null,'a timed-out probe reported an available host');
});
test('probe-falls-through-to-the-next-candidate',()=>{
  const spawn=fakeSpawn({'first --version':missing(),'second --version':ok('2.0'),'second --help':ok(CODEX_HELP)});
  const p=probeBin(['first','second'],{spawn});
  assert(p?.binary==='second',JSON.stringify(p));
  assert(p.version==='2.0',p.version);
});
test('a-failing-help-call-degrades-capabilities-instead-of-the-probe',()=>{
  const spawn=fakeSpawn({'x --version':ok('1.0'),'x --help':timeout()});
  const p=probeBin(['x'],{spawn});
  assert(p!==null,'probe was lost because --help failed');
  const cap=capabilities('claude',p);
  assert(cap.available===true,'host reported unavailable');
  assert(cap.structured_output===false&&cap.sandbox===false,'capabilities were invented without help output');
});
test('empty-candidate-names-are-skipped',()=>{
  const spawn=fakeSpawn({'real --version':ok('1'),'real --help':ok('')});
  const p=probeBin([undefined,'',null,'real'],{spawn});
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
  const p=probe('claude',{spawn,cache:false});
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
  probe('claude',{spawn});
  const afterFirst=spawn.calls.length;
  probe('claude',{spawn});
  assert(spawn.calls.length===afterFirst,`probe re-spawned: ${afterFirst} -> ${spawn.calls.length}`);
  resetProbeCache();
  probe('claude',{spawn});
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
  return buildInvocation(host,prompt,schema,budget,{spawn});
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
  runHost('antigravity','p',schema,{maxWallMs:45000},{spawn});
  const run=spawn.calls.at(-1);
  assert(run.opts.timeout===45000,`spawn bound ${run.opts.timeout}`);
  assert(run.args[run.args.indexOf('--print-timeout')+1]==='45s',JSON.stringify(run.args));
});
test('a-missing-host-is-pending-not-an-exception',()=>{
  resetProbeCache();
  const out=buildInvocation('claude','p',schema,{},{spawn:fakeSpawn({default:missing()})});
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
  const out=runHost('claude','p',schema,{},{spawn});
  assert(out.status==='PENDING',JSON.stringify(out));
  // Only the probe calls; no host run.
  assert(spawn.calls.every(c=>['--version','--help'].includes(c.args[0])),'a host was run despite an unusable invocation');
});

// --- run outcomes ---------------------------------------------------------
function hostRun(answer,budget={}){
  resetProbeCache();
  const spawn=fakeSpawn({'claude --version':ok('1.0'),'claude --help':ok(CLAUDE_HELP),'claude -p':answer});
  return runHost('claude','p',schema,budget,{spawn});
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
  runHost('claude','p',schema,{maxWallMs:1234},{spawn});
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

finish({platform:process.platform,real_binary_checks:POSIX});
