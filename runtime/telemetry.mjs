import fs from 'node:fs';
import path from 'node:path';
import {stateDir} from './store.mjs';
import {reportUsage} from './cost.mjs';
export function metrics(projectRoot){const d=stateDir(projectRoot);const runsDir=path.join(d,'runs');const eventDir=path.join(d,'events');const runs=fs.existsSync(runsDir)?fs.readdirSync(runsDir).filter(x=>x.endsWith('.json')).map(x=>JSON.parse(fs.readFileSync(path.join(runsDir,x),'utf8'))):[];const states={};const workflows={};const eventTypes={};for(const r of runs){states[r.state]=(states[r.state]||0)+1;workflows[r.workflow]=(workflows[r.workflow]||0)+1;const p=path.join(eventDir,`${r.run_id}.jsonl`);if(fs.existsSync(p))for(const line of fs.readFileSync(p,'utf8').split('\n').filter(Boolean)){const e=JSON.parse(line);eventTypes[e.type]=(eventTypes[e.type]||0)+1;}}
 const token={input_tokens:0,cached_input_tokens:0,output_tokens:0,reasoning_tokens:0,wall_ms:0};for(const r of runs){const u=reportUsage(projectRoot,r.run_id).total;for(const k of Object.keys(token))token[k]+=u[k]||0;}
 return {schema:'agent-sdlc/metrics/v1',runs:runs.length,states,workflows,event_types:eventTypes,usage:token,derived:{completed:runs.filter(r=>r.state==='CLOSE').length,blocked:runs.filter(r=>['BLOCKED','NEEDS_CONFIRMATION'].includes(r.state)).length}};}
