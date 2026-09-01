#!/usr/bin/env node
// Test suite for Parallel Task Execution Engine and batch partitioning.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {partitionParallelBatches,executeParallelBatches} from '../runtime/parallel.mjs';
import {initProject} from '../runtime/store.mjs';
import {newRun} from '../runtime/orchestrator.mjs';
import {route} from '../runtime/router.mjs';
import {createSuite} from './lib/suite.mjs';
import {makeTempDir} from './lib/tempdir.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const {test,assert,finish}=createSuite('agent-sdlc/parallel-execution-validation/v1','PARALLEL-EXECUTION-VALIDATION.json');

function fixture(){
  const d=makeTempDir('agent-sdlc-parallel-');
  execFileSync('git',['init','-q'],{cwd:d});
  fs.writeFileSync(path.join(d,'README.md'),'fixture\n');
  execFileSync('git',['add','.'],{cwd:d});
  execFileSync('git',['-c','user.email=test@test.local','-c','user.name=Tester','commit','-qm','init'],{cwd:d});
  initProject(d,{
    schema:'agent-sdlc/project/v1',
    project:'parallel-fixture',
    commands:{test_full:['node','-e','process.exit(0)']},
    context:{project_invariants:['do not edit generated files']}
  });
  return d;
}

await test('partitionParallelBatches-disjoint-tasks',()=>{
  const tasks=[
    {id:'T1',scope:{write:['src/auth/']}},
    {id:'T2',scope:{write:['src/ui/']}},
    {id:'T3',scope:{write:['src/api/']}}
  ];
  const batches=partitionParallelBatches(tasks);
  assert(batches.length===1,'disjoint tasks should all be in 1 batch');
  assert(batches[0].length===3,'batch 1 should have 3 tasks');
});

await test('partitionParallelBatches-conflicting-tasks',()=>{
  const tasks=[
    {id:'T1',scope:{write:['src/auth/login.js']}},
    {id:'T2',scope:{write:['src/auth/']}},
    {id:'T3',scope:{write:['src/ui/button.js']}},
    {id:'T4',scope:{write:['src/ui/']}}
  ];
  const batches=partitionParallelBatches(tasks);
  assert(batches.length===2,'conflicting tasks should be partitioned into 2 batches');
  assert(batches[0].length===2,'batch 1 should have 2 non-conflicting tasks');
  assert(batches[1].length===2,'batch 2 should have 2 non-conflicting tasks');
});

await test('executeParallelBatches-concurrent-execution',async ()=>{
  const d=fixture();
  const r=route(ROOT,'Parallel batch test');
  const run=newRun(ROOT,d,{objective:'Parallel batch test',route:r});
  run.state='IMPLEMENT';

  const tasks=[
    {task_id:'TASK-1',scope:{write:['src/a.js']}},
    {task_id:'TASK-2',scope:{write:['src/b.js']}}
  ];
  const batches=partitionParallelBatches(tasks);

  let executedCount=0;
  const runner=async ({task,writer})=>{
    executedCount++;
    return {task_id:task.task_id,status:'DONE',writer};
  };

  const res=await executeParallelBatches(d,{run,batches,workerRunner:runner,maxWorkers:2});
  assert(res.batches_count===1,'expected 1 batch');
  assert(res.total_tasks===2,'expected 2 total tasks');
  assert(executedCount===2,'expected 2 tasks executed');
  assert(res.results.every(r=>r.status==='DONE'),'all tasks should succeed');
});

finish();