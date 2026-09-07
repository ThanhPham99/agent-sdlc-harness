// Spawned reviewer agents for the two task review contracts.
//
// The task engine has always required a spec-compliance review and a code
// quality review before a task can be DONE, but nothing in the harness could
// produce one: an interactive orchestrator supplied them, and the autonomous
// runner made them up. This module is the missing third option -- a reviewer
// running as its own process, with its own context, that never sees the
// worker's reasoning.
//
// Three things make the result a review rather than a formality:
//
//   The prompt carries the task's specification and the diff, and nothing the
//   worker said about its own work. Independence is a property of what the
//   reviewer was shown, so it is established here or not at all.
//
//   The bindings -- schema, ids, attempt, diff_hash -- are written by the
//   harness afterwards, never read back from the model. A reviewer that echoes
//   the right diff_hash has proved nothing, and one that echoes it wrongly
//   would be rejected for a clerical reason instead of being read.
//
//   A reviewer that could not be reached returns UNAVAILABLE. It does not
//   return a clean review.
import fs from 'node:fs';
import path from 'node:path';
import {truncateUtf8} from './util.mjs';
import {putArtifact,emitTaskEvent} from './store.mjs';
import {getTaskWorkspace} from './workspace.mjs';
import {routeModel} from './model-router.mjs';
import {runHost} from './provider.mjs';
import {git} from './util.mjs';

const arr=x=>Array.isArray(x)?x:[];

/** How much diff a reviewer is shown. Beyond this it is reading noise. */
export const MAX_DIFF_BYTES=60000;

export const REVIEW_KINDS={
  spec:{
    schema:'agent-sdlc/spec-compliance-review/v1',
    schema_file:'protocol/schemas/SpecComplianceReview.schema.json',
    verdicts:'COMPLIANT | NON_COMPLIANT',
    categories:'MISSING_REQUIRED_BEHAVIOR, EXTRA_UNINTENDED_BEHAVIOR, ACCEPTANCE_CRITERION_MISMATCH, DESIGN_VIOLATION, SCOPE_CREEP, UNAPPROVED_CONTRACT_CHANGE'
  },
  quality:{
    schema:'agent-sdlc/code-quality-review/v1',
    schema_file:'protocol/schemas/CodeQualityReview.schema.json',
    verdicts:'ACCEPTED | CHANGES_REQUIRED',
    categories:'CORRECTNESS, CONCURRENCY_OR_IDEMPOTENCY, ERROR_HANDLING, SECURITY_OR_PRIVACY, MAINTAINABILITY, TEST_QUALITY, PERFORMANCE'
  }
};

/** The task's diff, bounded, read from its workspace. */
export function reviewDiff(projectRoot,run,task){
  const ws=getTaskWorkspace(projectRoot,run.run_id,task.task_id);
  const cwd=ws?.root||projectRoot;
  const base=ws?.base_revision??task.base_revision;
  const r=base?git(['diff','--no-ext-diff',base],cwd):git(['diff','--no-ext-diff'],cwd);
  if(r.code!==0)return {text:'',available:false,reason:'git diff failed in the task workspace'};
  const t=truncateUtf8(r.stdout,MAX_DIFF_BYTES);
  return {text:t.text,available:true,truncated:t.truncated};
}

const list=(xs,empty='(none)')=>arr(xs).length?arr(xs).map(x=>`- ${x}`).join('\n'):empty;

/**
 * The reviewer's prompt.
 *
 * What is deliberately absent is as load-bearing as what is present: no worker
 * narrative, no previous attempt's reasoning, no prior review. Adding any of
 * them would make `independence.achieved` a false claim.
 */
