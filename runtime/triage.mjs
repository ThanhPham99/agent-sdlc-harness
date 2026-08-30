// Structured Error Triage for Test and Verification Failures.
//
// Converts raw terminal stderr/stdout into a deterministic, structured
// diagnosis so agents and downstream self-healing loops can pinpoint the exact
// failing test, file location, and root cause without guessing.
import {truncateUtf8} from './util.mjs';

const PATTERNS={
  jest_fail:/^\s*(?:✕|●|FAIL)\s+(.+)$/gm,
  pytest_fail:/^FAILED\s+([^:\s]+::[^\s]+)/gm,
  gotest_fail:/^--- FAIL:\s+([^\s]+)/gm,
  cargo_fail:/^test\s+([^\s]+)\s+\.\.\.\s+FAILED/gm,
  tap_fail:/^not ok\s+\d+\s+-\s+(.+)$/gm,
  location:/(?:at\s+.*?\(([^)]+):(\d+):(\d+)\))|(?:([a-zA-Z0-9_\-\./\\]+\.(?:[jt]sx?|py|go|rs|php|rb|java|kt|cs)):(\d+)(?::(\d+))?)/g
};

export function classifyFailureType(raw){
  const text=String(raw||'');
  if(/timed out|timeout of \d+ms exceeded|SIGTERM|ETIMEDOUT/i.test(text))return 'TIMEOUT';
  if(/SyntaxError|parse error|invalid syntax/i.test(text))return 'SYNTAX_ERROR';
  if(/error\[E\d+\]|cannot find module|cannot find symbol|TS\d+|compilation error|build failed|fatal error/i.test(text))return 'COMPILATION_ERROR';
  if(/AssertionError|assert|expected|received|assertion failed|FAILED/i.test(text))return 'ASSERTION_FAILURE';
  if(/unauthorized|forbidden|secret|permission denied/i.test(text))return 'SECURITY_OR_PERMISSION_FAILURE';
  return 'COMMAND_FAILURE';
}

export function extractFailingNames(raw){
  const text=String(raw||'');
  const names=new Set();
  let m;

  // Jest / Vitest
  const jestRegex=new RegExp(PATTERNS.jest_fail.source,'gm');
  while((m=jestRegex.exec(text))!==null){
    const name=m[1].trim().replace(/\s+\(\d+ms\)$/,'');
    if(name&&!name.startsWith('Test Suites:'))names.add(name);
  }

  // Pytest
  const pytestRegex=new RegExp(PATTERNS.pytest_fail.source,'gm');
  while((m=pytestRegex.exec(text))!==null){
    names.add(m[1].trim());
  }

  // Go test
  const goRegex=new RegExp(PATTERNS.gotest_fail.source,'gm');
  while((m=goRegex.exec(text))!==null){
    names.add(m[1].trim());
  }

  // Cargo test
  const cargoRegex=new RegExp(PATTERNS.cargo_fail.source,'gm');
  while((m=cargoRegex.exec(text))!==null){
    names.add(m[1].trim());
  }

  // TAP / Node test
  const tapRegex=new RegExp(PATTERNS.tap_fail.source,'gm');
  while((m=tapRegex.exec(text))!==null){
    names.add(m[1].trim());
  }

  return Array.from(names);
}

export function extractLocations(raw){
  const text=String(raw||'');
  const locations=new Set();
  const locRegex=new RegExp(PATTERNS.location.source,'g');
  let m;
  while((m=locRegex.exec(text))!==null){
    const file=m[1]||m[4];
    const line=m[2]||m[5];
    if(file&&line&&!file.includes('node_modules')&&!file.includes('node:internal')){
      locations.add(`${file}:${line}`);
    }
  }
  return Array.from(locations).slice(0,10);
}

export function extractSummary(raw){
  const text=String(raw||'').trim();
  if(!text)return 'Command exited with non-zero status without output';
  const lines=text.split('\n').map(l=>l.trim()).filter(Boolean);
  
  // Find lines starting with Error:, AssertionError:, FAIL:, or FAILED
  const keyLine=lines.find(l=>/^(?:AssertionError|Error|TypeError|ReferenceError|FAIL|FAILED|fatal):/i.test(l))
    ||lines.find(l=>l.includes('Error:'))
    ||lines[lines.length-1];

  return truncateUtf8(keyLine||lines[0]||'Test execution failed',240).text;
}

export function triageFailure(rawOutput,commandKind='test'){
  const raw=String(rawOutput||'');
  const failure_type=classifyFailureType(raw);
  const failing_names=extractFailingNames(raw);
  const failing_locations=extractLocations(raw);
  const summary=extractSummary(raw);

  return {
    schema:'agent-sdlc/failure-triage/v1',
    command_kind:commandKind,
    failure_type,
    failing_names,
    failing_locations,
    summary,
    sample_excerpt:truncateUtf8(raw,800).text
  };
}
