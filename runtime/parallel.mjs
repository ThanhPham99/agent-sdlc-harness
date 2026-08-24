import path from 'node:path';
import {readJson} from './util.mjs';
function overlap(a=[],b=[]){return a.some(x=>b.includes(x));}
export function parallelPlan(root,tasks=[]){
  const p=readJson(path.join(root,'policies','parallelism-policy.json'));const normalized=tasks.map((t,i)=>({id:t.id||`task-${i+1}`,read_only:!!t.read_only,write_set:t.write_set||[],interface_set:t.interface_set||[],estimated_seconds:Number(t.estimated_seconds||0)}));
  const conflicts=[];for(let i=0;i<normalized.length;i++)for(let j=i+1;j<normalized.length;j++){const a=normalized[i],b=normalized[j];if(overlap(a.write_set,b.write_set)||overlap(a.interface_set,b.interface_set))conflicts.push([a.id,b.id]);}
  const disjoint=conflicts.length===0;const useful=normalized.length>1&&normalized.some(t=>t.estimated_seconds>=60);const allReadOnly=normalized.every(t=>t.read_only);
  const max=(disjoint&&(allReadOnly||useful))?Math.min(p.hard_default_max||2,normalized.length):p.default_max_parallel_agents||1;
  return {decision:max>1?'PARALLEL_BOUNDED':'SERIAL',max_parallel_agents:max,conflicts,tasks:normalized,reason:conflicts.length?'shared-write-or-interface':(max>1?'disjoint-and-worthwhile':'coordination-cost-not-justified')};
}
