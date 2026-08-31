#!/usr/bin/env node
// Test suite for expanded CLI commands, rewind engine, PR generator, webhook delivery, and edge-cases.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createSuite} from './lib/suite.mjs';
import {initProject,loadRun,saveRun,loadState,listTasks,saveTask,saveTaskGraph,stateDir} from '../runtime/store.mjs';
import {writeJson} from '../runtime/util.mjs';
import {newRun,transition} from '../runtime/orchestrator.mjs';
import {route} from '../runtime/router.mjs';
import {rewindRun} from '../runtime/rewind.mjs';
import {generatePrBody,generateChangelog,generateSemanticReleaseNotes} from '../runtime/pr-generator.mjs';
import {sendWebhook,sendWebhookWithRetry,testWebhook,computeWebhookSignature,getWebhookDeliveries,matchesPattern,dispatchWebhooks} from '../runtime/webhook.mjs';
import {normalizeInput} from '../runtime/normalize.mjs';
import {commands as projectCmds} from '../runtime/commands/project.mjs';
import {commands as deliveryCmds} from '../runtime/commands/delivery.mjs';
import {commands as repoCmds} from '../runtime/commands/repo.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const {test,assert,finish}=createSuite('agent-sdlc/commands-expansion-validation/v1','COMMANDS-EXPANSION-VALIDATION.json');

function fixture(){
  const d=fs.mkdtempSync(path.join(os.tmpdir(),'agent-sdlc-cmd-exp-'));
  execFileSync('git',['init','-q'],{cwd:d});
  fs.writeFileSync(path.join(d,'README.md'),'# Fixture\n');
  fs.writeFileSync(path.join(d,'.gitignore'),'dist/\nnode_modules/\n');
  execFileSync('git',['add','.'],{cwd:d});
  execFileSync('git',['-c','user.email=test@test.local','-c','user.name=Tester','commit','-qm','init'],{cwd:d});
  initProject(d,{
    schema:'agent-sdlc/project/v1',
    project:'cmd-exp-fixture',
    commands:{test_full:['node','-e','process.exit(0)']},
    context:{project_invariants:['invariant-1']}
  });
  return d;
}

await test('commands-project-doctor-fix-appends-tmp-to-gitignore',async ()=>{
  const d=fixture();
  let output=null;
  await projectCmds.doctor({
    ROOT,
    projectRoot:d,
    args:{fix:true},
    print:data=>{output=data;}
  });
  assert(output&&output.fixes_applied,'doctor output missing fixes_applied');
  assert(output.fixes_applied.includes('APPENDED_.tmp/_TO_.gitignore'),'did not append .tmp/ to .gitignore');
  const gi=fs.readFileSync(path.join(d,'.gitignore'),'utf8');
  assert(gi.includes('.tmp/'),'.gitignore does not have .tmp/');
});

await test('commands-project-knowledge-and-gc-and-webhook',async ()=>{
  const d=fixture();
  let kOut=null;
  await projectCmds.knowledge({
    args:{_:[ 'knowledge','status' ]},
    projectRoot:d,
    print:data=>{kOut=data;}
  });
  assert(kOut&&kOut.schema==='agent-sdlc/project-knowledge-status/v1','knowledge status failed');

  let gcOut=null;
  await projectCmds.gc({
    args:{_:[ 'gc','status' ],'older-than-days':0},
    projectRoot:d,
    print:data=>{gcOut=data;}
  });
  assert(gcOut&&gcOut.schema==='agent-sdlc/gc-plan/v1','gc status failed');

  let gcApplyOut=null;
  await projectCmds.gc({
    args:{_:[ 'gc','apply' ],'older-than-days':0},
    projectRoot:d,
    print:data=>{gcApplyOut=data;}
  });
  assert(gcApplyOut&&gcApplyOut.schema==='agent-sdlc/gc-result/v1','gc apply failed');

  let whListOut=null;
  await projectCmds.webhook({
    args:{_:[ 'webhook','list' ]},
    projectRoot:d,
    print:data=>{whListOut=data;}
  });
  assert(whListOut&&Array.isArray(whListOut.webhooks),'webhook list failed');
});