export function buildReviewPrompt(root,projectRoot,run,task,{kind,diff}){
  const spec=REVIEW_KINDS[kind];
  if(!spec)throw new Error(`unknown review kind ${kind}`);
  const shared=[
    `TASK ${task.task_id}: ${task.title||task.goal||'(untitled)'}`,
    `GOAL\n${task.goal||'(not stated)'}`,
    `ACCEPTANCE CRITERIA\n${list(task.acceptance_criteria)}`,
    `DONE CONDITIONS\n${list(task.done_conditions)}`,
    `DESIGN DECISIONS\n${list(task.design_decisions)}`,
    `DECLARED WRITE SCOPE\n${list(task.write_scope)}`,
    `INTERFACE SCOPE\n${list(task.interface_scope)}`,
    `COMPATIBILITY OBLIGATIONS\n${list(task.compatibility_obligations)}`,
    `DIFF UNDER REVIEW${diff.truncated?` (truncated at ${MAX_DIFF_BYTES} bytes)`:''}\n${diff.text||'(empty diff)'}`
  ].join('\n\n');

  const question=kind==='spec'
    ? [
      'You are reviewing SPEC COMPLIANCE only. The single question: does this diff implement exactly the task goal, acceptance criteria, design decisions and scope -- no less, and nothing extra?',
      'Say nothing about style, naming or maintainability; a separate review owns those and yours must not pre-empt it.',
      'List every acceptance criterion you checked in `acceptance_criteria_checked`, using the criterion text.',
      `Verdict is ${spec.verdicts}. Use NON_COMPLIANT when any required behavior is missing, any criterion is unmet, or the diff writes outside the declared scope.`
    ].join('\n')
    : [
      'You are reviewing CODE QUALITY. The specification is already accepted -- do not re-argue what the task was for.',
      'The question: given that specification, is this implementation safe and maintainable? Look at correctness, error paths, concurrency and idempotency, security and privacy, resource handling, test quality and performance.',
      'Mechanical coding-standards rules (var, any, parameter counts, filename casing, boolean prefixes) are already enforced deterministically and merged into your review afterwards. Do not spend the review on them.',
      `Verdict is ${spec.verdicts}. A BLOCKING correctness finding must carry a concrete \`failure_scenario\` -- inputs or state that produce the wrong outcome. Without one it is a guess, and the harness rejects it.`
    ].join('\n');

  return [
    'You are an independent reviewer in an SDLC harness. You did not write this code and you have not been told how it was written. Judge only what the diff shows.',
    question,
    shared,
    `Every finding needs concrete \`evidence\`: a file:line, a symbol, or a test name. Allowed categories: ${spec.categories}. Allowed severities: BLOCKING, MAJOR, MINOR, INFO.`,
    `Return ONE JSON object matching ${spec.schema} and nothing else -- no prose, no code fence. Set only \`verdict\` and \`findings\`${kind==='spec'?', plus `acceptance_criteria_checked`':''}; the harness fills in every identifier itself.`,
    'An empty `findings` list is a real answer when the diff is sound. Do not invent findings to look thorough, and do not withhold a blocking one to look agreeable.'
  ].join('\n\n');
}

/**
 * Pull the review object out of whatever the host CLI printed.
 *
 * Each host wraps model output differently -- Claude in a result envelope,
 * Codex in a JSONL stream -- and both may still hand back a fenced block. The
 * search is deliberately broad and the acceptance test narrow: an object is the
 * review only if it carries a verdict and a findings array.
 */
export function extractReviewJson(stdout){
  const isReview=o=>o&&typeof o==='object'&&!Array.isArray(o)&&typeof o.verdict==='string'&&Array.isArray(o.findings);
  const candidates=[];
  const consider=text=>{
    if(typeof text!=='string')return;
    const trimmed=text.replace(/^```(?:json)?\s*/i,'').replace(/```\s*$/,'').trim();
    for(const source of [trimmed,text]){
      const start=source.indexOf('{');const end=source.lastIndexOf('}');
      if(start<0||end<=start)continue;
      try{candidates.push(JSON.parse(source.slice(start,end+1)));}catch{/* try the next shape */}
    }
  };
  consider(stdout);
  for(const line of String(stdout||'').split('\n')){
    const t=line.trim();
    if(!t.startsWith('{'))continue;
    let doc;try{doc=JSON.parse(t);}catch{continue;}
    candidates.push(doc);
    // Host envelopes carry the model's text in one of these.
    for(const key of ['result','text','content','message','output'])consider(typeof doc?.[key]==='string'?doc[key]:null);
    if(typeof doc?.message?.content==='string')consider(doc.message.content);
  }
  // Last match wins: a streaming host prints the final answer last.
  return candidates.filter(isReview).at(-1)??null;
}

/**
 * Everything the harness knows for certain, written over whatever the model
 * returned. The reviewer supplies judgement; it does not supply bookkeeping.
 */
function bindReview(kind,run,task,model,{provider,modelAlias}){
  const spec=REVIEW_KINDS[kind];
  const bound={
    schema:spec.schema,
    task_id:task.task_id,
    run_id:run.run_id,
    attempt:task.attempt||0,
    base_revision:task.base_revision??null,
    diff_hash:task.diff_hash??null,
    verdict:model.verdict,
    findings:arr(model.findings),
    independence:{
      requested:task?.execution?.independent_review===true,
      achieved:true,
      // A separate process with a context this module built. The prompt is
      // constructed here, so "the worker's reasoning was withheld" is a fact
      // about this code rather than a claim about the reviewer's discipline.
      mode:'FRESH_CONTEXT_SUBAGENT',
      worker_reasoning_withheld:true,
      limitation:null
    },
    reviewer:{provider,model:modelAlias??null,spawned_by:'agent-sdlc/task-reviewer'}
  };
  if(kind==='spec')bound.acceptance_criteria_checked=arr(model.acceptance_criteria_checked);
  return bound;
}

