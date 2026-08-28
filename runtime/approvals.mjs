// Approval authority: a typed, provenance-bound record of who authorized a
// privileged capability, replacing an arbitrary caller-supplied string. Only
// an authority class the runtime can actually trust may satisfy a privileged
// gate; a wildcard capability and an approval with no expiry on a privileged
// scope are refused outright rather than accepted and audited after the fact.
import path from 'node:path';
import {now,readJson,uuid} from './util.mjs';
import {emit,saveRun} from './store.mjs';

export const TRUSTED_AUTHORITIES=['HOST_PERMISSION','USER_INTERACTIVE','ORG_POLICY','EXTERNAL_APPROVAL_PROVIDER'];
export const UNTRUSTED_AUTHORITIES=['AGENT_SELF','DATA_ONLY','UNKNOWN'];

export function isPrivilegedCapability(root,capability){
  const sec=readJson(path.join(root,'policies','security-policy.json'));
  if((sec.human_approval_required||[]).includes(capability))return true;
  const tools=readJson(path.join(root,'config','tools.json')).tools||{};
  const def=tools[capability];
  return def?.risk==='privileged'||def?.risk==='irreversible';
}

export function recordApproval(root,projectRoot,run,{capability,authority,actor=null,reason=null,expiresAt=null}={}){
  if(!capability)throw new Error('capability is required');
  if(capability==='*')throw new Error('a wildcard capability is not permitted');
  if(!TRUSTED_AUTHORITIES.includes(authority))throw new Error(`authority ${authority} cannot grant approval`);
  if(isPrivilegedCapability(root,capability)&&!expiresAt)throw new Error(`capability ${capability} is privileged and requires an expiry`);
  const record={approval_id:uuid('approval'),approval:capability,capability,authority,actor,reason,time:now(),expires_at:expiresAt,revoked_at:null};
  run.approvals=[...(run.approvals||[]),record];
  saveRun(projectRoot,run);
  emit(projectRoot,run,{type:'approval.recorded',payload:{capability,authority,actor,expires_at:expiresAt}});
  return record;
}

export function revokeApproval(root,projectRoot,run,capability,{reason=null}={}){
  const records=(run.approvals||[]).filter(a=>(a.capability||a.approval)===capability&&!a.revoked_at);
  const target=records.at(-1);
  if(!target)throw new Error(`no active approval found for ${capability}`);
  target.revoked_at=now();
  target.revoked_reason=reason;
  saveRun(projectRoot,run);
  emit(projectRoot,run,{type:'approval.revoked',payload:{capability,reason}});
  return target;
}

export function findValidApproval(run,capability){
  const nowIso=now();
  const candidates=(run.approvals||[]).filter(a=>
    (a.capability||a.approval)===capability&&
    TRUSTED_AUTHORITIES.includes(a.authority)&&
    !a.revoked_at&&
    (!a.expires_at||a.expires_at>nowIso)
  );
  return candidates.at(-1);
}

/**
 * The capabilities this run currently has authority for.
 *
 * Three callers built their own list with `(run.approvals||[]).map(a=>a.approval)`
 * -- every record ever written, revoked and expired ones included. So
 * `approval revoke` had no effect on the delivery push gate or the DESIGN
 * human-approval gate, and a lapsed grant kept authorizing indefinitely.
 * findValidApproval already encoded the rule; this is it applied to the whole
 * set, so a gate cannot accidentally ask the weaker question.
 */
export function activeCapabilities(run){
  const caps=new Set((run?.approvals||[]).map(a=>a.capability||a.approval).filter(Boolean));
  return [...caps].filter(c=>findValidApproval(run,c));
}

export function approvalStatus(a){
  if(a.revoked_at)return 'REVOKED';
  if(a.expires_at&&a.expires_at<=now())return 'EXPIRED';
  return 'ACTIVE';
}

export function listApprovals(run){
  return (run.approvals||[]).map(a=>({...a,status:approvalStatus(a)}));
}