await test('rewind-run-handles-stages-and-error-branches',async ()=>{
  const d=fixture();
  const r=route(ROOT,'Feature to test rewind');
  const run=newRun(ROOT,d,{objective:'Feature to test rewind',route:r});
  
  // Transition INTAKE -> REQUIREMENTS -> DESIGN
  transition(ROOT,d,run,'REQUIREMENTS',{evidence:['intake_valid'],internal:true});
  transition(ROOT,d,run,'DESIGN',{evidence:['requirements_confirmed'],internal:true});
  assert(run.state==='DESIGN','run should be in DESIGN stage');

  // Test rewind back to REQUIREMENTS
  const rewound=rewindRun(ROOT,d,run,{toStage:'REQUIREMENTS',preserveEvidence:false});
  assert(rewound.status==='REWOUND','rewind failed');
  assert(rewound.to_stage==='REQUIREMENTS','to_stage incorrect');
  assert(run.state==='REQUIREMENTS','run state not updated to REQUIREMENTS');

  // Test error: cannot rewind forward
  let forwardErr=null;
  try{
    rewindRun(ROOT,d,run,{toStage:'IMPLEMENT'});
  }catch(e){
    forwardErr=e;
  }
  assert(forwardErr&&forwardErr.message.includes('cannot rewind forward'),'failed to reject forward rewind');

  // Test error: invalid stage
  let invalidStageErr=null;
  try{
    rewindRun(ROOT,d,run,{toStage:'NON_EXISTENT_STAGE'});
  }catch(e){
    invalidStageErr=e;
  }
  assert(invalidStageErr&&invalidStageErr.message.includes('is not in workflow'),'failed to reject invalid stage');
});

await test('rewind-run-with-tasks-and-preserve-evidence',async ()=>{
  const d=fixture();
  const r=route(ROOT,'Test rewind with tasks');
  const run=newRun(ROOT,d,{objective:'Test rewind with tasks',route:r});

  saveTaskGraph(d,{
    schema:'agent-sdlc/task-graph/v1',
    run_id:run.run_id,
    tasks:[
      {task_id:'task-1',status:'DONE',title:'Task 1'},
      {task_id:'task-2',status:'IN_PROGRESS',title:'Task 2'}
    ]
  });

  const rewound=rewindRun(ROOT,d,run,{toStage:'INTAKE',toTaskId:'task-2',preserveEvidence:true});
  assert(rewound.status==='REWOUND','rewind with tasks failed');
  assert(rewound.to_task_id==='task-2','to_task_id incorrect');
});

await test('pr-generator-creates-pr-body-and-changelog-and-release-notes',async ()=>{
  const d=fixture();
  const r=route(ROOT,'PR Generator Test');
  const run=newRun(ROOT,d,{objective:'PR Generator Test',route:r});

  const tasksList=[
    {schema:'agent-sdlc/task/v1',run_id:run.run_id,task_id:'TASK-001',status:'DONE',title:'feat: add refund idempotency',category:'feature',scope:{write:['src/refund.js']}},
    {schema:'agent-sdlc/task/v1',run_id:run.run_id,task_id:'TASK-002',status:'DONE',title:'fix: resolve timeout leak',category:'bug',scope:{write:['src/leak.js']}},
    {schema:'agent-sdlc/task/v1',run_id:run.run_id,task_id:'TASK-003',status:'DONE',title:'perf: optimize graph traversal',category:'perf',scope:{write:['src/graph.js']}},
    {schema:'agent-sdlc/task/v1',run_id:run.run_id,task_id:'TASK-004',status:'DONE',title:'refactor: clean up storage logic',category:'refactor',scope:{write:['src/store.js']}},
    {schema:'agent-sdlc/task/v1',run_id:run.run_id,task_id:'TASK-005',status:'DONE',title:'update documentation and readme',category:'chore',scope:{write:['README.md']}}
  ];

  for(const t of tasksList)saveTask(d,t);

  saveTaskGraph(d,{
    schema:'agent-sdlc/task-graph/v1',
    run_id:run.run_id,
    tasks:tasksList
  });

  // Test Markdown PR Body
  const mdPr=generatePrBody(d,run,{format:'markdown'});
  assert(typeof mdPr==='string'&&mdPr.includes('## 🎯 Objective'),'pr body markdown invalid');
  assert(mdPr.includes('TASK-001'),'missing task TASK-001 in PR body');

  // Test JSON PR Body
  const jsonPr=generatePrBody(d,run,{format:'json'});
  assert(jsonPr&&jsonPr.schema==='agent-sdlc/pr-body/v1','pr body json schema invalid');
  assert(jsonPr.tasks_completed===5,'completed tasks count wrong');
  assert(jsonPr.affected_files.length>0,'affected files missing');

  // Test Changelog with categories
  const changelog=generateChangelog(d,{version:'3.0.0-rc1',tasks:tasksList});
  assert(changelog.includes('### 🚀 Features'),'changelog missing features section');
  assert(changelog.includes('### 🐛 Bug Fixes'),'changelog missing bug fixes section');
  assert(changelog.includes('### ⚡ Performance Improvements'),'changelog missing perf section');
  assert(changelog.includes('### ♻️ Refactoring & Chores'),'changelog missing refactor section');

  // Test Semantic Release Notes
  const relNotes=generateSemanticReleaseNotes(d,run,{version:'3.0.0-rc1',bumpType:'minor'});
  assert(relNotes.schema==='agent-sdlc/semantic-release-notes/v1','semantic release notes schema wrong');
  assert(relNotes.version==='3.0.0-rc1','release notes version wrong');
  assert(relNotes.badge_status==='VERIFIED_DETERMINISTIC','badge status incorrect');
});

