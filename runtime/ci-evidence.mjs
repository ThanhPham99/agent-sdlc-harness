// CI evidence, bound to an exact revision.
//
// A CI result is only evidence about the revision it ran on. This module makes
// that binding explicit and invalidates evidence when the revision moves,
// rather than letting a stale green run vouch for new code.
import fs from 'node:fs';
import path from 'node:path';
import {gitSha,now,readJson,sha256,writeJson,appendJsonl} from './util.mjs';
import {stateDir,putArtifact} from './store.mjs';

const arr=x=>Array.isArray(x)?x:[];
const dir=projectRoot=>path.join(stateDir(projectRoot),'ci-evidence');
const recPath=(projectRoot,runId)=>path.join(dir(projectRoot),`${runId}.json`);

export const CI_STATUSES=['PASS','FAIL','PENDING','BLOCKED','UNKNOWN'];

/**
 * Record a CI result for one revision. `status` is taken from the reported
 * checks, not from a caller's summary: any failing required check makes the
 * whole record FAIL.
 */
export function recordCiEvidence(projectRoot,run,{revision=null,provider='unknown',workflow=null,run_url=null,checks=[],logs=null}={}){
  const rev=revision||gitSha(projectRoot);
  const rows=arr(checks).map(c=>({
    name:c.name,required:c.required!==false,
    status:CI_STATUSES.includes(c.status)?c.status:'UNKNOWN',
    duration_ms:Number(c.duration_ms||0)
  }));
  const required=rows.filter(c=>c.required);
  const status=!rows.length?'UNKNOWN'
    :required.some(c=>c.status==='FAIL')?'FAIL'
    :required.some(c=>['PENDING','UNKNOWN'].includes(c.status))?'PENDING'
    :required.some(c=>c.status==='BLOCKED')?'BLOCKED'
    :'PASS';

  let artifact_ref=null;
  if(logs){
    artifact_ref=putArtifact(projectRoot,{kind:'ci-log',content:String(logs),runId:run.run_id,stage:run.state,
      sourceRevision:rev,filename:`ci-${workflow||provider}.log`}).artifact_id;
  }
  const record={
    schema:'agent-sdlc/ci-evidence/v1',
    run_id:run.run_id,
    provider,workflow,run_url,
    // The binding that makes this evidence rather than an anecdote.
    revision:rev,
    checks:rows,
    required_checks:required.length,
    status,
    artifact_ref,
    fingerprint:sha256(JSON.stringify({rev,rows})),
    recorded_at:now()
  };
  writeJson(recPath(projectRoot,run.run_id),record);
  appendJsonl(path.join(dir(projectRoot),`${run.run_id}.jsonl`),record);
  return record;
}

export function loadCiEvidence(projectRoot,runId){
  const p=recPath(projectRoot,runId);
  return fs.existsSync(p)?readJson(p):null;
}

/** Is the recorded CI evidence still about the current revision? */
export function ciEvidenceCurrent(projectRoot,runId,{revision=null}={}){
  const rec=loadCiEvidence(projectRoot,runId);
  const head=revision||gitSha(projectRoot);
  if(!rec)return {current:false,reason:'NO_CI_EVIDENCE',status:'UNKNOWN',head};
  if(!rec.revision)return {current:false,reason:'EVIDENCE_NOT_REVISION_BOUND',status:rec.status,head};
  if(rec.revision!==head){
    return {current:false,reason:'REVISION_CHANGED',status:rec.status,
      evidence_revision:rec.revision,head,action:'RERUN_CI_ON_CURRENT_REVISION'};
  }
  return {current:true,reason:null,status:rec.status,revision:rec.revision};
}

/** History of CI records for a run, oldest first. */
export function ciEvidenceHistory(projectRoot,runId){
  const p=path.join(dir(projectRoot),`${runId}.jsonl`);
  if(!fs.existsSync(p))return [];
  return fs.readFileSync(p,'utf8').split('\n').filter(Boolean).map(l=>JSON.parse(l));
}
