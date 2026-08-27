#!/usr/bin/env node
// State compatibility suite.
//
// runtime/compat.mjs answers "can this harness operate this project's state, and
// what changed since it was written". It sat at 35% coverage with one assertion
// against it, and it is the module a user reaches for precisely when their state
// looks wrong -- so its failure modes matter more than its happy path.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync,spawnSync} from 'node:child_process';
import {initProject} from '../runtime/store.mjs';
import {compatCheck,migrateState,stateSchema} from '../runtime/compat.mjs';
import {createSuite} from './lib/suite.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const VERSION=JSON.parse(fs.readFileSync(path.join(ROOT,'agent-sdlc.manifest.json'),'utf8')).version;
const {test,assert,finish}=createSuite('agent-sdlc/compat-validation/v1','COMPAT-VALIDATION.json');

/** A bare directory: a git repo with no harness state at all. */
function bare(){
  const d=fs.mkdtempSync(path.join(os.tmpdir(),'agent-sdlc-compat-'));
  execFileSync('git',['init','-q'],{cwd:d});
  return d;
}
function initialized(){
  const d=bare();
  initProject(d,{schema:'agent-sdlc/project/v1',project:'compat-fixture',commands:{}});
  return d;
}
const statePath=d=>path.join(d,'.agent-sdlc','state.json');
const readState=d=>JSON.parse(fs.readFileSync(statePath(d),'utf8'));
const writeState=(d,v)=>fs.writeFileSync(statePath(d),JSON.stringify(v,null,2)+'\n');

// --- discovery -------------------------------------------------------------
test('an-uninitialized-project-is-compatible-and-says-what-to-run',()=>{
  const c=compatCheck(ROOT,bare());
  assert(c.status==='UNINITIALIZED'&&c.compatible===true,JSON.stringify(c));
  assert(/init/.test(c.action),'no action given');
  assert(c.harness_version===VERSION,c.harness_version);
});
test('a-v2-project-is-refused-not-converted',()=>{
  const d=bare();
  fs.mkdirSync(path.join(d,'.ai-workflow'),{recursive:true});
  const c=compatCheck(ROOT,d);
  assert(c.status==='LEGACY_V2_DETECTED'&&c.compatible===false,JSON.stringify(c));
  assert(/Do not auto-convert/.test(c.action),'the refusal does not explain the manual path');
  let refused=false;
  try{migrateState(ROOT,d);}catch(e){refused=/LEGACY_V2_DETECTED/.test(e.message);}
  assert(refused,'a v2 project was migrated automatically');
});
test('a-freshly-initialized-project-is-compatible',()=>{
  const c=compatCheck(ROOT,initialized());
  assert(c.status==='COMPATIBLE'&&c.compatible===true,JSON.stringify(c));
  assert(c.state.schema===stateSchema,c.state.schema);
  assert(c.state.harness_version===VERSION,c.state.harness_version);
});
test('state-metadata-can-be-added-to-a-project-that-predates-it',()=>{
  const d=initialized();
  fs.rmSync(statePath(d));
  const c=compatCheck(ROOT,d);
  assert(c.status==='MIGRATION_AVAILABLE'&&c.compatible===true,JSON.stringify(c));
  const m=migrateState(ROOT,d);
  assert(m.status==='MIGRATED',JSON.stringify(m));
  assert(m.state.schema===stateSchema&&m.state.harness_version===VERSION,JSON.stringify(m.state));
  assert(compatCheck(ROOT,d).status==='COMPATIBLE','migration did not settle the project');
});
test('an-unknown-schema-is-incompatible-and-not-migrated',()=>{
  const d=initialized();
  writeState(d,{schema:'agent-sdlc/state/v99',harness_version:VERSION});
  const c=compatCheck(ROOT,d);
  assert(c.status==='INCOMPATIBLE_SCHEMA'&&c.compatible===false,JSON.stringify(c));
  let refused=false;
  try{migrateState(ROOT,d);}catch(e){refused=/INCOMPATIBLE_SCHEMA/.test(e.message);}
  assert(refused,'an unknown state schema was migrated');
});

// --- unreadable state ------------------------------------------------------
test('unreadable-state-is-diagnosed-not-thrown',()=>{
  // Regression: compatCheck read state.json with a bare JSON.parse, so the
  // command you run to diagnose broken state failed on the broken state -- and
  // a truncated state.json is exactly what a non-atomic write left behind.
  for(const body of ['{"schema":"agent-sdlc/sta','','not json at all','[]\0']){
    const d=initialized();
    fs.writeFileSync(statePath(d),body);
    let c;
    try{c=compatCheck(ROOT,d);}catch(e){throw new Error(`threw on ${JSON.stringify(body.slice(0,12))}: ${e.message}`);}
    if(body==='[]\0')continue; // parses on some inputs; only the throw matters
    assert(c.status==='CORRUPT_STATE'&&c.compatible===false,`${JSON.stringify(body.slice(0,12))} -> ${JSON.stringify(c)}`);
    assert(c.detail&&c.action,'no detail or recovery action reported');
    assert(/runs and artifacts are unaffected/.test(c.action),'the action does not say what is at risk');
  }
});
test('migration-refuses-to-touch-unreadable-state',()=>{
  const d=initialized();
  fs.writeFileSync(statePath(d),'{truncated');
  let refused=false;
  try{migrateState(ROOT,d);}catch(e){refused=/CORRUPT_STATE/.test(e.message);}
  assert(refused,'migration proceeded over unreadable state');
  assert(fs.readFileSync(statePath(d),'utf8')==='{truncated','the unreadable file was modified anyway');
});