await test('webhook-system-delivers-and-retries-and-records',async ()=>{
  let requestCount=0;
  let receivedSignature=null;
  const server=http.createServer((req,res)=>{
    requestCount++;
    receivedSignature=req.headers['x-agent-sdlc-signature'];
    if(requestCount===1){
      res.writeHead(500,{'Content-Type':'application/json'});
      res.end(JSON.stringify({error:'transient internal server error'}));
    }else{
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({ok:true}));
    }
  });

  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const port=server.address().port;
  const targetUrl=`http://127.0.0.1:${port}/webhook`;

  const d=fixture();
  const res=await sendWebhookWithRetry(targetUrl,{event:'test.event',data:{test:123}},{
    secret:'super-secret-key',
    maxRetries:3,
    initialBackoffMs:10,
    maxBackoffMs:50,
    projectRoot:d
  });

  const pingRes=await testWebhook(targetUrl,{secret:'super-secret-key'});
  assert(pingRes.status==='DELIVERED','testWebhook ping failed');

  server.close();

  assert(res.status==='DELIVERED','webhook was not delivered after retry');
  assert(res.attempts===2,'expected 2 delivery attempts');
  assert(receivedSignature&&receivedSignature.startsWith('sha256='),'missing hmac signature');

  const sig=computeWebhookSignature('test-secret',{hello:'world'});
  assert(typeof sig==='string'&&sig.startsWith('sha256='),'compute signature failed');

  const history=getWebhookDeliveries(d);
  assert(Array.isArray(history)&&history.length>0,'webhook deliveries history missing');

  assert(matchesPattern('run.started','run.*')===true,'pattern matching run.* failed');
  assert(matchesPattern('task.done','*.done')===false,'pattern matching negative failed');

  const dispatches=dispatchWebhooks(d,{type:'test.event'});
  assert(Array.isArray(dispatches),'dispatchWebhooks should return array');
});

await test('normalize-inputs-on-various-formats',async ()=>{
  const d=fixture();
  const csvFile=path.join(d,'test.csv');
  fs.writeFileSync(csvFile,'id,name,role\n1,Alice,Admin\n2,Bob,User\n');
  const csvRes=normalizeInput(csvFile);
  assert(csvRes.status==='NORMALIZED'&&csvRes.markdown.includes('| Alice | Admin |'),'normalize csv failed');

  const tsvFile=path.join(d,'test.tsv');
  fs.writeFileSync(tsvFile,'id\tscore\n1\t99\n2\t85\n');
  const tsvRes=normalizeInput(tsvFile);
  assert(tsvRes.status==='NORMALIZED'&&tsvRes.markdown.includes('| 99 |'),'normalize tsv failed');

  const jsonFile=path.join(d,'test.json');
  fs.writeFileSync(jsonFile,'{"key":"value","num":42}');
  const jsonRes=normalizeInput(jsonFile);
  assert(jsonRes.status==='NORMALIZED'&&jsonRes.markdown.includes('"key": "value"'),'normalize json failed');

  const imgFile=path.join(d,'image.png');
  fs.writeFileSync(imgFile,Buffer.from([0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A]));
  const imgRes=normalizeInput(imgFile);
  assert(imgRes.status==='NEEDS_MULTIMODAL','normalize image status incorrect');

  const unsuppFile=path.join(d,'data.xyz');
  fs.writeFileSync(unsuppFile,'custom data format');
  const unsuppRes=normalizeInput(unsuppFile);
  assert(unsuppRes.status==='PENDING'&&unsuppRes.reason==='UNSUPPORTED_FILE_TYPE','normalize unsupported type failed');
});

