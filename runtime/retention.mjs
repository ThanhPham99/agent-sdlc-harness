// F7: `.agent-sdlc` had no prune/gc. Runs, per-run event JSONL, task records
// and content-addressed artifact objects only grow -- cheap on a small
// project, unbounded on a long-lived one.
//
// Two-phase, like dev-link's status/apply split: `planGc` is pure and
// read-only (safe to call on every `gc status`); `applyGc` takes exactly the
// plan `planGc` produced and performs the deletions it named, re-verifying
// each run is still terminal immediately before touching it in case state
// changed between the two calls.
//
// A run is eligible only when it is TERMINAL (state === its own last stage),
// not suspended, and older than the cutoff -- never based on age alone, so an
// abandoned-but-still-open run is never touched. A run referenced by any
// feature phase's run_ids is excluded even if otherwise eligible: nothing
// dereferences that list today, but the traceability this harness is built
// around treats it as history a human might reasonably expect `feature show`
// to eventually surface, and gc is not the place to make that call silently.
//
// Artifacts are content-addressed and the object store is shared across every
// run, so a run's own artifact list is not enough to know an object is safe
// to delete -- two runs can produce byte-identical content and collide on the
// same hash. An artifact is only orphaned when NO surviving (kept) run, task,
// or handoff still references its artifact_id.
//
// What this module must NOT do is decide for itself which paths belong to a
// run. It used to: a literal list of seven paths, maintained by hand, which had
// fallen six behind the runtime that writes them -- evidence, ci-evidence,
// delivery, traceability, requirement-update and the run's workspaces were
// never removed, so a "reclaimed" run left its largest directories on disk
// forever. The list now comes from `layout.runPaths`, derived from the same
// table every writer resolves its paths through, so a namespace cannot be added
// without gc seeing it.
import fs from 'node:fs';
import path from 'node:path';
import {tasksDir,listRuns as listRunIds} from './store.mjs';
import * as layout from './layout.mjs';
import {readJson} from './util.mjs';

const DAY_MS=24*60*60*1000;

function listJsonFiles(dir){
  if(!fs.existsSync(dir))return [];
  return fs.readdirSync(dir).filter(f=>f.endsWith('.json'));
}

function listRuns(projectRoot){
  return listRunIds(projectRoot)
    .map(id=>readJson(layout.runFile(projectRoot,id),null))
    .filter(Boolean);
}

function listRunTasks(projectRoot,runId){
  const dir=tasksDir(projectRoot,runId);
  return listJsonFiles(dir).map(f=>readJson(path.join(dir,f),null)).filter(Boolean);
}

function listHandoffs(projectRoot){
  const dir=layout.handoffsDir(projectRoot);
  return listJsonFiles(dir).map(f=>readJson(path.join(dir,f),null)).filter(Boolean);
}

/** run_ids any feature phase still lists, best-effort (features are optional). */
function featureReferencedRunIds(projectRoot){
  const out=new Set();
  try{
    const dir=layout.featuresDir(projectRoot);
    if(!fs.existsSync(dir))return out;
    for(const featureFile of fs.readdirSync(dir).filter(f=>f.endsWith('.json'))){
      const feature=readJson(path.join(dir,featureFile));
      const phasesDir=layout.featurePhasesDir(projectRoot,feature.feature_id||path.basename(featureFile,'.json'));
      if(!fs.existsSync(phasesDir))continue;
      for(const phaseFile of fs.readdirSync(phasesDir).filter(f=>f.endsWith('.json'))){
        const phase=readJson(path.join(phasesDir,phaseFile));
        for(const rid of phase.run_ids||[])out.add(rid);
      }
    }
  }catch{/* best-effort; a malformed features tree must not block gc */}
  return out;
}

/**
 * Per-run paths, from the layout rather than from this module's memory.
 *
 * `layout.runPaths` returns prune roots: the smallest set of existing paths
 * whose removal deletes everything belonging to the run and nothing belonging
 * to another. It already filters to what exists and guarantees no root nests
 * inside another, so the sizes summed below cannot double-count.
 */
function runPaths(projectRoot,runId){
  return layout.runPaths(projectRoot,runId);
}

