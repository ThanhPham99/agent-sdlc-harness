#!/usr/bin/env node
// Development loop: make the host load this working tree.
//
// Claude Code loads the plugin from its own cache directory, not from the
// checkout. Editing a skill, hook or runtime file here therefore changes
// nothing in a live session, and the cache silently lags behind the repository
// (an alpha4 cache against an alpha6 tree during this project's own work). That
// makes every dev iteration debug the wrong copy.
//
// This reports the drift, and can replace the cached version directory with a
// link to this working tree so the host reads what you edit. It is reversible:
// the original directory is renamed aside, never deleted, and --revert puts it
// back. Nothing here runs in CI.
//
//   node scripts/dev-link.mjs             status only (default, read-only)
//   node scripts/dev-link.mjs --apply     link the cache entry to this tree
//   node scripts/dev-link.mjs --revert    restore the cached directory
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const PLUGIN='agent-sdlc-harness';
const BACKUP_SUFFIX='.pre-dev-link';
const argv=process.argv.slice(2);
const mode=argv.includes('--revert')?'revert':argv.includes('--apply')?'apply':'status';

const repoVersion=fs.readFileSync(path.join(ROOT,'VERSION'),'utf8').trim();

function hostHome(){
  // CLAUDE_CONFIG_DIR is the documented override; fall back to ~/.claude.
  const explicit=process.env.AGENT_SDLC_CLAUDE_HOME||process.env.CLAUDE_CONFIG_DIR;
  return explicit?path.resolve(explicit):path.join(os.homedir(),'.claude');
}

/** Records the host holds for this plugin, whatever marketplace installed it. */
function installedRecords(){
  const p=path.join(hostHome(),'plugins','installed_plugins.json');
  if(!fs.existsSync(p))return {path:p,present:false,records:[]};
  const doc=JSON.parse(fs.readFileSync(p,'utf8'));
  const records=[];
  for(const [key,entries] of Object.entries(doc.plugins||{})){
    if(!key.startsWith(`${PLUGIN}@`))continue;
    for(const e of entries||[])records.push({key,...e});
  }
  return {path:p,present:true,records};
}

const linkKind=p=>{
  try{return fs.lstatSync(p).isSymbolicLink()?'link':'directory';}catch{return 'missing';}
};
const linkTarget=p=>{try{return fs.readlinkSync(p);}catch{return null;}};
const sameTree=(a,b)=>!!a&&!!b&&path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase();

/** The cache path we are allowed to touch, or a reason we are not. */
function guard(installPath){
  const segments=installPath.split(path.sep);
  if(!segments.includes('plugins')||!segments.includes('cache')){
    return `refusing to modify ${installPath}: not inside a host plugins cache`;
  }
  if(path.resolve(installPath).toLowerCase()===ROOT.toLowerCase()){
    return `refusing to modify ${installPath}: that is this working tree`;
  }
  return null;
}

function describe(record){
  const installPath=record.installPath;
  const kind=linkKind(installPath);
  const target=kind==='link'?linkTarget(installPath):null;
  const linkedHere=sameTree(target,ROOT);
  let loadedVersion=null;
  try{loadedVersion=fs.readFileSync(path.join(installPath,'VERSION'),'utf8').trim();}catch{}
  return {
    key:record.key,
    install_path:installPath,
    recorded_version:record.version??null,
    loaded_version:loadedVersion,
    repo_version:repoVersion,
    entry:kind,
    link_target:target,
    linked_to_this_tree:linkedHere,
    backup_present:fs.existsSync(installPath+BACKUP_SUFFIX),
    drift:linkedHere?null:(loadedVersion===repoVersion?null:`host loads ${loadedVersion??'unknown'}, working tree is ${repoVersion}`)
  };
}

function apply(record){
  const installPath=record.installPath;
  const blocked=guard(installPath);
  if(blocked)return {action:'REFUSED',reason:blocked};
  if(sameTree(linkTarget(installPath),ROOT))return {action:'ALREADY_LINKED'};
  const backup=installPath+BACKUP_SUFFIX;
  if(fs.existsSync(backup))return {action:'REFUSED',reason:`${backup} already exists; run --revert first`};
  const existed=linkKind(installPath);
  if(existed==='link')removeLink(installPath);
  else if(existed==='directory')fs.renameSync(installPath,backup);
  fs.mkdirSync(path.dirname(installPath),{recursive:true});
  // 'junction' works on Windows without developer mode or elevation; it is
  // ignored on other platforms, where a directory symlink is created.
  fs.symlinkSync(ROOT,installPath,'junction');
  const loaded=fs.readFileSync(path.join(installPath,'VERSION'),'utf8').trim();
  return {action:'LINKED',backup:existed==='directory'?backup:null,loaded_version:loaded};
}

/**
 * Remove the link entry only. A recursive delete would follow a junction into
 * the working tree and delete the repository, so it is never used here.
 */
function removeLink(p){
  try{fs.rmdirSync(p);}catch{fs.unlinkSync(p);}
}

function revert(record){
  const installPath=record.installPath;
  const blocked=guard(installPath);
  if(blocked)return {action:'REFUSED',reason:blocked};
  if(linkKind(installPath)!=='link')return {action:'NOT_LINKED'};
  const backup=installPath+BACKUP_SUFFIX;
  removeLink(installPath);
  if(fs.existsSync(backup)){fs.renameSync(backup,installPath);return {action:'RESTORED',from:backup};}
  return {action:'UNLINKED',note:'no backup existed; reinstall the plugin to restore a cached copy'};
}

const {path:recordPath,present,records}=installedRecords();
const report={
  schema:'agent-sdlc/dev-link/v1',
  mode,
  repo_root:ROOT,
  repo_version:repoVersion,
  host_record:recordPath,
  host_record_present:present,
  plugins:records.map(r=>({...describe(r),...(mode==='apply'?{result:apply(r)}:mode==='revert'?{result:revert(r)}:{})}))
};
if(!records.length){
  report.note=present
    ?`no ${PLUGIN} install recorded for this host; install it once, then re-run with --apply`
    :`no host record at ${recordPath}; set CLAUDE_CONFIG_DIR if the host config lives elsewhere`;
}
if(mode==='status'&&records.some(r=>describe(r).drift))report.hint='run: npm run dev:link';
console.log(JSON.stringify(report,null,2));
const refused=report.plugins.some(p=>p.result?.action==='REFUSED');
process.exit(refused?1:0);
