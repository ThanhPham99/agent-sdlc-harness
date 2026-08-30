#!/usr/bin/env node
// Test suite for Terminal UI (TUI) Dashboard renderer.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {renderTuiDashboard} from '../runtime/tui.mjs';
import {commands} from '../runtime/commands/dashboard.mjs';
import {initProject} from '../runtime/store.mjs';
import {newRun} from '../runtime/orchestrator.mjs';
import {route} from '../runtime/router.mjs';
import {createSuite} from './lib/suite.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const {test,assert,finish}=createSuite('agent-sdlc/tui-validation/v1','TUI-VALIDATION.json');

function fixture(){
  const d=fs.mkdtempSync(path.join(os.tmpdir(),'agent-sdlc-tui-'));
  execFileSync('git',['init','-q'],{cwd:d});
  fs.writeFileSync(path.join(d,'README.md'),'fixture\n');
  execFileSync('git',['add','.'],{cwd:d});
  execFileSync('git',['-c','user.email=test@test.local','-c','user.name=Tester','commit','-qm','init'],{cwd:d});
  initProject(d,{
    schema:'agent-sdlc/project/v1',
    project:'tui-fixture',
    commands:{test_full:['node','-e','process.exit(0)']},
    context:{project_invariants:['do not edit generated files']}
  });
  return d;
}

await test('renderTuiDashboard-renders-boxes-and-title',()=>{
  const output=renderTuiDashboard({
    project:{project:'tui-demo'},
    version:'3.0.0-alpha6',
    runs:[],
    tasks:[]
  });
  assert(output.includes('Agent SDLC Terminal Dashboard'),'missing title in TUI');
  assert(output.includes('tui-demo'),'missing project name in TUI');
  assert(output.includes('Pipeline:'),'missing pipeline in TUI');
});

await test('renderTuiDashboard-renders-tasks-and-stats',()=>{
  const tasks=[
    {task_id:'TASK-001',status:'DONE',title:'Init core'},
    {task_id:'TASK-002',status:'RUNNING',title:'Implement UI'}
  ];
  const output=renderTuiDashboard({
    project:{project:'demo'},
    version:'3.0.0',
    runs:[{run_id:'run_123',state:'IMPLEMENT'}],
    tasks,
    metrics:{tasks:{total_tokens:54200,total_cost_usd:0.12}}
  });
  assert(output.includes('TASK-001'),'missing TASK-001 in TUI');
  assert(output.includes('[DONE]'),'missing DONE status in TUI');
  assert(output.includes('TASK-002'),'missing TASK-002 in TUI');
  assert(output.includes('54,200'),'missing tokens in TUI');
});

await test('dashboard-command-tui-flag',async ()=>{
  const d=fixture();
  let printed=null;
  const ctx={
    ROOT,
    projectRoot:d,
    args:{tui:true},
    print:msg=>{printed=msg;}
  };
  await commands.dashboard(ctx);
  assert(printed&&printed.status==='TUI_RENDERED','command tui flag failed');
});

finish();