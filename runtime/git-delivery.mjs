// Git / PR delivery state, bound to exact revisions.
//
// The point of this module is to stop PR and CI state from masquerading as
// feature state. `PR_READY` is not `MERGED`. A green CI run on an older
// revision is not evidence about the current one. Target-base drift is a
// re-impact trigger, not a detail.
import path from 'node:path';
import {git,gitSha,now,readJson,writeJson} from './util.mjs';
import {stateDir} from './store.mjs';
import {loadCiEvidence} from './ci-evidence.mjs';

export const DELIVERY_TARGETS=['PR_READY','MERGED','RELEASE_READY'];
const arr=x=>Array.isArray(x)?x:[];
const recordPath=(projectRoot,runId)=>path.join(stateDir(projectRoot),'delivery',`${runId}.json`);

export function loadDelivery(projectRoot,runId){
  const p=recordPath(projectRoot,runId);
  try{return readJson(p);}catch{return null;}
}

/** One bounded writer branch per independent work item, by default. */
export function branchFor(runId,taskId=null){
  const base=`agent-sdlc/${String(runId).replace(/^run_/,'')}`;
  return taskId?`${base}/${String(taskId).toLowerCase()}`:base;
}

const PROTECTED=[/^main$/,/^master$/,/^release\/.+/,/^prod(uction)?$/,/^develop$/];
export function isProtectedBranch(name){return PROTECTED.some(p=>p.test(String(name||'')));}

/**
 * Push authorization. Protected branches are denied by default and no policy
 * flag in this function can grant it — that decision belongs to an operator
 * approval recorded on the run, which the caller must pass explicitly.
 */
export function checkPushTarget(branch,{approvals=[]}={}){
  if(!isProtectedBranch(branch))return {decision:'ALLOW',reason:'UNPROTECTED_BRANCH',branch};
  const approved=arr(approvals).some(a=>a==='git.push_protected');
  return approved
    ?{decision:'APPROVAL_RECORDED',reason:'PROTECTED_BRANCH_WITH_EXPLICIT_APPROVAL',branch}
    :{decision:'DENY',reason:'PROTECTED_BRANCH_PUSH_DENIED_BY_DEFAULT',branch};
}

/** Base drift: has the target base moved since the revision we verified on? */
export function baseDrift(projectRoot,{base='main',recordedBaseRevision=null}={}){
  const resolve=ref=>{const r=git(['rev-parse',ref],projectRoot);return r.code===0?r.stdout.trim():null;};
  const current=resolve(base)||resolve(`origin/${base}`);
  if(!recordedBaseRevision||!current){
    return {available:!!current,drifted:false,reason:current?'NO_RECORDED_BASE':'BASE_REF_UNAVAILABLE',
      recorded:recordedBaseRevision,current};
  }
  if(current===recordedBaseRevision)return {available:true,drifted:false,recorded:recordedBaseRevision,current};
  const ahead=git(['rev-list','--count',`${recordedBaseRevision}..${current}`],projectRoot);
  return {available:true,drifted:true,recorded:recordedBaseRevision,current,
    commits_ahead:ahead.code===0?Number(ahead.stdout.trim()):null,
    action:'RE_IMPACT_AND_REVERIFY'};
}

/**
 * Record delivery readiness for a run. `target` is a claim the record must be
 * able to justify: MERGED requires an observed merge commit, never a prepared PR.
 */
export function recordDelivery(projectRoot,run,{
  target='PR_READY',branch=null,base='main',recordedBaseRevision=null,
  taskBranches=[],stacked=[],ciEvidence=undefined,mergeCommit=null,approvals=[]
}={}){
  if(!DELIVERY_TARGETS.includes(target))throw new Error(`unknown delivery target ${target}`);
  // Default to the run's recorded CI evidence rather than treating an omitted
  // argument as "no CI ran": the caller shouldn't have to remember to pass it.
  if(ciEvidence===undefined)ciEvidence=loadCiEvidence(projectRoot,run.run_id);
  const head=gitSha(projectRoot);
  const resolvedBranch=branch||branchFor(run.run_id);
  const drift=baseDrift(projectRoot,{base,recordedBaseRevision});
  const push=checkPushTarget(resolvedBranch,{approvals});
  const problems=[];

  if(!head)problems.push('NO_HEAD_REVISION');
  if(drift.drifted)problems.push('TARGET_BASE_DRIFTED');
  if(ciEvidence&&ciEvidence.revision&&head&&ciEvidence.revision!==head)problems.push('CI_EVIDENCE_REVISION_MISMATCH');
  if(ciEvidence&&ciEvidence.status!=='PASS')problems.push(`CI_${ciEvidence.status||'UNKNOWN'}`);
  if(!ciEvidence)problems.push('NO_CI_EVIDENCE');
  if(target==='MERGED'&&!mergeCommit)problems.push('MERGED_CLAIMED_WITHOUT_MERGE_COMMIT');
  if(target==='RELEASE_READY'&&!mergeCommit)problems.push('RELEASE_READY_WITHOUT_MERGE');

  // Stacked work has an explicit order; an implicit one is how stacks break.
  const stackOrder=arr(stacked).map((s,i)=>({position:i+1,branch:s.branch??s,depends_on:s.depends_on??null}));
  const undeclared=stackOrder.filter(s=>s.position>1&&!s.depends_on);
  if(undeclared.length)problems.push('STACKED_DEPENDENCY_ORDER_NOT_EXPLICIT');

  const record={
    schema:'agent-sdlc/delivery-record/v1',
    run_id:run.run_id,
    // The achieved target is never more than the evidence supports.
    claimed_target:target,
    achieved_target:problems.length?null:target,
    status:problems.length?'BLOCKED':'READY',
    branch:resolvedBranch,
    base,
    head_revision:head,
    base_drift:drift,
    push_authorization:push,
    task_branches:arr(taskBranches),
    stacked:stackOrder,
    ci_evidence:ciEvidence?{revision:ciEvidence.revision,status:ciEvidence.status,ref:ciEvidence.artifact_ref??null}:null,
    merge_commit:mergeCommit??null,
    problems,
    recorded_at:now()
  };
  writeJson(recordPath(projectRoot,run.run_id),record);
  return record;
}

/**
 * Group task branches into one delivery unit only when policy allows: same
 * module boundary, no interface change, and a declared dependency chain.
 */
export function groupTaskBranches(tasks,{allowInterfaceGrouping=false}={}){
  const groups=[];const singles=[];
  const byModule=new Map();
  for(const t of arr(tasks)){
    const iface=arr(t.scope?.interfaces).length>0;
    const destructive=t.risk?.destructive_data_change===true||t.category==='migration';
    if((iface&&!allowInterfaceGrouping)||destructive){singles.push(t.task_id);continue;}
    const mod=arr(t.scope?.modules)[0]||'(unknown)';
    if(!byModule.has(mod))byModule.set(mod,[]);
    byModule.get(mod).push(t);
  }
  for(const [mod,list] of byModule){
    if(list.length===1){singles.push(list[0].task_id);continue;}
    const ids=list.map(t=>t.task_id);
    const chained=list.every(t=>arr(t.depends_on).some(d=>ids.includes(d))||t.task_id===ids[0]);
    if(chained)groups.push({module:mod,tasks:ids,reason:'SAME_MODULE_DECLARED_CHAIN'});
    else singles.push(...ids);
  }
  return {
    schema:'agent-sdlc/branch-grouping/v1',
    groups,
    single_branches:[...new Set(singles)].sort(),
    reason:'interface-changing, migration and unchained work each get their own bounded branch'
  };
}