function sizeOf(p){
  const st=fs.statSync(p);
  if(!st.isDirectory())return st.size;
  let total=0;
  for(const entry of fs.readdirSync(p,{withFileTypes:true})){
    const full=path.join(p,entry.name);
    total+=entry.isDirectory()?sizeOf(full):fs.statSync(full).size;
  }
  return total;
}

/**
 * Read-only: which runs are eligible for removal, what would be reclaimed,
 * and which artifacts would become orphaned. Never touches disk.
 */
export function planGc(projectRoot,{olderThanDays=30,runId=null}={}){
  const cutoff=Date.now()-olderThanDays*DAY_MS;
  const runs=listRuns(projectRoot);
  const referenced=featureReferencedRunIds(projectRoot);

  const eligible=[];
  const skipped=[];
  for(const run of runs){
    if(runId&&run.run_id!==runId)continue;
    const terminal=run.state===run.stages?.at(-1)&&!run.suspended_from;
    const age=Date.now()-new Date(run.updated_at).getTime();
    if(!terminal){skipped.push({run_id:run.run_id,reason:'NOT_TERMINAL',state:run.state});continue;}
    if(referenced.has(run.run_id)){skipped.push({run_id:run.run_id,reason:'REFERENCED_BY_FEATURE_PHASE'});continue;}
    if(!runId&&age<olderThanDays*DAY_MS){skipped.push({run_id:run.run_id,reason:'TOO_RECENT',age_days:Math.floor(age/DAY_MS)});continue;}
    const paths=runPaths(projectRoot,run.run_id);
    eligible.push({run_id:run.run_id,state:run.state,updated_at:run.updated_at,
      paths:paths.map(p=>path.relative(projectRoot,p).split(path.sep).join('/')),
      bytes:paths.reduce((a,p)=>a+sizeOf(p),0)});
  }
  if(runId&&!eligible.length&&!skipped.length){
    skipped.push({run_id:runId,reason:'NOT_FOUND'});
  }

  // Mark-and-sweep for artifacts: everything a KEPT run, its tasks, or its
  // handoffs still reference is kept; everything else with no reference at
  // all is orphaned. An artifact touched by a run this call was not asked to
  // consider (no --run-id filter, or a different one) still counts as kept.
  const prunedRunIds=new Set(eligible.map(e=>e.run_id));
  const keptRunIds=new Set(runs.map(r=>r.run_id).filter(id=>!prunedRunIds.has(id)));
  const keepArtifactIds=new Set();
  for(const run of runs){
    if(!keptRunIds.has(run.run_id))continue;
    for(const a of run.artifacts||[])keepArtifactIds.add(a);
    for(const task of listRunTasks(projectRoot,run.run_id)){
      for(const a of [...(task.artifact_refs||[]),...(task.evidence_refs||[]),...(task.review_refs||[])])keepArtifactIds.add(a);
    }
  }
  for(const h of listHandoffs(projectRoot)){
    if(keptRunIds.has(h.run_id))for(const a of h.artifact_refs||[])keepArtifactIds.add(a);
  }

  // The store is enumerated PHYSICALLY here, not through `listArtifacts`.
  //
  // `listArtifacts` reports complete object+metadata pairs, which is what a
  // reader wants and exactly the wrong basis for reclamation: the two files are
  // written separately and cannot be made atomic, so a crash leaves one half
  // behind, and a half nothing enumerates is a half nothing can ever delete.
  // Planning from the reader's view left both kinds of debris on disk forever.
  //
  // An entry is orphaned under exactly one rule, and it applies to complete and
  // half entries alike: no surviving run, task or handoff references its
  // artifact_id.
  //
  // The identity of an entry does NOT come from its metadata document. Artifact
  // ids are content-addressed, so `artifact://sha256/<hash>` is a pure function
  // of the address the entry already sits at -- which means a metadata-less
  // entry has a perfectly well-known id and can be checked against the keep set
  // like any other. Deriving the id from the file instead, and skipping the
  // keep check when the file was missing, planned every half entry as an orphan
  // unconditionally: an open run's confirmed-requirements artifact whose
  // metadata had been lost was deleted, object and all, with no ageing and no
  // terminal run required, because the orphan sweep does not depend on run
  // eligibility. A broken pair a surviving run points at is a repair problem,
  // never gc's to take.
  //
  // The metadata is still read, for one narrow reason: a record may carry an id
  // that is not its own hash address (written by an older harness, or edited by
  // hand), and that id has to be honoured by the keep check too.
  const orphanedArtifacts=[];
  const relOf=(p)=>path.relative(projectRoot,p).split(path.sep).join('/');
  for(const entry of layout.listStoreEntries(projectRoot)){
    const metaPath=layout.objectMetaPath(projectRoot,entry.hash);
    const objectPath=layout.objectPath(projectRoot,entry.hash);
    const addressId=`artifact://sha256/${entry.hash}`;
    if(keepArtifactIds.has(addressId))continue;
    // Read explicitly, never through `readJson(p,null)`: a null fallback
    // RETHROWS (see util.mjs), so unparseable metadata anywhere in the store
    // would throw out of `planGc` and leave `gc status` and `gc apply` dead
    // project-wide until someone deleted the file by hand -- turning the very
    // debris this enumeration exists to reclaim into the thing that blocks
    // reclaiming anything.
    let meta=null;
    if(entry.has_meta){
      try{meta=JSON.parse(fs.readFileSync(metaPath,'utf8'));}
      catch{/* unreadable metadata is debris, not a planning failure */}
    }
    if(meta?.artifact_id&&keepArtifactIds.has(meta.artifact_id))continue;
    orphanedArtifacts.push({
      artifact_id:meta?.artifact_id??addressId,
      sha256:entry.hash,
      meta_path:entry.has_meta?relOf(metaPath):null,
      object_path:entry.has_object?relOf(objectPath):null,
      // An incomplete pair is named so an operator reading a gc plan can tell
      // "this artifact is no longer referenced" from "this is wreckage".
      incomplete:!(entry.has_object&&entry.has_meta&&meta)||undefined,
      bytes:entry.has_object?fs.statSync(objectPath).size:0
    });
  }

  return {
    schema:'agent-sdlc/gc-plan/v1',
    cutoff_days:olderThanDays,
    examined_runs:runs.length,
    eligible_runs:eligible,
    skipped_runs:skipped,
    orphaned_artifacts:orphanedArtifacts,
    reclaimable_bytes:eligible.reduce((a,e)=>a+e.bytes,0)+orphanedArtifacts.reduce((a,o)=>a+o.bytes,0),
    dry_run:true
  };
}

