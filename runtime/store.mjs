import fs from 'node:fs';
import path from 'node:path';
import {appendJsonl,ensureDir,now,readJson,sha256,uuid,writeJson} from './util.mjs';
export function stateDir(projectRoot){return path.join(projectRoot,'.agent-sdlc');}
export function initProject(projectRoot,config){const d=stateDir(projectRoot); ensureDir(path.join(d,'runs'));ensureDir(path.join(d,'artifacts','objects'));ensureDir(path.join(d,'artifacts','meta'));ensureDir(path.join(d,'events'));ensureDir(path.join(d,'cost'));ensureDir(path.join(d,'handoffs')); writeJson(path.join(d,'project.json'),config);const statePath=path.join(d,'state.json');if(!fs.existsSync(statePath))writeJson(statePath,{schema:'agent-sdlc/state/v1',harness_version:'3.0.0-alpha3',created_at:now()}); return d;}
export function projectConfig(projectRoot){return readJson(path.join(stateDir(projectRoot),'project.json'));}
export function runPath(projectRoot,runId){return path.join(stateDir(projectRoot),'runs',`${runId}.json`);}
export function saveRun(projectRoot,run){run.updated_at=now();writeJson(runPath(projectRoot,run.run_id),run);}
export function loadRun(projectRoot,runId){return readJson(runPath(projectRoot,runId));}
export function emit(projectRoot,run,event){const p=path.join(stateDir(projectRoot),'events',`${run.run_id}.jsonl`); const seq=fs.existsSync(p)?fs.readFileSync(p,'utf8').split('\n').filter(Boolean).length+1:1; const full={event_id:uuid('evt'),run_id:run.run_id,seq,time:now(),stage:run.state,provider:null,artifact_refs:[],usage:{},...event};appendJsonl(p,full);return full;}
export function putArtifact(projectRoot,{kind,content,runId=null,stage=null,sourceRevision=null,filename=null}){const d=stateDir(projectRoot);const hash=sha256(content);const objectPath=path.join(d,'artifacts','objects',hash);if(!fs.existsSync(objectPath))fs.writeFileSync(objectPath,content);const meta={artifact_id:`artifact://sha256/${hash}`,kind,sha256:hash,path:objectPath,filename,created_at:now(),run_id:runId,stage,source_revision:sourceRevision};writeJson(path.join(d,'artifacts','meta',`${hash}.json`),meta);return meta;}
export function getArtifact(projectRoot,ref){const hash=ref.replace('artifact://sha256/','');const d=stateDir(projectRoot);const meta=readJson(path.join(d,'artifacts','meta',`${hash}.json`));return {meta,content:fs.readFileSync(path.join(d,'artifacts','objects',hash),'utf8')};}
export function listArtifacts(projectRoot){const d=path.join(stateDir(projectRoot),'artifacts','meta');if(!fs.existsSync(d))return [];return fs.readdirSync(d).filter(x=>x.endsWith('.json')).map(x=>readJson(path.join(d,x)));}
