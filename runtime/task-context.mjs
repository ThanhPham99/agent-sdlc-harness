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
import fs from 'node:fs';
import path from 'node:path';
import {estimateTokens,gitSha,readJson,sha256,truncateUtf8,now} from './util.mjs';
import {getArtifact,listTasks,putTaskContextManifest} from './store.mjs';

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
  try{instructions=fs.readFileSync(path.join(root,spec.instructions),'utf8').trim();}catch{}
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
 * Compile one bounded task context package and persist its manifest with a
 * content hash, so a replay can prove exactly what the task was shown.
 */
export function buildTaskContext(root,projectRoot,run,task,{extraArtifactRefs=[],extraConstraints=[],persist=true}={}){
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
  const system=fs.readFileSync(path.join(root,'prompts','system.md'),'utf8').trim();
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
    `PROJECT INVARIANTS\n${list(manifest.project_invariants)}`,
    `RISK CONSTRAINTS\n${list(manifest.risk_constraints)}`,
    `VERIFICATION\n${list(manifest.verification_commands)}`,
    `DONE CONDITIONS\n${list(manifest.handoff_contract?.done_conditions)}`,
    `YOU MAY NOT\n${list(manifest.handoff_contract?.may_not)}`,
    `SOURCE ARTIFACTS\n${arr(manifest.artifact_summaries).map(a=>`${a.ref} ${a.kind||''}\n${a.summary||''}`).join('\n\n')||'(none)'}`,
    'Return a compact structured task result. Do not transition workflow state and do not declare the task complete.'
  ].join('\n\n');
}
