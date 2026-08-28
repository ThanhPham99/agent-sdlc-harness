#!/usr/bin/env node
// Token-hygiene guard regression suite.
//
// Mirrors scripts/validate-guard.mjs for the second PreToolUse guard: it
// exercises the real hook process against a fixed corpus and asserts the
// exact permission decision, in both directions -- known-verbose test/log
// commands must be denied, and already-bounded or unrelated commands must
// not be. It also asserts that each host adapter that wires the safety guard
// wires this one too, since a guard behind a matcher that never fires
// protects nothing.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {writeReport} from './lib/report-io.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const rj=p=>JSON.parse(fs.readFileSync(path.join(ROOT,p),'utf8'));
const VERSION=rj('agent-sdlc.manifest.json').version;
const GUARD=path.join(ROOT,'adapters','hooks','test-output-guard.mjs');
const cases=rj('evals/test-output-guard/cases.json').cases;

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
    // A false positive here (guard denies a command that should pass) is the
    // expensive failure: it teaches operators to disable the hook.
    failure_class:ok?null:(expected===null?'FALSE_POSITIVE':'MISSED_VERBOSE_OUTPUT'),
    reason:got.reason
  };
});

// Matcher coverage: every tool name the corpus expects to be guarded must be
// routed to this guard by every adapter that already routes it to the safety
// guard (pretool-guard). Antigravity has no PreToolUse hook stage at all, so
// it is out of scope here, same as for the safety guard.
const guardedTools=[...new Set(cases.filter(c=>c.expect!==null).map(c=>c.tool))];
const matcherRows=[];
for(const adapter of ['adapters/claude/hooks.json','adapters/codex/hooks.json']){
  const cfg=rj(adapter);
  const entries=cfg.hooks?.PreToolUse||[];
  const usesGuard=entries.filter(e=>JSON.stringify(e.hooks||[]).includes('test-output-guard'));
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
  schema:'agent-sdlc/test-output-guard-validation/v1',
  version:VERSION,
  guard:'adapters/hooks/test-output-guard.mjs',
  checks:rows.length+matcherRows.length,
  passes:rows.length+matcherRows.length-failures,
  failures,
  by_expectation:{
    deny:rows.filter(r=>r.expected==='deny').length,
    allow:rows.filter(r=>r.expected===null).length
  },
  false_positives:caseFailures.filter(r=>r.failure_class==='FALSE_POSITIVE').length,
  missed_verbose_output:caseFailures.filter(r=>r.failure_class==='MISSED_VERBOSE_OUTPUT').length,
  matcher_coverage:matcherRows,
  results:rows,
  status:failures?'FAIL':'PASS'
};
writeReport(path.join(ROOT,'evals','TEST-OUTPUT-GUARD-VALIDATION.json'),report);
console.log(JSON.stringify({...report,results:caseFailures.length?caseFailures:'all-pass',matcher_coverage:matcherFailures.length?matcherFailures:'all-pass'},null,2));
process.exit(failures?1:0);
