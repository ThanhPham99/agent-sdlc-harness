// Portable zip/unzip helpers. Info-ZIP is used when present (CI, macOS, Linux);
// Windows falls back to PowerShell Compress-Archive/Expand-Archive so the same
// build and verification scripts run on every developer machine.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

const has=bin=>{
  const probe=spawnSync(bin,['-h'],{encoding:'utf8'});
  return !probe.error;
};
const powershell=()=>['pwsh','powershell'].find(has);
function run(bin,args,opts={}){
  const r=spawnSync(bin,args,{encoding:'utf8',maxBuffer:20*1024*1024,...opts});
  if(r.error)throw new Error(`${bin} failed to start: ${r.error.message}`);
  if(r.status!==0)throw new Error(`${bin} exited ${r.status}: ${(r.stderr||r.stdout||'').trim().slice(0,600)}`);
  return r;
}

export function zipDir(dir,zipPath){
  fs.rmSync(zipPath,{force:true});
  const cwd=path.dirname(dir);
  const base=path.basename(dir);
  if(has('zip')){run('zip',['-qr',zipPath,base],{cwd});return {tool:'zip'};}
  const ps=powershell();
  if(!ps)throw new Error('no archiver available: install Info-ZIP `zip` or PowerShell');
  run(ps,['-NoProfile','-NonInteractive','-Command',`Compress-Archive -Path '${dir}' -DestinationPath '${zipPath}' -Force`]);
  return {tool:ps};
}

export function unzipTo(zipPath,destDir){
  fs.mkdirSync(destDir,{recursive:true});
  if(has('unzip')){run('unzip',['-q',zipPath,'-d',destDir]);return {tool:'unzip'};}
  const ps=powershell();
  if(!ps)throw new Error('no extractor available: install Info-ZIP `unzip` or PowerShell');
  run(ps,['-NoProfile','-NonInteractive','-Command',`Expand-Archive -Path '${zipPath}' -DestinationPath '${destDir}' -Force`]);
  return {tool:ps};
}
