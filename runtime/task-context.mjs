// Per-task context compiler.
//
//   One bounded task -> one bounded context package -> one primary writer.
//
// This does not duplicate the canonical context policy; it reads the same
// policies/context-policy.json and the same stage budget as runtime/context.mjs,
// and narrows the payload from "the stage" to "this task".
//
// Deliberately excluded by default, and named in the manifest so the omissions
// are as auditable as the inclusions: whole chat history, all requirements, all
// design docs, all tasks, the full repository tree, unrelated logs, every tool
// schema, and any previous worker's reasoning.
import path from 'node:path';
import {estimateTokens,gitSha,readJson,readTextFile,sha256,truncateUtf8,now} from './util.mjs';
import {getArtifact,listTasks,putTaskContextManifest} from './store.mjs';
import {openIntelligence,findTestsForFiles,findPublicInterfaces,findDataEntities,findDependents} from './repo-intelligence.mjs';

const arr=x=>Array.isArray(x)?x:[];

export const EXCLUDED_BY_DEFAULT=[
  'full_chat_history',
  'all_requirements',
  'all_design_documents',
  'all_tasks',
  'full_repository_tree',
  'unrelated_logs',
  'all_tool_schemas',
  'previous_worker_reasoning'
];

function taskSkillInstructions(root,task){
  const registry=readJson(path.join(root,'config','skills.json')).internal||{};
  const byCategory={
    implementation:'implementation',migration:'database',verification:'testing',
    security:'security',integration:'testing',documentation:'documentation',
    release:'ci-cd',operability:'monitoring'
  };
  const id=byCategory[task.category]||'implementation';
  const spec=registry[id];
  if(!spec)return null;
  let instructions='';
  // Hashed into the task context_hash; line endings must not change it.
  try{instructions=readTextFile(path.join(root,spec.instructions)).trim();}catch{}
  return {id,description:spec.description,instructions,max_response_words:spec.max_response_words};
}

/** Only the outputs of the tasks this task actually depends on. */
function dependencyOutputs(projectRoot,task,tasks){
  const byId=new Map(tasks.map(t=>[t.task_id,t]));
  return arr(task.depends_on).map(id=>{
    const dep=byId.get(id);
    if(!dep)return {task_id:id,summary:'MISSING_DEPENDENCY_RECORD',artifact_refs:[],diff_hash:null};
    return {
      task_id:id,
      // The done conditions, not the dependency's narrative.
      summary:arr(dep.done_conditions).join('; ')||dep.goal||null,
      artifact_refs:arr(dep.artifact_refs).slice(-3),
      diff_hash:dep.diff_hash??null
    };
  });
}

function verificationCommands(projectRoot,task){
  const cfg=readJson(path.join(projectRoot,'.agent-sdlc','project.json'),{});
  const targeted=arr(task.verification?.targeted_tests);
  const configured=arr(cfg.commands?.test_targeted).join(' ');
  const out=[...targeted];
  if(configured&&!out.length)out.push(configured);
  if(task.category==='migration'&&arr(cfg.commands?.build).length)out.push(arr(cfg.commands.build).join(' '));
  return out;
}

/**
 * Repository intelligence for the task's *declared scope*, not for the whole
 * repository and not from free-text mining of the objective. Dependency,
 * interface, entity and test facts come from the index before any broad
 * `repo.search`, and everything returned is anchored to a declared path.
 *
 * A failure here degrades the context, it never breaks the task: the manifest
 * records `unavailable` with the reason.
 */
