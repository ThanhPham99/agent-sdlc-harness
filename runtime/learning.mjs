// Regression learning: turn a real failure into a reusable eval fixture.
//
// Two rules shape everything here:
//
//   1. Sanitize. A fixture carries the minimal reproducible facts, never raw
//      proprietary logs, absolute paths, hostnames or secrets.
//   2. Propose, never mutate. One failure does not rewrite policy. This module
//      emits a *candidate* that deterministic or live eval must validate before
//      anyone adopts it.
import path from 'node:path';
import {now,sha256,redactHighEntropySecrets} from './util.mjs';

const arr=x=>Array.isArray(x)?x:[];

export const LEARNING_SOURCES=[
  'ESCAPED_DEFECT','INCIDENT_RCA','VERIFICATION_FAILURE','REVIEW_FINDING','INCORRECT_ROUTE',
  'INCORRECT_GATE_DECISION','SCHEDULER_CONFLICT','CONTEXT_OMISSION','PROVIDER_COMPATIBILITY_FAILURE'
];

const SUITE_BY_SOURCE={
  ESCAPED_DEFECT:'evals/plan-quality',
  INCIDENT_RCA:'evals/invalidation',
  VERIFICATION_FAILURE:'evals/task-runtime',
  REVIEW_FINDING:'evals/task-runtime',
  INCORRECT_ROUTE:'evals/activation',
  INCORRECT_GATE_DECISION:'evals/design-discovery',
  SCHEDULER_CONFLICT:'evals/task-runtime',
  CONTEXT_OMISSION:'evals/task-runtime',
  PROVIDER_COMPATIBILITY_FAILURE:'evals/provider-conformance'
};

