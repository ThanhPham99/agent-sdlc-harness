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
//
// The read-only status check lives in runtime/dev-link.mjs, not here, so
// `doctor` -- which ships in the distributed package, unlike this scripts/
// tree -- can report the same drift without a plugin developer remembering to
// run this script by hand.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {installedRecords,antigravityPluginPath,linkKind,linkTarget,sameTree,describeRecord,driftStatus,BACKUP_SUFFIX} from '../runtime/dev-link.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const argv=process.argv.slice(2);
const mode=argv.includes('--revert')?'revert':argv.includes('--apply')?'apply':'status';

const repoVersion=fs.readFileSync(path.join(ROOT,'VERSION'),'utf8').trim();
const describe=record=>describeRecord(record,{root:ROOT,repoVersion});

/** The cache path we are allowed to touch, or a reason we are not. */
function guard(installPath){
  const segments=installPath.split(path.sep);
  const isClaudeCache=segments.includes('plugins')&&segments.includes('cache');
  const isAntigravity=path.resolve(installPath).toLowerCase()===path.resolve(antigravityPluginPath()).toLowerCase()||(segments.includes('plugins')&&segments.includes('agent-sdlc-harness'));
  if(!isClaudeCache&&!isAntigravity){
    return `refusing to modify ${installPath}: not inside a host plugins cache`;
  }
  if(path.resolve(installPath).toLowerCase()===ROOT.toLowerCase()){
    return `refusing to modify ${installPath}: that is this working tree`;
  }
  return null;
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
  else if(existed==='directory'){
    fs.renameSync(installPath,backup);
    const backupPluginJson=path.join(backup,'plugin.json');
    if(fs.existsSync(backupPluginJson)){
      try{fs.renameSync(backupPluginJson,backupPluginJson+'.disabled');}catch{}
    }
  }
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
  if(fs.existsSync(backup)){
    const disabledPluginJson=path.join(backup,'plugin.json.disabled');
    if(fs.existsSync(disabledPluginJson)){
      try{fs.renameSync(disabledPluginJson,path.join(backup,'plugin.json'));}catch{}
    }
    fs.renameSync(backup,installPath);
    return {action:'RESTORED',from:backup};
  }
  return {action:'UNLINKED',note:'no backup existed; reinstall the plugin to restore a cached copy'};
}

function main(){
  if(mode==='status'){
    console.log(JSON.stringify(driftStatus(ROOT,repoVersion),null,2));
    process.exit(0);
  }
  const {path:recordPath,present,records}=installedRecords();
  const report={
    schema:'agent-sdlc/dev-link/v1',
    mode,
    repo_root:ROOT,
    repo_version:repoVersion,
    host_record:recordPath,
    host_record_present:present,
    plugins:records.map(r=>({...describe(r),result:mode==='apply'?apply(r):revert(r)}))
  };
  if(!records.length){
    report.note=present
      ?`no agent-sdlc-harness install recorded for this host; install it once, then re-run with --apply`
      :`no host record at ${recordPath}; set CLAUDE_CONFIG_DIR or AGENT_SDLC_ANTIGRAVITY_HOME if the host config lives elsewhere`;
  }
  console.log(JSON.stringify(report,null,2));
  const refused=report.plugins.some(p=>p.result?.action==='REFUSED');
  process.exit(refused?1:0);
}

main();
