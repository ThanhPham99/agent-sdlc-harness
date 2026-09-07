import fs from 'node:fs';
import path from 'node:path';
import {appendJsonl,ensureDir,now,readJson,sha256,uuid,writeJson,rootFrom} from './util.mjs';
// Every path this module touches comes from the layout authority. Nothing here
// joins a literal onto the state directory: that pattern is what made the tree
// unenumerable, and layout.mjs is the one place it now lives.
import * as layout from './layout.mjs';
const HARNESS_VERSION=readJson(path.join(rootFrom(import.meta.url),'agent-sdlc.manifest.json')).version;
// Re-exported because most of the runtime imports `stateDir` from here. There
// is still only one definition, in layout.mjs.
export const stateDir=layout.stateDir;
export function initProject(projectRoot,config){
  const ROOT=rootFrom(import.meta.url);
  const d=stateDir(projectRoot);
  // The v2 tree materializes itself from its own description. A directory
  // added to the layout table appears here with no edit to this function --
  // which is the whole point, since this list is what drifted before.
  layout.ensureLayout(projectRoot);
  const copyIfAbsent=(src,dest)=>{
    if(!fs.existsSync(src)||fs.existsSync(dest))return;
    try{ensureDir(path.dirname(dest));fs.copyFileSync(src,dest);}catch{}
  };
  copyIfAbsent(path.join(ROOT,'templates','intent.md'),layout.intentTemplateFile(projectRoot));
  copyIfAbsent(path.join(ROOT,'templates','REVIEW.md'),layout.reviewFile(projectRoot));
  copyIfAbsent(path.join(ROOT,'templates','SUMMARY.md'),layout.summaryFile(projectRoot));
  // The generated guides all live under docs/guides/ now, so the destination
  // is derived from the guide's own name rather than spelled out per file.
  const guides=[
    {tpl:'docs-README.md',guide:'README.md'},
    {tpl:'ARCHITECTURE-AND-STATE.md',guide:'ARCHITECTURE-AND-STATE.md'},
    {tpl:'WORKFLOWS-GUIDE.md',guide:'WORKFLOWS-GUIDE.md'},
    {tpl:'CLI-CHEAT-SHEET.md',guide:'CLI-CHEAT-SHEET.md'}
  ];
  for(const g of guides)copyIfAbsent(path.join(ROOT,'templates',g.tpl),layout.guideFile(projectRoot,g.guide));
  // The version stamp is what makes the tree self-describing: a reader can ask
  // what shape it is looking at instead of inferring it. Written before the
  // project config so a tree that exists at all has a version.
  const layoutPath=layout.layoutFile(projectRoot);
  if(!fs.existsSync(layoutPath)){
    writeJson(layoutPath,{
      schema:layout.LAYOUT_SCHEMA,
      layout_version:layout.LAYOUT_VERSION,
      harness_version:HARNESS_VERSION,
      created_at:now()
    });
  }
  writeJson(layout.projectConfigFile(projectRoot),config);
  const statePath=layout.stateFile(projectRoot);
  if(!fs.existsSync(statePath))writeJson(statePath,{schema:'agent-sdlc/state/v1',harness_version:HARNESS_VERSION,created_at:now()});
  return d;
}
export function projectConfig(projectRoot){return readJson(layout.projectConfigFile(projectRoot));}
export function runPath(projectRoot,runId){return layout.runFile(projectRoot,runId);}
// The run document is read-modify-write on every transition. Two writers that
// loaded the same revision would silently drop the first one's evidence, so a
// stale write is refused instead: reload the run and reapply. `writeJson` is
// atomic, so an interrupted write cannot truncate the document either.
//
// The version token is a counter, not `updated_at`. Timestamps have millisecond
// resolution, and on a fast filesystem the two writes of a lost-update race land
// inside the same millisecond -- which is how CI caught this on Linux while it
// passed on Windows. A counter cannot collide.
export function saveRun(projectRoot,run){
  const p=runPath(projectRoot,run.run_id);
  const disk=fs.existsSync(p)?readJson(p,{}):null;
  const held=Number(run.revision??0);
  if(disk){
    const current=Number(disk.revision??0);
    if(current!==held){
      throw new Error(`STALE_RUN_STATE: run ${run.run_id} is at revision ${current} on disk but this copy holds ${held}; reload the run and reapply the change`);
    }
  }
  run.revision=held+1;
  run.updated_at=now();
  writeJson(p,run);
}
export function loadRun(projectRoot,runId){return readJson(runPath(projectRoot,runId));}
export function loadState(projectRoot){return readJson(layout.stateFile(projectRoot),{});}
export function saveState(projectRoot,patch){
  const p=layout.stateFile(projectRoot);
  const state={...readJson(p,{schema:'agent-sdlc/state/v1',harness_version:HARNESS_VERSION,created_at:now()}),...patch};
  ensureDir(stateDir(projectRoot));
  writeJson(p,state);
  return state;
}
export function setActiveRun(projectRoot,runId){return saveState(projectRoot,{active_run_id:runId});}
// Run ids are UUIDs, so the readdir order that `listRuns` keeps is alphabetical
// and says nothing about age. Anything that means "the run being worked on" has
// to sort on `created_at`, which is why this is a separate function rather than
// an index into the list.
export function latestRunId(projectRoot){
  const runs=listRuns(projectRoot)
    .map(id=>({id,created_at:readJson(runPath(projectRoot,id),{}).created_at||''}))
    .sort((a,b)=>a.created_at<b.created_at?-1:a.created_at>b.created_at?1:(a.id<b.id?-1:1));
  return runs.length?runs[runs.length-1].id:null;
}
// The single answer to "which run does this command mean?".
//
// An explicit --run-id always wins. Otherwise the run `start` recorded as
// active is used, and if that run has since been deleted (or was never
// recorded, e.g. a project from an older harness version) the newest run on
// disk stands in. Returns null only when the project has no runs at all;
// callers turn that into their own argument error.
export function resolveRunId(projectRoot,explicit){
  if(explicit)return explicit;
  const active=loadState(projectRoot).active_run_id;
  if(active&&fs.existsSync(runPath(projectRoot,active)))return active;
  return latestRunId(projectRoot);
}
// A run is a directory now, not a `<run_id>.json` file, so the listing comes
// from the layout rather than from a filename pattern here. A directory with no
// run document in it is not a run: `task materialize` can create the tasks
// subtree first, and a half-built run must not be resolvable as the active one.
export function listRuns(projectRoot){
  return layout.listRunIds(projectRoot).filter(id=>fs.existsSync(layout.runFile(projectRoot,id)));
}
// Event sequence numbers are cosmetic display aids (e.g. mcp-server stream display).
// They were derived by reading and splitting the whole event log on every append:
// quadratic in the number of events for a single run. The count is now derived once
// per stream per process and then incremented. Event validation, replays, and hashes
// operate on append order and timestamps, so sequence collision across distinct
// concurrent processes is harmless.
const seqCache=new Map();
const lastHashCache=new Map();
function nextSeq(p){
  if(!seqCache.has(p)){
    let count=0;
    if(fs.existsSync(p))for(const line of fs.readFileSync(p,'utf8').split('\n'))if(line)count++;
    seqCache.set(p,count);
  }
  const seq=seqCache.get(p)+1;
  seqCache.set(p,seq);
  return seq;
}
export function emit(projectRoot,run,event){
  const p=layout.runEventsFile(projectRoot,run.run_id);
  if(!lastHashCache.has(p)){
    let prev='0'.repeat(64);
    if(fs.existsSync(p)){
      const lines=fs.readFileSync(p,'utf8').trim().split('\n').filter(Boolean);
      if(lines.length>0){
        try{
          const last=JSON.parse(lines[lines.length-1]);
          if(last.hash)prev=last.hash;
        }catch{}
      }
    }
    lastHashCache.set(p,prev);
  }
  const prev_hash=lastHashCache.get(p);
  const full={
    event_id:uuid('evt'),
    run_id:run.run_id,
    seq:nextSeq(p),
    time:now(),
    stage:run.state,
    provider:null,
    artifact_refs:[],
    usage:{},
    ...event,
    prev_hash
  };
  const event_hash=sha256(JSON.stringify(full));
  full.hash=event_hash;
  lastHashCache.set(p,event_hash);
  appendJsonl(p,full);
  try{
    import('./webhook.mjs').then(m=>m.dispatchWebhooks(projectRoot,full)).catch(()=>{});
    import('./server.mjs').then(m=>m.broadcastSseEvent(full)).catch(()=>{});
  }catch{}
  return full;
}
/**
 * Store content-addressed content and record who stored it.
 *
 * The object store is shared across runs and identical content is one object
 * by design (artifact-content-addressed-dedup-id pins that). The metadata used
 * to be rewritten wholesale on every put, so a second run storing the same
 * bytes took the first run's artifact over: kind, stage, run_id and revision
 * all became the newcomer's, and `listArtifacts().filter(m=>m.run_id===A)`
 * returned nothing for a run that had stored it. retention.mjs already reasons
 * about exactly this collision -- it marks from run references rather than
 * metadata for that reason -- and input.normalize makes it ordinary rather
 * than exotic, being deterministic enough that the same requirements file
 * normalized in two runs is byte-identical.
 *
 * So the object keeps one identity and gains a binding per distinct storer.
 * The top-level fields stay the FIRST binding, which is what every existing
 * reader already assumes; the caller is handed its own binding back, which is
 * what it asked about.
 *
 * The object and its metadata now live in the same shard directory rather than
 * in parallel `objects/` and `meta/` trees. They are written together, read
 * together and deleted together, and a flat directory of every object the
 * project has ever produced is not a shape that keeps working -- see the
 * fan-out note in layout.mjs.
 */
