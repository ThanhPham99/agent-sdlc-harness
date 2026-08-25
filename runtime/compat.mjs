import fs from 'node:fs';
import path from 'node:path';
import {readJson,writeJson,now} from './util.mjs';
import {stateDir} from './store.mjs';

// Compatibility between a project's persisted state and the harness operating
// it. Two rules shape this module:
//
//   * `compat-check` is the command you run when state looks wrong, so it must
//     never fail on the state it is diagnosing. An unreadable state.json used to
//     escape as a raw JSON SyntaxError -- from exactly the file that was written
//     non-atomically until run-state writes were hardened.
//   * A harness version change is a fact about the run state, and facts get
//     recorded. The schema staying compatible was reported as COMPATIBLE with
//     nothing anywhere noting that a different harness version had taken over,
//     while the same document showed two disagreeing versions.
const STATE_SCHEMA='agent-sdlc/state/v1';

const harnessVersion=(root)=>readJson(path.join(root,'agent-sdlc.manifest.json')).version;

/** state.json, or why it cannot be read. */
function readState(metaPath){
  if(!fs.existsSync(metaPath))return {present:false,state:null,error:null};
  try{return {present:true,state:JSON.parse(fs.readFileSync(metaPath,'utf8')),error:null};}
  catch(e){return {present:true,state:null,error:String(e.message).slice(0,200)};}
}

export function compatCheck(root,projectRoot){
  const version=harnessVersion(root);
  const d=stateDir(projectRoot);
  const legacy=path.join(projectRoot,'.ai-workflow');
  if(!fs.existsSync(d)){
    if(fs.existsSync(legacy))return {status:'LEGACY_V2_DETECTED',compatible:false,harness_version:version,action:'Do not auto-convert. Export durable artifacts/confirmed requirements from .ai-workflow, initialize v3, then import them as artifacts.'};
    return {status:'UNINITIALIZED',compatible:true,harness_version:version,action:'run init'};
  }
  const metaPath=path.join(d,'state.json');
  const {present,state,error}=readState(metaPath);
  if(!present)return {status:'MIGRATION_AVAILABLE',compatible:true,harness_version:version,action:'run migrate to add state metadata'};
  if(error)return {status:'CORRUPT_STATE',compatible:false,harness_version:version,state_file:metaPath,detail:error,
    action:'state.json is not readable JSON. Restore it from a state.backup-*.json beside it, or remove it and run migrate to write fresh metadata; runs and artifacts are unaffected.'};
  if(state.schema!==STATE_SCHEMA)return {status:'INCOMPATIBLE_SCHEMA',compatible:false,harness_version:version,state};
  // Incomplete metadata is a migration, not a clean bill of health: otherwise
  // check reports nothing to do while migrate still rewrites the file.
  if(!state.harness_version)return {status:'MIGRATION_AVAILABLE',compatible:true,harness_version:version,state,
    action:'state does not record which harness wrote it; run migrate to stamp the current version'};
  if(state.harness_version!==version){
    return {status:'HARNESS_VERSION_CHANGED',compatible:true,harness_version:version,
      state_harness_version:state.harness_version,state,
      action:`state was written by ${state.harness_version}; run migrate to record the change to ${version}`};
  }
  return {status:'COMPATIBLE',compatible:true,harness_version:version,state};
}

export function migrateState(root,projectRoot){
  const check=compatCheck(root,projectRoot);
  if(['LEGACY_V2_DETECTED','INCOMPATIBLE_SCHEMA','CORRUPT_STATE'].includes(check.status)){
    throw new Error(`automatic migration refused: ${check.status}`);
  }
  if(check.status==='UNINITIALIZED')throw new Error('project is not initialized');
  const d=stateDir(projectRoot);
  const metaPath=path.join(d,'state.json');
  const version=harnessVersion(root);
  const {present,state}=readState(metaPath);

  if(!present){
    const fresh={schema:STATE_SCHEMA,harness_version:version,created_at:now(),last_migrated_at:now(),migrations:[]};
    writeJson(metaPath,fresh);
    return {status:'MIGRATED',state:fresh};
  }
  if(state.harness_version===version)return {status:'NOOP',state};

  // The file about to be rewritten is the one worth backing up. The previous
  // implementation copied project.json instead, which migration never touches.
  fs.copyFileSync(metaPath,path.join(d,`state.backup-${Date.now()}.json`));
  const updated={
    ...state,
    harness_version:version,
    last_migrated_at:now(),
    migrations:[...(Array.isArray(state.migrations)?state.migrations:[]),
      {from:state.harness_version??null,to:version,at:now()}]
  };
  writeJson(metaPath,updated);
  return {status:'HARNESS_VERSION_RECORDED',from:state.harness_version??null,to:version,state:updated};
}

export const stateSchema=STATE_SCHEMA;
