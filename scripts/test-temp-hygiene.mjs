#!/usr/bin/env node
// Temp-fixture hygiene.
//
// Suites work in throwaway directories under os.tmpdir(). Left behind they are
// invisible until they are not: 57,178 of them, dated across one week of
// development, filled the disk and killed a verification run mid-flight. The
// cleanup contract is therefore a gate, not a convention.
//
// The behavioural cases run real child processes, because the thing under test
// is what happens when a process ends -- including when it ends badly, which is
// exactly the case per-suite cleanup could never cover.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createSuite} from './lib/suite.mjs';
import {makeTempDir,registeredTempDirs,cleanupTempDirs} from './lib/tempdir.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const HELPER=path.join(ROOT,'scripts','lib','tempdir.mjs');
const {test,assert,finish}=createSuite('agent-sdlc/temp-hygiene-validation/v1','TEMP-HYGIENE-VALIDATION.json');

const PREFIX='agent-sdlc-temp-hygiene-probe-';
// A file URL, not a path: on Windows an absolute path with a drive letter is
// not a valid ESM specifier, and node resolves it against the importing
// module's directory instead of failing loudly.
const helperUrl=JSON.stringify(pathToFileURL(HELPER).href);

/**
 * Run a child that makes two fixtures through the helper and then ends the way
 * `ending` says. Returns the directories it created, so the parent can check
 * the filesystem after the child is gone.
 */
function child(ending,{env={}}={}){
  const body=[
    `import {makeTempDir} from ${helperUrl};`,
    `const a=makeTempDir(${JSON.stringify(PREFIX)});`,
    `const b=makeTempDir(${JSON.stringify(PREFIX)});`,
    `process.stdout.write(JSON.stringify([a,b]));`,
    ending
  ].join('\n');
  const dir=makeTempDir('agent-sdlc-temp-hygiene-');
  const file=path.join(dir,'probe.mjs');
  fs.writeFileSync(file,body);
  const r=spawnSync(process.execPath,[file],{encoding:'utf8',timeout:60000,env:{...process.env,...env}});
  let dirs=[];
  try{dirs=JSON.parse((r.stdout||'').trim());}catch{}
  return {dirs,code:r.status,stderr:r.stderr||''};
}

const gone=dirs=>dirs.filter(d=>fs.existsSync(d));

test('a-child-that-returns-normally-leaves-nothing-behind',()=>{
  const {dirs,code}=child('');
  assert(dirs.length===2,`the probe did not report its fixtures (exit ${code})`);
  assert(gone(dirs).length===0,`left behind: ${JSON.stringify(gone(dirs))}`);
});

// The case per-suite cleanup structurally could not cover: the cleanup line is
// never reached.
test('a-child-that-throws-leaves-nothing-behind',()=>{
  const {dirs,code}=child('throw new Error("suite blew up");');
  assert(dirs.length===2,'the probe did not report its fixtures');
  assert(code!==0,'a throwing probe should not exit 0');
  assert(gone(dirs).length===0,`left behind: ${JSON.stringify(gone(dirs))}`);
});

// Every suite ends this way: createSuite exits non-zero on failure.
test('a-child-that-calls-process-exit-leaves-nothing-behind',()=>{
  const {dirs,code}=child('process.exit(1);');
  assert(dirs.length===2,'the probe did not report its fixtures');
  assert(code===1,`expected exit 1, got ${code}`);
  assert(gone(dirs).length===0,`left behind: ${JSON.stringify(gone(dirs))}`);
});

// An explicit rmSync inside a long suite is still worth having -- it frees
// space before the suite ends. The exit handler has to tolerate meeting a
// directory that is already gone, or the old cleanup lines would have to be
// deleted alongside this change.
test('a-directory-the-suite-already-removed-is-not-an-error',()=>{
  const d=makeTempDir(PREFIX);
  fs.rmSync(d,{recursive:true,force:true});
  assert(registeredTempDirs().includes(d),'a removed directory should stay registered');
  const removed=cleanupTempDirs();
  assert(removed.includes(d),'cleanup skipped an already-removed directory instead of tolerating it');
  assert(!fs.existsSync(d),'the directory came back');
});

test('the-escape-hatch-keeps-fixtures-and-says-so',()=>{
  const {dirs,stderr}=child('',{env:{AGENT_SDLC_KEEP_TEMP:'1'}});
  assert(dirs.length===2,'the probe did not report its fixtures');
  assert(gone(dirs).length===2,'AGENT_SDLC_KEEP_TEMP did not keep the fixtures');
  assert(/AGENT_SDLC_KEEP_TEMP/.test(stderr),`kept silently: ${stderr.slice(0,200)}`);
  for(const d of dirs)fs.rmSync(d,{recursive:true,force:true});
});

test('the-helper-creates-under-the-system-temp-directory',()=>{
  const d=makeTempDir(PREFIX);
  assert(fs.existsSync(d),'the helper returned a path it did not create');
  assert(path.resolve(d).startsWith(path.resolve(os.tmpdir())),`${d} is not under ${os.tmpdir()}`);
});

finish();
