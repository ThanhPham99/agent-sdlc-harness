#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {
  ROOT,VERSION,HOSTS,packageDigest,corpusDigest,qualificationSubjectDigest,hostPreflight,
  extractStructured,extractUsage,stripSchemaDialect,classifyFailure,hostProducedNoAnswer,CONTENT_KEYS,matchesExpected
} from './qualification-lib.mjs';
import {writeReport} from './lib/report-io.mjs';
import {route} from '../runtime/router.mjs';

let pass=0,fail=0;const rows=[];
function test(name,fn){try{fn();pass++;rows.push({name,status:'PASS'});}catch(e){fail++;rows.push({name,status:'FAIL',error:e.message});}}
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'agent-sdlc-qual-reg-'));
function fakeCli(name,missing=''){
  // A Node script rather than a /bin/sh script: qualification spawns host
  // binaries through `spawnHost`, so this fixture runs on Windows too.
  const p=path.join(tmp,`${name}.mjs`);
  const all={
    claude:'--bare --plugin-dir --print --output-format --json-schema --no-session-persistence --max-turns',
    codex:'--ephemeral --json --output-schema --output-last-message --sandbox --skip-git-repo-check',
    antigravity:'--sandbox --print --print-timeout --output-format --json-schema'
  }[name].split(' ').filter(x=>x!==missing).join(' ');
  fs.writeFileSync(p,`const a=process.argv.slice(2);\nif(a.includes('--version')){console.log(${JSON.stringify(`${name} fake-1.0`)});process.exit(0);}\nconsole.log(${JSON.stringify(all)});\nprocess.exit(0);\n`);
  return p;
}
for(const h of HOSTS)test(`preflight-compatible-${h}`,()=>{const p=hostPreflight(h,{binary:fakeCli(h)});if(p.status!=='READY')throw Error(JSON.stringify(p));});
test('preflight-incompatible-blocked',()=>{const p=hostPreflight('claude',{binary:fakeCli('claude','--json-schema')});if(p.status!=='BLOCKED'||!p.checks[1].missing_tokens.includes('--json-schema'))throw Error(JSON.stringify(p));});
// Claude Code 2.1.233 dropped --max-turns. Requiring it blocked preflight on a
// flag the runtime already treated as optional, so a host that lacks only an
// optional token stays READY and says which capability it gave up.
test('preflight-ready-without-optional-max-turns',()=>{
  const p=hostPreflight('claude',{binary:fakeCli('claude','--max-turns')});
  if(p.status!=='READY')throw Error(JSON.stringify(p));
  if(!p.degraded_capabilities.some(d=>d.flag==='--max-turns'))throw Error('degradation not reported');
  if(p.checks[1].required_tokens.includes('--max-turns'))throw Error('--max-turns is still required');
});
// --bare is not merely optional: on Claude Code 2.1.233 it drops the user's
// credentials, so every live case came back "Not logged in". It must never be
// required, and qualification must never pass it.
test('preflight-ready-without-bare',()=>{
  const p=hostPreflight('claude',{binary:fakeCli('claude','--bare')});
  if(p.status!=='READY')throw Error(JSON.stringify(p));
  if(p.checks[1].required_tokens.includes('--bare'))throw Error('--bare is still required');
});
test('qualification-never-passes-bare',()=>{
  const src=fs.readFileSync(path.join(ROOT,'scripts','qualify-host.mjs'),'utf8');
  if(/push\('--bare'\)|'--bare',/.test(src))throw Error('qualify-host still passes --bare');
});
// The host validator rejects a document that declares a dialect it cannot
// resolve, so the key is stripped on the way to --json-schema -- everywhere it
// appears, because a nested subschema carries one too.
test('strip-schema-dialect-removes-every-occurrence',()=>{
  const out=stripSchemaDialect({
    $schema:'https://json-schema.org/draft/2020-12/schema',
    type:'object',
    properties:{nested:{$schema:'https://json-schema.org/draft/2020-12/schema',type:'string'}},
    anyOf:[{$schema:'x',const:1}]
  });
  if(JSON.stringify(out).includes('$schema'))throw Error(JSON.stringify(out));
  if(out.type!=='object'||out.properties.nested.type!=='string'||out.anyOf[0].const!==1)throw Error('stripping altered the schema body');
});
// Nullability is expressed as an anyOf branch rather than a null inside the
// enum, because Antigravity rejects the latter outright: with `null` in any
// enum, `agy --json-schema` returns status ERROR for the whole document, and
// removing it makes the identical schema succeed. Claude accepts both forms, so
// anyOf is the encoding both hosts share. These helpers read either shape.
const allowedValues=prop=>prop?.enum
  ?? prop?.anyOf?.flatMap(b=>b.enum??(b.type==='null'?[null]:[]))
  ?? null;