export function putArtifact(projectRoot,{kind,content,runId=null,stage=null,sourceRevision=null,filename=null}){
  const hash=sha256(content);
  const objectPath=layout.objectPath(projectRoot,hash);
  const metaPath=layout.objectMetaPath(projectRoot,hash);
  const prior=fs.existsSync(metaPath)?readJson(metaPath):null;
  const binding={run_id:runId,stage,kind,source_revision:sourceRevision,filename,created_at:now()};
  const bindings=prior
    ?(prior.bindings||[{run_id:prior.run_id??null,stage:prior.stage??null,kind:prior.kind,
        source_revision:prior.source_revision??null,filename:prior.filename??null,created_at:prior.created_at}])
    :[];
  const known=bindings.some(b=>b.run_id===binding.run_id&&b.stage===binding.stage&&b.kind===binding.kind);
  if(!known)bindings.push(binding);
  const first=bindings[0];
  const stored={
    artifact_id:`artifact://sha256/${hash}`,
    kind:first.kind,sha256:hash,path:objectPath,filename:first.filename,
    created_at:prior?.created_at??binding.created_at,
    run_id:first.run_id,stage:first.stage,source_revision:first.source_revision,
    bindings
  };
  // Metadata first, then the object. The two writes cannot be made atomic, so
  // the choice is which half-state a crash leaves behind.
  //
  // Neither half is visible to a reader: `listArtifacts` returns complete pairs
  // only, and gc plans from `listArtifacts`, so neither half is reclaimable
  // through the plan either -- `layout.listStoreEntries` exists to give
  // retention the physical view that makes both reclaimable, and that is where
  // the real repair lives, not in this ordering.
  //
  // What the ordering decides is the SIZE and the REPAIRABILITY of the debris.
  // An object is arbitrarily large and nothing rewrites it; a metadata document
  // is a few hundred bytes and the next identical put restores the pair, since
  // the content hash is the same and this function is idempotent. So leaving
  // metadata behind is strictly the cheaper failure, and it self-heals on the
  // next put of the same content.
  writeJson(metaPath,stored);
  if(!fs.existsSync(objectPath)){
    ensureDir(path.dirname(objectPath));
    fs.writeFileSync(objectPath,content);
  }
  // The caller's view: the same object, described by the put it just made.
  return {...stored,kind,filename,run_id:runId,stage,source_revision:sourceRevision};
}
/** Every artifact this run stored, from any binding -- not just the first. */
export function artifactsForRun(projectRoot,runId){
  return listArtifacts(projectRoot).filter(m=>artifactBindings(m).some(b=>b.run_id===runId));
}
/** Bindings for a meta record, including metas written before bindings existed. */
export function artifactBindings(meta){
  if(Array.isArray(meta?.bindings)&&meta.bindings.length)return meta.bindings;
  return [{run_id:meta?.run_id??null,stage:meta?.stage??null,kind:meta?.kind??null,
    source_revision:meta?.source_revision??null,filename:meta?.filename??null,created_at:meta?.created_at??null}];
}
export function getArtifact(projectRoot,ref){
  const hash=ref.replace('artifact://sha256/','');
  const meta=readJson(layout.objectMetaPath(projectRoot,hash));
  return {meta,content:fs.readFileSync(layout.objectPath(projectRoot,hash),'utf8')};
}
// ---------------------------------------------------------------------------
// Task runtime persistence (alpha5).
//
// Task records are small, mutable and written often. They are written through a
// temp file + rename so an interrupted process leaves either the previous
// record or the new one, never a truncated JSON file. Large evidence stays in
// the content-addressed artifact store; task records hold refs.
// ---------------------------------------------------------------------------
export function tasksDir(projectRoot,runId){return layout.runTasksDir(projectRoot,runId);}
// Task ids come from a plan, and a plan is authored input: the id becomes a
// filename, so an id carrying a separator or a parent reference would write a
// task record outside its own run directory. The plan validator constrains the
// graph, not the characters, and the safe set is deliberately narrow -- the ids
// the engine has ever produced are TASK-001 and the like.
//
// The rule itself lives in layout.mjs, applied by every accessor that takes an
// id, so this is the same check every path in the tree gets rather than a
// second opinion about what is safe.
export function assertSafeTaskId(taskId){return layout.assertSafeSegment(taskId,'task_id');}
export function taskPath(projectRoot,runId,taskId){return layout.taskFile(projectRoot,runId,taskId);}
export function taskGraphPath(projectRoot,runId){return layout.taskGraphFile(projectRoot,runId);}
// `writeJson` is itself temp-file + rename now, so every JSON document the
// runtime owns gets the durability task records already had.
const writeJsonAtomic=writeJson;
export function saveTask(projectRoot,task){
  if(!task?.run_id||!task?.task_id)throw new Error('task requires run_id and task_id');
  assertSafeTaskId(task.task_id);
  task.updated_at=now();
  writeJsonAtomic(taskPath(projectRoot,task.run_id,task.task_id),task);
  return task;
}
export function loadTask(projectRoot,runId,taskId){return readJson(taskPath(projectRoot,runId,taskId));}
export function hasTask(projectRoot,runId,taskId){return fs.existsSync(taskPath(projectRoot,runId,taskId));}
// `graph.json`, `migration.json` and any future sidecar file live in the same
// directory and must never be read as tasks. That used to be enforced by
// matching the filename against /^TASK-[0-9]+.json$/, which also silently
// excluded every task record whose id followed a different convention: the
// plan validator places no constraint on task_id, so such a plan materialized
// with `materialized: true` and was then invisible to list, refresh, schedule,
// the governor and taskProgress -- an unexecutable run with nothing to say why.
// A record is now recognised by what it is rather than what it is called.
//
// The sidecar names come from the layout, which is what names them in the first
// place, so adding one cannot leave this list behind.
const TASK_SIDECARS=new Set(layout.TASK_SIDECARS);
export function listTasks(projectRoot,runId){
  const d=tasksDir(projectRoot,runId);
  if(!fs.existsSync(d))return [];
  return fs.readdirSync(d).filter(x=>x.endsWith('.json')&&!TASK_SIDECARS.has(x)).sort()
    .map(x=>readJson(path.join(d,x)))
    .filter(t=>t&&typeof t.task_id==='string'&&typeof t.run_id==='string');
}
export function saveTaskGraph(projectRoot,graph){
  if(!graph?.run_id)throw new Error('task graph requires run_id');
  graph.updated_at=now();
  writeJsonAtomic(taskGraphPath(projectRoot,graph.run_id),graph);
  return graph;
}
export function loadTaskGraph(projectRoot,runId){
  const p=taskGraphPath(projectRoot,runId);
  return fs.existsSync(p)?readJson(p):null;
}
export function emitTaskEvent(projectRoot,task,event){
  const p=layout.runTaskEventsFile(projectRoot,task.run_id);
  const seq=nextSeq(p);
  const full={
    schema:'agent-sdlc/task-event/v1',event_id:uuid('tevt'),run_id:task.run_id,task_id:task.task_id,
    seq,time:now(),status:task.status??null,attempt:task.attempt??0,provider:null,artifact_refs:[],usage:{},payload:{},
    ...event
  };
  appendJsonl(p,full);
  return full;
}
export function listTaskEvents(projectRoot,runId,taskId=null){
  const p=layout.runTaskEventsFile(projectRoot,runId);
  if(!fs.existsSync(p))return [];
  const rows=fs.readFileSync(p,'utf8').split('\n').filter(Boolean).map(l=>JSON.parse(l));
  return taskId?rows.filter(r=>r.task_id===taskId):rows;
}
export function putTaskContextManifest(projectRoot,manifest){
  const p=layout.taskContextFile(projectRoot,manifest.run_id,manifest.task_id);
  writeJsonAtomic(p,manifest);
  return {path:p,context_hash:manifest.context_hash};
}
export function getTaskContextManifest(projectRoot,runId,taskId){
  const p=layout.taskContextFile(projectRoot,runId,taskId);
  return fs.existsSync(p)?readJson(p):null;
}

