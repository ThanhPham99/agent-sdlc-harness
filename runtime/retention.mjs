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
import fs from 'node:fs';
import path from 'node:path';
import {stateDir,tasksDir} from './store.mjs';
import {readJson} from './util.mjs';

const DAY_MS=24*60*60*1000;

function listJsonFiles(dir){
  if(!fs.existsSync(dir))return [];
  return fs.readdirSync(dir).filter(f=>f.endsWith('.json'));
}

function listRuns(projectRoot){
  const dir=path.join(stateDir(projectRoot),'runs');
  return listJsonFiles(dir).map(f=>readJson(path.join(dir,f),null)).filter(Boolean);
}

function listRunTasks(projectRoot,runId){
  const dir=tasksDir(projectRoot,runId);
  return listJsonFiles(dir).map(f=>readJson(path.join(dir,f),null)).filter(Boolean);
}

function listHandoffs(projectRoot){
  const dir=path.join(stateDir(projectRoot),'handoffs');
  return listJsonFiles(dir).map(f=>readJson(path.join(dir,f),null)).filter(Boolean);
}

/** run_ids any feature phase still lists, best-effort (features are optional). */
function featureReferencedRunIds(projectRoot){
  const out=new Set();
  try{
    const dir=path.join(stateDir(projectRoot),'features');
    if(!fs.existsSync(dir))return out;
    for(const featureFile of fs.readdirSync(dir).filter(f=>f.endsWith('.json'))){
      const feature=readJson(path.join(dir,featureFile));
      const phasesDir=path.join(dir,feature.feature_id||path.basename(featureFile,'.json'),'phases');
      if(!fs.existsSync(phasesDir))continue;
      for(const phaseFile of fs.readdirSync(phasesDir).filter(f=>f.endsWith('.json'))){
        const phase=readJson(path.join(phasesDir,phaseFile));
        for(const rid of phase.run_ids||[])out.add(rid);
      }
    }
  }catch{/* best-effort; a malformed features tree must not block gc */}
  return out;
}

/** Per-run paths this module owns, relative to `.agent-sdlc`. */
function runPaths(projectRoot,runId){
  const d=stateDir(projectRoot);
  return [
    path.join(d,'runs',`${runId}.json`),
    path.join(d,'events',`${runId}.jsonl`),
    path.join(d,'tasks',runId),
    path.join(d,'task-events',`${runId}.jsonl`),
    path.join(d,'task-context',runId),
    path.join(d,'task-evidence',runId),
    path.join(d,'cost',`${runId}.jsonl`)
  ].filter(p=>fs.existsSync(p));
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

  const metaDir=path.join(stateDir(projectRoot),'artifacts','meta');
  const orphanedArtifacts=[];
  for(const f of listJsonFiles(metaDir)){
    const meta=readJson(path.join(metaDir,f));
    if(keepArtifactIds.has(meta.artifact_id))continue;
    const objectPath=path.join(stateDir(projectRoot),'artifacts','objects',meta.sha256);
    orphanedArtifacts.push({artifact_id:meta.artifact_id,sha256:meta.sha256,
      meta_path:path.relative(projectRoot,path.join(metaDir,f)).split(path.sep).join('/'),
      object_path:fs.existsSync(objectPath)?path.relative(projectRoot,objectPath).split(path.sep).join('/'):null,
      bytes:fs.existsSync(objectPath)?fs.statSync(objectPath).size:0});
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
    const runFile=path.join(stateDir(projectRoot),'runs',`${e.run_id}.json`);
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
      const metaFull=path.join(projectRoot,o.meta_path);
      if(fs.existsSync(metaFull))fs.unlinkSync(metaFull);
      if(o.object_path){const objFull=path.join(projectRoot,o.object_path);if(fs.existsSync(objFull))fs.unlinkSync(objFull);}
      removed_artifacts.push(o.artifact_id);
    }catch(err){errors.push({artifact_id:o.artifact_id,error:err.message});}
  }
  return {schema:'agent-sdlc/gc-result/v1',removed_runs,removed_artifacts,errors,applied:true};
}