await test('commands-delivery-and-ci-and-repo-handlers',async ()=>{
  const d=fixture();
  const r=route(ROOT,'Delivery Commands Test');
  const run=newRun(ROOT,d,{objective:'Delivery Commands Test',route:r});

  writeJson(path.join(stateDir(d),'state.json'),{active_run_id:run.run_id,workflow:run.workflow});

  // delivery targets
  let targetsOut=null;
  await deliveryCmds.delivery({
    args:{_:[ 'delivery','targets' ]},
    projectRoot:d,
    needRun:async()=>run,
    print:data=>{targetsOut=data;}
  });
  assert(targetsOut&&Array.isArray(targetsOut.targets),'delivery targets missing');

  // ci quarantine list & add & remove
  let qListOut=null;
  await deliveryCmds.ci({
    args:{_:[ 'ci','quarantine','list' ]},
    projectRoot:d,
    needRun:async()=>run,
    print:data=>{qListOut=data;}
  });
  assert(qListOut&&qListOut.schema==='agent-sdlc/quarantine-status/v1','quarantine list failed');

  let qAddOut=null;
  await deliveryCmds.ci({
    args:{_:[ 'ci','quarantine','add' ],test:'tests/flaky.test.js',reason:'FLAKY'},
    projectRoot:d,
    needRun:async()=>run,
    print:data=>{qAddOut=data;}
  });
  assert(qAddOut&&qAddOut.quarantine_id&&qAddOut.test_path==='tests/flaky.test.js','quarantine add failed');

  let qRemoveOut=null;
  await deliveryCmds.ci({
    args:{_:[ 'ci','quarantine','remove' ],test:'tests/flaky.test.js'},
    projectRoot:d,
    needRun:async()=>run,
    print:data=>{qRemoveOut=data;}
  });
  assert(qRemoveOut&&qRemoveOut.removed===true,'quarantine remove failed');

  // repo capability
  let capOut=null;
  await repoCmds.repo({
    args:{_:[ 'repo','capability' ]},
    projectRoot:d,
    print:data=>{capOut=data;}
  });
  assert(capOut&&capOut.tier,'repo capability missing');

  // trace kinds
  let kindsOut=null;
  await repoCmds.trace({
    args:{_:[ 'trace','kinds' ]},
    projectRoot:d,
    needRun:async()=>run,
    print:data=>{kindsOut=data;}
  });
  assert(kindsOut&&Array.isArray(kindsOut.node_kinds),'trace kinds missing');
});

await test('commands-run-status-pretty-and-next-and-gate',async ()=>{
  const d=fixture();
  const r=route(ROOT,'Run Commands Test');
  const run=newRun(ROOT,d,{objective:'Run Commands Test',route:r});
  const {commands:runCmds}=await import('../runtime/commands/run.mjs');

  let prettyOut=null;
  await runCmds.status({
    args:{pretty:true},
    needRun:async()=>run,
    print:data=>{prettyOut=data;}
  });
  assert(typeof prettyOut==='string'&&prettyOut.includes('=== SDLC Run'),'pretty status failed');

  let nextOut=null;
  await runCmds.next({
    needRun:async()=>run,
    print:data=>{nextOut=data;}
  });
  assert(nextOut&&nextOut.next,'run next failed');

  let gateStatusOut=null;
  await runCmds.gate({
    args:{_:[ 'gate','status' ]},
    ROOT,
    projectRoot:d,
    needRun:async()=>run,
    print:data=>{gateStatusOut=data;}
  });
  assert(gateStatusOut&&gateStatusOut.schema==='agent-sdlc/gate-decision/v1','gate status failed');

  let gateExplainOut=null;
  await runCmds.gate({
    args:{_:[ 'gate','explain' ],stage:'INTAKE'},
    ROOT,
    projectRoot:d,
    needRun:async()=>run,
    print:data=>{gateExplainOut=data;}
  });
  assert(gateExplainOut&&gateExplainOut.stage==='INTAKE','gate explain failed');
});