const acceptsNull=prop=>Array.isArray(prop?.enum)
  ? prop.enum.includes(null)
  : !!prop?.anyOf?.some(b=>b.type==='null');

// Every enum-constrained field in the decision schema came back correct in the
// first live run; every unconstrained one came back invented -- workflow
// "feature-development", overlay "production-change-control", next_action as a
// paragraph of prose. The vocabulary the host is allowed to answer with is
// therefore pinned to the canonical registries, and pinned means kept in sync:
// a workflow added to config/workflows.json and not to the schema would be an
// answer the model is forbidden to give.
test('decision-schema-workflow-enum-matches-the-registry',()=>{
  const schema=JSON.parse(fs.readFileSync(path.join(ROOT,'evals','live','semantic-decision.schema.json'),'utf8'));
  const registry=Object.keys(JSON.parse(fs.readFileSync(path.join(ROOT,'config','workflows.json'),'utf8')).workflows);
  const allowed=allowedValues(schema.properties.workflow).filter(x=>x!==null);
  const missing=registry.filter(w=>!allowed.includes(w));
  const extra=allowed.filter(w=>!registry.includes(w));
  if(missing.length||extra.length)throw Error(`missing ${JSON.stringify(missing)} extra ${JSON.stringify(extra)}`);
  if(!acceptsNull(schema.properties.workflow))throw Error('an inactive decision must still be able to answer null');
});
test('decision-schema-observed-state-enum-matches-the-state-machine',()=>{
  const schema=JSON.parse(fs.readFileSync(path.join(ROOT,'evals','live','repository-decision.schema.json'),'utf8'));
  const sm=JSON.parse(fs.readFileSync(path.join(ROOT,'config','state-machine.json'),'utf8'));
  const states=[...new Set(sm.edges.flatMap(e=>[e.from,e.to]))];
  const allowed=allowedValues(schema.properties.observed_state).filter(x=>x!==null);
  const missing=states.filter(s=>!allowed.includes(s));
  if(missing.length)throw Error(`state machine has states the schema forbids: ${JSON.stringify(missing)}`);
});
// Three places name overlays and nothing kept them agreeing: `incident` was
// mandated by a router rule and mapped to an internal skill while having no
// overlays/*.md for either to point at, and `release-impact` had a file that
// nothing referenced. An overlay the router can mandate must have guidance to
// load when it does.
test('every-mandatable-overlay-has-a-guidance-file',()=>{
  const rules=JSON.parse(fs.readFileSync(path.join(ROOT,'config','router-rules.json'),'utf8'));
  const wf=JSON.parse(fs.readFileSync(path.join(ROOT,'config','workflows.json'),'utf8')).workflows;
  const mandatable=new Set([
    ...rules.rules.flatMap(r=>r.overlays||[]),
    ...Object.values(wf).flatMap(v=>v.required_overlays||[])
  ]);
  const missing=[...mandatable].filter(o=>!fs.existsSync(path.join(ROOT,'overlays',`${o}.md`)));
  if(missing.length)throw Error(`mandatable overlays with no overlays/*.md: ${JSON.stringify(missing)}`);
});
test('overlay-enum-is-exactly-what-the-router-can-mandate',()=>{
  const rules=JSON.parse(fs.readFileSync(path.join(ROOT,'config','router-rules.json'),'utf8'));
  const wf=JSON.parse(fs.readFileSync(path.join(ROOT,'config','workflows.json'),'utf8')).workflows;
  const mandatable=[...new Set([
    ...rules.rules.flatMap(r=>r.overlays||[]),
    ...Object.values(wf).flatMap(v=>v.required_overlays||[])
  ])].sort();
  const schema=JSON.parse(fs.readFileSync(path.join(ROOT,'evals','live','semantic-decision.schema.json'),'utf8'));
  const allowed=[...schema.properties.overlays.items.enum].sort();
  // Offering an overlay the router never mandates is offering the model a
  // wrong answer: release-impact and client-impact were picked in six cases
  // purely because the enum listed them.
  if(JSON.stringify(allowed)!==JSON.stringify(mandatable))throw Error(`enum ${JSON.stringify(allowed)} != mandatable ${JSON.stringify(mandatable)}`);
});
// Grading a field the model was never told the meaning of measures guessing.
// human_stop_required, trust_action, approval_required and
// untrusted_instruction_detected were all graded with no definition anywhere --
// not the schema, not a skill, policy or prompt -- and every one of them was
// answered wrongly in a way the definition later explained. A field the corpus
// grades has to say what it means, unless its name plus its enum already do.
test('every-graded-decision-field-is-defined',()=>{
  const schema=JSON.parse(fs.readFileSync(path.join(ROOT,'evals','live','semantic-decision.schema.json'),'utf8'));
  // activate, profile and next_action are self-describing: a boolean named
  // "activate", and two fields whose enums enumerate every legal answer.
  const selfEvident=new Set(['activate','profile','next_action','reason_codes']);
  const graded=new Set();
  for(const f of ['semantic-cases.json','security-cases.json','activation-cases.json']){
    for(const c of JSON.parse(fs.readFileSync(path.join(ROOT,'evals','live',f),'utf8')).cases){
      for(const k of Object.keys(c.expected||{}))graded.add(k);
    }
  }
  const undefinedFields=[...graded].filter(k=>!selfEvident.has(k)&&!schema.properties[k]?.description);
  if(undefinedFields.length)throw Error(`graded but undefined: ${JSON.stringify(undefinedFields)}`);
});
// The corpus expectations are not opinion: they agree with the deterministic
// router, which is the canonical answer. The bypass demand belongs in
// trust_action, not in the route.
//
// The expected route is read from the router rather than written here as a
// literal. A literal is how this case came to expect new-feature: the router
// declares no new-feature keyword rule at all, so new-feature is what it
// answers when NOTHING matched, and the case spent its life measuring whether
// a host could reproduce a fallback. The DEFAULT_NEW_FEATURE check below is
// the part that would have caught it.
test('security-case-routes-match-the-deterministic-router',()=>{
  const cases=JSON.parse(fs.readFileSync(path.join(ROOT,'evals','live','security-cases.json'),'utf8')).cases;
  const sec009=cases.find(c=>c.id==='SEC009');
  if(!sec009)throw Error('SEC009 is missing from the corpus');
  const routed=route(ROOT,sec009.prompt);
  if(routed.reason_codes.includes('DEFAULT_NEW_FEATURE'))
    throw Error(`SEC009 expects the router fallback, not a considered route: ${JSON.stringify(routed)}`);
  if(sec009.expected.workflow!==routed.workflow||sec009.expected.profile!==routed.profile)
    throw Error(`SEC009 no longer matches the router: expected ${JSON.stringify(sec009.expected)}, router ${JSON.stringify(routed)}`);
  if(sec009.expected.trust_action!=='DENY')throw Error('a request to defeat a control should be DENY');
});
// A quota that ran out is not a host that answered wrongly. classifyFailure
// knew "rate limit" and "quota exceeded" but not the wording Claude Code
// actually uses, nor the 429 it carries, so an exhausted session was recorded
// as a genuine FAIL: one real run went from 15/20 to 2/20 on evidence that
// said the host got the answers wrong. Verbatim messages, not paraphrases.
test('an-exhausted-quota-is-transient-not-a-failure',()=>{
  const transient=[
    "You've hit your session limit · resets 12:30am (Asia/Bangkok)",
    '{"api_error_status":429,"result":"limit"}',
    'rate limit exceeded',
    'usage limit reached',
    'quota exceeded',
    'HTTP status: 429'
  ];
  for(const t of transient){
    const got=classifyFailure(t,1);
    if(got!=='BLOCKED_TRANSIENT')throw Error(`${JSON.stringify(t.slice(0,60))} classified ${got}`);
  }
  // and a real contract break is still a failure, not swallowed as transient
  if(classifyFailure('unknown option --nope',1)!=='FAIL_CLI_CONTRACT')throw Error('CLI drift stopped being a failure');
  if(classifyFailure('assertion failed: expected 3 got 4',1)!=='FAIL_UNCLASSIFIED')throw Error('a genuine failure was reclassified');
});
// Antigravity rejects a schema with `null` inside any enum: `agy --json-schema`
// returns status ERROR for the whole document, and the identical schema with
// the null removed succeeds. Claude accepts either form. That asymmetry is
// invisible until a host run fails wholesale, so the portable encoding is
// pinned here rather than rediscovered. profile and trust_action carried
// null-in-enum from the start, so Antigravity could never have been qualified
// on this corpus.
test('no-decision-schema-enum-contains-null',()=>{
  for(const f of ['semantic-decision.schema.json','repository-decision.schema.json']){
    const d=JSON.parse(fs.readFileSync(path.join(ROOT,'evals','live',f),'utf8'));
    const offenders=[];
    const walk=(node,where)=>{
      if(Array.isArray(node))return node.forEach((x,i)=>walk(x,`${where}[${i}]`));
      if(!node||typeof node!=='object')return;
      if(Array.isArray(node.enum)&&node.enum.includes(null))offenders.push(where);
      for(const [k,v] of Object.entries(node))walk(v,`${where}.${k}`);
    };
    walk(d,f);
    if(offenders.length)throw Error(`null inside enum at ${offenders.join(', ')} -- use anyOf with a {"type":"null"} branch instead`);
  }
});
// Temp cleanup sits in a finally that wraps the whole case loop, and the
// evidence document is built after it. When rmSync threw EPERM on Windows --
// agy holds a handle on the workspace it was given -- twenty cases of real API
// calls were discarded with nothing written at all, twice, before the stack
// trace was even captured. Housekeeping must not be able to destroy the
// measurement, so the call is guarded and the outcome is reported.
test('temp-cleanup-cannot-destroy-a-run',()=>{
  const src=fs.readFileSync(path.join(ROOT,'scripts','qualify-host.mjs'),'utf8');
  const fin=src.slice(src.indexOf('}finally{'),src.indexOf('}finally{')+900);
  if(!/try\{fs\.rmSync/.test(fin))throw Error('the finally-block rmSync is unguarded again');
  if(!/maxRetries/.test(fin))throw Error('no retry for a transient Windows lock');
  if(!/tempCleanup=\{status:'LEAKED'/.test(fin))throw Error('a failed cleanup is not recorded');
  if(!/name:'temp_cleanup'/.test(src))throw Error('cleanup outcome never reaches the evidence');
});
// A host that answers badly must fail its case, never the run. Antigravity
// returned `overlays` as something that is not an array; validateDecision
// detected exactly that and grade() then spread it anyway, so one malformed
// answer threw and discarded nineteen good ones. Measuring a second host is
// how the harness learns it was only ever robust to the first.
test('a-malformed-answer-fails-its-case-not-the-run',()=>{
  const src=fs.readFileSync(path.join(ROOT,'scripts','qualify-host.mjs'),'utf8');
  if(/const diffs=grade\(/.test(src))throw Error('grade() is called unguarded again');
  if(/const diffs=gradeE2E\(/.test(src))throw Error('gradeE2E() is called unguarded again');
  if(!/MALFORMED_DECISION/.test(src))throw Error('a malformed answer has no recorded reason');
  // and the array comparison itself no longer assumes the shape
  if(/\[\.\.\.\(a\?\.overlays\|\|\[\]\)\]/.test(src))throw Error('overlays is spread without an Array.isArray check');
});
// Antigravity echoes the schema back in its reply envelope, after the answer.
// parseJsonObject scans for any object containing the required key and keeps
// the last one -- and a schema's `properties` map contains every field name the
// decision has, so the schema won and all 20 cases were graded against
// {activate:{type:'boolean'}}. The declared structured output is now consulted
// before any scanning, and a schema-shaped match is refused outright.
test('the-reply-is-preferred-over-an-echoed-schema',()=>{
  const envelope=JSON.stringify({
    conversation_id:'x',
    status:'SUCCESS',
    structured_output:{activate:true,workflow:'bug-fix',profile:'STANDARD',overlays:[],human_stop_required:false,next_action:'RUN_SDLC_ORCHESTRATOR'},
    json_schema:{type:'object',properties:{
      activate:{type:'boolean'},
      workflow:{anyOf:[{type:'string',enum:['bug-fix']},{type:'null'}]},
      profile:{anyOf:[{type:'string',enum:['FAST']},{type:'null'}]}
    }}
  });
  const got=extractStructured(envelope,null,'activate');
  if(got?.activate!==true)throw Error(`extracted the wrong object: ${JSON.stringify(got).slice(0,200)}`);
  if(got.workflow!=='bug-fix')throw Error(`expected the decision, got ${JSON.stringify(got).slice(0,200)}`);
});
test('a-bare-echoed-schema-yields-no-decision',()=>{
  // No answer at all, only the schema: the honest result is null, which the
  // caller records as NO_STRUCTURED_DECISION rather than grading a schema.
  const onlySchema=JSON.stringify({json_schema:{type:'object',properties:{
    activate:{type:'boolean'},workflow:{anyOf:[{type:'string',enum:['bug-fix']},{type:'null'}]}
  }}});
  const got=extractStructured(onlySchema,null,'activate');
  if(got!==null)throw Error(`a schema was accepted as a decision: ${JSON.stringify(got).slice(0,200)}`);
});
// Pinning is only safe if it cannot forbid an answer the corpus asks for.
// Silence is not a wrong answer.
//
// Both envelopes below are verbatim from Antigravity 1.1.23 during live SMOKE
// qualification. Graded as NO_STRUCTURED_DECISION they made two consecutive
// runs of the same corpus score 17/20 and 13/20, disagreeing on six of twenty
// cases, where every single difference was the host returning nothing.
test('an-empty-host-response-is-recognised-as-silence',()=>{
  const canceled="{\"conversation_id\": \"17128cd5\", \"status\": \"CANCELED\", \"response\": \"\", \"duration_seconds\": 25.7, \"num_turns\": 1}";
  const success="{\"conversation_id\": \"91daa426\", \"status\": \"SUCCESS\", \"response\": \"\", \"duration_seconds\": 39.0, \"num_turns\": 1}";
  if(!hostProducedNoAnswer(canceled,null))throw Error('a CANCELED empty response was not recognised as silence');
  if(!hostProducedNoAnswer(success,null))throw Error('an empty response reported as SUCCESS was not recognised as silence');
  if(!hostProducedNoAnswer('',null))throw Error('no output at all was not recognised as silence');
  if(!hostProducedNoAnswer('   \n  ',null))throw Error('whitespace-only output was not recognised as silence');
});

// A host that said something and got it wrong has failed the case. Only
// silence changes class, so each of these must stay a failure.
test('output-that-exists-is-never-treated-as-silence',()=>{
  const cases={
    prose:'I would route this as a hotfix, because the request mentions production.',
    fenced:'```json\n{\"activate\":true,\"workflow\":\"hotfix\"}\n```',
    wrong_shape:'{"verdict":"probably a hotfix"}',
    envelope_with_no_content_field:JSON.stringify({status:'CANCELED',duration_seconds:25.7}),
    envelope_with_prose:JSON.stringify({status:'SUCCESS',response:'a hotfix, I think'}),
    envelope_with_json:JSON.stringify({status:'SUCCESS',response:'{"activate":true}'}),
    quota:"{\"is_error\": true, \"result\": \"You've hit your session limit\", \"type\": \"result\", \"api_error_status\": 429}"
  };
  for(const [name,text] of Object.entries(cases)){
    if(hostProducedNoAnswer(text,null))throw Error(`${name} was treated as silence`);
  }
});

test('a-written-final-answer-file-is-never-silence',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'agent-sdlc-noanswer-'));
  const final=path.join(dir,'answer.json');
  fs.writeFileSync(final,'{"activate":true}');
  if(hostProducedNoAnswer('',final))throw Error('an answer delivered by file was read as silence');
  fs.writeFileSync(final,'   ');
  if(!hostProducedNoAnswer('',final))throw Error('an empty answer file is still silence');
  fs.rmSync(dir,{recursive:true,force:true});
});

// The extractor searches these fields for an answer and the silence predicate
// reads them to establish there was none; two lists would eventually disagree.
test('the-content-key-list-has-one-definition',()=>{
  const src=fs.readFileSync(path.join(ROOT,'scripts','qualification-lib.mjs'),'utf8');
  const literals=src.match(/\['structured_output'/g)||[];
  if(literals.length!==1)throw Error(`the content-key list is written ${literals.length} times; it must be CONTENT_KEYS only`);
  if(!CONTENT_KEYS.includes('response')||!CONTENT_KEYS.includes('result'))throw Error(JSON.stringify(CONTENT_KEYS));
});

// A set-valued expectation says more than one answer is correct, never that
// the corpus could not decide. These rails are the difference between the two.
test('a-set-valued-expectation-stays-inside-the-escalating-answers',()=>{
  const ESCALATING=['HUMAN','DENY'];
  const cases=JSON.parse(fs.readFileSync(path.join(ROOT,'evals','live','security-cases.json'),'utf8')).cases;
  const withSets=[];
  for(const c of cases){
    const e=c.expected||{};
    for(const [k,v] of Object.entries(e)){
      if(!Array.isArray(v)||k==='overlays')continue;
      if(k!=='trust_action')throw Error(`${c.id}: only trust_action may be a set, not ${k}`);
      if(v.length<2)throw Error(`${c.id}: a set of ${v.length} is a single value in disguise`);
      if(new Set(v).size!==v.length)throw Error(`${c.id}: duplicate values in ${JSON.stringify(v)}`);
      for(const x of v)if(!ESCALATING.includes(x))throw Error(`${c.id}: ${x} does not refuse and escalate, so it cannot share a set`);
      withSets.push(c.id);
    }
    // Whatever the label, the two fields that carry the safety property are pinned.
    if(typeof e.human_stop_required!=='boolean')throw Error(`${c.id}: human_stop_required is not a single boolean`);
    if(typeof e.approval_required!=='boolean')throw Error(`${c.id}: approval_required is not a single boolean`);
    if(!c.expected_note&&Array.isArray(e.trust_action))throw Error(`${c.id}: a set needs a recorded reason`);
  }
  if(JSON.stringify(withSets)!==JSON.stringify(['SEC015']))
    throw Error(`sets are meant to be exceptional; found ${JSON.stringify(withSets)}`);
});

test('a-set-valued-expectation-admits-its-members-and-nothing-else',()=>{
  const cases=JSON.parse(fs.readFileSync(path.join(ROOT,'evals','live','security-cases.json'),'utf8')).cases;
  const sec015=cases.find(c=>c.id==='SEC015');
  if(!sec015)throw Error('SEC015 is missing from the corpus');
  const expected=sec015.expected.trust_action;
  // matchesExpected is the function qualify-host grades with, imported rather
  // than restated: a copy here could pass while the real grading disagreed.
  for(const ok of ['HUMAN','DENY'])
    if(!matchesExpected(expected,ok))throw Error(`${ok} should satisfy SEC015`);
  for(const bad of ['NONE','QUARANTINE',null,undefined])
    if(matchesExpected(expected,bad))throw Error(`${JSON.stringify(bad)} should not satisfy SEC015`);
  // A single-valued expectation must keep grading exactly as before.
  const sec014=cases.find(c=>c.id==='SEC014');
  if(!matchesExpected(sec014.expected.trust_action,'DENY'))throw Error('SEC014 no longer accepts its own answer');
  if(matchesExpected(sec014.expected.trust_action,'HUMAN'))throw Error('a single-valued expectation became permissive');
});

// The enum check reads expectations as single values; a set has to be unfolded
// or it would silently stop being checked against the schema.
test('every-value-in-a-set-is-in-the-schema-enum',()=>{
  const sem=JSON.parse(fs.readFileSync(path.join(ROOT,'evals','live','semantic-decision.schema.json'),'utf8')).properties;
  const allowed=allowedValues(sem.trust_action);
  for(const c of JSON.parse(fs.readFileSync(path.join(ROOT,'evals','live','security-cases.json'),'utf8')).cases){
    const v=c.expected?.trust_action;
    for(const x of (Array.isArray(v)?v:[v]))
      if(x!==undefined&&!allowed.includes(x??null))throw Error(`${c.id}: trust_action ${x} is not in the enum`);
  }
});

test('decision-schema-enums-admit-every-expected-value',()=>{
  const sem=JSON.parse(fs.readFileSync(path.join(ROOT,'evals','live','semantic-decision.schema.json'),'utf8')).properties;
  for(const f of ['semantic-cases.json','security-cases.json','activation-cases.json']){
    for(const c of JSON.parse(fs.readFileSync(path.join(ROOT,'evals','live',f),'utf8')).cases){
      const e=c.expected||{};
      if(!allowedValues(sem.workflow).includes(e.workflow??null))throw Error(`${f}: workflow ${e.workflow} is not in the enum`);
      if(!allowedValues(sem.next_action).includes(e.next_action??null))throw Error(`${f}: next_action ${e.next_action} is not in the enum`);
      for(const o of e.overlays||[])if(!sem.overlays.items.enum.includes(o))throw Error(`${f}: overlay ${o} is not in the enum`);
    }
  }
  const rep=JSON.parse(fs.readFileSync(path.join(ROOT,'evals','live','repository-decision.schema.json'),'utf8')).properties;
  for(const c of JSON.parse(fs.readFileSync(path.join(ROOT,'evals','live','repository-e2e-cases.json'),'utf8')).cases){
    if(!allowedValues(rep.observed_state).includes(c.expected?.observed_state??null))throw Error(`observed_state ${c.expected?.observed_state} is not in the enum`);
  }
});
// Stripping happens at the call site; the files keep their declared dialect so
// every other consumer, and every editor, still sees one.
test('live-decision-schemas-keep-their-dialect-on-disk',()=>{
  for(const f of ['semantic-decision.schema.json','repository-decision.schema.json']){
    const d=JSON.parse(fs.readFileSync(path.join(ROOT,'evals','live',f),'utf8'));
    if(!d.$schema)throw Error(`${f} lost its $schema declaration`);
  }
});
test('structured-output-extraction',()=>{const x=extractStructured('{"response":"{\\"activate\\":true,\\"workflow\\":\\"new-feature\\"}"}',null,'activate');if(x?.workflow!=='new-feature')throw Error(JSON.stringify(x));});
test('token-usage-proxy-marked',()=>{const u=extractUsage('not-json','hello','world');if(u.source!=='PROXY_ESTIMATE'||!u.total_tokens)throw Error(JSON.stringify(u));});

function evidence(host,status='QUALIFIED',when=new Date().toISOString(),hash=packageDigest(host)){
  return {schema:'agent-sdlc/live-host-qualification/v1',version:VERSION,evaluated_at:when,host,tier:'FULL',status,promotion_evidence:status==='QUALIFIED',package:{file:`agent-sdlc-${host}-${VERSION}.zip`,sha256:hash,verified:true},bound_inputs:{corpus_sha256:corpusDigest(),qualification_subject_sha256:qualificationSubjectDigest()},preflight:{host_version:`${host} fake-1.0`},semantic_summary:{PASS:84,FAIL:0,SKIP:0,BLOCKED:0},repository_e2e_summary:{PASS:8,FAIL:0,SKIP:0,BLOCKED:0},required_semantic_case_count:84,required_repository_e2e_count:8,token_usage:{source:'ACTUAL_HOST_REPORTED',total_tokens:1000}};
}
function runAggregate(map,label){const out=path.join(tmp,`${label}-result.json`),approval=path.join(tmp,`${label}-approval.json`);const args=[path.join(ROOT,'scripts','qualify-release.mjs'),'--output',out,'--approval',approval];for(const h of HOSTS){const p=path.join(tmp,`${label}-${h}.json`);fs.writeFileSync(p,JSON.stringify(map[h],null,2));args.push('--evidence',`${h}=${p}`);}const r=spawnSync(process.execPath,args,{cwd:ROOT,encoding:'utf8'});return {code:r.status,out,approval,stdout:r.stdout,stderr:r.stderr};}
test('promotion-accepts-exact-fresh-qualified-evidence',()=>{const m=Object.fromEntries(HOSTS.map(h=>[h,evidence(h)]));const r=runAggregate(m,'good');if(r.code!==0||!fs.existsSync(r.approval))throw Error(`${r.code} ${r.stdout} ${r.stderr}`);const d=JSON.parse(fs.readFileSync(r.out,'utf8'));if(!d.promotion_to_rc_allowed)throw Error(JSON.stringify(d));});
test('promotion-rejects-package-digest-tamper',()=>{const m=Object.fromEntries(HOSTS.map(h=>[h,evidence(h)]));m.codex=evidence('codex','QUALIFIED',new Date().toISOString(),'0'.repeat(64));const r=runAggregate(m,'tamper');if(r.code!==1||fs.existsSync(r.approval))throw Error(`code=${r.code}`);});
test('promotion-rejects-stale-evidence',()=>{const m=Object.fromEntries(HOSTS.map(h=>[h,evidence(h)]));m.claude=evidence('claude','QUALIFIED',new Date(Date.now()-169*3600_000).toISOString());const r=runAggregate(m,'stale');if(r.code!==1||fs.existsSync(r.approval))throw Error(`code=${r.code}`);});
test('promotion-preserves-pending-as-exit-2',()=>{const m=Object.fromEntries(HOSTS.map(h=>[h,evidence(h)]));m.antigravity=evidence('antigravity','PENDING');m.antigravity.semantic_summary={PASS:0,FAIL:0,SKIP:84,BLOCKED:0};m.antigravity.repository_e2e_summary={PASS:0,FAIL:0,SKIP:8,BLOCKED:0};const r=runAggregate(m,'pending');if(r.code!==2||fs.existsSync(r.approval))throw Error(`code=${r.code}`);const d=JSON.parse(fs.readFileSync(r.out,'utf8'));if(d.status!=='LIVE_HOST_PENDING')throw Error(JSON.stringify(d));});

fs.rmSync(tmp,{recursive:true,force:true});
const report={schema:'agent-sdlc/qualification-harness-regression/v1',version:VERSION,checks:rows.length,passes:pass,failures:fail,results:rows};fs.mkdirSync(path.join(ROOT,'evals'),{recursive:true});writeReport(path.join(ROOT,'evals','QUALIFICATION-HARNESS-REGRESSION.json'),report);console.log(JSON.stringify(report,null,2));process.exit(fail?1:0);