// Secret-shaped values are replaced wholesale rather than partially masked:
// a partially masked token is still a leak of its shape and length.
const SECRET_PATTERNS=[
  [/AKIA[0-9A-Z]{16}/g,'[REDACTED_AWS_KEY_ID]'],
  [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,'[REDACTED_PRIVATE_KEY]'],
  [/\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{16,}/g,'[REDACTED_TOKEN]'],
  [/\bsk-[A-Za-z0-9]{16,}/g,'[REDACTED_TOKEN]'],
  [/\b(?:sk|pk|rk)_(?:live|test)_[0-9a-zA-Z]{24,}\b/g,'[REDACTED_STRIPE_KEY]'],
  [/\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^/\s:@]+:[^/\s:@]+@[^\s/:]+(?::\d+)?\/[^\s?]*/gi,'[REDACTED_DATABASE_URL]'],
  [/\b(?:Bearer)\s+[A-Za-z0-9._~+/-]{20,}\b/gi,'Bearer [REDACTED_TOKEN]'],
  [/\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,'[REDACTED_JWT]'],
  [/\b(?:xox[baprs]-)[A-Za-z0-9-]{10,}/g,'[REDACTED_TOKEN]'],
  [/((?:api[_-]?key|secret|token|password|passwd|pwd|authorization|bearer)\s*[:=]\s*)(["']?)[^\s"',;]+\2/gi,'$1[REDACTED]'],
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,'[REDACTED_EMAIL]'],
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/g,'[REDACTED_IP]'],
  [/[A-Za-z]:\\[^\s"']{3,}/g,'[REDACTED_PATH]'],
  [/(?:\/Users|\/home)\/[^\s"'/]+/g,'[REDACTED_HOME]'],
  [/\bhttps?:\/\/[^\s"']+/g,'[REDACTED_URL]']
];

/** Redact secret-shaped and environment-identifying content from free text. */
export function sanitizeText(text,{maxChars=1200}={}){
  let out=String(text??'');
  for(const [rx,rep] of SECRET_PATTERNS)out=out.replace(rx,rep);
  out=redactHighEntropySecrets(out);
  if(out.length>maxChars)out=out.slice(0,maxChars)+'…[TRUNCATED]';
  return out;
}

/** Repository-relative, secret-free path. Absolute paths never survive. */
export function sanitizePath(p,{projectRoot=null}={}){
  let s=String(p??'').replace(/\\/g,'/');
  if(projectRoot){
    const root=String(projectRoot).replace(/\\/g,'/').replace(/\/+$/,'');
    if(s.startsWith(root+'/'))s=s.slice(root.length+1);
  }
  return sanitizeText(s,{maxChars:200});
}

/**
 * Build a candidate regression fixture. Deterministic: the same failure always
 * produces the same candidate, including its id.
 */
export function buildRegressionCandidate({
  source,title,projectRoot=null,
  observed=null,expected=null,
  runId=null,taskId=null,
  failureClass=null,
  evidence=[],
  diagnostic=null,
  paths=[],
  policyHypothesis=null
}={}){
  if(!LEARNING_SOURCES.includes(source))throw new Error(`unknown learning source ${source}`);
  const facts={
    source,
    title:sanitizeText(title,{maxChars:160}),
    failure_class:failureClass??null,
    observed:sanitizeText(observed,{maxChars:600}),
    expected:sanitizeText(expected,{maxChars:600}),
    paths:arr(paths).map(p=>sanitizePath(p,{projectRoot})).slice(0,10),
    // Evidence travels as refs and hashes, never as content.
    evidence_refs:arr(evidence).filter(e=>typeof e==='string'&&e.startsWith('artifact://')).slice(0,10),
    diagnostic:diagnostic?sanitizeText(diagnostic):null
  };
  const fingerprint=sha256(JSON.stringify(facts));
  return {
    schema:'agent-sdlc/regression-candidate/v1',
    candidate_id:`REGCAND-${fingerprint.slice(0,12)}`,
    status:'CANDIDATE',
    suite:SUITE_BY_SOURCE[source],
    // Identifiers are recorded but carry no repository content.
    origin:{run_id:runId??null,task_id:taskId??null},
    facts,
    fingerprint,
    // A candidate proposes; it never adopts.
    policy_change:policyHypothesis?{
      status:'PROPOSED_NOT_APPLIED',
      hypothesis:sanitizeText(policyHypothesis,{maxChars:400}),
      requires:'deterministic or live eval validation before adoption'
    }:null,
    auto_applied:false,
    adoption_requires:['deterministic_eval_pass','human_review'],
    created_at:now()
  };
}

/** Check that a candidate is safe to commit into an eval corpus. */
export function validateRegressionCandidate(candidate){
  const errors=[];const warnings=[];
  const c=candidate||{};
  if(c.schema!=='agent-sdlc/regression-candidate/v1')errors.push('SCHEMA_MISMATCH');
  if(!LEARNING_SOURCES.includes(c.facts?.source))errors.push('UNKNOWN_SOURCE');
  if(!c.facts?.title)errors.push('MISSING_TITLE');
  if(!c.facts?.observed||!c.facts?.expected)errors.push('MISSING_OBSERVED_OR_EXPECTED');
  if(c.auto_applied===true)errors.push('CANDIDATE_MARKED_AUTO_APPLIED');
  if(c.policy_change&&c.policy_change.status!=='PROPOSED_NOT_APPLIED')errors.push('POLICY_CHANGE_NOT_MARKED_PROPOSED');

  // Re-scan the serialized candidate: sanitization must have already happened.
  const serialized=JSON.stringify(c);
  const leaks=[];
  for(const [rx] of SECRET_PATTERNS){
    const clone=new RegExp(rx.source,rx.flags.replace('g','')+'');
    if(clone.test(serialized.replace(/\[REDACTED[^\]]*\]/g,'')))leaks.push(rx.source.slice(0,40));
  }
  if(leaks.length)errors.push(`UNSANITIZED_CONTENT:${leaks.length}`);
  if(/[A-Za-z]:\\|\/Users\/|\/home\//.test(serialized.replace(/\[REDACTED[^\]]*\]/g,'')))errors.push('ABSOLUTE_PATH_LEAK');
  if(!arr(c.facts?.paths).length)warnings.push('NO_PATHS_RECORDED');
  if(!arr(c.facts?.evidence_refs).length)warnings.push('NO_EVIDENCE_REFS');
  return {schema:'agent-sdlc/regression-candidate-validation/v1',valid:errors.length===0,
    leaks,errors,warnings,suite:c.suite??null};
}

/** Render a candidate as a runnable eval case for its target suite. */
export function toEvalCase(candidate){
  const f=candidate.facts;
  return {
    id:candidate.candidate_id,
    origin:candidate.facts.source,
    title:f.title,
    // A regression case must be runnable from these facts alone.
    given:{paths:f.paths,failure_class:f.failure_class},
    when:f.observed,
    expect:f.expected,
    suite:candidate.suite,
    status:'CANDIDATE_PENDING_VALIDATION'
  };
}
