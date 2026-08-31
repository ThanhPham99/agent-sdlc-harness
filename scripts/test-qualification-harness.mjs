#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {
  ROOT,VERSION,HOSTS,packageDigest,corpusDigest,qualificationSubjectDigest,hostPreflight,
  extractStructured,extractUsage,stripSchemaDialect
} from './qualification-lib.mjs';
import {writeReport} from './lib/report-io.mjs';

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
  const allowed=schema.properties.workflow.enum.filter(x=>x!==null);
  const missing=registry.filter(w=>!allowed.includes(w));
  const extra=allowed.filter(w=>!registry.includes(w));
  if(missing.length||extra.length)throw Error(`missing ${JSON.stringify(missing)} extra ${JSON.stringify(extra)}`);
  if(!schema.properties.workflow.enum.includes(null))throw Error('an inactive decision must still be able to answer null');
});
test('decision-schema-observed-state-enum-matches-the-state-machine',()=>{
  const schema=JSON.parse(fs.readFileSync(path.join(ROOT,'evals','live','repository-decision.schema.json'),'utf8'));
  const sm=JSON.parse(fs.readFileSync(path.join(ROOT,'config','state-machine.json'),'utf8'));
  const states=[...new Set(sm.edges.flatMap(e=>[e.from,e.to]))];
  const allowed=schema.properties.observed_state.enum.filter(x=>x!==null);
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
// Pinning is only safe if it cannot forbid an answer the corpus asks for.
test('decision-schema-enums-admit-every-expected-value',()=>{
  const sem=JSON.parse(fs.readFileSync(path.join(ROOT,'evals','live','semantic-decision.schema.json'),'utf8')).properties;
  for(const f of ['semantic-cases.json','security-cases.json','activation-cases.json']){
    for(const c of JSON.parse(fs.readFileSync(path.join(ROOT,'evals','live',f),'utf8')).cases){
      const e=c.expected||{};
      if(!sem.workflow.enum.includes(e.workflow??null))throw Error(`${f}: workflow ${e.workflow} is not in the enum`);
      if(!sem.next_action.enum.includes(e.next_action??null))throw Error(`${f}: next_action ${e.next_action} is not in the enum`);
      for(const o of e.overlays||[])if(!sem.overlays.items.enum.includes(o))throw Error(`${f}: overlay ${o} is not in the enum`);
    }
  }
  const rep=JSON.parse(fs.readFileSync(path.join(ROOT,'evals','live','repository-decision.schema.json'),'utf8')).properties;
  for(const c of JSON.parse(fs.readFileSync(path.join(ROOT,'evals','live','repository-e2e-cases.json'),'utf8')).cases){
    if(!rep.observed_state.enum.includes(c.expected?.observed_state??null))throw Error(`observed_state ${c.expected?.observed_state} is not in the enum`);
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
