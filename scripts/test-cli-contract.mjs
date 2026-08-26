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

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const CLI=path.join(ROOT,'runtime','cli.mjs');
let pass=0,fail=0;const rows=[];
const test=(name,fn)=>{try{fn();pass++;rows.push({name,status:'PASS'});}catch(e){fail++;rows.push({name,status:'FAIL',error:String(e.message).slice(0,400)});}};

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

/** Run the CLI the way an agent does and return {status, stdout, stderr}. */
function raw(args,cwd=PROJECT){
  const r=spawnSync(process.execPath,[CLI,...args,'--project',cwd],
    {cwd,encoding:'utf8',timeout:120000,maxBuffer:32*1024*1024});
  return {status:r.status,stdout:r.stdout||'',stderr:r.stderr||''};
}
/** Expect success and JSON on stdout. */
function json(args,cwd=PROJECT){
  const r=raw(args,cwd);
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
  for(const args of [['task','nope'],['repo','nope'],['trace','nope'],['ci','nope'],['govern','nope'],['learn','nope'],['design','nope'],['plan','nope'],['delivery','nope'],['activation','nope']]){
    const err=failure([...args,...R]);
    if(!/unknown .* subcommand/.test(err.error))throw new Error(`${args.join(' ')}: ${err.error}`);
  }
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

const report={schema:'agent-sdlc/cli-contract-validation/v1',checks:rows.length,passes:pass,failures:fail,results:rows};
fs.writeFileSync(path.join(ROOT,'evals','CLI-CONTRACT-VALIDATION.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(fail?report:{...report,results:'all-pass'},null,2));
process.exit(fail?1:0);