// Sorted, like listTasks and listWorkspaces above: readdir order is the
// filesystem's business (NTFS gives names in B-tree order, ext4 with dir_index
// gives hash order) and it reached a content hash through the traceability
// graph. `listObjectHashes` sorts by hash, so the order is stable and carries
// no meaning of its own -- exactly as before, when meta filenames were hashes.
//
// A hash with no readable metadata beside it is skipped rather than returned
// as a hole, and skipping it must not depend on `readJson`'s fallback: a null
// fallback RETHROWS (see util.mjs), so this was written with an explicit catch
// after the first version of it turned a half-written object into a permanent
// failure of every caller.
//
// The half-state is real rather than hypothetical. `putArtifact` writes the
// object first and the metadata second, so a process killed between the two
// leaves an object nothing describes -- and an unparseable metadata file is the
// same situation. Neither is an artifact a caller can use, and neither is worth
// failing an entire listing over.
export function listArtifacts(projectRoot){
  const out=[];
  for(const hash of layout.listObjectHashes(projectRoot)){
    const p=layout.objectMetaPath(projectRoot,hash);
    if(!fs.existsSync(p))continue;
    try{
      const meta=JSON.parse(fs.readFileSync(p,'utf8'));
      if(meta&&typeof meta==='object')out.push(meta);
    }catch{/* unreadable metadata is debris, not a listing failure */}
  }
  return out;
}

