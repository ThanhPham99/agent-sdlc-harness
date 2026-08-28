// Read-only half of the dev-link check: is the host's cached copy of this
// plugin stale relative to (or linked to) this codebase's own root.
//
// Lives in runtime/, not scripts/, so `doctor` -- which ships in the
// distributed package (scripts/build-dist.mjs's `common` list has no
// `scripts` entry) -- can report the same drift a plugin developer would
// otherwise only see by remembering to run `node scripts/dev-link.mjs`.
// scripts/dev-link.mjs imports these for its CLI and adds the mutating
// apply/revert actions, which stay dev-only and out of the shipped package.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const PLUGIN='agent-sdlc-harness';
export const BACKUP_SUFFIX='.pre-dev-link';

// CLAUDE_CONFIG_DIR is the documented override; fall back to ~/.claude.
export function hostHome(){
  const explicit=process.env.AGENT_SDLC_CLAUDE_HOME||process.env.CLAUDE_CONFIG_DIR;
  return explicit?path.resolve(explicit):path.join(os.homedir(),'.claude');
}

/** Records the host holds for this plugin, whatever marketplace installed it. */
export function installedRecords(){
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

export const linkKind=p=>{try{return fs.lstatSync(p).isSymbolicLink()?'link':'directory';}catch{return 'missing';}};
export const linkTarget=p=>{try{return fs.readlinkSync(p);}catch{return null;}};
export const sameTree=(a,b)=>!!a&&!!b&&path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase();

export function describeRecord(record,{root,repoVersion}){
  const installPath=record.installPath;
  const kind=linkKind(installPath);
  const target=kind==='link'?linkTarget(installPath):null;
  const linkedHere=sameTree(target,root);
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

/** Status-mode report: no mutation, safe to call from `doctor` on every run. */
export function driftStatus(root,repoVersion){
  const {path:recordPath,present,records}=installedRecords();
  const plugins=records.map(r=>describeRecord(r,{root,repoVersion}));
  const report={
    schema:'agent-sdlc/dev-link/v1',
    mode:'status',
    repo_root:root,
    repo_version:repoVersion,
    host_record:recordPath,
    host_record_present:present,
    plugins
  };
  if(!records.length){
    report.note=present
      ?`no ${PLUGIN} install recorded for this host; install it once, then re-run with --apply`
      :`no host record at ${recordPath}; set CLAUDE_CONFIG_DIR if the host config lives elsewhere`;
  }
  if(plugins.some(p=>p.drift))report.hint='run: npm run dev:link';
  return report;
}