await test('commands-govern-learn-review-handlers',async ()=>{
  const d=fixture();
  const r=route(ROOT,'Govern Learn Review Test');
  const run=newRun(ROOT,d,{objective:'Govern Learn Review Test',route:r});

  // govern policy
  let policyOut=null;
  await deliveryCmds.govern({
    args:{_:[ 'govern','policy' ]},
    ROOT,
    projectRoot:d,
    needRun:async()=>run,
    need:k=>'task-1',
    print:data=>{policyOut=data;}
  });
  assert(policyOut&&policyOut.schema==='agent-sdlc/cost-context-governance-policy/v1','govern policy failed');

  // govern boundaries
  let boundariesOut=null;
  await deliveryCmds.govern({
    args:{_:[ 'govern','boundaries' ]},
    ROOT,
    projectRoot:d,
    needRun:async()=>run,
    need:k=>'task-1',
    print:data=>{boundariesOut=data;}
  });
  assert(boundariesOut&&boundariesOut.schema==='agent-sdlc/arch-audit/v1','govern boundaries failed');

  // govern simulate
  let simOut=null;
  await deliveryCmds.govern({
    args:{_:[ 'govern','simulate' ]},
    ROOT,
    projectRoot:d,
    needRun:async()=>run,
    need:k=>'task-1',
    print:data=>{simOut=data;}
  });
  assert(simOut&&simOut.schema==='agent-sdlc/simulation/v1','govern simulate failed');

  // learn sources
  let sourcesOut=null;
  await deliveryCmds.learn({
    args:{_:[ 'learn','sources' ]},
    projectRoot:d,
    need:k=>'ESCAPED_DEFECT',
    print:data=>{sourcesOut=data;}
  });
  assert(sourcesOut&&Array.isArray(sourcesOut.sources),'learn sources failed');

  // learn candidate
  let candOut=null;
  await deliveryCmds.learn({
    args:{_:[ 'learn','candidate' ],title:'Candidate bug',observed:'failed',expected:'passed'},
    projectRoot:d,
    need:k=>k==='source'?'ESCAPED_DEFECT':'val',
    print:data=>{candOut=data;}
  });
  assert(candOut&&candOut.candidate&&candOut.validation,'learn candidate failed');

  // review audit
  let revOut=null;
  await deliveryCmds.review({
    args:{_:[ 'review','audit' ]},
    projectRoot:d,
    print:data=>{revOut=data;}
  });
  assert(revOut&&revOut.schema==='agent-sdlc/review-scorecard/v1','review audit failed');
});

await test('commands-run-context-explain-diff-metrics',async ()=>{
  const d=fixture();
  const r=route(ROOT,'Run Context and Explain Test');
  const run=newRun(ROOT,d,{objective:'Run Context and Explain Test',route:r});
  const {commands:runCmds}=await import('../runtime/commands/run.mjs');

  let ctxOut=null;
  await runCmds.context({
    args:{},
    ROOT,
    projectRoot:d,
    needRun:async()=>run,
    print:data=>{ctxOut=data;}
  });
  assert(ctxOut&&ctxOut.objective,'context failed');

  let promptOut=null;
  await runCmds.context({
    args:{prompt:true},
    ROOT,
    projectRoot:d,
    needRun:async()=>run,
    print:data=>{promptOut=data;}
  });
  assert(typeof promptOut==='string'&&promptOut.length>0,'prompt render failed');

  let metricsOut=null;
  await runCmds.metrics({
    projectRoot:d,
    print:data=>{metricsOut=data;}
  });
  assert(metricsOut,'metrics failed');

  let planOut=null;
  await runCmds['parallel-plan']({
    args:{tasks:JSON.stringify([{id:'T1',reads:['a.js'],writes:['b.js']}])},
    ROOT,
    print:data=>{planOut=data;}
  });
  assert(planOut,'parallel plan failed');

  let explainOut=null;
  await runCmds.explain({
    ROOT,
    projectRoot:d,
    needRun:async()=>run,
    print:data=>{explainOut=data;}
  });
  assert(explainOut&&explainOut.schema==='agent-sdlc/run-explanation/v1','explain failed');

  let diffOut=null;
  await runCmds.diff({
    projectRoot:d,
    needRun:async()=>run,
    print:data=>{diffOut=data;}
  });
  assert(diffOut&&diffOut.schema==='agent-sdlc/run-diff/v1','diff failed');
});

