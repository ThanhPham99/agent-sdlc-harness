import path from 'node:path';
import {readJson} from './util.mjs';
import {probe,capabilities} from './provider.mjs';

const HARD_STAGES=new Set(['DESIGN','REVIEW','RELEASE']);
const CHEAP_TASKS=new Set(['classification','triage','bounded-summary','metadata']);
const NO_MODEL_TASKS=new Set(['format','schema-validate','grep','build','test','lint','mechanical']);

export function routeModel(root,projectRoot,run,{task='stage',provider='auto',requireStructured=false}={}){
  const policy=readJson(path.join(root,'policies','model-routing.json'));
  const cfg=readJson(path.join(projectRoot,'.agent-sdlc','project.json'),{});
  if(NO_MODEL_TASKS.has(task))return {mode:'DETERMINISTIC',provider:null,tier:null,model_alias:null,reason:'mechanical-task'};
  let tier=policy.risk_floor?.[run.profile]||'standard';
  if(CHEAP_TASKS.has(task)&&run.profile!=='STRICT')tier='economy';
  if(run.profile==='STRICT'&&HARD_STAGES.has(run.state))tier='high';
  if(['incident-response','security-remediation'].includes(run.workflow)&&['DESIGN','PLAN','REVIEW'].includes(run.state))tier='high';
  const preferred=provider!=='auto'?[provider]:(cfg.providers?.preferred||policy.provider_order||[]);
  const considered=[];
  for(const host of preferred){
    let cap;
    try{cap=capabilities(host,probe(host));}catch{cap={host,available:false};}
    considered.push(cap);
    if(!cap.available)continue;
    if(requireStructured&&!cap.structured_output)continue;
    const envModel=process.env[`AGENT_SDLC_MODEL_${host.toUpperCase()}_${tier.toUpperCase()}`]||process.env[`AGENT_SDLC_MODEL_${host.toUpperCase()}`]||process.env[`AGENT_SDLC_QUAL_MODEL_${host.toUpperCase()}`];
    const projectModel=cfg.providers?.[host]?.models?.[tier]||cfg.providers?.[host]?.model;
    const modelAlias=envModel||projectModel||policy.provider_specific?.[host]?.[tier]||null;
    return {mode:'MODEL',provider:host,tier,model_alias:modelAlias,reason:'first-qualified-provider',considered};
  }
  return {mode:'PENDING',provider:null,tier,model_alias:null,reason:'no-qualified-provider-available',considered};
}
