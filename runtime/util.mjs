import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
export const now=()=>new Date().toISOString();
export const sha256=(x)=>crypto.createHash('sha256').update(x).digest('hex');
export const ensureDir=(p)=>fs.mkdirSync(p,{recursive:true});
export const readJson=(p,fallback=null)=>{try{return JSON.parse(fs.readFileSync(p,'utf8'));}catch(e){if(fallback!==null)return fallback;throw e;}};
// Text that feeds a hash must not depend on how git checked the file out. With
// a CRLF worktree (Windows, or .gitattributes added after the initial checkout)
// raw reads make context_hash differ from Linux for the very same commit, which
// breaks the reproducibility the evidence model depends on.
export const normalizeText=(s)=>{let t=String(s??'');if(t.charCodeAt(0)===0xFEFF)t=t.slice(1);return t.replace(/\r\n?/g,'\n');};
export const readTextFile=(p)=>normalizeText(fs.readFileSync(p,'utf8'));
// Durable JSON write: a temp file plus rename, so an interrupted process leaves
// either the previous document or the new one, never a truncated one. Run state
// is rewritten on every transition, and a truncated run file is unrecoverable.
let writeSeq=0;
export const writeJson=(p,v)=>{
  ensureDir(path.dirname(p));
  const tmp=`${p}.${process.pid}.${writeSeq++}.tmp`;
  try{
    fs.writeFileSync(tmp,JSON.stringify(v,null,2)+'\n');
    fs.renameSync(tmp,p);
  }catch(e){
    try{fs.rmSync(tmp,{force:true});}catch{}
    throw e;
  }
};
export const appendJsonl=(p,v)=>{ensureDir(path.dirname(p));fs.appendFileSync(p,JSON.stringify(v)+'\n');};
// fileURLToPath is required for Windows: URL.pathname yields "/D:/..." which
// path.resolve then re-anchors to the current drive ("D:\D:\...").
export function rootFrom(importMetaUrl){return path.resolve(path.dirname(fileURLToPath(importMetaUrl)),'..');}
// The home directory the global config layer lives under, and the one override
// point for it.
//
// `os.homedir()` alone is not testable and not relocatable: it reads $HOME on
// POSIX but %USERPROFILE% on Windows, so a suite that pinned $HOME to a temp
// directory still wrote the developer's real ~/.agent-sdlc/config.json on
// Windows -- turning `activation enable --global` coverage into a machine-wide
// side effect. The sibling host paths already had an override each
// (AGENT_SDLC_CLAUDE_HOME, CODEX_HOME); this is the harness's own.
export function userHome(){
  const override=process.env.AGENT_SDLC_HOME;
  return override&&override.trim()?path.resolve(override):os.homedir();
}
export function globalConfigPath(){return path.join(userHome(),'.agent-sdlc','config.json');}
export function findProjectRoot(start=process.cwd()){let p=path.resolve(start); while(true){if(fs.existsSync(path.join(p,'.agent-sdlc','project.json')))return p; const parent=path.dirname(p); if(parent===p)return path.resolve(start); p=parent;}}
export function git(args,cwd){const r=spawnSync('git',args,{cwd,encoding:'utf8'});return {code:r.status??1,stdout:r.stdout||'',stderr:r.stderr||''};}
export function gitSha(cwd){const r=git(['rev-parse','HEAD'],cwd);return r.code===0?r.stdout.trim():null;}
export function dirtyHash(cwd){const r=git(['diff','--binary','HEAD'],cwd);return r.code===0?sha256(r.stdout):null;}
export function uuid(prefix='id'){return `${prefix}_${crypto.randomUUID()}`;}
export function estimateTokens(text,charsPerToken=4){return Math.ceil((text||'').length/charsPerToken);}
export function safeRelative(base,p){const abs=path.resolve(base,p); if(!abs.startsWith(path.resolve(base)+path.sep) && abs!==path.resolve(base)) throw new Error('path escapes project root'); return abs;}
/**
 * A boolean arriving from an untrusted boundary — an MCP argument or a CLI flag.
 *
 * `!!value` reads the string "false" as true, and hosts (and models driving
 * them) routinely serialize booleans as strings. That turned
 * `{"force": "false"}` into a full gate bypass: a run skipped two stages with no
 * evidence and no approval, from a caller that had explicitly said false.
 *
 * Use this for flags whose true value *removes* a protection (force, approved,
 * allow-*). Flags whose true value adds one (dry-run, no-*) stay permissive, so
 * an unparseable value fails safe in both directions.
 */
export function truthy(v){
  if(v===true)return true;
  if(typeof v==='number')return v===1;
  if(typeof v!=='string')return false;
  return ['true','1','yes','on'].includes(v.trim().toLowerCase());
}
export function parseArgs(argv){const out={_:[]}; for(let i=0;i<argv.length;i++){const a=argv[i]; if(a.startsWith('--')){const k=a.slice(2); const n=argv[i+1]; if(n!==undefined && !n.startsWith('--')){out[k]=n;i++;}else out[k]=true;} else out._.push(a);} return out;}
export function truncateUtf8(s,maxBytes){const b=Buffer.from(s||''); if(b.length<=maxBytes)return {text:s||'',truncated:false}; return {text:b.subarray(0,maxBytes).toString('utf8'),truncated:true};}
