import path from 'node:path';
import {readJson} from './util.mjs';

function stripEmbeddedData(s){return (s||'').replace(/```[\s\S]*?```/g,' ').replace(/"[^"]*"/g,' ').replace(/'[^']*'/g,' ').replace(/`[^`]*`/g,' ');}
function normalize(s){return stripEmbeddedData(s).toLowerCase().replace(/[^a-z0-9]+/g,' ').replace(/\s+/g,' ').trim();}
function keywordMatch(text,keyword){const t=` ${normalize(text)} `;const k=normalize(keyword);return k? t.includes(` ${k} `):false;}

export function route(root,objective,explicitWorkflow=null,explicitProfile=null){
  const wf=readJson(path.join(root,'config','workflows.json')).workflows;
  if(explicitWorkflow){if(!wf[explicitWorkflow])throw new Error(`unknown workflow: ${explicitWorkflow}`);return {workflow:explicitWorkflow,profile:explicitProfile||wf[explicitWorkflow].default_profile,overlays:wf[explicitWorkflow].required_overlays||[],reason_codes:['EXPLICIT_WORKFLOW'],risk_flags:[]};}
  const rules=readJson(path.join(root,'config','router-rules.json'));
  for(const r of rules.rules){const hits=r.keywords.filter(k=>keywordMatch(objective,k));if(hits.length)return {workflow:r.workflow,profile:explicitProfile||r.profile,overlays:r.overlays||[],reason_codes:hits.map(x=>`KEYWORD:${x}`),risk_flags:r.profile==='STRICT'?['HIGH_RISK_ROUTE']:[]};}
  return {...rules.default,profile:explicitProfile||rules.default.profile,reason_codes:['DEFAULT_NEW_FEATURE'],risk_flags:[]};
}
