import fs from 'node:fs';
import path from 'node:path';
import {appendJsonl,ensureDir,now,readJson,sha256,uuid,writeJson,rootFrom} from './util.mjs';
const HARNESS_VERSION=readJson(path.join(rootFrom(import.meta.url),'agent-sdlc.manifest.json')).version;
export function stateDir(projectRoot){return path.join(projectRoot,'.agent-sdlc');}
export function initProject(projectRoot,config){const d=stateDir(projectRoot); ensureDir(path.join(d,'runs'));ensureDir(path.join(d,'artifacts','objects'));ensureDir(path.join(d,'artifacts','meta'));ensureDir(path.join(d,'events'));ensureDir(path.join(d,'cost'));ensureDir(path.join(d,'handoffs'));ensureDir(path.join(d,'tasks'));ensureDir(path.join(d,'task-events'));ensureDir(path.join(d,'task-evidence'));ensureDir(path.join(d,'task-context')); writeJson(path.join(d,'project.json'),config);const statePath=path.join(d,'state.json');if(!fs.existsSync(statePath))writeJson(statePath,{schema:'agent-sdlc/state/v1',harness_version:HARNESS_VERSION,created_at:now()}); return d;}
export function projectConfig(projectRoot){return readJson(path.join(stateDir(projectRoot),'project.json'));}
export function runPath(projectRoot,runId){return path.join(stateDir(projectRoot),'runs',`${runId}.json`);}
// The run document is read-modify-write on every transition. Two writers that
// loaded the same revision would silently drop the first one's evidence, so a
// stale write is refused instead: reload the run and reapply. `writeJson` is
// atomic, so an interrupted write cannot truncate the document either.
export function saveRun(projectRoot,run){
  const p=runPath(projectRoot,run.run_id);
  const disk=fs.existsSync(p)?readJson(p,{}):null;
  if(disk?.updated_at&&run.updated_at&&disk.updated_at!==run.updated_at){
    throw new Error(`STALE_RUN_STATE: run ${run.run_id} was updated on disk at ${disk.updated_at} after this copy was loaded at ${run.updated_at}; reload the run and reapply the change`);
  }
  run.updated_at=now();
  writeJson(p,run);
}
export function loadRun(projectRoot,runId){return readJson(runPath(projectRoot,runId));}
// Event sequence numbers were derived by reading and splitting the whole event
// log on every append: quadratic in the number of events for a single run. The
// count is now derived once per stream per process and then incremented.
const seqCache=new Map();
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
export function emit(projectRoot,run,event){const p=path.join(stateDir(projectRoot),'events',`${run.run_id}.jsonl`); const full={event_id:uuid('evt'),run_id:run.run_id,seq:nextSeq(p),time:now(),stage:run.state,provider:null,artifact_refs:[],usage:{},...event};appendJsonl(p,full);return full;}
export function putArtifact(projectRoot,{kind,content,runId=null,stage=null,sourceRevision=null,filename=null}){const d=stateDir(projectRoot);const hash=sha256(content);const objectPath=path.join(d,'artifacts','objects',hash);if(!fs.existsSync(objectPath))fs.writeFileSync(objectPath,content);const meta={artifact_id:`artifact://sha256/${hash}`,kind,sha256:hash,path:objectPath,filename,created_at:now(),run_id:runId,stage,source_revision:sourceRevision};writeJson(path.join(d,'artifacts','meta',`${hash}.json`),meta);return meta;}
export function getArtifact(projectRoot,ref){const hash=ref.replace('artifact://sha256/','');const d=stateDir(projectRoot);const meta=readJson(path.join(d,'artifacts','meta',`${hash}.json`));return {meta,content:fs.readFileSync(path.join(d,'artifacts','objects',hash),'utf8')};}
// ---------------------------------------------------------------------------
// Task runtime persistence (alpha5).
//
// Task records are small, mutable and written often. They are written through a
// temp file + rename so an interrupted process leaves either the previous
// record or the new one, never a truncated JSON file. Large evidence stays in
// the content-addressed artifact store; task records hold refs.
// ---------------------------------------------------------------------------
export function tasksDir(projectRoot,runId){return path.join(stateDir(projectRoot),'tasks',runId);}
export function taskPath(projectRoot,runId,taskId){return path.join(tasksDir(projectRoot,runId),`${taskId}.json`);}
export function taskGraphPath(projectRoot,runId){return path.join(tasksDir(projectRoot,runId),'graph.json');}
// `writeJson` is itself temp-file + rename now, so every JSON document the
// runtime owns gets the durability task records already had.
const writeJsonAtomic=writeJson;
export function saveTask(projectRoot,task){
  if(!task?.run_id||!task?.task_id)throw new Error('task requires run_id and task_id');
  task.updated_at=now();
  writeJsonAtomic(taskPath(projectRoot,task.run_id,task.task_id),task);
  return task;
}
export function loadTask(projectRoot,runId,taskId){return readJson(taskPath(projectRoot,runId,taskId));}
export function hasTask(projectRoot,runId,taskId){return fs.existsSync(taskPath(projectRoot,runId,taskId));}
export function listTasks(projectRoot,runId){
  const d=tasksDir(projectRoot,runId);
  if(!fs.existsSync(d))return [];
  // Only task records. `graph.json`, `migration.json` and any future sidecar
  // file live in the same directory and must never be read as tasks.
  return fs.readdirSync(d).filter(x=>/^TASK-[0-9]+\.json$/.test(x)).sort()
    .map(x=>readJson(path.join(d,x)));
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
  const p=path.join(stateDir(projectRoot),'task-events',`${task.run_id}.jsonl`);
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
  const p=path.join(stateDir(projectRoot),'task-events',`${runId}.jsonl`);
  if(!fs.existsSync(p))return [];
  const rows=fs.readFileSync(p,'utf8').split('\n').filter(Boolean).map(l=>JSON.parse(l));
  return taskId?rows.filter(r=>r.task_id===taskId):rows;
}
export function putTaskContextManifest(projectRoot,manifest){
  const p=path.join(stateDir(projectRoot),'task-context',manifest.run_id,`${manifest.task_id}.json`);
  writeJsonAtomic(p,manifest);
  return {path:p,context_hash:manifest.context_hash};
}
export function getTaskContextManifest(projectRoot,runId,taskId){
  const p=path.join(stateDir(projectRoot),'task-context',runId,`${taskId}.json`);
  return fs.existsSync(p)?readJson(p):null;
}

export function listArtifacts(projectRoot){const d=path.join(stateDir(projectRoot),'artifacts','meta');if(!fs.existsSync(d))return [];return fs.readdirSync(d).filter(x=>x.endsWith('.json')).map(x=>readJson(path.join(d,x)));}
