import path from 'node:path';
import fs from 'node:fs';
import {estimateTokens,gitSha,readJson,sha256,truncateUtf8} from './util.mjs';
import {getArtifact} from './store.mjs';

const CORE_SKILL_BY_STAGE={
  INTAKE:'requirements',REQUIREMENTS:'requirements',DESIGN:'architecture',PLAN:'planning',
  IMPLEMENT:'implementation',VERIFY:'testing',REVIEW:'code-review',RELEASE:'ci-cd',
  DEPLOY:'deployment',OBSERVE:'monitoring',CLOSE:'documentation'
};
const WORKFLOW_SKILLS={
  'security-remediation':['security'],'incident-response':['incident'],'dependency-upgrade':['upgrade'],
  'database-migration':['database'],'performance':['performance'],'maintenance':['maintenance'],
  'refactor':['maintenance'],'modernization':['modernization'],'compliance-change':['compliance'],
  'documentation':['documentation'],'ci-cd-change':['ci-cd'],'infrastructure-change':['ci-cd'],
  'observability-change':['monitoring'],'api-breaking-change':['documentation'],'deprecation-removal':['upgrade','documentation']
};
const OVERLAY_SKILLS={security:'security',incident:'incident','db-migration':'database','api-breaking-change':'documentation'};

function resolveSkills(root,run){
  const registry=readJson(path.join(root,'config','skills.json')).internal||{};
  const ids=[]; const add=id=>{if(id&&registry[id]&&!ids.includes(id)&&registry[id].stages?.includes(run.state))ids.push(id);};
  add(CORE_SKILL_BY_STAGE[run.state]);
  for(const id of WORKFLOW_SKILLS[run.workflow]||[])add(id);
  for(const overlay of run.overlays||[])add(OVERLAY_SKILLS[overlay]);
  // Release/deploy work always needs deployment semantics; strict stages also carry security review guidance.
  if(['RELEASE','DEPLOY'].includes(run.state))add('deployment');
  if(run.profile==='STRICT'&&['DESIGN','VERIFY','REVIEW','RELEASE'].includes(run.state))add('security');
  return ids.map(id=>{const spec=registry[id];let instructions='';try{instructions=fs.readFileSync(path.join(root,spec.instructions),'utf8').trim();}catch{}return {id,description:spec.description,instructions,max_response_words:spec.max_response_words};});
}

export function buildContext(root,projectRoot,run,{symbols=[],artifactRefs=[],constraints=[]}={}){
  const stagePolicy=readJson(path.join(root,'policies','stage-policy.json')).stages[run.state];
  if(!stagePolicy)throw new Error(`no stage policy for ${run.state}`);
  const cfg=readJson(path.join(projectRoot,'.agent-sdlc','project.json'),{});
  const policy=readJson(path.join(root,'policies','context-policy.json'));
  const charsPerToken=policy.limits?.context_estimate_chars_per_token||4;
  const maxContextTokens=stagePolicy.budget?.max_context_tokens_estimate||40000;
  // Keep artifact payload to at most ~55% of stage context budget, preserving room for system/tool/skill/task text.
  let remainingArtifactBytes=Math.max(8000,Math.floor(maxContextTokens*charsPerToken*0.55));
  const artifacts=[];
  for(const ref of artifactRefs.slice(-20)){
    try{
      const a=getArtifact(projectRoot,ref);
      const cap=Math.min(4000,remainingArtifactBytes);
      if(cap<=0)break;
      const t=truncateUtf8(a.content,cap);
      artifacts.push({ref,kind:a.meta.kind,summary:t.text,sha256:a.meta.sha256,truncated:t.truncated});
      remainingArtifactBytes-=Buffer.byteLength(t.text);
    }catch{artifacts.push({ref,missing:true});}
  }
  const skills=resolveSkills(root,run);
  const manifest={
    schema:'agent-sdlc/context-manifest/v1',run_id:run.run_id,objective:run.objective,git_sha:gitSha(projectRoot),
    stage:run.state,workflow:run.workflow,profile:run.profile,artifacts:artifactRefs,symbols,
    constraints:[...(cfg.context?.project_invariants||[]),...constraints],evidence_required:stagePolicy.gate_requirements||[],
    allowed_tools:stagePolicy.allowed_tools,budget:stagePolicy.budget,
    skills:skills.map(s=>({id:s.id,description:s.description,max_response_words:s.max_response_words})),
    skill_instructions:skills.map(s=>({id:s.id,instructions:s.instructions})),artifact_summaries:artifacts
  };
  const serialized=JSON.stringify(manifest);
  manifest.estimated_tokens=estimateTokens(serialized,charsPerToken);
  manifest.context_budget_status=manifest.estimated_tokens<=maxContextTokens?'WITHIN_BUDGET':'OVER_BUDGET';
  manifest.context_hash=sha256(serialized);
  return manifest;
}

export function renderPrompt(root,manifest){
  const system=fs.readFileSync(path.join(root,'prompts','system.md'),'utf8').trim();
  const skillText=(manifest.skill_instructions||[]).map(s=>`### ${s.id}\n${s.instructions}`).join('\n\n');
  return `${system}\n\nSTAGE SKILLS\n${skillText||'(none)'}\n\nOBJECTIVE\n${manifest.objective}\n\nSTAGE\n${manifest.stage}\n\nAUTHORIZED SYMBOLS\n${(manifest.symbols||[]).join('\n')||'(discover only as needed)'}\n\nSOURCE ARTIFACTS\n${(manifest.artifact_summaries||[]).map(a=>`${a.ref} ${a.kind||''}\n${a.summary||''}`).join('\n\n')||'(none)'}\n\nCONSTRAINTS\n${(manifest.constraints||[]).join('\n')||'(none)'}\n\nREQUIRED EVIDENCE\n${(manifest.evidence_required||[]).join('\n')||'(none)'}\n\nALLOWED TOOLS\n${(manifest.allowed_tools||[]).join(', ')}\n\nReturn a compact StageResult JSON.`;
}