/**
 * Verify cryptographic hash-chain integrity of a run's event stream.
 */
export function verifyEventChain(projectRoot,runId){
  const p=layout.runEventsFile(projectRoot,runId);
  if(!fs.existsSync(p))return {valid:true,event_count:0,head_hash:null,corrupted_at_seq:null};
  const lines=fs.readFileSync(p,'utf8').trim().split('\n').filter(Boolean);
  let expectedPrev='0'.repeat(64);
  for(let i=0;i<lines.length;i++){
    try{
      const evt=JSON.parse(lines[i]);
      if(evt.prev_hash!==undefined){
        if(evt.prev_hash!==expectedPrev){
          return {valid:false,event_count:lines.length,corrupted_at_seq:evt.seq||i+1,reason:'PREV_HASH_MISMATCH'};
        }
        const {hash,...rest}=evt;
        const computed=sha256(JSON.stringify(rest));
        if(hash&&hash!==computed){
          return {valid:false,event_count:lines.length,corrupted_at_seq:evt.seq||i+1,reason:'EVENT_HASH_TAMPERED'};
        }
        expectedPrev=hash||expectedPrev;
      }
    }catch(e){
      return {valid:false,event_count:lines.length,corrupted_at_seq:i+1,reason:`JSON_PARSE_ERROR:${e.message}`};
    }
  }
  return {valid:true,event_count:lines.length,head_hash:expectedPrev,corrupted_at_seq:null};
}
