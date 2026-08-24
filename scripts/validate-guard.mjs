#!/usr/bin/env node
// Host guard regression suite.
//
// The PreToolUse guard is the only defence-in-depth layer that runs inside the
// host, before the model's command reaches a shell. It is enforced by the host,
// not by the SDLC runtime, so a silent regression here is invisible to every
// other suite. This script exercises the real hook process against a fixed
// corpus and asserts the exact permission decision, in both directions:
// destructive commands must be stopped, and everyday commands must not be.
//
// It also asserts that each host adapter actually routes its shell-capable
// tool names into the guard. A perfect guard behind a matcher that never fires
// protects nothing.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const rj=p=>JSON.parse(fs.readFileSync(path.join(ROOT,p),'utf8'));
const VERSION=rj('agent-sdlc.manifest.json').version;
const GUARD=path.join(ROOT,'adapters','hooks','pretool-guard.mjs');
const cases=rj('evals/guard/cases.json').cases;

function decide(c){
  const payload={tool_name:c.tool,tool_input:c.file_path?{file_path:c.file_path}:{command:c.command}};
  const r=spawnSync(process.execPath,[GUARD],{input:JSON.stringify(payload),encoding:'utf8',timeout:5000});
  if(r.error)return {decision:'ERROR',reason:String(r.error.message)};
  const out=(r.stdout||'').trim();
  if(!out)return {decision:null,reason:null};
  try{
    const parsed=JSON.parse(out);
    return {
      decision:parsed.hookSpecificOutput?.permissionDecision??null,
      reason:parsed.hookSpecificOutput?.permissionDecisionReason??null
    };
  }catch{return {decision:'UNPARSEABLE',reason:out.slice(0,200)};}
}

const rows=cases.map(c=>{
  const got=decide(c);
  const expected=c.expect??null;
  const ok=got.decision===expected;
  return {
    case_id:c.id,
    status:ok?'PASS':'FAIL',
    tool:c.tool,
    command:c.command,
    expected,
    actual:got.decision,
    // A false positive is the expensive failure: it teaches operators to
    // disable the guard. Label it so triage is not guesswork.
    failure_class:ok?null:(expected===null?'FALSE_POSITIVE':(got.decision===null?'MISSED_DESTRUCTIVE':'WRONG_SEVERITY')),
    reason:got.reason
  };
});

// Matcher coverage: every tool name the corpus expects to be guarded must be
// routed to the guard by every adapter that declares a PreToolUse hook.
const guardedTools=[...new Set(cases.filter(c=>c.expect!==null).map(c=>c.tool))];
const matcherRows=[];
for(const adapter of ['adapters/claude/hooks.json','adapters/codex/hooks.json']){
  const cfg=rj(adapter);
  const entries=cfg.hooks?.PreToolUse||[];
  const usesGuard=entries.filter(e=>JSON.stringify(e.hooks||[]).includes('pretool-guard'));
  for(const tool of guardedTools){
    const covered=usesGuard.some(e=>{
      if(!e.matcher)return true;
      try{return new RegExp(`^(?:${e.matcher})$`).test(tool);}catch{return false;}
    });
    matcherRows.push({adapter,tool,status:covered?'PASS':'FAIL',
      matchers:usesGuard.map(e=>e.matcher||'*')});
  }
}

const caseFailures=rows.filter(r=>r.status==='FAIL');
const matcherFailures=matcherRows.filter(r=>r.status==='FAIL');
const failures=caseFailures.length+matcherFailures.length;
const report={
  schema:'agent-sdlc/guard-validation/v1',
  version:VERSION,
  guard:'adapters/hooks/pretool-guard.mjs',
  checks:rows.length+matcherRows.length,
  passes:rows.length+matcherRows.length-failures,
  failures,
  by_expectation:{
    deny:rows.filter(r=>r.expected==='deny').length,
    ask:rows.filter(r=>r.expected==='ask').length,
    allow:rows.filter(r=>r.expected===null).length
  },
  false_positives:caseFailures.filter(r=>r.failure_class==='FALSE_POSITIVE').length,
  missed_destructive:caseFailures.filter(r=>r.failure_class==='MISSED_DESTRUCTIVE').length,
  matcher_coverage:matcherRows,
  results:rows,
  status:failures?'FAIL':'PASS'
};
fs.writeFileSync(path.join(ROOT,'evals','GUARD-VALIDATION.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({...report,results:caseFailures.length?caseFailures:'all-pass',matcher_coverage:matcherFailures.length?matcherFailures:'all-pass'},null,2));
process.exit(failures?1:0);
