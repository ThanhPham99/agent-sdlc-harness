import {spawnSync} from 'node:child_process';
import {resolveLaunch} from './launcher.mjs';

// Host CLI probing and invocation building.
//
// Everything here talks to a binary the harness does not control, so each call
// is bounded. A host that never answers is an unavailable host from the caller's
// point of view, not a reason for the harness to stop responding: probes used to
// run `--version` and `--help` with no timeout and the default 1 MB buffer, so a
// hung or chatty CLI blocked `doctor`, `model-route` and every stage invocation
// indefinitely.
const PROBE_TIMEOUT_MS=5000;
const PROBE_MAX_BUFFER=4*1024*1024;

// Windows caps an entire command line at 32767 characters. POSIX caps a single
// argument at MAX_ARG_STRLEN (128 KiB) while allowing a much larger total. The
// stage prompt travels as one argv element, so a large context would otherwise
// fail inside spawn with an opaque E2BIG or ENAMETOOLONG.
const WINDOWS_COMMAND_LINE_LIMIT=32767;
const POSIX_ARG_LIMIT=128*1024;

// The wall-clock budget for one host turn. It lives here rather than at the
// single spawn site because two things need to agree on it: the out-of-band
// spawn timeout, and the in-band flag on hosts that have one.
export const DEFAULT_MAX_WALL_MS=900000;

/** A Go duration, for hosts whose timeout flag is parsed by Go. */
const goDuration=ms=>`${Math.max(1,Math.round(ms/1000))}s`;

// A pinned binary is authoritative: when AI_SDLC_<HOST>_BIN is set, it is the
// only candidate. Falling through to a PATH binary silently re-pointed every
// probe, invocation and piece of qualification evidence at a host the operator
// did not name — and made `agy`/`claude` on PATH mask a broken pin.
const HOST_DEFAULTS={claude:['claude'],codex:['codex'],antigravity:['agy','antigravity']};
const HOST_BIN_ENV={claude:'AI_SDLC_CLAUDE_BIN',codex:'AI_SDLC_CODEX_BIN',antigravity:'AI_SDLC_ANTIGRAVITY_BIN'};
const HOST_CANDIDATES=Object.fromEntries(Object.keys(HOST_DEFAULTS).map(h=>[h,()=>{
  const pinned=process.env[HOST_BIN_ENV[h]];
  return pinned?[pinned]:HOST_DEFAULTS[h];
}]));

// A host "binary" may be a real executable or a Node script (the offline
// transport regression and test suites use fake host CLIs). Windows cannot exec
// a JS file directly, so script binaries are launched through this process's
// Node executable on every platform.
//
// Host resolution moved to runtime/launcher.mjs so the tool gateway gets the
// same rules. This kept the .mjs/.cjs/.js case and gained the one it was
// missing: a host installed as a Windows .cmd shim, which spawnSync refuses to
// start directly and which therefore reported as "host not installed".
function spawnHost(spawn,bin,args,opts,launch=resolveLaunch){
  const l=launch([String(bin),...args]);
  // An unlaunchable candidate is reported the way an unanswered probe already
  // was, so probeBin moves to the next name instead of throwing.
  if(l.status!=='OK')return {status:null,stdout:'',stderr:'',error:{code:'ENOENT'}};
  return spawn(l.bin,l.args,{...opts,...l.spawnOptions});
}

/**
 * First candidate that answers `--version`. `spawn` and `launch` are
 * injectable so the bounded-probe contract, and how a candidate name becomes
 * a spawnable bin/args pair, can both be tested without a real host binary or
 * the real PATH.
 */
export function probeBin(names,{spawn=spawnSync,launch=resolveLaunch}={}){
  for(const n of names){
    if(!n)continue;
    const opts={encoding:'utf8',timeout:PROBE_TIMEOUT_MS,maxBuffer:PROBE_MAX_BUFFER};
    const v=spawnHost(spawn,n,['--version'],opts,launch);
    if(v?.error||v?.status!==0)continue;
    const h=spawnHost(spawn,n,['--help'],opts,launch);
    // A help call that timed out or overflowed still leaves partial output;
    // capability detection degrades rather than failing the probe.
    return {binary:n,version:(v.stdout||v.stderr||'').trim(),help:(h?.stdout||h?.stderr||'')};
  }
  return null;
}

