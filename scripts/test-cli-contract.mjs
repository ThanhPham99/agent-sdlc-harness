#!/usr/bin/env node
// CLI contract suite.
//
// runtime/cli.mjs is the largest module in the runtime and the surface the
// skills instruct the model to call, yet the coverage report showed the
// deterministic suite never executed a single line of it: only six of its ~41
// commands were exercised anywhere, by verify-dist against a packaged tree.
//
// This drives the real binary as an agent does -- spawned, one argv at a time,
// parsing stdout as JSON -- over the whole stage loop, and pins the contract an
// agent depends on: stdout is JSON, a failure exits non-zero with a structured
// error rather than a stack trace, and a refused gate stays refused.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync,spawnSync} from 'node:child_process';
import {createSuite} from './lib/suite.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const CLI=path.join(ROOT,'runtime','cli.mjs');
const {test,assert,finish}=createSuite('agent-sdlc/cli-contract-validation/v1','CLI-CONTRACT-VALIDATION.json');

function fixture(){
  const d=fs.mkdtempSync(path.join(os.tmpdir(),'agent-sdlc-cli-'));
  execFileSync('git',['init','-q'],{cwd:d});
  fs.writeFileSync(path.join(d,'README.md'),'fixture\n');
  fs.mkdirSync(path.join(d,'src'),{recursive:true});
  fs.writeFileSync(path.join(d,'src','service.js'),'export function charge(amount){return amount;}\n');
  execFileSync('git',['add','.'],{cwd:d});
  execFileSync('git',['-c','user.email=a@b.c','-c','user.name=t','commit','-qm','init'],{cwd:d});
  return d;
}
const PROJECT=fixture();

/** Run the CLI the way an agent does and return {status, stdout, stderr}.
 *  `env` overlays the child environment; the provider commands use it to pin a
 *  fake host binary so they stay hermetic on a machine with a real host CLI. */
