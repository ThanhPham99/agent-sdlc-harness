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
// The -ate/-ation family (investigate/investigation, evaluate/evaluation, ...)
// forms its noun regularly, so folding this one suffix pair lets "a security
// investigation" reach the "investigate" keyword without a general stemmer
// that would risk unrelated false matches elsewhere in the keyword table.
function foldVerbNounFamily(s){return s.split(' ').map(w=>w.length>6&&w.endsWith('ation')?w.slice(0,-5)+'ate':w).join(' ');}
function normalize(s){return foldVerbNounFamily(foldDiacritics(stripEmbeddedData(s)).toLowerCase().replace(/[^a-z0-9]+/g,' ').replace(/\s+/g,' ').trim());}
function keywordMatch(text,keyword){const t=` ${normalize(text)} `;const k=normalize(keyword);return k? t.includes(` ${k} `):false;}
const keywordWords=k=>normalize(k).split(' ').filter(Boolean).length;
// STRICT rules outrank everything else on a tie, since misreading a
// security/incident/db-migration objective as something lower-scrutiny is the
// worse mistake. Below that, "investigate" intent outranks a same-weight
// "change" hit, because an assessment verb usually governs the whole request
// ("investigate optimization opportunities" is a spike about optimization, not
// an optimization change) -- this is what let first-match-wins pick whichever
// rule happened to sit earlier in config/router-rules.json.
const rulePriority=r=>r.profile==='STRICT'?2:(r.intent==='investigate'?1.5:1);
const intentOf=r=>r.intent||'change';

export function route(root,objective,explicitWorkflow=null,explicitProfile=null){
  const wf=readJson(path.join(root,'config','workflows.json')).workflows;
  if(explicitWorkflow){if(!wf[explicitWorkflow])throw new Error(`unknown workflow: ${explicitWorkflow}`);return {workflow:explicitWorkflow,profile:explicitProfile||wf[explicitWorkflow].default_profile,overlays:wf[explicitWorkflow].required_overlays||[],reason_codes:['EXPLICIT_WORKFLOW'],risk_flags:[]};}
  const rules=readJson(path.join(root,'config','router-rules.json'));
  const candidates=rules.rules.map((rule,idx)=>{
    const hits=rule.keywords.filter(k=>keywordMatch(objective,k));
    const score=hits.reduce((sum,k)=>sum+keywordWords(k)*rulePriority(rule),0);
    return {rule,idx,hits,score};
  }).filter(c=>c.hits.length>0);
  if(!candidates.length)return {...rules.default,profile:explicitProfile||rules.default.profile,reason_codes:['DEFAULT_NEW_FEATURE'],risk_flags:[]};
  // Stable score-desc order; a genuine tie prefers STRICT, then declaration
  // order, so the outcome is deterministic rather than array-position luck.
  candidates.sort((a,b)=>b.score-a.score||(a.rule.profile==='STRICT'?0:1)-(b.rule.profile==='STRICT'?0:1)||a.idx-b.idx);
  const [top,second]=candidates;
  const risk_flags=[];
  if(top.rule.profile==='STRICT')risk_flags.push('HIGH_RISK_ROUTE');
  // Every match is reported, not just the winner's, so a human or the
  // orchestrator can see the competing interpretation that was scored down.
  const reason_codes=candidates.flatMap(c=>c.hits.map(h=>`KEYWORD:${h}`));
  if(second&&(second.score===top.score||intentOf(second.rule)!==intentOf(top.rule)||second.score>=top.score*0.5)){
    risk_flags.push('AMBIGUOUS_ROUTE');
  }
  return {workflow:top.rule.workflow,profile:explicitProfile||top.rule.profile,overlays:top.rule.overlays||[],reason_codes,risk_flags};
}