/**
 * Delete exactly what a `planGc` result named. Re-checks each run is still
 * terminal right before removing it -- defensive against state changing
 * between `gc status` and `gc apply`, not a transactional guarantee.
 */
export function applyGc(projectRoot,plan){
  const removed_runs=[];
  const errors=[];
  for(const e of plan.eligible_runs||[]){
    const runFile=layout.runFile(projectRoot,e.run_id);
    if(fs.existsSync(runFile)){
      const fresh=readJson(runFile);
      if(fresh.state!==fresh.stages?.at(-1)||fresh.suspended_from){
        errors.push({run_id:e.run_id,error:'NO_LONGER_TERMINAL_SKIPPED'});
        continue;
      }
    }
    for(const rel of e.paths){
      const full=path.join(projectRoot,rel);
      try{
        if(!fs.existsSync(full))continue;
        if(fs.statSync(full).isDirectory())fs.rmSync(full,{recursive:true});
        else fs.unlinkSync(full);
      }catch(err){errors.push({run_id:e.run_id,path:rel,error:err.message});}
    }
    removed_runs.push(e.run_id);
  }
  const removed_artifacts=[];
  for(const o of plan.orphaned_artifacts||[]){
    try{
      // Either side can legitimately be absent now that the plan reports
      // incomplete pairs: an object with no metadata has no meta_path, and
      // metadata with no object has no object_path. Both are nulls to skip,
      // not paths to join -- path.join(root,null) throws.
      const unlinkIfPresent=(rel)=>{
        if(!rel)return;
        const full=path.join(projectRoot,rel);
        if(fs.existsSync(full))fs.unlinkSync(full);
      };
      unlinkIfPresent(o.meta_path);
      unlinkIfPresent(o.object_path);
      removed_artifacts.push(o.artifact_id);
    }catch(err){errors.push({artifact_id:o.artifact_id,error:err.message});}
  }
  return {schema:'agent-sdlc/gc-result/v1',removed_runs,removed_artifacts,errors,applied:true};
}