await test('commands-repo-intelligence-and-trace-deep',async ()=>{
  const d=fixture();
  const r=route(ROOT,'Repo Trace Deep Test');
  const run=newRun(ROOT,d,{objective:'Repo Trace Deep Test',route:r});

  fs.mkdirSync(path.join(d,'src'),{recursive:true});
  fs.writeFileSync(path.join(d,'src','index.js'),'export const main = () => true;\n');
  fs.writeFileSync(path.join(d,'src','helper.js'),'import {main} from "./index.js";\nexport function help() { return main(); }\n');

  // repo index
  let idxOut=null;
  await repoCmds.repo({
    args:{_:[ 'repo','index' ],force:true},
    projectRoot:d,
    print:data=>{idxOut=data;}
  });
  assert(idxOut&&idxOut.schema==='agent-sdlc/repo-index/v1','repo index failed');

  // repo status
  let statOut=null;
  await repoCmds.repo({
    args:{_:[ 'repo','status' ]},
    projectRoot:d,
    print:data=>{statOut=data;}
  });
  assert(statOut&&statOut.indexed,'repo status failed');

  // repo dead-code
  let deadOut=null;
  await repoCmds.repo({
    args:{_:[ 'repo','dead-code' ]},
    projectRoot:d,
    print:data=>{deadOut=data;}
  });
  assert(deadOut&&deadOut.schema==='agent-sdlc/dead-code-report/v1','dead code failed');

  // repo symbol
  let symOut=null;
  await repoCmds.repo({
    args:{_:[ 'repo','symbol','main' ]},
    projectRoot:d,
    print:data=>{symOut=data;}
  });
  assert(symOut&&Array.isArray(symOut.locations),'repo symbol failed');

  // trace build and show
  let traceBuildOut=null;
  await repoCmds.trace({
    args:{_:[ 'trace','build' ]},
    projectRoot:d,
    needRun:async()=>run,
    print:data=>{traceBuildOut=data;}
  });
  assert(traceBuildOut&&traceBuildOut.schema==='agent-sdlc/traceability-graph/v1','trace build failed');

  let traceShowOut=null;
  await repoCmds.trace({
    args:{_:[ 'trace','show' ],mermaid:true},
    projectRoot:d,
    needRun:async()=>run,
    print:data=>{traceShowOut=data;}
  });
  assert(typeof traceShowOut==='string'&&(traceShowOut.includes('graph LR')||traceShowOut.includes('graph TD')),'trace show mermaid failed');
});

await test('commands-delivery-deep',async ()=>{
  const d=fixture();
  const r=route(ROOT,'Delivery Deep Test');
  const run=newRun(ROOT,d,{objective:'Delivery Deep Test',route:r});

  // delivery branch
  let branchOut=null;
  await deliveryCmds.delivery({
    args:{_:[ 'delivery','branch' ]},
    needRun:async()=>run,
    print:data=>{branchOut=data;}
  });
  assert(branchOut&&branchOut.branch,'delivery branch failed');

  // delivery push-check
  let pushOut=null;
  await deliveryCmds.delivery({
    args:{_:[ 'delivery','push-check' ]},
    needRun:async()=>run,
    print:data=>{pushOut=data;}
  });
  assert(pushOut&&pushOut.decision,'delivery push-check failed');

  // delivery drift
  let driftOut=null;
  await deliveryCmds.delivery({
    args:{_:[ 'delivery','drift' ],base:'master'},
    projectRoot:d,
    print:data=>{driftOut=data;}
  });
  assert(driftOut&&typeof driftOut.drifted==='boolean','delivery drift failed');

  // delivery group
  let groupOut=null;
  await deliveryCmds.delivery({
    args:{_:[ 'delivery','group' ]},
    projectRoot:d,
    needRun:async()=>run,
    print:data=>{groupOut=data;}
  });
  assert(groupOut&&groupOut.schema,'delivery group failed');

  // ci record
  let ciRecOut=null;
  await deliveryCmds.ci({
    args:{_:[ 'ci','record' ],provider:'github-actions',revision:'abc1234'},
    projectRoot:d,
    needRun:async()=>run,
    print:data=>{ciRecOut=data;}
  });
  assert(ciRecOut&&ciRecOut.schema==='agent-sdlc/ci-evidence/v1','ci record failed');

  // ci show
  let ciShowOut=null;
  await deliveryCmds.ci({
    args:{_:[ 'ci','show' ]},
    projectRoot:d,
    needRun:async()=>run,
    print:data=>{ciShowOut=data;}
  });
  assert(ciShowOut&&ciShowOut.schema==='agent-sdlc/ci-evidence/v1','ci show failed');

  // ci history
  let ciHistOut=null;
  await deliveryCmds.ci({
    args:{_:[ 'ci','history' ]},
    projectRoot:d,
    needRun:async()=>run,
    print:data=>{ciHistOut=data;}
  });
  assert(Array.isArray(ciHistOut),'ci history failed');

  // ci verify-chain
  let chainOut=null;
  await deliveryCmds.ci({
    args:{_:[ 'ci','verify-chain' ]},
    projectRoot:d,
    needRun:async()=>run,
    print:data=>{chainOut=data;}
  });
  assert(chainOut&&typeof chainOut.valid==='boolean','ci verify-chain failed');
});

