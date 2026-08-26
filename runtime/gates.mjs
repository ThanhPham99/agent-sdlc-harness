// Deterministic gate decision: which required tokens are present, which are
// missing, and which are present but stale for the current workspace. This is
// the one place transition() asks "is this stage's gate satisfied," so the
// answer stays consistent between the orchestrator and the CLI/MCP explain
// surfaces.
import path from 'node:path';
import {readJson} from './util.mjs';
import {isEvidenceFresh} from './evidence.mjs';

export function evaluateGate(root,projectRoot,run,stage,haveTokens=null){
  const policy=readJson(path.join(root,'policies','stage-policy.json'));
  const req=policy.stages[stage]?.gate_requirements||[];
  const authority=policy.evidence_authority||{};
  const have=new Set(haveTokens??(run.evidence[stage]||[]));
  const satisfied=[],missing=[],stale=[];
  for(const token of req){
    if(!have.has(token)){missing.push(token);continue;}
    if(authority[token]==='runtime'&&!isEvidenceFresh(projectRoot,run,stage,token)){stale.push(token);continue;}
    satisfied.push(token);
  }
  return {
    schema:'agent-sdlc/gate-decision/v1',
    stage,required:req,
    decision:(missing.length||stale.length)?'BLOCKED':'PASS',
    satisfied,missing,stale
  };
}
