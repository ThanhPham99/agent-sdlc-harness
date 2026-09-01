#!/usr/bin/env node
// Test suite for Git Worktree isolation, commit, integration, and writer safety.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createTaskWorkspace,commitTaskWorkspace,integrateTaskWorkspace,cleanupTaskWorkspace,getTaskWorkspace,checkWriterIsolation} from '../runtime/workspace.mjs';
import {initProject} from '../runtime/store.mjs';
import {newRun} from '../runtime/orchestrator.mjs';
import {route} from '../runtime/router.mjs';
import {createSuite} from './lib/suite.mjs';
import {makeTempDir} from './lib/tempdir.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const {test,assert,finish}=createSuite('agent-sdlc/worktree-isolation-validation/v1','WORKTREE-ISOLATION-VALIDATION.json');

function fixture(){
  const d=makeTempDir('agent-sdlc-worktree-');
  execFileSync('git',['init','-q'],{cwd:d});
  fs.writeFileSync(path.join(d,'README.md'),'fixture\n');
  fs.writeFileSync(path.join(d,'src.js'),'export const base = 1;\n');
  execFileSync('git',['add','.'],{cwd:d});
  execFileSync('git',['-c','user.email=test@test.local','-c','user.name=Tester','commit','-qm','init'],{cwd:d});
  initProject(d,{
    schema:'agent-sdlc/project/v1',
    project:'worktree-fixture',
    commands:{test_full:['node','-e','process.exit(0)']},
    context:{project_invariants:['do not edit generated files']}
  });
  return d;
}

test('isolated-worktree-creation',()=>{
  const d=fixture();
  const r=route(ROOT,'Implement parallel auth and notify');
  const run=newRun(ROOT,d,{objective:'Implement parallel auth and notify',route:r});
  run.state='IMPLEMENT';

  const task={
    task_id:'TASK-001',
    goal:'Add auth store',
    scope:{write:['src/auth/store.js']}
  };

  const ws=createTaskWorkspace(d,{run,task,writer:'writer-auth'});
  assert(ws.mode==='isolated-worktree',`expected isolated-worktree, got ${ws.mode}`);
  assert(ws.writable===true,'expected writable workspace');
  assert(ws.root!==d,'expected dedicated worktree directory');
  assert(fs.existsSync(ws.root),'worktree directory does not exist');
  assert(ws.branch.includes('task-001'),`branch name mismatch: ${ws.branch}`);
});

test('parallel-worktrees-are-disjoint',()=>{
  const d=fixture();
  const r=route(ROOT,'Parallel tasks');
  const run=newRun(ROOT,d,{objective:'Parallel tasks',route:r});
  run.state='IMPLEMENT';

  const taskA={task_id:'TASK-A',goal:'Task A',scope:{write:['src/a.js']}};
  const taskB={task_id:'TASK-B',goal:'Task B',scope:{write:['src/b.js']}};

  const wsA=createTaskWorkspace(d,{run,task:taskA,writer:'writer-a'});
  const wsB=createTaskWorkspace(d,{run,task:taskB,writer:'writer-b'});

  assert(wsA.root!==wsB.root,'worktree roots must not overlap');
  assert(wsA.branch!==wsB.branch,'worktree branches must be distinct');

  const isolation=checkWriterIsolation(d,run.run_id);
  assert(isolation.valid===true,`isolation check failed: ${JSON.stringify(isolation.violations)}`);
  assert(isolation.active===2,'expected 2 active workspaces');
});

test('commitTaskWorkspace-persists-uncommitted-files',()=>{
  const d=fixture();
  const r=route(ROOT,'Commit test');
  const run=newRun(ROOT,d,{objective:'Commit test',route:r});
  run.state='IMPLEMENT';

  const task={task_id:'TASK-C1',goal:'Write new module',scope:{write:['src/module.js']}};
  const ws=createTaskWorkspace(d,{run,task,writer:'writer-c1'});

  // Write new file inside worktree
  fs.mkdirSync(path.join(ws.root,'src'),{recursive:true});
  fs.writeFileSync(path.join(ws.root,'src','module.js'),'export const hello = "world";\n');

  const res=commitTaskWorkspace(d,{run,task});
  assert(res.committed===true,'expected commit to succeed');
  assert(typeof res.commit_sha==='string'&&res.commit_sha.length>0,'missing commit SHA');

  const updatedWs=getTaskWorkspace(d,run.run_id,task.task_id);
  assert(updatedWs.commit_sha===res.commit_sha,'workspace record missing commit_sha');
});

test('integrateTaskWorkspace-merges-changes-into-root',()=>{
  const d=fixture();
  const r=route(ROOT,'Integrate test');
  const run=newRun(ROOT,d,{objective:'Integrate test',route:r});
  run.state='IMPLEMENT';

  const task={task_id:'TASK-INT',goal:'Add helper',scope:{write:['src/helper.js']}};
  const ws=createTaskWorkspace(d,{run,task,writer:'writer-int'});

  // Write file in worktree
  fs.mkdirSync(path.join(ws.root,'src'),{recursive:true});
  fs.writeFileSync(path.join(ws.root,'src','helper.js'),'export const helper = () => 42;\n');

  const intResult=integrateTaskWorkspace(d,{run,task});
  assert(intResult.integrated===true,`integration failed: ${intResult.output}`);

  // The helper file should now exist in the project root
  assert(fs.existsSync(path.join(d,'src','helper.js')),'integrated file missing in project root');
});

test('cleanupTaskWorkspace-auto-commits-on-cleanup',()=>{
  const d=fixture();
  const r=route(ROOT,'Cleanup test');
  const run=newRun(ROOT,d,{objective:'Cleanup test',route:r});
  run.state='IMPLEMENT';

  const task={task_id:'TASK-CLN',goal:'Cleanup test',scope:{write:['src/clean.js']}};
  const ws=createTaskWorkspace(d,{run,task,writer:'writer-cln'});

  // Write file in worktree
  fs.writeFileSync(path.join(ws.root,'clean.txt'),'cleanup test\n');

  const clnResult=cleanupTaskWorkspace(d,{run,task,force:true,autoCommit:true});
  assert(clnResult.status==='CLEANED','expected status CLEANED');
  assert(!fs.existsSync(ws.root),'worktree directory should be removed');

  const postWs=getTaskWorkspace(d,run.run_id,task.task_id);
  assert(typeof postWs.commit_sha==='string','commit_sha should be recorded before worktree removal');
});

finish();
