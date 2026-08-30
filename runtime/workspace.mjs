// Task workspace abstraction.
//
// The scheduler must not know how a host isolates a writer. It asks for a
// workspace; this module decides between:
//
//   shared-readonly    the project tree, no writes (investigators, reviewers)
//   isolated-worktree  a git worktree on a task branch (the default writer mode)
//   provider-sandbox   the host provides isolation; we only record the binding
//
// Rules enforced here:
// - a writer task gets exactly one writable workspace;
// - two writer agents never share the same moving worktree;
// - evidence binds to base SHA + workspace diff hash;
// - cleanup refuses to run while evidence is unpersisted;
// - production credentials never become ambient writer workspace credentials.
import fs from 'node:fs';
import path from 'node:path';
import {ensureDir,git,gitSha,now,readJson,sha256,untrackedDigest,untrackedFiles,writeJson} from './util.mjs';
import {stateDir,emitTaskEvent} from './store.mjs';

export const WORKSPACE_MODES=['shared-readonly','isolated-worktree','provider-sandbox'];

const wsRoot=projectRoot=>path.join(stateDir(projectRoot),'workspaces');
const wsRecordPath=(projectRoot,runId,taskId)=>path.join(wsRoot(projectRoot),runId,`${taskId}.json`);
export const taskBranch=(runId,taskId)=>`agent-sdlc/${String(runId).replace(/^run_/,'')}/${taskId.toLowerCase()}`;

function record(projectRoot,runId,taskId){
  const p=wsRecordPath(projectRoot,runId,taskId);
  return fs.existsSync(p)?readJson(p):null;
}

export function getTaskWorkspace(projectRoot,runId,taskId){return record(projectRoot,runId,taskId);}

/**
 * Credentials a writer workspace may see. Production and deploy secrets are
 * stripped: a bounded implementation task has no business holding them, and an
 * ambient credential is the one thing a sandbox cannot take back.
 */
export function scrubbedEnv(env=process.env){
  const denied=/(^|_)(PROD|PRODUCTION|DEPLOY|RELEASE)_?(TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL|CREDENTIALS)$|^AWS_SESSION_TOKEN$|^KUBE_TOKEN$/i;
  const out={};const removed=[];
  for(const [k,v] of Object.entries(env)){
    if(denied.test(k)){removed.push(k);continue;}
    out[k]=v;
  }
  return {env:out,removed};
}

/**
 * Create (or return) the single workspace bound to one task. Binding is
 * idempotent per task; a second writer for the same task is refused.
 */