// --- harness version drift -------------------------------------------------
test('a-harness-version-change-is-reported',()=>{
  // Regression: this reported COMPATIBLE while the same document showed two
  // disagreeing versions, and migrate answered NOOP.
  const d=initialized();
  writeState(d,{...readState(d),harness_version:'3.0.0-alpha4'});
  const c=compatCheck(ROOT,d);
  assert(c.status==='HARNESS_VERSION_CHANGED',JSON.stringify(c));
  assert(c.compatible===true,'a compatible schema was called incompatible');
  assert(c.state_harness_version==='3.0.0-alpha4'&&c.harness_version===VERSION,JSON.stringify(c));
  assert(c.action.includes('3.0.0-alpha4')&&c.action.includes(VERSION),c.action);
});
test('migration-records-the-version-change-and-backs-up-the-file-it-rewrites',()=>{
  const d=initialized();
  const before=readState(d);
  writeState(d,{...before,harness_version:'3.0.0-alpha4'});
  const m=migrateState(ROOT,d);
  assert(m.status==='HARNESS_VERSION_RECORDED',JSON.stringify(m));
  assert(m.from==='3.0.0-alpha4'&&m.to===VERSION,JSON.stringify(m));
  const after=readState(d);
  assert(after.harness_version===VERSION,after.harness_version);
  assert(after.created_at===before.created_at,'creation time was rewritten');
  assert(after.last_migrated_at,'no migration timestamp');
  assert(after.migrations.length===1&&after.migrations[0].from==='3.0.0-alpha4','history not recorded');
  const backups=fs.readdirSync(path.join(d,'.agent-sdlc')).filter(f=>/^state\.backup-\d+\.json$/.test(f));
  assert(backups.length===1,`expected one state backup, found ${backups.length}`);
  assert(JSON.parse(fs.readFileSync(path.join(d,'.agent-sdlc',backups[0]),'utf8')).harness_version==='3.0.0-alpha4','the backup is not the pre-migration state');
  // The file migration never touches must not be copied.
  assert(!fs.readdirSync(path.join(d,'.agent-sdlc')).some(f=>f.startsWith('project.backup-')),'project.json was backed up by a migration that does not touch it');
  assert(compatCheck(ROOT,d).status==='COMPATIBLE','the recorded change did not settle the project');
});
test('migration-history-accumulates-and-is-idempotent',()=>{
  const d=initialized();
  writeState(d,{...readState(d),harness_version:'3.0.0-alpha4'});
  migrateState(ROOT,d);
  assert(migrateState(ROOT,d).status==='NOOP','a second migration was not a no-op');
  writeState(d,{...readState(d),harness_version:'3.0.0-alpha5'});
  const second=migrateState(ROOT,d);
  assert(second.status==='HARNESS_VERSION_RECORDED',JSON.stringify(second));
  const history=readState(d).migrations;
  assert(history.length===2,`history length ${history.length}`);
  assert(history[0].from==='3.0.0-alpha4'&&history[1].from==='3.0.0-alpha5',JSON.stringify(history));
});
test('state-that-does-not-record-its-harness-is-stamped-not-refused',()=>{
  // check and migrate must agree: reporting COMPATIBLE while migrate still
  // rewrites the file would make "nothing to do" a lie.
  const d=initialized();
  writeState(d,{schema:stateSchema});
  const c=compatCheck(ROOT,d);
  assert(c.status==='MIGRATION_AVAILABLE'&&c.compatible===true,JSON.stringify(c));
  const m=migrateState(ROOT,d);
  assert(m.status==='HARNESS_VERSION_RECORDED'&&m.from===null&&m.to===VERSION,JSON.stringify(m));
  assert(readState(d).harness_version===VERSION,'the version was not stamped');
  assert(compatCheck(ROOT,d).status==='COMPATIBLE','stamping did not settle the project');
});

// --- CLI surface -----------------------------------------------------------
test('the-cli-reports-corrupt-state-without-a-stack-trace',()=>{
  const d=initialized();
  fs.writeFileSync(statePath(d),'{truncated');
  const check=spawnSync(process.execPath,[path.join(ROOT,'runtime','cli.mjs'),'compat-check','--project',d],{encoding:'utf8'});
  assert(check.status===0,`compat-check exited ${check.status}`);
  assert(JSON.parse(check.stdout).status==='CORRUPT_STATE',check.stdout.slice(0,200));
  const migrate=spawnSync(process.execPath,[path.join(ROOT,'runtime','cli.mjs'),'migrate','--project',d],{encoding:'utf8'});
  assert(migrate.status===1,`migrate exited ${migrate.status}`);
  const err=JSON.parse(migrate.stderr||'{}');
  assert(err.status==='ERROR'&&/CORRUPT_STATE/.test(err.error),migrate.stderr.slice(0,200));
});

finish({harness_version:VERSION});