await test('commands-repo-queries',async ()=>{
  const d=fixture();
  const r=route(ROOT,'Repo Queries Test');
  const run=newRun(ROOT,d,{objective:'Repo Queries Test',route:r});

  fs.mkdirSync(path.join(d,'src'),{recursive:true});
  fs.writeFileSync(path.join(d,'src','index.js'),'export const main = () => true;\n');
  fs.writeFileSync(path.join(d,'src','helper.js'),'import {main} from "./index.js";\nexport function help() { return main(); }\n');

  // repo references
  let refOut=null;
  await repoCmds.repo({
    args:{_:[ 'repo','references','main' ]},
    projectRoot:d,
    print:data=>{refOut=data;}
  });
  assert(refOut&&refOut.query==='findReferences','repo references failed');

  // repo tests
  let testsOut=null;
  await repoCmds.repo({
    args:{_:[ 'repo','tests' ],path:'src/index.js'},
    projectRoot:d,
    print:data=>{testsOut=data;}
  });
  assert(testsOut&&testsOut.query==='findTestsForFiles','repo tests failed');

  // repo impact
  let impOut=null;
  await repoCmds.repo({
    args:{_:[ 'repo','impact' ],path:'src/index.js'},
    projectRoot:d,
    print:data=>{impOut=data;}
  });
  assert(impOut&&impOut.query==='findTransitiveImpact','repo impact failed');

  // repo impacted-tests
  let impTestsOut=null;
  await repoCmds.repo({
    args:{_:[ 'repo','impacted-tests' ],path:'src/index.js'},
    projectRoot:d,
    print:data=>{impTestsOut=data;}
  });
  assert(impTestsOut&&impTestsOut.query==='findImpactedTests','repo impacted-tests failed');

  // repo module
  let modOut=null;
  await repoCmds.repo({
    args:{_:[ 'repo','module','src/index.js' ]},
    projectRoot:d,
    print:data=>{modOut=data;}
  });
  assert(modOut&&modOut.query==='findModuleBoundary','repo module failed');

  // repo dependents
  let depOut=null;
  await repoCmds.repo({
    args:{_:[ 'repo','dependents','src/index.js' ]},
    projectRoot:d,
    print:data=>{depOut=data;}
  });
  assert(depOut&&depOut.query==='findDependents','repo dependents failed');

  // repo interfaces
  let ifaceOut=null;
  await repoCmds.repo({
    args:{_:[ 'repo','interfaces' ],path:'src/index.js'},
    projectRoot:d,
    print:data=>{ifaceOut=data;}
  });
  assert(ifaceOut&&ifaceOut.query==='findPublicInterfaces','repo interfaces failed');

  // repo entities
  let entOut=null;
  await repoCmds.repo({
    args:{_:[ 'repo','entities' ],path:'src/index.js'},
    projectRoot:d,
    print:data=>{entOut=data;}
  });
  assert(entOut&&entOut.query==='findDataEntities','repo entities failed');

  // repo events
  let evOut=null;
  await repoCmds.repo({
    args:{_:[ 'repo','events' ],path:'src/index.js'},
    projectRoot:d,
    print:data=>{evOut=data;}
  });
  assert(evOut&&evOut.query==='findEventContracts','repo events failed');

  // repo recent
  let recOut=null;
  await repoCmds.repo({
    args:{_:[ 'repo','recent' ]},
    projectRoot:d,
    print:data=>{recOut=data;}
  });
  assert(recOut&&recOut.query==='findRecentChanges','repo recent failed');

  // repo surface
  let surfOut=null;
  await repoCmds.repo({
    args:{_:[ 'repo','surface' ],objective:'add new feature'},
    projectRoot:d,
    print:data=>{surfOut=data;}
  });
  assert(surfOut&&surfOut.query==='getMinimalChangeSurface','repo surface failed');

  // trace validate
  await repoCmds.trace({
    args:{_:[ 'trace','build' ]},
    projectRoot:d,
    needRun:async()=>run,
    print:()=>{}
  });

  let valOut=null;
  await repoCmds.trace({
    args:{_:[ 'trace','validate' ]},
    projectRoot:d,
    needRun:async()=>run,
    print:data=>{valOut=data;}
  });
  assert(valOut&&valOut.schema==='agent-sdlc/traceability-validation/v1','trace validate failed');

  // trace closure
  let closureOut=null;
  await repoCmds.trace({
    args:{_:[ 'trace','closure' ],node:'REQUIREMENT:REQ-001'},
    projectRoot:d,
    needRun:async()=>run,
    print:data=>{closureOut=data;}
  });
  assert(closureOut&&closureOut.schema==='agent-sdlc/invalidation-closure/v1','trace closure failed');

  // trace invalidate
  let invOut=null;
  await repoCmds.trace({
    args:{_:[ 'trace','invalidate' ],node:'REQUIREMENT:REQ-001'},
    projectRoot:d,
    needRun:async()=>run,
    print:data=>{invOut=data;}
  });
  assert(invOut&&invOut.schema==='agent-sdlc/invalidation-record/v1','trace invalidate failed');

  // trace history
  let histOut=null;
  await repoCmds.trace({
    args:{_:[ 'trace','history' ]},
    projectRoot:d,
    needRun:async()=>run,
    print:data=>{histOut=data;}
  });
  assert(Array.isArray(histOut),'trace history failed');

  // repo mutate
  let mutOut=null;
  await repoCmds.repo({
    args:{_:[ 'repo','mutate' ],file:'src/index.js','max-mutants':3},
    projectRoot:d,
    print:data=>{mutOut=data;}
  });
  assert(mutOut&&mutOut.schema==='agent-sdlc/mutation-report/v1','repo mutate failed');
});

