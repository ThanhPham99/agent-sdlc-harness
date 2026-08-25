import path from 'node:path';
import {readJson} from './util.mjs';

function stripEmbeddedData(s){return (s||'').replace(/```[\s\S]*?```/g,' ').replace(/"[^"]*"/g,' ').replace(/'[^']*'/g,' ').replace(/`[^`]*`/g,' ');}
// Objectives are written in the operator's own language. Normalization used to
// drop every non-ASCII character, so a Vietnamese objective disintegrated into
// fragments ("sửa lỗi" -> "s a l i") and always fell through to the default
// workflow, taking the wrong stage set and profile with it. Folding combining
// marks keeps a single ASCII keyword table serving both languages; the same
// folding is applied to the keywords, so rules stay readable with diacritics.
// Combining marks are matched by code point rather than by a regex literal so
// the source stays readable in any editor; d-with-stroke does not decompose.
function foldDiacritics(s){
  let out='';
  for(const ch of s.normalize('NFD')){
    const c=ch.codePointAt(0);
    if(c>=0x0300&&c<=0x036f)continue;
    out+=(c===0x0111||c===0x0110)?'d':ch;
  }
  return out;
}
function normalize(s){return foldDiacritics(stripEmbeddedData(s)).toLowerCase().replace(/[^a-z0-9]+/g,' ').replace(/\s+/g,' ').trim();}
function keywordMatch(text,keyword){const t=` ${normalize(text)} `;const k=normalize(keyword);return k? t.includes(` ${k} `):false;}

export function route(root,objective,explicitWorkflow=null,explicitProfile=null){
  const wf=readJson(path.join(root,'config','workflows.json')).workflows;
  if(explicitWorkflow){if(!wf[explicitWorkflow])throw new Error(`unknown workflow: ${explicitWorkflow}`);return {workflow:explicitWorkflow,profile:explicitProfile||wf[explicitWorkflow].default_profile,overlays:wf[explicitWorkflow].required_overlays||[],reason_codes:['EXPLICIT_WORKFLOW'],risk_flags:[]};}
  const rules=readJson(path.join(root,'config','router-rules.json'));
  for(const r of rules.rules){const hits=r.keywords.filter(k=>keywordMatch(objective,k));if(hits.length)return {workflow:r.workflow,profile:explicitProfile||r.profile,overlays:r.overlays||[],reason_codes:hits.map(x=>`KEYWORD:${x}`),risk_flags:r.profile==='STRICT'?['HIGH_RISK_ROUTE']:[]};}
  return {...rules.default,profile:explicitProfile||rules.default.profile,reason_codes:['DEFAULT_NEW_FEATURE'],risk_flags:[]};
}
