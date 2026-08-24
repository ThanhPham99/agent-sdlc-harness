import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
export const now=()=>new Date().toISOString();
export const sha256=(x)=>crypto.createHash('sha256').update(x).digest('hex');
export const ensureDir=(p)=>fs.mkdirSync(p,{recursive:true});
export const readJson=(p,fallback=null)=>{try{return JSON.parse(fs.readFileSync(p,'utf8'));}catch(e){if(fallback!==null)return fallback;throw e;}};
export const writeJson=(p,v)=>{ensureDir(path.dirname(p));fs.writeFileSync(p,JSON.stringify(v,null,2)+'\n');};
export const appendJsonl=(p,v)=>{ensureDir(path.dirname(p));fs.appendFileSync(p,JSON.stringify(v)+'\n');};
export function rootFrom(importMetaUrl){return path.resolve(path.dirname(new URL(importMetaUrl).pathname),'..');}
export function findProjectRoot(start=process.cwd()){let p=path.resolve(start); while(true){if(fs.existsSync(path.join(p,'.agent-sdlc','project.json')))return p; const parent=path.dirname(p); if(parent===p)return path.resolve(start); p=parent;}}
export function git(args,cwd){const r=spawnSync('git',args,{cwd,encoding:'utf8'});return {code:r.status??1,stdout:r.stdout||'',stderr:r.stderr||''};}
export function gitSha(cwd){const r=git(['rev-parse','HEAD'],cwd);return r.code===0?r.stdout.trim():null;}
export function dirtyHash(cwd){const r=git(['diff','--binary','HEAD'],cwd);return r.code===0?sha256(r.stdout):null;}
export function uuid(prefix='id'){return `${prefix}_${crypto.randomUUID()}`;}
export function estimateTokens(text,charsPerToken=4){return Math.ceil((text||'').length/charsPerToken);}
export function safeRelative(base,p){const abs=path.resolve(base,p); if(!abs.startsWith(path.resolve(base)+path.sep) && abs!==path.resolve(base)) throw new Error('path escapes project root'); return abs;}
export function parseArgs(argv){const out={_:[]}; for(let i=0;i<argv.length;i++){const a=argv[i]; if(a.startsWith('--')){const k=a.slice(2); const n=argv[i+1]; if(n!==undefined && !n.startsWith('--')){out[k]=n;i++;}else out[k]=true;} else out._.push(a);} return out;}
export function truncateUtf8(s,maxBytes){const b=Buffer.from(s||''); if(b.length<=maxBytes)return {text:s||'',truncated:false}; return {text:b.subarray(0,maxBytes).toString('utf8'),truncated:true};}