// A host does not appear or disappear inside one process, and `doctor` alone
// probed every host twice. Memoized per process, keyed by host and the binary
// override that selected it.
const probeCache=new Map();
export function probe(host,{spawn=spawnSync,launch=resolveLaunch,cache=true}={}){
  const candidates=HOST_CANDIDATES[host];
  if(!candidates)throw new Error('unknown host');
  const names=candidates().filter(Boolean);
  const key=`${host}\0${names.join('\0')}`;
  if(cache&&probeCache.has(key))return probeCache.get(key);
  const result=probeBin(names,{spawn,launch});
  if(cache)probeCache.set(key,result);
  return result;
}
/** Drop memoized probes; for tests and for a host installed mid-session. */
export function resetProbeCache(){probeCache.clear();}

export function capabilities(host,p){
  const h=p?.help||'';
  return {
    host,available:!!p,version:p?.version||null,
    structured_output:/json-schema|output-schema|json schema/i.test(h),
    resumable:/resume|continue|previous/i.test(h),
    sandbox:/sandbox|permission-mode/i.test(h),
    mcp:/mcp/i.test(h)
  };
}

function sandboxForStage(stage){return ['IMPLEMENT','VERIFY'].includes(stage)?'workspace-write':'read-only';}

/**
 * Why this argv cannot be spawned on this platform, or null when it can.
 * Reported as a status by the caller instead of surfacing as a spawn errno.
 */
export function argvLimitProblem(argv,platform=process.platform){
  const sizes=argv.map(a=>Buffer.byteLength(String(a)));
  if(platform==='win32'){
    // +1 per argument for the separating space.
    const total=sizes.reduce((n,s)=>n+s+1,0);
    if(total>WINDOWS_COMMAND_LINE_LIMIT)return {reason:'PROMPT_EXCEEDS_ARGV_LIMIT',bytes:total,limit:WINDOWS_COMMAND_LINE_LIMIT,scope:'command_line'};
    return null;
  }
  const largest=Math.max(0,...sizes);
  if(largest>POSIX_ARG_LIMIT)return {reason:'PROMPT_EXCEEDS_ARGV_LIMIT',bytes:largest,limit:POSIX_ARG_LIMIT,scope:'single_argument'};
  return null;
}

export function buildInvocation(host,prompt,schemaPath,budget={},{spawn=spawnSync,launch=resolveLaunch}={}){
  const p=probe(host,{spawn,launch});
  const maxWallMs=budget.maxWallMs||DEFAULT_MAX_WALL_MS;
  if(!p)return {status:'PENDING',reason:'HOST_CLI_NOT_FOUND',argv:null};
  const h=p.help||'';
  let a;
  if(host==='claude'){
    a=[p.binary,'-p',prompt,'--output-format','json'];
    if(/--max-turns/.test(h)&&budget.maxTurns)a.push('--max-turns',String(budget.maxTurns));
    if(/--json-schema/.test(h)&&schemaPath)a.push('--json-schema',schemaPath);
  }
  else if(host==='codex'){
    a=[p.binary,'exec','--json'];
    if(/--ephemeral/.test(h))a.push('--ephemeral');
    if(/--sandbox/.test(h))a.push('--sandbox',sandboxForStage(budget.stage));
    if(/--output-schema/.test(h)&&schemaPath)a.push('--output-schema',schemaPath);
    a.push(prompt);
  }
  else{
    a=[p.binary];
    if(/--print/.test(h))a.push('--print',prompt);else a.push(prompt);
    if(/--output-format/.test(h))a.push('--output-format','json');
    if(/--json-schema/.test(h)&&schemaPath)a.push('--json-schema',schemaPath);
    if(/--sandbox/.test(h))a.push('--sandbox');
    // Antigravity bounds print mode itself and defaults to 5m. Left unset, the
    // host gave up at its own default while the harness waited out a 15m spawn
    // timeout, so a budget overrun surfaced as a host FAIL rather than a clean
    // timeout. Where the host has an in-band bound it gets the same budget the
    // spawn is given. Claude and Codex advertise no such flag, so for them the
    // spawn timeout stays the only bound -- which is why every invocation
    // reports max_wall_ms below rather than leaving it implicit in the argv.
    if(/--print-timeout/.test(h))a.push('--print-timeout',goDuration(maxWallMs));
  }
  const tooLong=argvLimitProblem(a);
  if(tooLong)return {status:'PENDING',...tooLong,argv:null,version:p.version,max_wall_ms:maxWallMs};
  // The budget is part of the invocation contract, not a private detail of the
  // spawn: `provider-command` hands this document to a caller who may run the
  // argv themselves, and on Claude and Codex nothing in the argv says when to
  // give up.
  return {status:'READY',argv:a,version:p.version,max_wall_ms:maxWallMs,max_turns:budget.maxTurns??null};
}

