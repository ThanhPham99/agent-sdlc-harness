import path from 'node:path';
import {estimateTokens,gitSha,readJson,readTextFile,sha256,truncateUtf8} from './util.mjs';
import {getArtifact} from './store.mjs';
import {getProjectKnowledgeStatus} from './project-knowledge.mjs';
import {resolveProcedures} from './procedures.mjs';

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
const OVERLAY_SKILLS={security:'security',incident:'incident','db-migration':'database','api-breaking-change':'documentation','client-impact':'frontend-integration'};
// Extra ids resolveSkills adds outside the three maps above (see resolveSkills
// below): deployment/security are stage- and profile-driven, project-bootstrap
// is G0-driven. The procedure-coverage audit (runtime/procedures.mjs) treats
// every id reachable through this function as accounted for, so a file only
// needs registering in config/procedures.json when nothing here already
// reaches it.
export function legacyReachableSkillIds(){
  return new Set([
    ...Object.values(CORE_SKILL_BY_STAGE),
    ...Object.values(WORKFLOW_SKILLS).flat(),
    ...Object.values(OVERLAY_SKILLS),
    'deployment','security','project-bootstrap'
  ]);
}

function resolveRoles(root,stagePolicy){
  const registry=readJson(path.join(root,'config','roles.json')).roles||{};
  return (stagePolicy.roles||[]).filter(id=>registry[id]).map(id=>{
    const r=registry[id];
    return {id,responsibilities:r.responsibilities||[],default_constraint:r.default_constraint};
  });
}

function resolveSkills(root,projectRoot,run){
  const registry=readJson(path.join(root,'config','skills.json')).internal||{};
  const ids=[]; const add=id=>{if(id&&registry[id]&&!ids.includes(id)&&registry[id].stages?.includes(run.state))ids.push(id);};
  add(CORE_SKILL_BY_STAGE[run.state]);
  for(const id of WORKFLOW_SKILLS[run.workflow]||[])add(id);
  for(const overlay of run.overlays||[])add(OVERLAY_SKILLS[overlay]);
  // Release/deploy work always needs deployment semantics; strict stages also carry security review guidance.
  if(['RELEASE','DEPLOY'].includes(run.state))add('deployment');
  if(run.profile==='STRICT'&&['DESIGN','VERIFY','REVIEW','RELEASE'].includes(run.state))add('security');
  // G0: a new feature with no captured project knowledge bootstraps it first,
  // rather than the model guessing at architecture it was never shown. Scoped
  // to new-feature only -- a missing doc does not turn every other workflow
  // into a project bootstrap.
  if(run.workflow==='new-feature'&&['INTAKE','REQUIREMENTS'].includes(run.state)){
    if(getProjectKnowledgeStatus(projectRoot).status!=='READY')add('project-bootstrap');
  }
  // readTextFile, not readFileSync: skill text is hashed into context_hash, so a
  // CRLF checkout must not change the hash for the same commit.
  return ids.map(id=>{const spec=registry[id];let instructions='';try{instructions=readTextFile(path.join(root,spec.instructions)).trim();}catch{}return {id,description:spec.description,instructions,max_response_words:spec.max_response_words};});
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
  const skills=resolveSkills(root,projectRoot,run);
  const procedures=resolveProcedures(root,projectRoot,run);
  const manifest={
    schema:'agent-sdlc/context-manifest/v1',run_id:run.run_id,objective:run.objective,git_sha:gitSha(projectRoot),
    stage:run.state,workflow:run.workflow,profile:run.profile,artifacts:artifactRefs,symbols,
    constraints:[...(cfg.context?.project_invariants||[]),...constraints],evidence_required:stagePolicy.gate_requirements||[],
    allowed_tools:stagePolicy.allowed_tools,budget:stagePolicy.budget,active_roles:resolveRoles(root,stagePolicy),
    skills:skills.map(s=>({id:s.id,description:s.description,max_response_words:s.max_response_words})),
    skill_instructions:skills.map(s=>({id:s.id,instructions:s.instructions})),artifact_summaries:artifacts,
    procedures:procedures.map(p=>({id:p.id,group:p.group,when:p.when})),
    procedure_instructions:procedures.map(p=>({id:p.id,instructions:p.instructions}))
  };
  const serialized=JSON.stringify(manifest);
  manifest.estimated_tokens=estimateTokens(serialized,charsPerToken);
  manifest.context_budget_status=manifest.estimated_tokens<=maxContextTokens?'WITHIN_BUDGET':'OVER_BUDGET';
  manifest.context_hash=sha256(serialized);
  return manifest;
}

export function renderPrompt(root,manifest){
  const system=readTextFile(path.join(root,'prompts','system.md')).trim();
  const skillText=(manifest.skill_instructions||[]).map(s=>`### ${s.id}\n${s.instructions}`).join('\n\n');
  const roleText=(manifest.active_roles||[]).map(r=>`${r.id}: ${(r.responsibilities||[]).join(', ')}`).join('\n');
  const procedureText=(manifest.procedure_instructions||[]).map(p=>`### ${p.id}\n${p.instructions}`).join('\n\n');
  return `${system}\n\nSTAGE SKILLS\n${skillText||'(none)'}\n\nDETAILED PROCEDURES\n${procedureText||'(none)'}\n\nOBJECTIVE\n${manifest.objective}\n\nSTAGE\n${manifest.stage}\n\nACTIVE ROLES\n${roleText||'(none)'}\n\nAUTHORIZED SYMBOLS\n${(manifest.symbols||[]).join('\n')||'(discover only as needed)'}\n\nSOURCE ARTIFACTS\n${(manifest.artifact_summaries||[]).map(a=>`${a.ref} ${a.kind||''}\n${a.summary||''}`).join('\n\n')||'(none)'}\n\nCONSTRAINTS\n${(manifest.constraints||[]).join('\n')||'(none)'}\n\nREQUIRED EVIDENCE\n${(manifest.evidence_required||[]).join('\n')||'(none)'}\n\nALLOWED TOOLS\n${(manifest.allowed_tools||[]).join(', ')}\n\nReturn a compact StageResult JSON.`;
}