export function createTaskWorkspace(projectRoot,{run,task,writer=null,mode=null,allowDirty=false}){
  const runId=run.run_id;
  const existing=record(projectRoot,runId,task.task_id);
  const resolvedMode=mode||task.execution?.workspace_mode||(task.scope?.write?.length?'isolated-worktree':'shared-readonly');
  if(!WORKSPACE_MODES.includes(resolvedMode))throw new Error(`unknown workspace mode ${resolvedMode}`);
  const resolvedWriter=writer||task.execution?.primary_writer||null;

  if(existing){
    if(existing.writable&&resolvedWriter&&existing.writer&&existing.writer!==resolvedWriter){
      throw new Error(`task ${task.task_id} already bound to primary writer ${existing.writer}; one task has exactly one writer`);
    }
    return {...existing,reused:true};
  }
  if(resolvedMode!=='shared-readonly'&&!resolvedWriter){
    throw new Error(`a writable workspace for ${task.task_id} requires a primary writer`);
  }

  const base=gitSha(projectRoot);
  const ws={
    schema:'agent-sdlc/task-workspace/v1',
    run_id:runId,
    task_id:task.task_id,
    mode:resolvedMode,
    writable:resolvedMode!=='shared-readonly',
    writer:resolvedWriter,
    base_revision:base,
    branch:null,
    root:projectRoot,
    credentials_scrubbed:[],
    created_at:now(),
    cleaned_at:null,
    checkpoints:[],
    status:'ACTIVE',
    reused:false
  };

  if(resolvedMode==='isolated-worktree'){
    const dir=path.join(wsRoot(projectRoot),runId,`${task.task_id}-tree`);
    const branch=taskBranch(runId,task.task_id);
    ensureDir(path.dirname(dir));
    if(!base){
      // No commit to branch from: fall back honestly rather than pretending isolation.
      ws.mode='shared-readonly';ws.writable=false;
      ws.degraded='NO_BASE_REVISION_AVAILABLE';
    }else{
      // Uncommitted tracked changes do not block isolation — a worktree at the
      // base revision is still the honest thing to branch from. What they do
      // affect is what the workspace can see, so record the exclusion instead
      // of silently dropping isolation.
      // Untracked included: `uncommitted_changes_excluded` is what the worktree
      // cannot see, and a file that exists only in the project root is exactly
      // as invisible from a tree at the base revision as an unstaged edit is.
      // `.agent-sdlc/` is the harness's own state, not work being excluded.
      const modified=git(['status','--porcelain','--untracked-files=all'],projectRoot).stdout
        .split('\n').map(l=>l.trim()).filter(Boolean)
        .filter(l=>!/^\?\?\s+\.agent-sdlc\//.test(l)).join('\n');
      const existingBranch=git(['branch','--list',branch],projectRoot);
      const branchExists=existingBranch.code===0&&existingBranch.stdout.trim().length>0;
      const worktreeArgs=branchExists
        ?['worktree','add',dir,branch]
        :['worktree','add','-b',branch,dir,base];
      const r=git(worktreeArgs,projectRoot);
      if(r.code!==0){
        ws.mode='provider-sandbox';ws.writable=true;ws.root=projectRoot;
        ws.degraded=`WORKTREE_UNAVAILABLE:${(r.stderr||'').trim().slice(0,200)}`;
      }else{
        ws.root=dir;ws.branch=branch;
        if(modified&&!allowDirty)ws.uncommitted_changes_excluded=modified.split('\n').length;
      }
    }
  }
  ws.credentials_scrubbed=ws.writable?scrubbedEnv().removed:[];
  writeJson(wsRecordPath(projectRoot,runId,task.task_id),ws);
  emitTaskEvent(projectRoot,task,{type:'task.workspace_created',payload:{mode:ws.mode,writable:ws.writable,branch:ws.branch,degraded:ws.degraded??null,base_revision:ws.base_revision}});
  return ws;
}

/** Diff of the workspace against its base revision, plus a stable hash. */
export function workspaceDiff(projectRoot,ws){
  const cwd=ws.root||projectRoot;
  const base=ws.base_revision;
  const diff=base?git(['diff','--binary',base],cwd):git(['diff','--binary'],cwd);
  const namesRaw=base?git(['diff','--name-only',base],cwd):git(['diff','--name-only'],cwd);
  // Listed once and reused for both the path list and the content digest.
  const untrackedList=untrackedFiles(cwd)??[];
  const changed=[...new Set([
    ...namesRaw.stdout.split('\n').map(s=>s.trim()).filter(Boolean),
    ...untrackedList
  ])].sort();
  return {
    base_revision:base,
    changed_paths:changed,
    // The untracked digest, not just the untracked NAMES: `git diff` never
    // shows a file that was created and never staged, so without it a task
    // could rewrite every module it added and keep the same binding.
    diff_hash:diff.code===0?sha256(diff.stdout+changed.join('\n')+'\n'+untrackedDigest(cwd,untrackedList)):null,
    diff_available:diff.code===0
  };
}

/** A named checkpoint binds evidence to a base SHA and a diff hash. */
export function checkpointTaskWorkspace(projectRoot,{run,task,label='checkpoint'}){
  const ws=record(projectRoot,run.run_id,task.task_id);
  if(!ws)throw new Error(`no workspace for ${task.task_id}`);
  const d=workspaceDiff(projectRoot,ws);
  const cp={label,time:now(),base_revision:d.base_revision,diff_hash:d.diff_hash,changed_paths:d.changed_paths};
  ws.checkpoints=[...(ws.checkpoints||[]),cp];
  writeJson(wsRecordPath(projectRoot,run.run_id,task.task_id),ws);
  return cp;
}

/**
 * Remove the workspace. Refuses while the task still has no persisted evidence,
 * unless the caller explicitly accepts losing it.
 */
export function cleanupTaskWorkspace(projectRoot,{run,task,evidencePersisted=null,force=false}){
  const ws=record(projectRoot,run.run_id,task.task_id);
  if(!ws)return {status:'NO_WORKSPACE'};
  const hasEvidence=evidencePersisted??((task.evidence_refs||[]).length>0||(ws.checkpoints||[]).length>0);
  if(ws.writable&&!hasEvidence&&!force){
    return {status:'REFUSED_EVIDENCE_NOT_PERSISTED',workspace:ws};
  }
  if(ws.mode==='isolated-worktree'&&ws.root&&ws.root!==projectRoot&&fs.existsSync(ws.root)){
    const r=git(['worktree','remove','--force',ws.root],projectRoot);
    if(r.code!==0)try{fs.rmSync(ws.root,{recursive:true,force:true});}catch{}
  }
  ws.status='CLEANED';ws.cleaned_at=now();
  writeJson(wsRecordPath(projectRoot,run.run_id,task.task_id),ws);
  emitTaskEvent(projectRoot,task,{type:'task.workspace_cleaned',payload:{mode:ws.mode,branch:ws.branch,checkpoints:(ws.checkpoints||[]).length}});
  return {status:'CLEANED',workspace:ws};
}

/** Every workspace bound in one run; used to assert the one-writer invariant. */
export function listTaskWorkspaces(projectRoot,runId){
  const d=path.join(wsRoot(projectRoot),runId);
  if(!fs.existsSync(d))return [];
  return fs.readdirSync(d).filter(x=>x.endsWith('.json')).sort().map(x=>readJson(path.join(d,x)));
}

/** Fails when two active writable workspaces share a root or a writer. */
export function checkWriterIsolation(projectRoot,runId){
  const active=listTaskWorkspaces(projectRoot,runId).filter(w=>w.status==='ACTIVE'&&w.writable);
  const violations=[];
  const byRoot=new Map();const byWriter=new Map();
  for(const w of active){
    const rootKey=path.resolve(w.root||'');
    if(byRoot.has(rootKey))violations.push({kind:'SHARED_WRITABLE_ROOT',tasks:[byRoot.get(rootKey),w.task_id],root:rootKey});
    else byRoot.set(rootKey,w.task_id);
    if(w.writer){
      if(byWriter.has(w.writer))violations.push({kind:'WRITER_BOUND_TO_TWO_TASKS',tasks:[byWriter.get(w.writer),w.task_id],writer:w.writer});
      else byWriter.set(w.writer,w.task_id);
    }
  }
  return {schema:'agent-sdlc/writer-isolation-check/v1',run_id:runId,active:active.length,violations,valid:violations.length===0};
}
