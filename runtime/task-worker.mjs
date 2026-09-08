// Spawned worker agent for task implementation.
//
// The worker executes in its own process and context, scoped to the task's
// isolated workspace and declared write scope. It implements the required
// changes and runs targeted verification before handing off to review.
import path from 'node:path';
import {truncateUtf8} from './util.mjs';
import {putArtifact,emitTaskEvent} from './store.mjs';
import {getTaskWorkspace} from './workspace.mjs';
import {routeModel} from './model-router.mjs';
import {runHost} from './provider.mjs';

const arr=x=>Array.isArray(x)?x:[];
const list=(xs,empty='(none)')=>arr(xs).length?arr(xs).map(x=>`- ${x}`).join('\n'):empty;

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
    '2. STRICT TDD (RED-GREEN-REFACTOR CYCLE):',
    '   - NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST.',
    '   - STEP 1 (RED): Write or locate a minimal, focused test demonstrating the required behavior or bug.',
    '   - STEP 2 (VERIFY RED): Run the targeted test command and watch it FAIL with the expected assertion failure. If it passes or fails on syntax/import error, fix the test first.',
    '   - STEP 3 (GREEN): Write the MINIMAL production code to make the test pass. No premature abstractions, no extra unrequested features.',
    '   - STEP 4 (VERIFY GREEN): Run the test command again and confirm it passes with 0 failures.',
    '   - STEP 5 (REFACTOR): Clean up while ensuring tests remain green.',
    '   - IRON LAW ENFORCEMENT: If you wrote production code before watching a test fail, DELETE the unverified code and start over from tests.',
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
