// Spawned worker agent for task implementation.
//
// The worker executes in its own process and context, scoped to the task's
// isolated workspace and declared write scope. It implements the required
// changes and runs targeted verification before handing off to review.
import path from 'node:path';
import {readJson,readTextFile,truncateUtf8} from './util.mjs';
import {putArtifact,emitTaskEvent} from './store.mjs';
import {getTaskWorkspace} from './workspace.mjs';
import {routeModel} from './model-router.mjs';
import {runHost} from './provider.mjs';

const arr=x=>Array.isArray(x)?x:[];
const list=(xs,empty='(none)')=>arr(xs).length?arr(xs).map(x=>`- ${x}`).join('\n'):empty;

// Procedure files carry an orchestrator-only preamble -- a `# Workflow
// Module: <id>` title, its blockquote banner, and often a `## Workflow
// preflight` section -- that assumes an orchestrator channel and `BLOCKED`
// semantics this standalone worker subprocess has neither. Strip it
// structurally, by heading shape, never by matching one file's own wording,
// so any procedure this helper is later pointed at gets the same treatment.
function stripModulePreamble(text){
  const lines=text.split(/\r?\n/);
  const isBlank=l=>(l||'').trim()==='';
  let i=0;
  // Only ever strip when the preamble is positively identified (a
  // `# Workflow Module: <id>` title and/or its blockquote banner) -- a file
  // without that signature is returned untouched, real title included.
  let sawModuleBanner=false;
  if(/^#\s+Workflow Module:/.test(lines[i]||'')){i++;sawModuleBanner=true;}
  while(isBlank(lines[i]))i++;
  if(/^>/.test(lines[i]||'')){
    while(/^>/.test(lines[i]||''))i++;
    sawModuleBanner=true;
  }
  if(!sawModuleBanner)return text;
  while(isBlank(lines[i]))i++;
  if(/^#\s+/.test(lines[i]||'')&&!/^##/.test(lines[i]||''))i++;
  while(isBlank(lines[i]))i++;
  if(/^##\s+Workflow preflight/i.test(lines[i]||'')){
    i++;
    while(i<lines.length&&!/^#{1,2}\s+/.test(lines[i]))i++;
  }
  return lines.slice(i).join('\n');
}

// The worker runs in its own process and may have no Skill tool, so its rules
// are inlined -- but read from the one canonical file, not restated here. A
// fourth copy of the TDD rules is how they drift.
//
// A malformed registry must degrade the prompt, not crash every dispatch --
// but a missing entry or a dangling instructions path is exactly the drift
// this exists to prevent, so that failure is loud (stderr), not silent.
function readProcedureText(root,id){
  const registryPath=path.join(root,'config','procedures.json');
  let registry;
  try{registry=readJson(registryPath);}
  catch(e){
    console.error(`[task-worker] procedure registry unreadable at ${registryPath}: ${e.message}`);
    return '';
  }
  const spec=registry?.procedures?.[id];
  if(!spec?.instructions){
    console.error(`[task-worker] no procedure "${id}" registered in ${registryPath}`);
    return '';
  }
  const instructionsPath=path.join(root,spec.instructions);
  try{return stripModulePreamble(readTextFile(instructionsPath)).trim();}
  catch(e){
    console.error(`[task-worker] procedure "${id}" instructions file missing at ${instructionsPath}: ${e.message}`);
    return '';
  }
}

/**
 * Construct the prompt for an autonomous worker agent.
 */
export function buildWorkerPrompt(root,projectRoot,run,task,{prevFailure=null}={}){
  const sections=[
    `TASK ${task.task_id}: ${task.title||task.goal||'(untitled)'}`,
    `GOAL\n${task.goal||'(not stated)'}`,
    `ACCEPTANCE CRITERIA\n${list(task.acceptance_criteria)}`,
    `DONE CONDITIONS\n${list(task.done_conditions)}`,
    `DESIGN DECISIONS\n${list(task.design_decisions)}`,
    `DECLARED WRITE SCOPE (EXHAUSTIVE - you must only edit files in this scope)\n${list(task.write_scope||task.scope?.write,'(read-only task)')}`,
    `INTERFACE SCOPE\n${list(task.interface_scope||task.scope?.interfaces)}`,
    `COMPATIBILITY OBLIGATIONS\n${list(task.compatibility_obligations)}`,
    `VERIFICATION / TARGETED TESTS\n${list(task.verification?.targeted_tests||task.verification_commands)}`
  ];

  const tdd=readProcedureText(root,'tdd');
  if(tdd)sections.push(`TDD PROCEDURE (canonical: harness/internal-skills/tdd.md)\n${tdd}`);

  if(prevFailure){
    const feedbackLines=[
      `Attempt count: ${prevFailure.attempt||1}`,
      `Failure class: ${prevFailure.failure?.class||prevFailure.failure?.reason||'VERIFICATION_OR_REVIEW_FAILED'}`
    ];
    if(prevFailure.verification?.output){
      feedbackLines.push(`Verification output:\n${truncateUtf8(prevFailure.verification.output,2000).text}`);
    }
    if(arr(prevFailure.findings).length){
      feedbackLines.push('Review findings to address:');
      for(const f of prevFailure.findings){
        feedbackLines.push(`- [${f.severity||'BLOCKING'}] ${f.category||'FINDING'}: ${f.finding||f.description||f.message||''} (${f.evidence||''})`);
      }
    }
    sections.push(`PREVIOUS ATTEMPT FAILURE & REVIEW FEEDBACK\n${feedbackLines.join('\n')}`);
  }

  const instructions=[
    'You are an autonomous worker agent implementing this task inside an SDLC harness.',
    'CORE INVARIANTS & IRON LAWS:',
    '1. STRICT WRITE SCOPE: Edit ONLY files matching the DECLARED WRITE SCOPE. Edits outside the declared write scope are blocked by the security gate.',
    '2. STRICT TDD: follow the procedure below exactly.',
    '3. NO PLACEHOLDERS: Implement complete, functional code. Never leave TODO comments, mock shortcuts, or incomplete stubs.',
    '4. EVIDENCE OVER CLAIMS: Before declaring completion, run the targeted verification test command yourself and confirm 0 failures with exit code 0.',
    '5. BACKWARD COMPATIBILITY: Ensure existing tests pass and backward compatibility obligations are preserved.',
    '6. When finished, ensure all changes are saved. The harness will automatically capture the git diff, run verification tests, and dispatch independent reviewer agents.'
  ].join('\n');

  return [
    instructions,
    sections.join('\n\n')
  ].join('\n\n');
}

/**
 * Execute a task using an autonomous worker agent.
 */
export function executeTaskWithAgent(root,projectRoot,run,task,{provider='auto',budget={},runner=runHost,prevFailure=null}={}){
  const unavailable=reason=>({status:'UNAVAILABLE',task_id:task.task_id,reason});

  const routing=(()=>{
    if(runner!==runHost){
      return {mode:'MODEL',provider:provider!=='auto'?provider:'claude',tier:'standard',model_alias:'mock',reason:'custom-runner'};
    }
    try{
      return routeModel(root,projectRoot,run,{
        task:task.category||'implementation',
        provider,
        requireStructured:false
      });
    }catch(e){
      return {mode:'PENDING',reason:e.message};
    }
  })();

  if(routing.mode!=='MODEL'||!routing.provider){
    return unavailable(`no worker provider available (${routing.reason||routing.mode})`);
  }

  const ws=getTaskWorkspace(projectRoot,run.run_id,task.task_id);
  const cwd=ws?.root||projectRoot;

  const prompt=buildWorkerPrompt(root,projectRoot,run,task,{prevFailure});
  const maxWallMs=budget.maxWallMs??600000;
  const maxTurns=budget.maxTurns??25;

  const res=runner(routing.provider,prompt,null,{
    stage:'IMPLEMENT',
    maxTurns,
    maxWallMs,
    cwd
  });

  if(res.status!=='PASS'){
    return unavailable(`worker host ${routing.provider} did not complete (${res.reason||res.error||`status ${res.status}`}${res.timed_out?', timed out':''})`);
  }

  const transcriptContent=[
    `=== WORKER EXECUTION TRANSCRIPT FOR ${task.task_id} (Attempt ${task.attempt||0}) ===`,
    `Provider: ${routing.provider}`,
    `Model: ${routing.model_alias||'default'}`,
    `Exit Code: ${res.exit_code}`,
    `=== STDOUT ===\n${res.stdout||'(none)'}`,
    `=== STDERR ===\n${res.stderr||'(none)'}`
  ].join('\n\n');

  const ref=putArtifact(projectRoot,{
    kind:'worker-execution-transcript',
    content:transcriptContent,
    runId:run.run_id,
    stage:run.state||'IMPLEMENT',
    sourceRevision:task.base_revision,
    filename:`${task.task_id}-worker-attempt${task.attempt||0}.log`
  }).artifact_id;

  emitTaskEvent(projectRoot,task,{
    type:'task.worker_spawned',
    artifact_refs:[ref],
    payload:{
      provider:routing.provider,
      model:routing.model_alias??null,
      attempt:task.attempt||0,
      exit_code:res.exit_code
    }
  });

  return {
    status:'EXECUTED',
    task_id:task.task_id,
    provider:routing.provider,
    transcript_ref:ref,
    exit_code:res.exit_code
  };
}