function raw(args,cwd=PROJECT,env=null){
  const r=spawnSync(process.execPath,[CLI,...args,'--project',cwd],
    {cwd,encoding:'utf8',timeout:120000,maxBuffer:32*1024*1024,
     ...(env?{env:{...process.env,...env}}:{})});
  return {status:r.status,stdout:r.stdout||'',stderr:r.stderr||''};
}
/** Expect success and JSON on stdout. */
function json(args,cwd=PROJECT,env=null){
  const r=raw(args,cwd,env);
  if(r.status!==0)throw new Error(`${args.join(' ')} exited ${r.status}: ${(r.stderr||r.stdout).slice(0,300)}`);
  try{return JSON.parse(r.stdout);}catch{throw new Error(`${args.join(' ')} did not print JSON: ${r.stdout.slice(0,200)}`);}
}
/** Expect failure, and a structured error rather than a stack trace. */
function failure(args,cwd=PROJECT){
  const r=raw(args,cwd);
  if(r.status===0)throw new Error(`${args.join(' ')} unexpectedly succeeded`);
  const text=r.stderr||r.stdout;
  if(/\n {4}at [^\n]*\(/.test(text))throw new Error(`${args.join(' ')} leaked a stack trace: ${text.slice(0,200)}`);
  let doc=null;try{doc=JSON.parse(text);}catch{}
  if(!doc||doc.status!=='ERROR'||typeof doc.error!=='string'){
    throw new Error(`${args.join(' ')} did not print a structured error: ${text.slice(0,200)}`);
  }
  return doc;
}

// --- project bootstrap -----------------------------------------------------
test('init-creates-project-state',()=>{
  const out=json(['init']);
  if(out.status!=='INITIALIZED')throw new Error(JSON.stringify(out));
  if(!fs.existsSync(path.join(PROJECT,'.agent-sdlc','project.json')))throw new Error('project.json missing');
});
test('doctor-reports-version-and-project-state',()=>{
  const out=json(['doctor']);
  if(out.project!=='READY')throw new Error(JSON.stringify(out.project));
  if(!out.version||!out.node)throw new Error(JSON.stringify(out));
  if(!Array.isArray(out.providers)||!out.providers.length)throw new Error('no provider report');
});
test('route-is-deterministic-across-processes',()=>{
  const a=json(['route','--objective','database schema migration with backfill']);
  const b=json(['route','--objective','database schema migration with backfill']);
  if(JSON.stringify(a)!==JSON.stringify(b))throw new Error('route differs between processes');
  if(a.workflow!=='database-migration'||a.profile!=='STRICT')throw new Error(JSON.stringify(a));
});
test('config-show-and-compat-check-answer-without-a-run',()=>{
  if(!json(['config-show']).effective)throw new Error('no effective config');
  const c=json(['compat-check']);
  if(typeof c!=='object')throw new Error('compat-check returned no document');
});

// --- the stage loop --------------------------------------------------------
const run=json(['start','--objective','Fix incorrect refund rounding','--workflow','bug-fix']);
test('start-returns-a-run-in-the-first-stage',()=>{
  if(run.workflow!=='bug-fix'||run.state!=='INTAKE'||!run.run_id)throw new Error(JSON.stringify(run));
  if(run.stages[0]!=='INTAKE'||run.stages.at(-1)!=='CLOSE')throw new Error(JSON.stringify(run.stages));
});
const R=['--run-id',run.run_id];
test('status-round-trips-the-persisted-run',()=>{
  const s=json(['status',...R]);
  if(s.run_id!==run.run_id||s.state!=='INTAKE')throw new Error(JSON.stringify(s));
});
test('next-names-the-following-stage',()=>{
  const n=json(['next',...R]);
  if(n.next!=='REQUIREMENTS')throw new Error(JSON.stringify(n));
});
test('context-is-bounded-and-carries-the-stage-policy',()=>{
  const c=json(['context',...R]);
  if(c.context_budget_status!=='WITHIN_BUDGET')throw new Error(c.context_budget_status);
  if(!c.allowed_tools.length||!c.budget)throw new Error('no policy in the manifest');
  if(!c.context_hash||c.context_hash.length!==64)throw new Error('no context hash');
});
test('context-prompt-mode-returns-text-not-json',()=>{
  const r=raw(['context',...R,'--prompt']);
  if(r.status!==0)throw new Error(`exit ${r.status}`);
  if(r.stdout.trim().startsWith('{'))throw new Error('prompt mode printed JSON');
  if(!/ALLOWED TOOLS/.test(r.stdout))throw new Error('prompt is missing its tool section');
});
test('context-carries-active-roles-for-intake',()=>{
  const c=json(['context',...R]);
  const ids=(c.active_roles||[]).map(x=>x.id);
  if(!ids.includes('pm')||!ids.includes('support'))throw new Error(JSON.stringify(ids));
  const pm=c.active_roles.find(x=>x.id==='pm');
  if(!Array.isArray(pm.responsibilities)||!pm.responsibilities.length)throw new Error(JSON.stringify(pm));
});
test('context-carries-the-intake-procedure-and-nothing-out-of-stage',()=>{
  const c=json(['context',...R]);
  const ids=(c.procedures||[]).map(x=>x.id);
  if(!ids.includes('requirements-intake'))throw new Error(JSON.stringify(ids));
  if(ids.includes('docs-update')||ids.includes('workflow-maintenance'))throw new Error(`out-of-stage or manual-only procedure leaked: ${JSON.stringify(ids)}`);
  const instr=(c.procedure_instructions||[]).find(x=>x.id==='requirements-intake');
  if(!instr?.instructions)throw new Error('procedure selected but instructions text missing');
});
test('artifact-put-get-list-round-trip',()=>{
  const a=json(['artifact-put',...R,'--kind','requirement','--content','rounding must use bankers rounding']);
  if(!a.artifact_id.startsWith('artifact://sha256/'))throw new Error(a.artifact_id);
  const got=json(['artifact-get','--ref',a.artifact_id]);
  if(got.content!=='rounding must use bankers rounding')throw new Error('content mismatch');
  if(!json(['artifact-list']).some(x=>x.artifact_id===a.artifact_id))throw new Error('artifact not listed');
  if(!json(['status',...R]).artifacts.includes(a.artifact_id))throw new Error('artifact not attached to the run');
});
// bug-fix runs INTAKE -> REQUIREMENTS -> PLAN, with no DESIGN stage; the stage
// after REQUIREMENTS is read from the run rather than assumed.
test('a-stage-outside-the-workflow-is-refused',()=>{
  const err=failure(['transition',...R,'--to','DESIGN']);
  if(!/not in workflow/.test(err.error))throw new Error(err.error);
  if(json(['status',...R]).state!=='INTAKE')throw new Error('run moved on a refused transition');
});
test('gate-refuses-a-transition-without-evidence',()=>{
  json(['transition',...R,'--to','REQUIREMENTS']);
  const err=failure(['transition',...R,'--to','PLAN']);
  if(!/gate blocked|missing evidence/.test(err.error))throw new Error(err.error);
  if(json(['status',...R]).state!=='REQUIREMENTS')throw new Error('run advanced despite a refused gate');
});
test('transition-advances-with-evidence',()=>{
  const out=json(['transition',...R,'--to','PLAN','--evidence','requirements_confirmed']);
  if(out.state!=='PLAN')throw new Error(JSON.stringify(out.state));
  if(!out.evidence.REQUIREMENTS.includes('requirements_confirmed'))throw new Error('evidence not recorded');
});
test('force-and-approval-flags-are-rejected-outright',()=>{
  // --force used to skip the gate machinery entirely; it no longer exists as a
  // bypass at all, in any form -- a bare flag, an explicit true, or a string
  // that says false all fail the same named error rather than any of them
  // being honoured.
  const r=json(['start','--objective','Add wishlist capability']);
  const at=['--run-id',r.run_id];
  for(const value of ['false','0','no','true']){
    const out=raw(['transition',...at,'--to','DESIGN','--force',value]);
    if(out.status===0)throw new Error(`--force ${value} was honoured`);
    if(json(['status',...at]).state!=='INTAKE')throw new Error(`--force ${value} moved the run`);
  }
  const bare=failure(['transition',...at,'--to','DESIGN','--force']);
  if(!/FORCE_DISABLED/.test(bare.error))throw new Error(bare.error);
  if(json(['status',...at]).state!=='INTAKE')throw new Error('a bare --force moved the run');
  const withApproval=failure(['transition',...at,'--to','DEPLOY','--approval','*']);
  if(!/FORCE_DISABLED/.test(withApproval.error))throw new Error(withApproval.error);
  if(json(['status',...at]).state!=='INTAKE')throw new Error('--approval * moved the run');
});
test('approval-grant-requires-a-tty',()=>{
  const r=json(['start','--objective','Add loyalty points']);
  const at=['--run-id',r.run_id];
  const err=failure(['approval','grant',...at,'--capability','deploy.production']);
  if(!/interactive terminal/.test(err.error))throw new Error(err.error);
});
test('approval-status-starts-empty',()=>{
  const r=json(['start','--objective','Add loyalty tiers']);
  const status=json(['approval','status','--run-id',r.run_id]);
  if(!Array.isArray(status)||status.length!==0)throw new Error(JSON.stringify(status));
});
test('gate-status-and-explain-report-missing-evidence',()=>{
  const r=json(['start','--objective','Add gate-status capability']);
  const at=['--run-id',r.run_id];
  const g0=json(['gate','status',...at]);
  if(g0.decision!=='PASS')throw new Error(JSON.stringify(g0)); // INTAKE has no requirements
  json(['transition',...at,'--to','REQUIREMENTS']);
  const g1=json(['gate','explain',...at,'--stage','REQUIREMENTS']);
  if(g1.decision!=='BLOCKED'||!g1.missing.includes('requirements_confirmed'))throw new Error(JSON.stringify(g1));
});
test('knowledge-status-reports-missing-on-a-fresh-project',()=>{
  const k=json(['knowledge','status']);
  if(k.status!=='MISSING'||k.missing.length!==4)throw new Error(JSON.stringify(k));
});
test('tool-check-denies-a-tool-the-stage-forbids',()=>{
  const d=json(['tool-check',...R,'--tool','deploy.production']);
  if(d.decision!=='DENY')throw new Error(JSON.stringify(d));
});
test('handoff-put-get-list-round-trip',()=>{
  const h=json(['handoff-put',...R,'--summary','rounding fixed at the boundary','--verified','unit tests pass','--next','review']);
  const id=h.handoff_id||h.id;
  if(!id)throw new Error(JSON.stringify(h));
  const got=json(['handoff-get','--id',id]);
  if(!JSON.stringify(got).includes('rounding fixed'))throw new Error('handoff content lost');
  if(!json(['handoff-list',...R]).length)throw new Error('handoff not listed');
});
test('usage-add-and-report-accumulate-numbers-not-strings',()=>{
  json(['usage-add',...R,'--provider','claude','--model','opus','--input','100','--output','50']);
  json(['usage-add',...R,'--provider','claude','--model','opus','--input','20','--output','5']);
  const rep=json(['usage-report',...R]);
  if(rep.total.input_tokens!==120||rep.total.output_tokens!==55)throw new Error(JSON.stringify(rep.total));
});
test('model-route-answers-for-the-current-stage',()=>{
  const m=json(['model-route',...R]);
  if(!m||typeof m!=='object'||!Object.keys(m).length)throw new Error('empty routing decision');
});
test('metrics-and-replay-export-cover-the-run',()=>{
  if(typeof json(['metrics'])!=='object')throw new Error('no metrics document');
  const bundle=json(['replay-export',...R]);
  if(!bundle.event_stream_sha256||!Array.isArray(bundle.events))throw new Error('incomplete replay bundle');
  if(!bundle.events.some(e=>e.type==='stage.transition'))throw new Error('transitions absent from the replay');
  const out=path.join(PROJECT,'replay.json');
  json(['replay-export',...R,'--output',out]);
  const v=json(['replay-validate','--file',out]);
  if(!v.valid)throw new Error(JSON.stringify(v));
});

// --- repository intelligence ----------------------------------------------
test('repo-index-then-status-reports-the-same-revision',()=>{
  const idx=json(['repo','index']);
  if(!idx.revision||!idx.counts)throw new Error(JSON.stringify(idx));
  const st=json(['repo','status']);
  if(!st.indexed||st.revision!==idx.revision)throw new Error(JSON.stringify(st));
});
test('repo-symbol-finds-an-indexed-symbol',()=>{
  const s=json(['repo','symbol','--name','charge']);
  if(!JSON.stringify(s).includes('service.js'))throw new Error(JSON.stringify(s).slice(0,200));
});

// --- read-only reference surfaces (no run, no state change) ---------------
for(const args of [
  ['activation','policy'],['activation','events'],['activation','cost'],
  ['design','policy'],['task','failure-policy'],['task','state-machine'],
  ['trace','kinds'],['delivery','targets'],['govern','policy'],['learn','sources'],
  ['provider-probe'],['parallel-plan','--tasks','[]']
]){
  test(`reference-surface-${args.join('-')}`,()=>{
    const out=json(args);
    if(out===null||(typeof out==='object'&&!Object.keys(out).length))throw new Error('empty document');
  });
}

// --- error contracts ------------------------------------------------------
test('unknown-command-prints-help-and-exits-2',()=>{
  const r=raw(['not-a-command']);
  if(r.status!==2)throw new Error(`exit ${r.status}`);
  if(!/Commands: init, route, start/.test(r.stdout))throw new Error('help text not printed');
});
test('no-command-prints-help-and-exits-0',()=>{
  const r=raw([]);
  if(r.status!==0)throw new Error(`exit ${r.status}`);
  if(!/Commands: init/.test(r.stdout))throw new Error('help text not printed');
});
test('missing-run-id-is-a-structured-error',()=>{
  const err=failure(['status']);
  if(!/run-id required/.test(err.error))throw new Error(err.error);
});
test('unknown-run-id-is-a-structured-error',()=>{
  failure(['status','--run-id','run_does-not-exist']);
});
test('unknown-workflow-is-a-structured-error',()=>{
  const err=failure(['route','--objective','x','--workflow','not-a-workflow']);
  if(!/unknown workflow/.test(err.error))throw new Error(err.error);
});
test('unknown-subcommands-are-structured-errors',()=>{
  for(const args of [['task','nope'],['repo','nope'],['trace','nope'],['ci','nope'],['govern','nope'],['learn','nope'],['design','nope'],['plan','nope'],['delivery','nope'],['activation','nope'],['requirement-update','nope'],['feature','nope']]){
    const err=failure([...args,...R]);
    if(!/unknown .* subcommand/.test(err.error))throw new Error(`${args.join(' ')}: ${err.error}`);
  }
});
test('requirement-update-plan-without-continues-is-refused',()=>{
  const err=failure(['requirement-update','plan',...R,'--node','ACCEPTANCE_CRITERION:AC-001']);
  if(!/--continues/.test(err.error))throw new Error(err.error);
});
test('requirement-update-show-with-no-plan-yet-says-so',()=>{
  const out=json(['requirement-update','show',...R]);
  if(out.status!=='NO_PLAN_RECORDED')throw new Error(JSON.stringify(out));
});

// --- feature/phase identity -------------------------------------------------
test('feature-create-and-show-round-trip',()=>{
  const f=json(['feature','create','--title','CLI feature test']);
  if(f.status!=='ACTIVE'||f.title!=='CLI feature test'||f.current_phase_id!==null)throw new Error(JSON.stringify(f));
  const shown=json(['feature','show','--feature-id',f.feature_id]);
  if(shown.feature_id!==f.feature_id)throw new Error(JSON.stringify(shown));
  if(!json(['feature','list']).some(x=>x.feature_id===f.feature_id))throw new Error('feature missing from list');
});
test('a-plain-start-stays-unbound-by-default',()=>{
  const r=json(['start','--objective','Add an unrelated capability']);
  if(r.feature_id!==null||r.phase_id!==null)throw new Error(JSON.stringify(r));
});
test('start-with-track-feature-creates-a-feature-and-phase-named-after-the-objective',()=>{
  const r=json(['start','--objective','Track this new feature end to end','--track-feature']);
  if(!r.feature_id||!r.phase_id)throw new Error(JSON.stringify(r));
  const f=json(['feature','show','--feature-id',r.feature_id]);
  if(f.title!=='Track this new feature end to end')throw new Error(JSON.stringify(f));
  if(f.current_phase_id!==r.phase_id)throw new Error('feature pointer does not match the bound phase');
  const phase=json(['feature','phase-show','--feature-id',r.feature_id,'--phase-id',r.phase_id]);
  if(!phase.run_ids.includes(r.run_id))throw new Error('phase was not attached to the new run');
});
test('continue-feature-without-feature-id-is-refused-at-start',()=>{
  const err=failure(['start','--objective','Continue something','--workflow','continue-feature']);
  if(!/--feature-id/.test(err.error))throw new Error(err.error);
});
test('continue-feature-with-feature-id-resolves-and-attaches',()=>{
  const f=json(['feature','create','--title','Continuation target']);
  const p=json(['feature','phase-create','--feature-id',f.feature_id,'--name','phase 1']);
  const r=json(['start','--objective','Continue phase 1 work','--workflow','continue-feature','--feature-id',f.feature_id]);
  if(r.feature_id!==f.feature_id||r.phase_id!==p.phase_id)throw new Error(JSON.stringify(r));
});
test('feature-phase-complete-marks-status-and-timestamp',()=>{
  const f=json(['feature','create','--title','Phase completion check']);
  const p=json(['feature','phase-create','--feature-id',f.feature_id]);
  const completed=json(['feature','phase-complete','--feature-id',f.feature_id,'--phase-id',p.phase_id]);
  if(completed.status!=='COMPLETE'||!completed.completed_at)throw new Error(JSON.stringify(completed));
  // Completing a phase must never silently complete the feature (B5).
  if(json(['feature','show','--feature-id',f.feature_id]).status!=='ACTIVE')throw new Error('phase completion leaked into feature status');
});
test('feature-update-changes-status-explicitly',()=>{
  const f=json(['feature','create','--title','Status update check']);
  const updated=json(['feature','update','--feature-id',f.feature_id,'--status','DEFERRED']);
  if(updated.status!=='DEFERRED')throw new Error(JSON.stringify(updated));
});
test('required-file-flags-are-reported-not-crashed',()=>{
  for(const args of [['plan','validate'],['design','validate'],['normalize']]){
    const err=failure([...args,...R]);
    if(!/required/.test(err.error))throw new Error(`${args.join(' ')}: ${err.error}`);
  }
});
test('a-refused-plan-gate-exits-non-zero',()=>{
  const bad=path.join(PROJECT,'bad-plan.json');
  fs.writeFileSync(bad,JSON.stringify({schema:'agent-sdlc/task-plan/v1',plan_id:'PLAN-1',tasks:[]}));
  const r=raw(['plan','validate','--file',bad]);
  if(r.status===0)throw new Error('an invalid plan validated successfully');
  const doc=JSON.parse(r.stdout||'{}');
  if(doc.valid!==false)throw new Error('no validation verdict on stdout');
});

// --- tool-run, the command that actually produces evidence ------------------
// tool-run is the only command that writes a tool-evidence record bound to a git
// SHA -- the hinge of the whole evidence-driven model -- and no suite had ever
// invoked it, in this file or any other. Neither had provider-command,
// provider-run or fallback.
//
// Reaching a stage that allows a verification tool means walking the entire gate
// chain, and the gates refuse hand-asserted evidence: PLAN evidence must come
// from the deterministic validator, not from --evidence. So this block doubles
// as the only end-to-end CLI drive of the stage loop up to IMPLEMENT.

/** sha256 of nothing: what an empty diff hashes to. */
const EMPTY_SHA256='e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

/** Where runToImplement wrote a run's plan, for the commands that re-read it. */
const PLAN_FILE=runId=>path.join(PROJECT,`plan-${runId}.json`);

/** A review bound to the task's current attempt and diff, written to a file.
 *  `overrides` supplies the schema, the verdict and anything a case wants to
 *  break on purpose. */
function reviewFile(runId,label,task,overrides){
  const file=path.join(PROJECT,`review-${runId}-${label}.json`);
  fs.writeFileSync(file,JSON.stringify({
    task_id:task.task_id,attempt:task.attempt,diff_hash:task.diff_hash,findings:[],
    independence:{requested:false,achieved:true,mode:'SEPARATE_CONTEXT',
      worker_reasoning_withheld:true,reviewer:'independent-reviewer'},
    ...overrides
  },null,2));
  return file;
}

/** Drive a fresh run from INTAKE to IMPLEMENT through the real gates. */
function runToImplement(objective){
  const r=json(['start','--objective',objective]);
  const at=['--run-id',r.run_id];
  json(['transition',...at,'--to','REQUIREMENTS']);
  json(['transition',...at,'--to','DESIGN','--evidence','requirements_confirmed']);
  const design=path.join(PROJECT,`design-${r.run_id}.json`);
  fs.writeFileSync(design,JSON.stringify({
    schema:'agent-sdlc/design-decision/v1',decision_id:'DESIGN-001',objective,mode:'COMPACT',
    requirements:['AC-001','AC-002'],decision:'Key refunds by idempotency key in the existing repository',
    approval:{required:false,status:'NOT_REQUIRED'},
    affected_interfaces:['POST /v1/refunds'],verification_obligations:['contract test for POST /v1/refunds']
  }));
  if(!json(['design','record',...at,'--file',design]).recorded)throw new Error('design decision was refused');
  json(['transition',...at,'--to','PLAN']);
  const planFile=path.join(PROJECT,`plan-${r.run_id}.json`);
  fs.writeFileSync(planFile,JSON.stringify({
    schema:'agent-sdlc/task-plan/v1',plan_id:'PLAN-001',objective,profile:'STANDARD',
    requirements:['AC-001','AC-002'],design_decisions:['DESIGN-001'],integration_tasks:['TASK-002'],
    tasks:[
      {task_id:'TASK-001',title:'Idempotent refund',goal:'Make PaymentService.refund idempotent',
        category:'implementation',acceptance_criteria:['AC-001'],design_decisions:['DESIGN-001'],
        modules:['src'],write_scope:['src/service.js'],read_scope:['src/'],
        likely_symbols:['charge'],interface_scope:['POST /v1/refunds'],
        compatibility_obligations:['keep the v1 refund response shape'],
        verification:{targeted_tests:['tests/service.test.js'],expected_behavior:['a repeated refund is a no-op']},
        done_conditions:['a repeated refund does not double-refund; targeted tests pass'],
        estimated_seconds:300},
      {task_id:'TASK-002',title:'Refund flow integration',goal:'Verify the assembled refund flow',
        category:'integration',depends_on:['TASK-001'],acceptance_criteria:['AC-002'],
        design_decisions:['DESIGN-001'],changes_behavior:false,
        verification:{targeted_tests:['tests/routes.test.js'],expected_behavior:['refund endpoint stays compatible']},
        done_conditions:['end-to-end refund flow passes'],estimated_seconds:120}
    ]
  }));
  if(!json(['plan','record',...at,'--file',planFile]).recorded)throw new Error('plan was refused');
  if(!json(['task','materialize',...at,'--file',planFile]).materialized)throw new Error('tasks were not materialized');
  const state=json(['transition',...at,'--to','IMPLEMENT']).state;
  if(state!=='IMPLEMENT')throw new Error(`run stalled at ${state}`);
  return at;
}

test('tool-run-passes-and-binds-its-evidence-to-the-revision',()=>{
  // The project fixture has no test runner, so the targeted command is declared
  // explicitly: what is under test is the tool gateway and the evidence record,
  // not the detector.
  const cfgPath=path.join(PROJECT,'.agent-sdlc','project.json');
  const cfg=JSON.parse(fs.readFileSync(cfgPath,'utf8'));
  cfg.commands={...(cfg.commands||{}),test_targeted:[process.execPath,'-e','console.log("targeted {selector} ok")']};
  fs.writeFileSync(cfgPath,JSON.stringify(cfg,null,2));

  const at=runToImplement('Add refund idempotency');
  if(json(['tool-check',...at,'--tool','test.run_targeted']).decision!=='ALLOW')throw new Error('IMPLEMENT did not allow the targeted test tool');

  const out=json(['tool-run',...at,'--tool','test.run_targeted','--args','{"selector":"service"}']);
  if(out.status!=='PASS'||out.exit_code!==0)throw new Error(JSON.stringify(out));
  // The {selector} placeholder is substituted, not passed through literally.
  if(!/targeted service ok/.test(out.summary))throw new Error(`selector not substituted: ${JSON.stringify(out.summary)}`);

  // A PASS is what turns into gate evidence, and the record is bound to the
  // exact revision it was produced at -- otherwise stale evidence would pass a
  // gate for code that has since changed.
  const runId=at[1];
  const ledger=path.join(PROJECT,'.agent-sdlc','evidence',`${runId}.jsonl`);
  const rec=fs.readFileSync(ledger,'utf8').trim().split('\n').map(l=>JSON.parse(l))
    .find(e=>e.tool==='test.run_targeted');
  if(!rec)throw new Error('tool-run wrote no evidence record');
  if(rec.claim!=='targeted_verification_pass'||rec.status!=='PASS')throw new Error(JSON.stringify(rec));
  if(!/^[0-9a-f]{40}$/.test(rec.workspace?.git_sha||''))throw new Error(`evidence not bound to a revision: ${JSON.stringify(rec.workspace)}`);
  if(!json(['status',...at]).evidence.IMPLEMENT?.includes('targeted_verification_pass'))throw new Error('evidence never reached the run');
});

test('tool-run-outside-an-allowing-stage-is-a-policy-deny-not-an-error',()=>{
  // A stage refusal is an answer, not a failure: it stays exit 0 with a DENY
  // envelope so a caller can tell "policy said no" from "the command broke".
  const r=json(['start','--objective','Add a deny-path check']);
  const at=['--run-id',r.run_id];
  const out=raw(['tool-run',...at,'--tool','test.run_targeted']);
  if(out.status!==0)throw new Error(`a policy DENY exited ${out.status}`);
  const doc=JSON.parse(out.stdout);
  if(doc.status!=='DENY'||doc.summary?.reason!=='NOT_ALLOWED_IN_STAGE')throw new Error(JSON.stringify(doc));
});

test('a-missing-required-flag-is-an-argument-error-not-a-domain-answer',()=>{
  // Regression: these commands read their flag straight out of argv, so a
  // missing --tool reached the policy engine and came back DENY/UNKNOWN_TOOL at
  // exit 0 -- indistinguishable from a real refusal -- while a missing --to
  // leaked "state undefined not in workflow ..." and a missing --ref leaked a
  // TypeError. Every one of them is now an argument error like --run-id.
  const r=json(['start','--objective','Add a missing-flag check']);
  const at=['--run-id',r.run_id];
  for(const [args,flag] of [
    [['tool-run',...at],'--tool'],[['tool-check',...at],'--tool'],
    [['transition',...at],'--to'],[['artifact-get'],'--ref'],
    [['provider-command',...at],'--host'],[['provider-run',...at],'--host'],
    [['fallback',...at],'--task-id']
  ]){
    const err=failure(args);
    if(err.error!==`${flag} required`)throw new Error(`${args[0]}: ${err.error}`);
  }
});

// --- provider transport through the CLI -------------------------------------
// A fake host binary keeps these hermetic: without the pin they would answer
// differently on a developer machine with a real host CLI than on CI, and
// provider-run would spawn the real thing.
const FAKE_HOST=(()=>{
  const bin=path.join(PROJECT,'claude.mjs');
  fs.copyFileSync(path.join(ROOT,'evals','fake-host-cli.mjs'),bin);
  fs.chmodSync(bin,0o755);
  return {AI_SDLC_CLAUDE_BIN:bin};
})();

test('provider-command-builds-an-invocation-without-spawning-the-host',()=>{
  const r=json(['start','--objective','Add idempotent refund processing']);
  const inv=json(['provider-command','--run-id',r.run_id,'--host','claude'],PROJECT,FAKE_HOST);
  if(inv.status!=='READY'||!Array.isArray(inv.argv)||!inv.argv.length)throw new Error(JSON.stringify(inv).slice(0,300));
  // The pin is authoritative: the invocation targets the pinned binary rather
  // than whatever `claude` happens to be on PATH.
  if(inv.argv[0]!==FAKE_HOST.AI_SDLC_CLAUDE_BIN)throw new Error(`invocation targets ${inv.argv[0]}`);
  // Structured output is what makes a stage result parseable rather than prose,
  // and the flag is only passed because the host's --help advertises it.
  const schemaFlag=inv.argv.indexOf('--json-schema');
  if(schemaFlag<0||!/StageResult\.schema\.json$/.test(inv.argv[schemaFlag+1]||''))throw new Error(`no StageResult schema in ${JSON.stringify(inv.argv)}`);
  // The compiled run context reaches the host as the prompt.
  if(!inv.argv.some(a=>/SDLC execution agent/.test(a)))throw new Error('the compiled prompt is not in the invocation');
  // provider-command prints a command a caller may run themselves, and Claude
  // has no timeout flag, so the argv alone never says when to give up. The
  // budget is part of the document.
  if(!(inv.max_wall_ms>0))throw new Error(`invocation reports no budget: ${JSON.stringify(inv).slice(0,200)}`);
});

test('provider-run-round-trips-a-host-and-records-the-completion',()=>{
  const r=json(['start','--objective','Add idempotent refund processing']);
  const at=['--run-id',r.run_id];
  const out=json(['provider-run',...at,'--host','claude'],PROJECT,FAKE_HOST);
  if(out.status!=='PASS')throw new Error(JSON.stringify(out).slice(0,300));
  // The run must carry the provider call, not just return it: a provider
  // invocation that leaves no event is invisible to replay and cost reporting.
  const bundle=json(['replay-export',...at]);
  const ev=bundle.events.find(e=>e.type==='provider.completed');
  if(!ev)throw new Error('provider-run emitted no provider.completed event');
  if(ev.provider!=='claude'||ev.payload?.status!=='PASS')throw new Error(JSON.stringify(ev));
});

test('fallback-without-a-target-provider-refuses-structurally',()=>{
  // No --to means there is nothing to fall back to. That is a domain answer with
  // a checkpoint attached, not an error, so the caller can see where the task
  // stood before deciding.
  const at=runToImplement('Add refund retry handling');
  const out=json(['fallback',...at,'--task-id','TASK-001','--from','claude']);
  if(out.resumed!==false||out.reason!=='NO_FALLBACK_PROVIDER')throw new Error(JSON.stringify(out).slice(0,300));
  if(!out.checkpoint)throw new Error('a refusal carried no checkpoint');
});

test('fallback-resumes-a-task-on-the-target-provider-from-its-checkpoint',()=>{
  const at=runToImplement('Add refund reconciliation');
  const out=json(['fallback',...at,'--task-id','TASK-001','--from','claude','--to','codex','--failure-class','PROVIDER_TIMEOUT']);
  if(out.resumed!==true)throw new Error(JSON.stringify(out).slice(0,300));
  if(out.fallback_provider!=='codex'||out.failure_class!=='PROVIDER_TIMEOUT')throw new Error(JSON.stringify(out).slice(0,300));
  // Resumption reconstructs context from durable state rather than replaying a
  // conversation, so the task must come back bound to a context manifest.
  if(!out.context_delta)throw new Error('no context delta reported on resume');
});

// --- the task engine, driven the way an agent drives it ---------------------
// 78 subcommands were dispatched and documented without any suite invoking them
// through the CLI. The task engine was the worst of it: 3 of 31. It is exercised
// in-process by validate-task-engine, but the CLI is the surface the skills tell
// the model to call, and nothing had ever walked a task from materialized to
// DONE across process boundaries.
test('a-task-runs-from-materialized-to-done-through-the-cli',()=>{
  const at=runToImplement('Add refund idempotency end to end');
  const runId=at[1];
  const T=['--task-id','TASK-001'];

  if(json(['task','refresh',...at]).promoted?.[0]!=='TASK-001')throw new Error('the root task was not promoted to ready');
  const started=json(['task','start',...at,...T]);
  if(!started.started||started.task.status!=='RUNNING')throw new Error(JSON.stringify(started).slice(0,200));

  // Writer isolation: the task gets its own git worktree, and edits made
  // anywhere else are correctly invisible to it. Writing to the project root
  // here would leave changed_paths empty and the whole lifecycle would pass
  // while verifying nothing.
  const ws=json(['task','workspaces',...at]).workspaces.find(w=>w.task_id==='TASK-001');
  if(ws.mode!=='isolated-worktree'||!ws.root)throw new Error(JSON.stringify(ws).slice(0,200));
  fs.writeFileSync(path.join(ws.root,'src','service.js'),
    'const seen=new Map();\nexport function charge(id,amount){\n  if(seen.has(id))return seen.get(id);\n  const r={id,amount};seen.set(id,r);return r;\n}\n');

  const captured=json(['task','capture',...at,...T]);
  if(!captured.changed_paths.includes('src/service.js'))throw new Error(`capture missed the edit: ${JSON.stringify(captured)}`);
  if(captured.diff_hash===EMPTY_SHA256)throw new Error('a real edit hashed as an empty diff');

  const verified=json(['task','verify',...at,...T]);
  if(verified.evidence?.status!=='PASS')throw new Error(JSON.stringify(verified.evidence).slice(0,200));
  // verify records evidence; it does not move the task. The state machine is
  // walked by advance, which re-verifies rather than trusting an earlier
  // attempt, so a stale PASS cannot carry a task forward.
  if(json(['task','show',...at,...T]).status!=='RUNNING')throw new Error('verify moved the task on its own');

  // advance takes the reviews as arguments rather than trusting whatever was
  // recorded earlier, so a task cannot be walked to DONE by recording a review
  // for some other attempt.
  const blocked=json(['task','advance',...at,...T]);
  if(blocked.advanced!==false||blocked.awaiting!=='SPEC_COMPLIANCE_REVIEW')throw new Error(JSON.stringify(blocked).slice(0,200));
  if(json(['task','show',...at,...T]).status!=='SPEC_REVIEW')throw new Error('advance did not walk verification to the review state');

  const task=json(['task','show',...at,...T]);
  const spec=reviewFile(runId,'spec',task,{schema:'agent-sdlc/spec-compliance-review/v1',verdict:'COMPLIANT',
    acceptance_criteria_checked:task.acceptance_criteria||[]});
  const quality=reviewFile(runId,'quality',task,{schema:'agent-sdlc/code-quality-review/v1',verdict:'ACCEPTED'});

  const done=json(['task','advance',...at,...T,'--spec-review',spec,'--quality-review',quality]);
  if(!done.advanced||done.task.status!=='DONE')throw new Error(JSON.stringify({a:done.advanced,s:done.task.status,steps:done.steps}));
  const progress=json(['task','progress',...at]);
  if(progress.by_status?.DONE!==1||progress.done_count!==1)throw new Error(JSON.stringify(progress).slice(0,200));
});

test('a-review-cannot-claim-independence-it-did-not-have',()=>{
  // The one thing the review contract exists to prevent: a reviewer asserting
  // independence while admitting it shared the worker's context. Recorded
  // through the CLI, the invalid review must be refused with a non-zero exit.
  const at=runToImplement('Add refund independence check');
  const T=['--task-id','TASK-001'];
  json(['task','refresh',...at]);
  json(['task','start',...at,...T]);
  const task=json(['task','show',...at,...T]);
  const bad=reviewFile(at[1],'spec-contradictory',task,{schema:'agent-sdlc/spec-compliance-review/v1',verdict:'COMPLIANT',
    acceptance_criteria_checked:task.acceptance_criteria||[],
    independence:{requested:true,achieved:true,mode:'SAME_CONTEXT',worker_reasoning_withheld:true}});
  const r=raw(['task','review',...at,...T,'--file',bad]);
  if(r.status===0)throw new Error('a contradictory independence claim was accepted');
  const doc=JSON.parse(r.stdout);
  if(!doc.validation?.errors?.includes('INDEPENDENCE_CLAIM_CONTRADICTS_MODE'))throw new Error(JSON.stringify(doc.validation));
});

// --- read-only surfaces that needed a run with real tasks -------------------
const ENGINE=runToImplement('Add refund reporting surfaces');
json(['task','refresh',...ENGINE]);
json(['repo','index']);
json(['trace','build',...ENGINE]);
for(const args of [
  ['task','list'],['task','ready'],['task','progress'],['task','graph'],['task','events'],
  ['task','metrics'],['task','usage'],['task','workspaces'],['task','schedule'],
  ['task','show','--task-id','TASK-001'],['task','context','--task-id','TASK-001'],
  ['task','context-show','--task-id','TASK-001'],['task','checkpoint','--task-id','TASK-001'],
  ['task','classify','--task-id','TASK-001'],['task','replay','--task-id','TASK-001'],
  ['repo','capability'],['repo','tests'],['repo','entities'],['repo','events'],['repo','recent'],
  ['repo','surface'],['repo','interfaces'],['repo','references','--name','charge'],
  ['repo','module','--module','src'],['repo','dependents','--target','src/service.js'],
  ['trace','show'],['trace','validate'],['trace','coverage'],['trace','history'],
  ['delivery','status'],['delivery','branch'],['delivery','push-check'],['delivery','drift'],['delivery','group'],
  ['ci','history'],['govern','report'],
  ['activation','status'],['activation','doctor'],['activation','classify'],
  ['plan','graph','--file',PLAN_FILE(ENGINE[1])],['design','mode'],['feature','active']
]){
  // Named from the command and subcommand only. Folding the whole argv in put a
  // temp path and a run id into one case name, so that row changed on every run
  // and the tracked report churned for no reason.
  test(`read-surface-${args.slice(0,2).join('-').replace(/[^a-z0-9-]/gi,'')}`,()=>{
    const out=json([...args,...ENGINE]);
    if(out===undefined)throw new Error('no document');
  });
}

test('activation-print-bootstrap-emits-pasteable-text-not-json',()=>{
  // The bootstrap instruction is meant to be pasted into a host config, so this
  // one command answers in text. It is in the sweep as a text case rather than
  // dropped, because an empty answer here means auto-activation ships nothing.
  const r=raw(['activation','print-bootstrap',...ENGINE]);
  if(r.status!==0)throw new Error(`exit ${r.status}`);
  if(r.stdout.trim().startsWith('{'))throw new Error('print-bootstrap printed JSON');
  if(!/sdlc-router/.test(r.stdout))throw new Error('the bootstrap text names no skill');
});

test('required-flags-are-guarded-across-every-command-group',()=>{
  // A sweep of all 152 command+subcommand surfaces found five more places that
  // read a flag straight out of argv: `handoff-get` opened a path with the
  // literal string "undefined" in it, `replay-validate` threw a raw Node
  // TypeError about paths[0], and govern/learn reported "unknown task
  // undefined". None of them said which flag was missing.
  for(const [args,flag] of [
    [['handoff-get'],'--id'],[['replay-validate'],'--file'],
    [['govern','complexity'],'--task-id'],[['govern','task'],'--task-id'],
    [['learn','candidate'],'--source']
  ]){
    const err=failure([...args,...ENGINE]);
    if(err.error!==`${flag} required`)throw new Error(`${args.join(' ')}: ${err.error}`);
  }
});

finish();
