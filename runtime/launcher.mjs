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
    try{
      if(!fs.statSync(c).isFile())continue;
      // Windows filesystems are case-insensitive but case-preserving: a
      // candidate built from PATHEXT casing (e.g. ".CMD") can stat-match a
      // file actually named "npm.cmd". Normalize to the on-disk casing so
      // callers (and cmd.exe) see the real name rather than our guess. This
      // is scoped to win32 only: realpathSync also follows symlinks to their
      // real target, which is how many POSIX toolchains install (a PATH
      // entry symlinked to a .js file) -- resolving through it there would
      // wrongly flip `via` from 'direct' to 'node' for those installs.
      if(platform==='win32'){try{return fs.realpathSync.native(c);}catch{return c;}}
      return c;
    }catch{/* next candidate */}
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
