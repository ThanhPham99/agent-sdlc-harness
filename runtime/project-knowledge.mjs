// Project knowledge readiness (G0). Knowledge itself is authored by the model
// through the project-bootstrap skill and stored as ordinary content-addressed
// artifacts (kind: system-context / architecture / standards / feature-index);
// this module only answers the deterministic question of whether that
// knowledge exists yet, so the orchestrator can decide whether to load the
// bootstrap skill before a new feature starts, without guessing at
// architecture it was never shown.
import fs from 'node:fs';
import path from 'node:path';
import {stateDir} from './store.mjs';

export const KNOWLEDGE_KINDS=['system-context','architecture','standards','feature-index'];

function artifactsByKind(projectRoot,kind){
  const dir=path.join(stateDir(projectRoot),'artifacts','meta');
  if(!fs.existsSync(dir))return [];
  const rows=[];
  for(const f of fs.readdirSync(dir)){
    if(!f.endsWith('.json'))continue;
    try{
      const meta=JSON.parse(fs.readFileSync(path.join(dir,f),'utf8'));
      if(meta.kind===kind)rows.push(meta);
    }catch{}
  }
  return rows.sort((a,b)=>String(a.created_at).localeCompare(String(b.created_at)));
}

export function getProjectKnowledgeStatus(projectRoot){
  const present={};
  for(const kind of KNOWLEDGE_KINDS){
    const rows=artifactsByKind(projectRoot,kind);
    present[kind]=rows.length?rows.at(-1).artifact_id:null;
  }
  const have=KNOWLEDGE_KINDS.filter(k=>present[k]);
  const missing=KNOWLEDGE_KINDS.filter(k=>!present[k]);
  const status=have.length===0?'MISSING':missing.length===0?'READY':'PARTIAL';
  return {schema:'agent-sdlc/project-knowledge-status/v1',status,present,missing};
}
