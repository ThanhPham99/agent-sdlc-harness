// Approval authority: a typed, provenance-bound record of who authorized a
// privileged capability, replacing an arbitrary caller-supplied string. Only
// an authority class the runtime can actually trust may satisfy a privileged
// gate; a wildcard capability and an approval with no expiry on a privileged
// scope are refused outright rather than accepted and audited after the fact.
import path from 'node:path';
import {now,readJson,uuid} from './util.mjs';
import {emit,saveRun,loadRun} from './store.mjs';

export const TRUSTED_AUTHORITIES=['HOST_PERMISSION','USER_INTERACTIVE','ORG_POLICY','EXTERNAL_APPROVAL_PROVIDER'];
export const UNTRUSTED_AUTHORITIES=['AGENT_SELF','DATA_ONLY','UNKNOWN'];

/**
 * The capability names the gates themselves check.
 *
 * These used to live as bare string literals at each gate site, so the name a
 * caller had to request was discoverable only by reading the gate. Requesting
 * `vcs.commit_push` instead of `delivery_commit_approved` produced a ticket
 * that was granted, recorded, and matched by nothing -- an approval that reads
 * as GRANTED in `run.approvals` while satisfying no gate at all. The gates now
 * import these, so the registry below cannot drift from what they check.
 */
export const GATE_CAPABILITIES={
  DESIGN_HUMAN_APPROVED:'design_human_approved',
  DELIVERY_COMMIT_APPROVED:'delivery_commit_approved',
  DEPLOY_PRODUCTION:'deploy.production',
  GIT_PUSH_PROTECTED:'git.push_protected'
};

/**
 * Every capability name the harness actually consumes, derived from the places
 * that consume it rather than restated by hand:
 *
 * - the gate constants above,
 * - `human_approval_required` in policies/security-policy.json,
 * - tool ids in config/tools.json whose risk is privileged or irreversible,
 * - evidence tokens in policies/stage-policy.json marked `human`, which
 *   orchestrator.mjs satisfies with findValidApproval.
 *
 * A deployment that needs a new capability adds it to security-policy.json;
 * that is a config edit, not a code change.
 */
export function knownCapabilities(root){
  const caps=new Set(Object.values(GATE_CAPABILITIES));
  const sec=readJson(path.join(root,'policies','security-policy.json'));
  for(const c of sec.human_approval_required||[])caps.add(c);
  const tools=readJson(path.join(root,'config','tools.json')).tools||{};
  for(const [id,def] of Object.entries(tools)){
    if(def?.risk==='privileged'||def?.risk==='irreversible')caps.add(id);
  }
  const stage=readJson(path.join(root,'policies','stage-policy.json'));
  for(const [token,authority] of Object.entries(stage.evidence_authority||{})){
    if(authority==='human')caps.add(token);
  }
  return [...caps].sort();
}

/**
 * Refuse a capability nothing reads. `recordApproval` already refuses a
 * wildcard and an untrusted authority outright rather than auditing the
 * mistake afterwards; an unconsumed name belongs in the same category.
 */
export function assertKnownCapability(root,capability){
  const known=knownCapabilities(root);
  if(known.includes(capability))return capability;
  throw new Error(`unknown capability ${capability}: no gate or policy consumes it. Valid capabilities are ${known.join(', ')}. To add one, list it under human_approval_required in policies/security-policy.json.`);
}

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
  assertKnownCapability(root,capability);
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
export function activeCapabilities(root,run){
  const known=new Set(knownCapabilities(root));
  const caps=new Set((run?.approvals||[]).map(a=>a.capability||a.approval).filter(Boolean));
  return [...caps].filter(c=>known.has(c)&&findValidApproval(run,c));
}

/**
 * Validation on the write path cannot speak for a record that was already
 * stored: a run written before the registry existed, or a hand-edited
 * `.agent-sdlc/runs/*.json`, still holds whatever name it was given. Read as
 * ACTIVE, such a record is indistinguishable from a real grant. So the
 * registry is re-checked here, on the read, and an unconsumed name is reported
 * as what it is.
 *
 * The record itself is left alone. Deleting it would tidy the display and
 * destroy the audit trail that makes the orphan discoverable in the first
 * place.
 */
export function approvalStatus(a,known){
  const capability=a.capability||a.approval;
  if(known&&!known.has(capability))return 'UNKNOWN_CAPABILITY';
  if(a.revoked_at)return 'REVOKED';
  if(a.expires_at&&a.expires_at<=now())return 'EXPIRED';
  return 'ACTIVE';
}

export function listApprovals(root,run){
  const known=new Set(knownCapabilities(root));
  return (run.approvals||[]).map(a=>({...a,status:approvalStatus(a,known)}));
}

export function requestApprovalTicket(root,projectRoot,run,{capability,reason=null,expiresInMinutes=60}={}){
  if(!capability)throw new Error('capability is required');
  assertKnownCapability(root,capability);
  const currentRun=loadRun(projectRoot,run.run_id);
  const ticketId=uuid('ticket');
  const expiresAt=new Date(Date.now()+Number(expiresInMinutes)*60000).toISOString();
  const ticket={
    ticket_id:ticketId,
    capability,
    reason,
    status:'PENDING',
    requested_at:now(),
    expires_at:expiresAt,
    decision_at:null,
    actor:null
  };
  currentRun.approval_tickets=[...(currentRun.approval_tickets||[]),ticket];
  saveRun(projectRoot,currentRun);
  run.approval_tickets=currentRun.approval_tickets;
  run.revision=currentRun.revision;
  emit(projectRoot,currentRun,{type:'approval.ticket_requested',payload:{ticket_id:ticketId,capability}});
  return ticket;
}

export function grantApprovalTicket(root,projectRoot,run,{ticketId,actor='USER_INTERACTIVE',reason=null}={}){
  const currentRun=loadRun(projectRoot,run.run_id);
  const tickets=currentRun.approval_tickets||[];
  const t=tickets.find(x=>x.ticket_id===ticketId);
  if(!t)throw new Error(`approval ticket not found: ${ticketId}`);
  if(t.status!=='PENDING')throw new Error(`approval ticket is ${t.status}, not PENDING`);

  const rec=recordApproval(root,projectRoot,currentRun,{
    capability:t.capability,
    authority:'USER_INTERACTIVE',
    actor,
    reason:reason||t.reason||'Granted interactive ticket',
    expiresAt:t.expires_at
  });

  t.status='GRANTED';
  t.decision_at=now();
  t.actor=actor;
  saveRun(projectRoot,currentRun);
  run.approvals=currentRun.approvals;
  run.approval_tickets=currentRun.approval_tickets;
  run.revision=currentRun.revision;
  return rec;
}

export function listApprovalTickets(run){
  return (run.approval_tickets||[]).map(t=>({
    ...t,
    is_expired:t.expires_at?t.expires_at<=now():false
  }));
}