/**
 * Run one reviewer and return its review, or why there is not one.
 *
 * `status` is `REVIEWED` or `UNAVAILABLE`. There is deliberately no third
 * outcome that yields a usable review: every way this can go wrong -- no
 * provider, host failure, timeout, unparseable output, a verdict outside the
 * contract -- produces UNAVAILABLE, so a caller cannot mistake a failed
 * reviewer for a clean one.
 */
export function reviewTaskWithAgent(root,projectRoot,run,task,{kind,provider='auto',budget={},runner=runHost}={}){
  const spec=REVIEW_KINDS[kind];
  if(!spec)throw new Error(`unknown review kind ${kind}`);
  const unavailable=reason=>({status:'UNAVAILABLE',kind,reason,review:null});

  const routing=(()=>{
    try{return routeModel(root,projectRoot,run,{task:'review',provider,requireStructured:true});}
    catch(e){return {mode:'PENDING',reason:e.message};}
  })();
  if(routing.mode!=='MODEL'||!routing.provider){
    return unavailable(`no reviewer provider available (${routing.reason||routing.mode})`);
  }

  const diff=reviewDiff(projectRoot,run,task);
  if(!diff.available)return unavailable(diff.reason);

  const prompt=buildReviewPrompt(root,projectRoot,run,task,{kind,diff});
  const schemaPath=path.join(root,spec.schema_file);
  const res=runner(routing.provider,prompt,fs.existsSync(schemaPath)?schemaPath:null,{
    stage:'REVIEW',maxTurns:budget.maxTurns??6,maxWallMs:budget.maxWallMs??600000
  });
  if(res.status!=='PASS'){
    return unavailable(`reviewer host ${routing.provider} did not complete (${res.reason||res.error||`status ${res.status}`}${res.timed_out?', timed out':''})`);
  }

  const model=extractReviewJson(res.stdout);
  if(!model)return unavailable(`reviewer host ${routing.provider} returned no review document matching ${spec.schema}`);

  const allowed=spec.verdicts.split('|').map(v=>v.trim());
  if(!allowed.includes(model.verdict)){
    return unavailable(`reviewer returned verdict ${JSON.stringify(model.verdict)}, expected one of ${allowed.join(', ')}`);
  }

  const review=bindReview(kind,run,task,model,{provider:routing.provider,modelAlias:routing.model_alias});
  // The raw transcript is kept because a review that decided a gate should be
  // auditable back to what the reviewer actually said.
  const ref=putArtifact(projectRoot,{
    kind:`${kind}-review-transcript`,
    content:res.stdout,
    runId:run.run_id,stage:run.state,sourceRevision:task.base_revision,
    filename:`${task.task_id}-${kind}-reviewer-attempt${task.attempt||0}.log`
  }).artifact_id;
  review.artifact_refs=[ref];
  emitTaskEvent(projectRoot,task,{
    type:'task.reviewer_spawned',
    artifact_refs:[ref],
    payload:{kind,provider:routing.provider,model:routing.model_alias??null,verdict:review.verdict,findings:review.findings.length}
  });
  return {status:'REVIEWED',kind,review,provider:routing.provider,transcript_ref:ref};
}

/**
 * Both reviews for one task, in the order the gate reads them.
 *
 * Returns the `{specReview, qualityReview}` shape `runAutoTaskLoop` expects, so
 * a spawned reviewer and a caller-supplied one are interchangeable. Either
 * missing means the pair is incomplete, and the runner falls back to its
 * marked placeholders rather than advancing on half a review.
 */
export function reviewTaskPair(root,projectRoot,run,task,options={}){
  const spec=reviewTaskWithAgent(root,projectRoot,run,task,{...options,kind:'spec'});
  // Quality runs regardless of the spec verdict: the engine only reaches the
  // quality gate when spec compliance was clean, and a NON_COMPLIANT spec
  // review short-circuits there without the quality document being read.
  const quality=reviewTaskWithAgent(root,projectRoot,run,task,{...options,kind:'quality'});
  return {
    specReview:spec.review,
    qualityReview:quality.review,
    attempts:[{kind:'spec',status:spec.status,reason:spec.reason??null},
      {kind:'quality',status:quality.status,reason:quality.reason??null}]
  };
}
