import path from 'node:path';
import {estimateTokens,gitSha,readJson,readTextFile,sha256,truncateUtf8} from './util.mjs';
import {getArtifact} from './store.mjs';
import {getProjectKnowledgeStatus} from './project-knowledge.mjs';
import {resolveProcedures} from './procedures.mjs';
import {loadRequirementUpdatePlan} from './requirement-update.mjs';
import {loadFeature,loadPhase} from './features.mjs';

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

function resolveFeatureContext(projectRoot,run){
  if(!run.feature_id)return null;
  try{
    const feature=loadFeature(projectRoot,run.feature_id);
    const phase=run.phase_id?loadPhase(projectRoot,run.feature_id,run.phase_id):null;
    return {feature_id:feature.feature_id,title:feature.title,status:feature.status,
      open_questions:feature.open_questions,deferred_items:feature.deferred_items,
      phase:phase?{phase_id:phase.phase_id,name:phase.name,status:phase.status}:null};
  }catch{return null;} // run.feature_id is a durable pointer; a project restored without .agent-sdlc/features/ must not crash context compilation
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

/**
 * Condense verbose test/build stdout/stderr to reduce token footprint while preserving
 * 100% of error diagnostics, stack traces, failure summaries, and assertion mismatches.
 */
export function condenseLog(rawLog,{maxLines=60,preserveHead=10,preserveTail=25}={}){
  const text=String(rawLog||'').trim();
  if(!text)return '';
  const lines=text.split('\n');
  if(lines.length<=maxLines)return text;

  const errorIndices=new Set();
  const errorPatterns=/(?:error|err|fail|fatal|exception|syntaxerror|typeerror|assertionerror|errno|stack|at\s+.*:\d+|\^|--- FAIL:|FAIL\s+|FAILED\s+|FAILURES|failures:|assertion failed:|short test summary info|expected:<.*> but was:<.*>|expected.*received|panicked at|panic:)/i;
  const blockPatterns=/(?:short test summary info|FAILURES|failures:|=== FAILURES ===|AssertionError|Expected:|Received:|expected:<)/i;

  for(let i=0;i<lines.length;i++){
    if(errorPatterns.test(lines[i])){
      const isBlock=blockPatterns.test(lines[i]);
      const before=isBlock?3:2;
      const after=isBlock?8:4;
      for(let j=Math.max(0,i-before);j<=Math.min(lines.length-1,i+after);j++){
        errorIndices.add(j);
      }
    }
  }

  for(let i=0;i<Math.min(preserveHead,lines.length);i++)errorIndices.add(i);
  for(let i=Math.max(0,lines.length-preserveTail);i<lines.length;i++)errorIndices.add(i);

  const selectedLines=[...errorIndices].sort((a,b)=>a-b);
  const result=[];
  let lastIdx=-1;

  for(const idx of selectedLines){
    if(lastIdx!==-1&&idx>lastIdx+1){
      const omitted=idx-lastIdx-1;
      result.push(`... [${omitted} verbose log lines omitted for brevity] ...`);
    }
    result.push(lines[idx]);
    lastIdx=idx;
  }

  return result.join('\n');
}

/**
 * Compact artifact summaries when context payload exceeds stage token budget.
 */
export function compactArtifactSummaries(artifacts,maxBudgetTokens,charsPerToken=4){
  if(!Array.isArray(artifacts)||artifacts.length===0)return artifacts;
  const maxBytes=maxBudgetTokens*charsPerToken;
  let totalBytes=artifacts.reduce((acc,a)=>acc+(a.summary?Buffer.byteLength(a.summary):0),0);
  if(totalBytes<=maxBytes)return artifacts;

  const compacted=artifacts.map(a=>({...a}));
  for(let i=0;i<compacted.length-1;i++){
    if(totalBytes<=maxBytes)break;
    const a=compacted[i];
    if(a.summary&&a.summary.length>200){
      const originalBytes=Buffer.byteLength(a.summary);
      const lines=a.summary.split('\n');
      const concise=lines.slice(0,3).join('\n')+`\n... [compacted from ${lines.length} lines, sha256: ${a.sha256?a.sha256.slice(0,12):'n/a'}]`;
      a.summary=concise;
      a.compacted=true;
      totalBytes-=(originalBytes-Buffer.byteLength(concise));
    }
  }
  return compacted;
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
  const maxArtifactTokens=Math.floor(maxContextTokens*0.45);
  const finalArtifacts=compactArtifactSummaries(artifacts,maxArtifactTokens,charsPerToken);
  const skills=resolveSkills(root,projectRoot,run);
  const procedures=resolveProcedures(root,projectRoot,run);
  const manifest={
    schema:'agent-sdlc/context-manifest/v1',run_id:run.run_id,objective:run.objective,git_sha:gitSha(projectRoot),
    stage:run.state,workflow:run.workflow,profile:run.profile,artifacts:artifactRefs,symbols,
    constraints:[...(cfg.context?.project_invariants||[]),...constraints],evidence_required:stagePolicy.gate_requirements||[],
    allowed_tools:stagePolicy.allowed_tools,budget:stagePolicy.budget,active_roles:resolveRoles(root,stagePolicy),
    skills:skills.map(s=>({id:s.id,description:s.description,max_response_words:s.max_response_words})),
    skill_instructions:skills.map(s=>({id:s.id,instructions:s.instructions})),artifact_summaries:finalArtifacts,
    procedures:procedures.map(p=>({id:p.id,group:p.group,when:p.when})),
    procedure_instructions:procedures.map(p=>({id:p.id,instructions:p.instructions})),
    requirement_update:run.workflow==='requirement-update'?loadRequirementUpdatePlan(projectRoot,run.run_id):null,
    feature:resolveFeatureContext(projectRoot,run)
  };
  const serialized=JSON.stringify(manifest);
  manifest.estimated_tokens=estimateTokens(serialized,charsPerToken);
  manifest.context_budget_status=manifest.estimated_tokens<=maxContextTokens?'WITHIN_BUDGET':'OVER_BUDGET';
  manifest.context_hash=sha256(serialized);
  return manifest;
}

export function renderCacheablePrompt(root,manifest){
  const system=readTextFile(path.join(root,'prompts','system.md')).trim();
  const skillText=(manifest.skill_instructions||[]).map(s=>`### ${s.id}\n${s.instructions}`).join('\n\n');
  const roleText=(manifest.active_roles||[]).map(r=>`${r.id}: ${(r.responsibilities||[]).join(', ')}`).join('\n');
  const procedureText=(manifest.procedure_instructions||[]).map(p=>`### ${p.id}\n${p.instructions}`).join('\n\n');
  const ru=manifest.requirement_update;
  const requirementUpdateText=ru?`This run continues ${ru.continues_run_id}. Changed: ${ru.changed} (${ru.delta_class}). ${ru.affected_count} node(s) invalidated, ${ru.preserved_count} preserved -- do not redo preserved work. Earliest affected stage: ${ru.earliest_outer_gate||'none (no downstream impact)'}. This run still must produce its own evidence at every gate it passes through.`:'';
  const ft=manifest.feature;
  const featureText=ft?`Feature ${ft.feature_id} "${ft.title}" (${ft.status})${ft.phase?`, phase ${ft.phase.phase_id} "${ft.phase.name}" (${ft.phase.status})`:''}.${ft.deferred_items?.length?` Deferred: ${ft.deferred_items.join('; ')}.`:''}${ft.open_questions?.length?` Open questions: ${ft.open_questions.join('; ')}.`:''} This run finishing does not mean the feature is complete -- feature completion is tracked separately.`:'';

  const staticPrefix=`${system}\n\nALLOWED TOOLS\n${(manifest.allowed_tools||[]).join(', ')}`;
  const stagePrefix=`STAGE SKILLS\n${skillText||'(none)'}\n\nDETAILED PROCEDURES\n${procedureText||'(none)'}\n\nACTIVE ROLES\n${roleText||'(none)'}`;
  const dynamicSuffix=`OBJECTIVE\n${manifest.objective}\n\nSTAGE\n${manifest.stage}\n\nFEATURE\n${featureText||'(standalone run, not attached to a feature)'}\n\nREQUIREMENT UPDATE\n${requirementUpdateText||'(none)'}\n\nAUTHORIZED SYMBOLS\n${(manifest.symbols||[]).join('\n')||'(discover only as needed)'}\n\nSOURCE ARTIFACTS\n${(manifest.artifact_summaries||[]).map(a=>`${a.ref} ${a.kind||''}\n${a.summary||''}`).join('\n\n')||'(none)'}\n\nCONSTRAINTS\n${(manifest.constraints||[]).join('\n')||'(none)'}\n\nREQUIRED EVIDENCE\n${(manifest.evidence_required||[]).join('\n')||'(none)'}\n\nReturn a compact StageResult JSON.`;

  const fullPrompt=`${system}\n\nSTAGE SKILLS\n${skillText||'(none)'}\n\nDETAILED PROCEDURES\n${procedureText||'(none)'}\n\nOBJECTIVE\n${manifest.objective}\n\nSTAGE\n${manifest.stage}\n\nFEATURE\n${featureText||'(standalone run, not attached to a feature)'}\n\nACTIVE ROLES\n${roleText||'(none)'}\n\nREQUIREMENT UPDATE\n${requirementUpdateText||'(none)'}\n\nAUTHORIZED SYMBOLS\n${(manifest.symbols||[]).join('\n')||'(discover only as needed)'}\n\nSOURCE ARTIFACTS\n${(manifest.artifact_summaries||[]).map(a=>`${a.ref} ${a.kind||''}\n${a.summary||''}`).join('\n\n')||'(none)'}\n\nCONSTRAINTS\n${(manifest.constraints||[]).join('\n')||'(none)'}\n\nREQUIRED EVIDENCE\n${(manifest.evidence_required||[]).join('\n')||'(none)'}\n\nALLOWED TOOLS\n${(manifest.allowed_tools||[]).join(', ')}\n\nReturn a compact StageResult JSON.`;

  return {
    static_prefix:staticPrefix,
    stage_prefix:stagePrefix,
    dynamic_suffix:dynamicSuffix,
    full_prompt:fullPrompt,
    cache_blocks:[
      {type:'static_prefix',content:staticPrefix,cache_control:{type:'ephemeral'}},
      {type:'stage_prefix',content:stagePrefix,cache_control:{type:'ephemeral'}},
      {type:'dynamic_suffix',content:dynamicSuffix}
    ]
  };
}

export function renderPrompt(root,manifest){
  return renderCacheablePrompt(root,manifest).full_prompt;
}
