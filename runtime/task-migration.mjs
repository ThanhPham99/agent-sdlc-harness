// Deterministic migration: alpha4 TaskPlan artifacts -> alpha5 TaskGraph + Task
// records.
//
// Rules, in the order they matter:
// - preserve the original plan artifact hash/ref;
// - generate stable task IDs only when absent;
// - never mark a generated task DONE automatically;
// - a run already past IMPLEMENT does not get fabricated per-task evidence; its
//   history is marked LEGACY_STAGE_EVIDENCE instead;
// - back up before mutation;
// - fail closed on an unknown newer schema.
import fs from 'node:fs';
import path from 'node:path';
import {now,sha256,writeJson} from './util.mjs';
import {listArtifacts,getArtifact,loadTaskGraph,listTasks,stateDir} from './store.mjs';
import {materializeTaskGraph} from './task-engine.mjs';

const KNOWN_PLAN_SCHEMAS=['agent-sdlc/task-plan/v1'];
const POST_IMPLEMENT=['VERIFY','REVIEW','RELEASE','DEPLOY','OBSERVE','CLOSE'];

/** Newest validated plan artifact belonging to this run, if any. */
export function findPlanArtifact(projectRoot,runId){
  const metas=listArtifacts(projectRoot)
    .filter(m=>m.kind==='task-plan'&&m.run_id===runId)
    .sort((a,b)=>String(a.created_at).localeCompare(String(b.created_at)));
  const meta=metas.at(-1);
  if(!meta)return null;
  try{
    const {content}=getArtifact(projectRoot,meta.artifact_id);
    return {meta,plan:JSON.parse(content)};
  }catch(e){return {meta,plan:null,error:e.message};}
}

function backup(projectRoot,runId){
  const dir=path.join(stateDir(projectRoot),'backups',`task-migration-${runId}`);
  const src=path.join(stateDir(projectRoot),'tasks',runId);
  if(!fs.existsSync(src))return null;
  fs.cpSync(src,dir,{recursive:true});
  return dir;
}

/** Assign stable IDs to any planned task that lacks one. Order-stable. */
export function assignStableTaskIds(plan){
  const used=new Set((plan.tasks||[]).map(t=>t?.task_id).filter(Boolean));
  let n=0;
  const nextId=()=>{
    let id;
    do{n++;id=`TASK-${String(n).padStart(3,'0')}`;}while(used.has(id));
    used.add(id);return id;
  };
  const assigned=[];
  const tasks=(plan.tasks||[]).map(t=>{
    if(t?.task_id)return t;
    const id=nextId();
    assigned.push(id);
    return {...t,task_id:id};
  });
  return {plan:{...plan,tasks},assigned};
}

/**
 * Migrate one run. Idempotent: an existing graph and existing task records are
 * preserved, and re-running reports SKIPPED rather than rebuilding.
 */
export function migrateRunToTaskRuntime(root,projectRoot,run,{dryRun=false}={}){
  const existingGraph=loadTaskGraph(projectRoot,run.run_id);
  const existingTasks=listTasks(projectRoot,run.run_id);
  if(existingGraph&&existingTasks.length){
    return {schema:'agent-sdlc/task-migration/v1',run_id:run.run_id,status:'SKIPPED',
      reason:'task graph and task records already exist',tasks:existingTasks.length,backup:null};
  }
  const found=findPlanArtifact(projectRoot,run.run_id);
  if(!found?.plan){
    return {schema:'agent-sdlc/task-migration/v1',run_id:run.run_id,status:'NO_PLAN_ARTIFACT',
      reason:found?.error||'no task-plan artifact recorded for this run',tasks:0,backup:null};
  }
  if(!KNOWN_PLAN_SCHEMAS.includes(found.plan.schema)){
    // Fail closed: a newer plan schema may carry semantics this code cannot honour.
    return {schema:'agent-sdlc/task-migration/v1',run_id:run.run_id,status:'FAILED_CLOSED',
      reason:`unknown plan schema ${found.plan.schema}`,tasks:0,backup:null};
  }

  const {plan,assigned}=assignStableTaskIds(found.plan);
  const legacy=POST_IMPLEMENT.includes(run.state);
  if(dryRun){
    return {schema:'agent-sdlc/task-migration/v1',run_id:run.run_id,status:'DRY_RUN',
      plan_id:plan.plan_id,plan_artifact_ref:found.meta.artifact_id,plan_sha256:sha256(JSON.stringify(found.plan)),
      generated_task_ids:assigned,would_create:plan.tasks.length,
      legacy_stage_evidence:legacy,tasks:0,backup:null};
  }

  const backupDir=backup(projectRoot,run.run_id);
  const result=materializeTaskGraph(root,projectRoot,run,plan,{
    planArtifactRef:found.meta.artifact_id,
    sourceRevision:found.meta.source_revision??plan.source_revision??null,
    legacyStageEvidence:legacy
  });
  if(!result.materialized){
    return {schema:'agent-sdlc/task-migration/v1',run_id:run.run_id,status:'INVALID_PLAN',
      reason:'the recorded plan no longer passes the plan validator',
      errors:result.validation.errors,tasks:0,backup:backupDir};
  }
  const record={
    schema:'agent-sdlc/task-migration/v1',
    run_id:run.run_id,
    status:'MIGRATED',
    plan_id:plan.plan_id,
    // The original artifact hash is preserved, not the ID-assigned copy's.
    plan_artifact_ref:found.meta.artifact_id,
    plan_sha256:sha256(JSON.stringify(found.plan)),
    generated_task_ids:assigned,
    created:result.created,
    preserved:result.preserved,
    tasks:result.created.length+result.preserved.length,
    // No per-task evidence is invented for work that already ran stage-level.
    evidence_class:legacy?'LEGACY_STAGE_EVIDENCE':'TASK_EVIDENCE',
    legacy_stage_evidence:legacy,
    initial_status:'CREATED',
    backup:backupDir,
    migrated_at:now()
  };
  writeJson(path.join(stateDir(projectRoot),'tasks',run.run_id,'migration.json'),record);
  return record;
}