await test('commands-run-rewind-and-approval-revoke',async ()=>{
  const d=fixture();
  const r=route(ROOT,'Run Rewind Revoke Test');
  let run=newRun(ROOT,d,{objective:'Run Rewind Revoke Test',route:r});
  const {transition}=await import('../runtime/orchestrator.mjs');
  run=transition(ROOT,d,run,'REQUIREMENTS',{evidence:['intake_valid']});

  const {commands:runCmds}=await import('../runtime/commands/run.mjs');

  // run rewind
  let rewOut=null;
  await runCmds.rewind({
    args:{'to-stage':'INTAKE','preserve-evidence':true},
    ROOT,
    projectRoot:d,
    needRun:async()=>run,
    print:data=>{rewOut=data;}
  });
  assert(rewOut&&rewOut.status==='REWOUND','run rewind failed');

  // run approval revoke
  const {recordApproval}=await import('../runtime/approvals.mjs');
  recordApproval(ROOT,d,run,{
    capability:'git.push',
    authority:'USER_INTERACTIVE',
    actor:'test-user',
    reason:'test grant',
    expiresAt:new Date(Date.now()+3600000).toISOString()
  });

  let revAppOut=null;
  await runCmds.approval({
    args:{_:[ 'approval','revoke' ],capability:'git.push'},
    ROOT,
    projectRoot:d,
    needRun:async()=>run,
    print:data=>{revAppOut=data;}
  });
  assert(revAppOut&&revAppOut.revoked_at,'run approval revoke failed');
});

finish();
