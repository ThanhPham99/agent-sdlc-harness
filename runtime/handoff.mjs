import fs from 'node:fs';
import path from 'node:path';
import {uuid,now,writeJson,readJson} from './util.mjs';
import * as layout from './layout.mjs';
export function putHandoff(projectRoot,run,payload={}){const h={schema:'agent-sdlc/handoff/v1',handoff_id:uuid('handoff'),run_id:run.run_id,stage:run.state,time:now(),objective:run.objective,summary:payload.summary||'',verified_facts:payload.verified_facts||[],unknowns:payload.unknowns||[],artifact_refs:payload.artifact_refs||run.artifacts||[],next_action:payload.next_action||null};const p=layout.handoffFile(projectRoot,h.handoff_id);writeJson(p,h);return h;}
export function getHandoff(projectRoot,id){return readJson(layout.handoffFile(projectRoot,id));}
export function listHandoffs(projectRoot,runId=null){const d=layout.handoffsDir(projectRoot);if(!fs.existsSync(d))return [];return fs.readdirSync(d).filter(x=>x.endsWith('.json')).map(x=>readJson(path.join(d,x))).filter(x=>!runId||x.run_id===runId).sort((a,b)=>a.time.localeCompare(b.time));}
