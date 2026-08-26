// Tool-produced evidence, bound to the workspace state at record time. A gate
// token this module writes is not just present -- it is anchored to the exact
// git SHA and working-tree diff that produced it, so a later edit makes it
// stale rather than silently still counting. Mirrors the append-only-JSONL
// pattern already used by ci-evidence.mjs, rather than adding a new field to
// the Run schema.
import fs from 'node:fs';
import path from 'node:path';
import {gitSha,dirtyHash,now,appendJsonl} from './util.mjs';
import {stateDir,saveRun} from './store.mjs';

const dir=projectRoot=>path.join(stateDir(projectRoot),'evidence');
const logPath=(projectRoot,runId)=>path.join(dir(projectRoot),`${runId}.jsonl`);

export function currentWorkspaceFingerprint(projectRoot){
  return {git_sha:gitSha(projectRoot),dirty_diff_sha256:dirtyHash(projectRoot)};
}

export function recordEvidence(projectRoot,run,{stage,claim,status,tool=null,exitCode=null,artifactRef=null}){
  const record={
    schema:'agent-sdlc/tool-evidence/v1',
    run_id:run.run_id,stage,claim,status,tool,exit_code:exitCode,
    workspace:currentWorkspaceFingerprint(projectRoot),
    artifact_ref:artifactRef,recorded_at:now()
  };
  appendJsonl(logPath(projectRoot,run.run_id),record);
  if(status==='PASS'){
    run.evidence[stage]=[...new Set([...(run.evidence[stage]||[]),claim])];
    saveRun(projectRoot,run);
  }
  return record;
}

export function listEvidence(projectRoot,runId){
  const p=logPath(projectRoot,runId);
  return fs.existsSync(p)?fs.readFileSync(p,'utf8').split('\n').filter(Boolean).map(l=>JSON.parse(l)):[];
}

export function latestEvidence(projectRoot,runId,stage,claim){
  const rows=listEvidence(projectRoot,runId).filter(r=>r.stage===stage&&r.claim===claim&&r.status==='PASS');
  return rows.at(-1)||null;
}

// A claim this module never recorded is not tracked by staleness -- treat it
// as fresh so a token written by another path (a structural gate record like
// design_or_skip_decision) is unaffected.
export function isEvidenceFresh(projectRoot,run,stage,claim){
  const rec=latestEvidence(projectRoot,run.run_id,stage,claim);
  if(!rec)return true;
  const current=currentWorkspaceFingerprint(projectRoot);
  return rec.workspace.git_sha===current.git_sha&&rec.workspace.dirty_diff_sha256===current.dirty_diff_sha256;
}
