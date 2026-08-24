import fs from 'node:fs';
import path from 'node:path';
import {stateDir} from './store.mjs';
import {uuid,now,writeJson,readJson} from './util.mjs';
export function putHandoff(projectRoot,run,payload={}){const h={schema:'agent-sdlc/handoff/v1',handoff_id:uuid('handoff'),run_id:run.run_id,stage:run.state,time:now(),objective:run.objective,summary:payload.summary||'',verified_facts:payload.verified_facts||[],unknowns:payload.unknowns||[],artifact_refs:payload.artifact_refs||run.artifacts||[],next_action:payload.next_action||null};const p=path.join(stateDir(projectRoot),'handoffs',`${h.handoff_id}.json`);writeJson(p,h);return h;}
export function getHandoff(projectRoot,id){return readJson(path.join(stateDir(projectRoot),'handoffs',`${id}.json`));}
export function listHandoffs(projectRoot,runId=null){const d=path.join(stateDir(projectRoot),'handoffs');if(!fs.existsSync(d))return [];return fs.readdirSync(d).filter(x=>x.endsWith('.json')).map(x=>readJson(path.join(d,x))).filter(x=>!runId||x.run_id===runId).sort((a,b)=>a.time.localeCompare(b.time));}
