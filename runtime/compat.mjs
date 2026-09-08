import fs from 'node:fs';
import path from 'node:path';
import {readJson,writeJson,now} from './util.mjs';
import {stateDir} from './store.mjs';
import * as layout from './layout.mjs';
import {detectLayoutVersion,LAYOUT_VERSION} from './layout.mjs';
import {migrateLayout} from './layout-migration.mjs';

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
  // The SHAPE of the tree is checked before anything about its contents.
  //
  // Every branch below reasons about state.json, and a v1 tree reaches several
  // of them first -- it was reported `MIGRATION_AVAILABLE, compatible: true`,
  // i.e. "your state metadata is a little behind", for a tree whose runs,
  // artifacts and history are all unreachable to this harness. Layout
  // invisibility is both the most serious of these conditions and the only one
  // that returns `compatible: false`, so it is answered first.
  //
  // Reported, not repaired: the migration is a separate, backed-up operation.
  const layoutState=detectLayoutVersion(projectRoot);
  if(layoutState.migration_required){
    return {status:'LAYOUT_MIGRATION_REQUIRED',compatible:false,harness_version:version,
      layout:layoutState,
      action:`this project's .agent-sdlc is on layout v${layoutState.layout_version} but this harness reads v${LAYOUT_VERSION}; run migrate to convert it (the old tree is copied to a backup first). Markers: ${layoutState.markers.slice(0,6).join(', ')}`};
  }
  const metaPath=layout.stateFile(projectRoot);
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
  return {status:'COMPATIBLE',compatible:true,harness_version:version,state,layout:layoutState};
}

export function migrateState(root,projectRoot){
  const check=compatCheck(root,projectRoot);
  if(['LEGACY_V2_DETECTED','INCOMPATIBLE_SCHEMA','CORRUPT_STATE'].includes(check.status)){
    throw new Error(`automatic migration refused: ${check.status}`);
  }
  if(check.status==='UNINITIALIZED')throw new Error('project is not initialized');

  // The on-disk SHAPE is migrated before the state metadata, because every
  // branch below reads state.json and a v1 tree's state.json is the one file
  // that sits at the same path in both layouts -- so this is the only ordering
  // where the rest of this function is operating on a tree it can see.
  //
  // `migrateLayout` returns ALREADY_CURRENT on a tree that is already v2 and
  // has no recorded unfinished work, so this stays a single idempotent entry
  // point rather than a mode the caller has to choose.
  const layoutResult=migrateLayout(projectRoot);
  if(layoutResult.status==='INCOMPLETE'){
    // Name every reason, not just one of the three. This interpolated
    // `retained_legacy_dirs` alone, so the commonest case -- a filename v2
    // cannot address -- threw `layout migration incomplete: []`, which reads
    // like a harness bug rather than like a file to rename.
    const why=[
      layoutResult.retained_legacy_dirs?.length&&`legacy directories still populated: ${layoutResult.retained_legacy_dirs.map(r=>r.name).join(', ')}`,
      layoutResult.unaddressable?.length&&`names v2 cannot address (rename them, then re-run): ${layoutResult.unaddressable.map(u=>u.what).join(', ')}`,
      layoutResult.errors?.length&&`moves that failed: ${layoutResult.errors.map(e=>`${e.what} (${e.code||'error'})`).join(', ')}`
    ].filter(Boolean).join('; ')||'no cause recorded';
    throw new Error(`layout migration incomplete: ${why}; the pre-migration tree is preserved at ${layoutResult.backup}`);
  }
  const d=stateDir(projectRoot);
  const metaPath=layout.stateFile(projectRoot);
  const version=harnessVersion(root);
  const {present,state}=readState(metaPath);

  if(!present){
    const fresh={schema:STATE_SCHEMA,harness_version:version,created_at:now(),last_migrated_at:now(),migrations:[]};
    writeJson(metaPath,fresh);
    return {status:'MIGRATED',state:fresh,layout:layoutResult};
  }
  // Not a no-op if the SHAPE changed: the harness version can match while the
  // tree was v1 a moment ago, and reporting NOOP there would hide the
  // migration that just ran.
  if(state.harness_version===version){
    return layoutResult.migrated
      ?{status:'LAYOUT_MIGRATED',state,layout:layoutResult}
      :{status:'NOOP',state,layout:layoutResult};
  }

  // The file about to be rewritten is the one worth backing up. The previous
  // implementation copied project.json instead, which migration never touches.
  fs.copyFileSync(metaPath,layout.stateBackupFile(projectRoot,Date.now()));
  const updated={
    ...state,
    harness_version:version,
    last_migrated_at:now(),
    migrations:[...(Array.isArray(state.migrations)?state.migrations:[]),
      {from:state.harness_version??null,to:version,at:now()}]
  };
  writeJson(metaPath,updated);
  return {status:'HARNESS_VERSION_RECORDED',from:state.harness_version??null,to:version,state:updated,layout:layoutResult};
}

export const stateSchema=STATE_SCHEMA;