export function runHost(host,prompt,schemaPath,budget={},{spawn=spawnSync,launch=resolveLaunch}={}){
  const inv=buildInvocation(host,prompt,schemaPath,budget,{spawn,launch});
  if(inv.status!=='READY')return inv;
  const r=spawnHost(spawn,inv.argv[0],inv.argv.slice(1),
    {encoding:'utf8',timeout:inv.max_wall_ms,maxBuffer:20*1024*1024},launch);
  // A spawn that timed out or never started has no exit code. Reporting 1 there
  // made a wall-clock timeout indistinguishable from a host that ran and failed,
  // which is exactly the distinction the fallback policy needs.
  const errorCode=r?.error?String(r.error.code||r.error.message):null;
  return {
    ...inv,
    exit_code:r?.status??null,
    stdout:r?.stdout||'',stderr:r?.stderr||'',
    timed_out:errorCode==='ETIMEDOUT'||(r?.status==null&&r?.signal!=null&&!!inv.max_wall_ms),
    error:errorCode,
    status:r?.status===0?'PASS':'FAIL'
  };
}

/**
 * Execute an LLM host turn with adaptive dynamic failover across candidates.
 * Automatically tries candidates in order; if candidate A fails or times out,
 * attempts candidate B while recording the fallback event.
 */
export function executeWithAdaptiveFailover(prompt, schemaPath, budget = {}, {
  candidates = ['claude', 'codex', 'antigravity'],
  spawn = spawnSync,
  launch = resolveLaunch
} = {}) {
  const attempts = [];
  let successfulResult = null;

  for (const host of candidates) {
    const res = runHost(host, prompt, schemaPath, budget, { spawn, launch });
    attempts.push({ host, status: res.status, error: res.error, timed_out: res.timed_out });
    if (res.status === 'PASS') {
      successfulResult = {
        ...res,
        host,
        failover_occurred: attempts.length > 1,
        attempts
      };
      break;
    }
  }

  if (successfulResult) return successfulResult;

  return {
    status: 'FAIL',
    reason: 'ALL_CANDIDATES_FAILED',
    attempts,
    failover_occurred: attempts.length > 1
  };
}

/**
 * Format a cacheable prompt package for a specific provider/host CLI.
 * If host supports structured prompt caching blocks, outputs the multi-part structure;
 * otherwise returns the unified full_prompt string.
 */
export function formatProviderPrompt(host, cacheablePrompt) {
  if (typeof cacheablePrompt === 'string') return { prompt: cacheablePrompt, cache_enabled: false };
  const fullPrompt = cacheablePrompt.full_prompt || '';
  if (!cacheablePrompt.cache_blocks) {
    return { prompt: fullPrompt, cache_enabled: false };
  }

  if (host === 'claude') {
    return {
      prompt: fullPrompt,
      cache_enabled: true,
      provider: 'anthropic',
      cache_control: { type: 'ephemeral' },
      blocks: cacheablePrompt.cache_blocks
    };
  }

  if (host === 'antigravity') {
    return {
      prompt: fullPrompt,
      cache_enabled: true,
      provider: 'google-antigravity',
      cache_control: { type: 'context_cache' },
      blocks: cacheablePrompt.cache_blocks
    };
  }

  return {
    prompt: fullPrompt,
    cache_enabled: false,
    provider: host || 'generic',
    blocks: cacheablePrompt.cache_blocks
  };
}

