// Per-task verification evidence.
//
// A task cannot become DONE on a worker's self-claim. This module produces the
// replacement: an agent-sdlc/task-verification/v1 record bound to a base
// revision and a workspace diff hash, listing the commands actually executed
// and their exit codes.
//
// Escalation ladder: nearest targeted test -> affected integration/contract
// tests -> a broader suite only when policy or risk requires it.
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {now,readJson,truncateUtf8} from './util.mjs';
import {putArtifact,emitTaskEvent,saveTask} from './store.mjs';
import {workspaceDiff,getTaskWorkspace} from './workspace.mjs';

const arr=x=>Array.isArray(x)?x:[];
const norm=p=>String(p||'').replace(/\\/g,'/').replace(/^\.\//,'').replace(/\/+$/,'');

export function environmentFingerprint(){
  return {platform:process.platform,arch:process.arch,node:process.version,kernel:os.release()};
}

/** Which strategy this task's risk and category justify. */
export function verificationStrategy(task,{escalate=false}={}){
  if(escalate)return 'BROAD_SUITE';
  if(task.category==='integration')return 'AFFECTED_INTEGRATION';
  if(task.risk?.security==='HIGH'||task.risk?.destructive_data_change===true)return 'AFFECTED_INTEGRATION';
  if(arr(task.scope?.interfaces).length)return 'AFFECTED_INTEGRATION';
  return 'TARGETED';
}

/** Which project commands a strategy runs, in order. */
export function plannedCommands(projectRoot,task,strategy){
  const cfg=readJson(path.join(projectRoot,'.agent-sdlc','project.json'),{});
  const out=[];
  const targeted=arr(cfg.commands?.test_targeted);
  const full=arr(cfg.commands?.test_full);
  const build=arr(cfg.commands?.build);
  if(targeted.length)out.push({kind:'test_targeted',command:targeted});
  if(strategy!=='TARGETED'&&build.length)out.push({kind:'build',command:build});
  if(strategy==='BROAD_SUITE'&&full.length)out.push({kind:'test_full',command:full});
  if((task.risk?.security==='HIGH'||arr(task.scope?.interfaces).length)&&strategy!=='TARGETED'){
    out.push({kind:'security_secret_scan',command:['git','grep','-l','-E','(AKIA[0-9A-Z]{16}|BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY)']});
  }
  return out;
}

/** Paths a task changed that its approved write scope does not cover. */
export function scopeAudit(task,changedPaths){
  const allowed=arr(task.scope?.write).map(norm);
  const forbidden=arr(task.scope?.forbidden).map(norm);
  const covered=p=>allowed.some(a=>{
    const stem=a.split(/[*?]/)[0].replace(/\/+$/,'');
    return p===a||p===stem||(stem&&p.startsWith(stem+'/'));
  });
  const hitsForbidden=p=>forbidden.some(f=>{
    const stem=f.split(/[*?]/)[0].replace(/\/+$/,'');
    return p===f||p===stem||(stem&&p.startsWith(stem+'/'));
  });
  const paths=arr(changedPaths).map(norm);
  const out_of_scope_paths=paths.filter(p=>!covered(p)||hitsForbidden(p));
  return {changed_paths:paths,out_of_scope_paths,respected:out_of_scope_paths.length===0};
}

/**
 * Execute the planned verification for one task attempt and persist the
 * evidence record. Raw logs go to the artifact store; only summaries travel.
 */
export function verifyTask(root,projectRoot,run,task,{escalate=false,timeoutMs=180000,commands=null,dryRun=false}={}){
  const ws=getTaskWorkspace(projectRoot,run.run_id,task.task_id);
  const cwd=ws?.root||projectRoot;
  const diff=ws?workspaceDiff(projectRoot,ws):{base_revision:task.base_revision,changed_paths:[],diff_hash:task.diff_hash,diff_available:false};
  const strategy=verificationStrategy(task,{escalate});
  const planned=commands||plannedCommands(projectRoot,task,strategy);
  const executed=[];
  let allPassed=true;

  for(const c of planned){
    if(dryRun){executed.push({...c,exit_code:null,duration_ms:0,log_ref:null,summary:'DRY_RUN'});continue;}
    const start=Date.now();
    const r=spawnSync(c.command[0],c.command.slice(1),{cwd,encoding:'utf8',timeout:timeoutMs,maxBuffer:20*1024*1024});
    const raw=(r.stdout||'')+(r.stderr||'');
    // `git grep -l` exits 1 when nothing matched, which is the clean outcome.
    const exit=c.kind==='security_secret_scan'?(r.status===1?0:(r.status===0?1:r.status??1)):(r.status??1);
    const t=truncateUtf8(raw,4000);
    let log_ref=null;
    if(raw&&(exit!==0||t.truncated)){
      log_ref=putArtifact(projectRoot,{kind:'task-verification-log',content:raw,runId:run.run_id,stage:run.state,filename:`${task.task_id}-${c.kind}.log`}).artifact_id;
    }
    if(exit!==0)allPassed=false;
    executed.push({kind:c.kind,command:c.command,exit_code:exit,duration_ms:Date.now()-start,log_ref,summary:t.text||null});
  }

  const scope=scopeAudit(task,diff.changed_paths);
  // A task that must change behaviour but produced no diff has not been verified.
  const noWork=task.changes_behavior!==false&&arr(task.scope?.write).length>0&&!diff.changed_paths.length;
  const status=dryRun?'PENDING':(!executed.length?'BLOCKED':(allPassed&&scope.respected&&!noWork?'PASS':'FAIL'));
  const reason=dryRun?'DRY_RUN'
    :!executed.length?'NO_VERIFICATION_COMMANDS_CONFIGURED'
    :!scope.respected?'SCOPE_VIOLATION'
    :noWork?'NO_CHANGE_CAPTURED'
    :allPassed?null:'COMMAND_FAILED';

  const evidence={
    schema:'agent-sdlc/task-verification/v1',
    task_id:task.task_id,
    run_id:run.run_id,
    attempt:task.attempt||0,
    base_revision:diff.base_revision??null,
    diff_hash:diff.diff_hash??null,
    strategy,
    commands:executed.length?executed:[{kind:'custom',command:['(none configured)'],exit_code:null,duration_ms:0,log_ref:null,summary:'no project verification command available'}],
    tests:{
      passed:executed.filter(c=>c.kind.startsWith('test')&&c.exit_code===0).length,
      failed:executed.filter(c=>c.kind.startsWith('test')&&c.exit_code!==0&&c.exit_code!==null).length,
      skipped:0,
      failing_names:[]
    },
    build:executed.some(c=>c.kind==='build')
      ?{required:true,status:executed.find(c=>c.kind==='build').exit_code===0?'PASS':'FAIL'}
      :{required:false,status:'SKIPPED'},
    security:executed.some(c=>c.kind.startsWith('security'))
      ?{required:true,status:executed.filter(c=>c.kind.startsWith('security')).every(c=>c.exit_code===0)?'PASS':'FAIL',new_high_findings:executed.filter(c=>c.kind.startsWith('security')&&c.exit_code!==0).length}
      :{required:false,status:'SKIPPED',new_high_findings:0},
    scope,
    environment:environmentFingerprint(),
    status,
    reason,
    artifact_refs:executed.map(c=>c.log_ref).filter(Boolean),
    recorded_at:now()
  };

  const ref=putArtifact(projectRoot,{
    kind:'task-verification',
    content:JSON.stringify(evidence,null,2)+'\n',
    runId:run.run_id,stage:run.state,sourceRevision:evidence.base_revision,
    filename:`${task.task_id}-verification-attempt${evidence.attempt}.json`
  }).artifact_id;

  task.base_revision=evidence.base_revision??task.base_revision;
  task.diff_hash=evidence.diff_hash??task.diff_hash;
  task.evidence_refs=[...new Set([...(task.evidence_refs||[]),ref])];
  saveTask(projectRoot,task);
  emitTaskEvent(projectRoot,task,{
    type:status==='PASS'?'task.verified':'task.verification_failed',
    artifact_refs:[ref],
    payload:{status,reason,strategy,diff_hash:evidence.diff_hash,out_of_scope:scope.out_of_scope_paths}
  });
  if(!scope.respected){
    emitTaskEvent(projectRoot,task,{type:'task.scope_violation',payload:{out_of_scope_paths:scope.out_of_scope_paths}});
  }
  return {evidence,artifact_ref:ref};
}
