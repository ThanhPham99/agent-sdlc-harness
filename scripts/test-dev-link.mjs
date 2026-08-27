#!/usr/bin/env node
// scripts/dev-link.mjs edits a host plugin cache and creates a directory link
// into this working tree, so it is exercised against a synthetic host root
// rather than the developer's real one.
//
// The load-bearing property: reverting must remove only the link. A recursive
// delete would follow the junction into the working tree and delete the
// repository, so the fixture asserts the tree is still intact afterwards.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createSuite} from './lib/suite.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const SCRIPT=path.join(ROOT,'scripts','dev-link.mjs');
const {test,assert,finish}=createSuite('agent-sdlc/dev-link-validation/v1','DEV-LINK-VALIDATION.json');

/** A host root shaped like ~/.claude, with one recorded install. */
function hostFixture(version='3.0.0-alpha4'){
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'agent-sdlc-host-'));
  const installPath=path.join(home,'plugins','cache','agent-sdlc-github','agent-sdlc-harness',version);
  fs.mkdirSync(installPath,{recursive:true});
  fs.writeFileSync(path.join(installPath,'VERSION'),`${version}\n`);
  fs.writeFileSync(path.join(installPath,'marker.txt'),'cached copy\n');
  fs.writeFileSync(path.join(home,'plugins','installed_plugins.json'),JSON.stringify({
    version:2,
    plugins:{'agent-sdlc-harness@agent-sdlc-github':[{scope:'user',installPath,version}]}
  },null,2));
  return {home,installPath};
}

const run=(home,args=[])=>JSON.parse(execFileSync(process.execPath,[SCRIPT,...args],
  {encoding:'utf8',env:{...process.env,AGENT_SDLC_CLAUDE_HOME:home}}));

const repoVersion=fs.readFileSync(path.join(ROOT,'VERSION'),'utf8').trim();

test('status-reports-drift-without-touching-the-cache',()=>{
  const {home,installPath}=hostFixture();
  const out=run(home);
  if(out.mode!=='status')throw Error(out.mode);
  if(!out.plugins[0].drift)throw Error('drift not reported');
  if(out.plugins[0].entry!=='directory')throw Error('cache entry changed by a status run');
  if(!fs.existsSync(path.join(installPath,'marker.txt')))throw Error('status run modified the cache');
});

test('apply-links-the-host-to-this-working-tree',()=>{
  const {home,installPath}=hostFixture();
  const out=run(home,['--apply']);
  const r=out.plugins[0];
  if(r.result.action!=='LINKED')throw Error(JSON.stringify(r.result));
  if(fs.readFileSync(path.join(installPath,'VERSION'),'utf8').trim()!==repoVersion)throw Error('host still loads the cached version');
  if(!fs.existsSync(path.join(installPath,'skills','sdlc-router','SKILL.md')))throw Error('working tree not visible through the link');
  if(!fs.existsSync(installPath+'.pre-dev-link'))throw Error('original cache directory was not preserved');
});

test('apply-is-idempotent',()=>{
  const {home}=hostFixture();
  run(home,['--apply']);
  const again=run(home,['--apply']);
  if(again.plugins[0].result.action!=='ALREADY_LINKED')throw Error(JSON.stringify(again.plugins[0].result));
});

test('revert-restores-the-cache-and-leaves-the-repo-intact',()=>{
  const {home,installPath}=hostFixture();
  run(home,['--apply']);
  const out=run(home,['--revert']);
  if(out.plugins[0].result.action!=='RESTORED')throw Error(JSON.stringify(out.plugins[0].result));
  if(fs.readFileSync(path.join(installPath,'VERSION'),'utf8').trim()!=='3.0.0-alpha4')throw Error('cached copy not restored');
  if(fs.readFileSync(path.join(installPath,'marker.txt'),'utf8')!=='cached copy\n')throw Error('cached content lost');
  // The reason this suite exists.
  for(const rel of ['VERSION','package.json','runtime/store.mjs','skills/sdlc-router/SKILL.md']){
    if(!fs.existsSync(path.join(ROOT,rel)))throw Error(`revert deleted ${rel} from the working tree`);
  }
});

test('refuses-a-path-outside-a-plugins-cache',()=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'agent-sdlc-host-'));
  const installPath=path.join(home,'somewhere','else');
  fs.mkdirSync(installPath,{recursive:true});
  fs.mkdirSync(path.join(home,'plugins'),{recursive:true});
  fs.writeFileSync(path.join(home,'plugins','installed_plugins.json'),JSON.stringify({
    version:2,plugins:{'agent-sdlc-harness@agent-sdlc-github':[{scope:'user',installPath,version:'x'}]}
  }));
  let refused=false;
  try{run(home,['--apply']);}catch(e){refused=/refusing to modify/.test(e.stdout||'');}
  if(!refused)throw Error('modified a path outside the plugins cache');
  if(fs.existsSync(installPath+'.pre-dev-link'))throw Error('cache directory was moved anyway');
});

test('missing-host-record-is-reported-not-crashed',()=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'agent-sdlc-host-'));
  const out=run(home,['--apply']);
  if(out.host_record_present)throw Error('claimed a record exists');
  if(!out.note)throw Error('no explanation for the empty result');
});

finish();