export function scopeIntelligence(projectRoot,task,{maxItems=12}={}){
  const scopePaths=[...new Set([...arr(task.scope?.write),...arr(task.scope?.read)])];
  if(!scopePaths.length)return {available:false,reason:'NO_DECLARED_SCOPE'};
  try{
    const intel=openIntelligence(projectRoot);
    const files=[...intel.graph.files.keys()];
    // Expand declared prefixes to the indexed files they actually cover.
    const inScope=files.filter(p=>scopePaths.some(s=>{
      const stem=String(s).replace(/\\/g,'/').split(/[*?]/)[0].replace(/\/+$/,'');
      return p===stem||(stem&&p.startsWith(stem+'/'));
    }));
    if(!inScope.length){
      return {available:true,capability_tier:intel.capability?.tier??null,revision:intel.revision,
        reason:'DECLARED_SCOPE_NOT_YET_INDEXED',files:[],symbols:[],tests:[],
        public_interfaces:[],data_entities:[],dependents:[]};
    }
    const symbols=[...new Set(inScope.flatMap(p=>arr(intel.graph.files.get(p)?.symbols)))].sort().slice(0,maxItems*2);
    const tests=findTestsForFiles(intel,inScope).tests.map(t=>t.path).slice(0,maxItems);
    const interfaces=findPublicInterfaces(intel,inScope);
    const entities=findDataEntities(intel,inScope).entities.map(e=>e.entity).slice(0,maxItems);
    const dependents=[...new Set(arr(task.scope?.write).flatMap(p=>
      findDependents(intel,p,{maxDepth:2}).dependents.map(d=>d.path)))]
      .filter(p=>!inScope.includes(p)).slice(0,maxItems);
    return {
      available:true,
      capability_tier:intel.capability?.tier??null,
      revision:intel.revision,
      stale:intel.stale?.stale===true,
      files:inScope.slice(0,maxItems*2),
      symbols,
      tests,
      public_interfaces:interfaces.routes.slice(0,maxItems),
      exported_symbols:[...new Set(interfaces.files.flatMap(f=>arr(f.exports)))].sort().slice(0,maxItems*2),
      data_entities:entities,
      // Who breaks if this write scope changes — the reason to read further.
      dependents
    };
  }catch(e){
    return {available:false,reason:`INTELLIGENCE_UNAVAILABLE:${e.message.slice(0,120)}`};
  }
}

/**
 * Compile one bounded task context package and persist its manifest with a
 * content hash, so a replay can prove exactly what the task was shown.
 */
export function buildTaskContext(root,projectRoot,run,task,{extraArtifactRefs=[],extraConstraints=[],persist=true,intelligence=true}={}){
  const contextPolicy=readJson(path.join(root,'policies','context-policy.json'));
  const stagePolicy=readJson(path.join(root,'policies','stage-policy.json')).stages[run.state]
    ||readJson(path.join(root,'policies','stage-policy.json')).stages.IMPLEMENT;
  const cfg=readJson(path.join(projectRoot,'.agent-sdlc','project.json'),{});
  const charsPerToken=contextPolicy.limits?.context_estimate_chars_per_token||4;
  const stageMax=stagePolicy.budget?.max_context_tokens_estimate||40000;
  // A task is a slice of a stage, so it gets a slice of the stage budget.
  const taskMax=Math.max(8000,Math.floor(stageMax*0.6));

  const tasks=listTasks(projectRoot,run.run_id);
  const refs=[...new Set([...arr(task.artifact_refs),...extraArtifactRefs])].slice(-8);
  let remainingBytes=Math.max(4000,Math.floor(taskMax*charsPerToken*0.5));
  const artifact_summaries=[];
  for(const ref of refs){
    const cap=Math.min(3000,remainingBytes);
    if(cap<=0)break;
    try{
      const a=getArtifact(projectRoot,ref);
      const t=truncateUtf8(a.content,cap);
      artifact_summaries.push({ref,kind:a.meta.kind,summary:t.text,sha256:a.meta.sha256,truncated:t.truncated});
      remainingBytes-=Buffer.byteLength(t.text);
    }catch{artifact_summaries.push({ref,missing:true});}
  }

  const riskConstraints=[];
  if(task.risk?.security==='HIGH')riskConstraints.push('security-critical: no new trust boundary or credential path without approval');
  if(task.risk?.data!=='LOW')riskConstraints.push('data-affecting: preserve rollback/backout obligations');
  if(task.risk?.destructive_data_change)riskConstraints.push('destructive data change: expand/backfill/verify/contract, never drop before verify');
  if(arr(task.scope?.interfaces).length)riskConstraints.push('public interface in scope: honour the declared compatibility obligations');

  const skill=taskSkillInstructions(root,task);
  const manifest={
    schema:'agent-sdlc/task-context-manifest/v1',
    run_id:run.run_id,
    task_id:task.task_id,
    plan_id:task.plan_id??null,
    attempt:task.attempt||0,
    objective:task.goal,
    outer_stage:run.state,
    acceptance_criteria:arr(task.acceptance_criteria),
    design_decisions:arr(task.design_decisions),
    dependency_outputs:dependencyOutputs(projectRoot,task,tasks),
    scope:{
      read:arr(task.scope?.read),
      write:arr(task.scope?.write),
      interfaces:arr(task.scope?.interfaces),
      forbidden:arr(task.scope?.forbidden)
    },
    symbols:arr(task.scope?.symbols),
    files:[...new Set([...arr(task.scope?.read),...arr(task.scope?.write)])],
    // Deterministic repository facts for the declared scope, consulted before
    // any broad search. Anchored to declared paths, never mined from prose.
    intelligence:intelligence?scopeIntelligence(projectRoot,task):{available:false,reason:'DISABLED_BY_CALLER'},
    project_invariants:arr(cfg.context?.project_invariants),
    risk_constraints:[...riskConstraints,...extraConstraints],
    verification_commands:verificationCommands(projectRoot,task),
    handoff_contract:{
      required_evidence:['agent-sdlc/task-verification/v1',...arr(task.verification?.required_evidence)],
      done_conditions:arr(task.done_conditions),
      expected_behavior:arr(task.verification?.expected_behavior),
      compatibility_obligations:arr(task.compatibility_obligations),
      rollback_obligations:arr(task.rollback_obligations),
      return_shape:'structured task result; the engine owns every state transition',
      may_not:['transition the outer run','mark the task DONE','write outside the declared write scope']
    },
    skill:skill?{id:skill.id,description:skill.description,max_response_words:skill.max_response_words}:null,
    skill_instructions:skill?.instructions||null,
    artifact_summaries,
    excluded:EXCLUDED_BY_DEFAULT,
    budget:{max_context_tokens_estimate:taskMax,derived_from_stage:run.state,stage_max:stageMax},
    git_sha:gitSha(projectRoot),
    created_at:now()
  };
  // The hash covers what the task was shown, not when it was shown: identical
  // inputs must produce an identical hash or replay comparison is meaningless.
  const {created_at,...hashable}=manifest;
  const serialized=JSON.stringify(hashable);
  manifest.estimated_tokens=estimateTokens(JSON.stringify(manifest),charsPerToken);
  manifest.context_budget_status=manifest.estimated_tokens<=taskMax?'WITHIN_BUDGET':'OVER_BUDGET';
  manifest.context_hash=sha256(serialized);
  if(persist)putTaskContextManifest(projectRoot,manifest);
  return manifest;
}

/** Render the bounded task prompt. Nothing outside the manifest reaches it. */
export function renderTaskPrompt(root,manifest){
  const system=readTextFile(path.join(root,'prompts','system.md')).trim();
  const list=(xs,empty='(none)')=>arr(xs).length?arr(xs).join('\n'):empty;
  return [
    system,
    `TASK\n${manifest.task_id} — ${manifest.objective}`,
    `MODULE GUIDANCE\n${manifest.skill_instructions||'(none)'}`,
    `ACCEPTANCE CRITERIA\n${list(manifest.acceptance_criteria)}`,
    `DESIGN DECISIONS\n${list(manifest.design_decisions)}`,
    `DEPENDENCY OUTPUTS\n${arr(manifest.dependency_outputs).map(d=>`${d.task_id}: ${d.summary||''}`).join('\n')||'(none)'}`,
    `WRITE SCOPE (exhaustive)\n${list(manifest.scope?.write,'(read-only task)')}`,
    `READ SCOPE\n${list(manifest.scope?.read,'(discover only as needed)')}`,
    `INTERFACE SCOPE\n${list(manifest.scope?.interfaces)}`,
    `FORBIDDEN\n${list(manifest.scope?.forbidden)}`,
    `SYMBOLS\n${list(manifest.symbols,'(discover only as needed)')}`,
    `REPOSITORY FACTS (deterministic, in scope)\n${manifest.intelligence?.available
      ?[`tier: ${manifest.intelligence.capability_tier}`,
        `symbols: ${arr(manifest.intelligence.symbols).join(', ')||'(none)'}`,
        `tests: ${arr(manifest.intelligence.tests).join(', ')||'(none)'}`,
        `interfaces: ${arr(manifest.intelligence.public_interfaces).join(', ')||'(none)'}`,
        `data entities: ${arr(manifest.intelligence.data_entities).join(', ')||'(none)'}`,
        `dependents of your write scope: ${arr(manifest.intelligence.dependents).join(', ')||'(none)'}`].join('\n')
      :`unavailable: ${manifest.intelligence?.reason||'unknown'}`}`,
    `PROJECT INVARIANTS\n${list(manifest.project_invariants)}`,
    `RISK CONSTRAINTS\n${list(manifest.risk_constraints)}`,
    `VERIFICATION\n${list(manifest.verification_commands)}`,
    `DONE CONDITIONS\n${list(manifest.handoff_contract?.done_conditions)}`,
    `YOU MAY NOT\n${list(manifest.handoff_contract?.may_not)}`,
    `SOURCE ARTIFACTS\n${arr(manifest.artifact_summaries).map(a=>`${a.ref} ${a.kind||''}\n${a.summary||''}`).join('\n\n')||'(none)'}`,
    'Return a compact structured task result. Do not transition workflow state and do not declare the task complete.'
  ].join('\n\n');
}
