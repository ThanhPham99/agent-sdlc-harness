#!/usr/bin/env node
// Test suite for expanded CLI commands, rewind engine, PR generator, webhook delivery, and edge-cases.
import fs from 'node:fs';
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
import {makeTempDir} from './lib/tempdir.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const {test,assert,finish}=createSuite('agent-sdlc/commands-expansion-validation/v1','COMMANDS-EXPANSION-VALIDATION.json');

function fixture(){
  const d=makeTempDir('agent-sdlc-cmd-exp-');
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

await test('task-scheduler-edge-cases-and-caps-and-mermaid',async ()=>{
  const d=fixture();
  const r=route(ROOT,'Scheduler Edge Cases Test');
  const run=newRun(ROOT,d,{objective:'Scheduler Edge Cases Test',route:r});

  const {
    mustSerialize,
    benefitJustified,
    readySet,
    scheduleTasks,
    scheduleView,
    renderTaskDagMermaid
  }=await import('../runtime/task-scheduler.mjs');
  const {saveTask}=await import('../runtime/store.mjs');

  const policy={
    serialize_on:{
      categories:['MIGRATION','SECURITY_CRITICAL'],
      risk:{security:['HIGH'],data:['CRITICAL']},
      destructive_data_change:true
    },
    benefit_threshold:{min_estimated_seconds:10},
    writers:{hard_default_max:4,default_max_concurrent:2,absolute_max:8},
    profile_max_writers:{STANDARD:2,STRICT:1,FAST:4},
    read_only:{hard_default_max:4,default_max_concurrent:2},
    budget:{respect_stage_max_model_calls:true,min_remaining_model_calls_per_dispatch:2}
  };

  // Test mustSerialize
  const tSec={category:'FEATURE',risk:{security:'HIGH'}};
  const tData={category:'FEATURE',risk:{data:'CRITICAL'}};
  const tDestruct={category:'FEATURE',risk:{destructive_data_change:true}};
  assert(mustSerialize(policy,tSec).length>0,'mustSerialize security failed');
  assert(mustSerialize(policy,tData).length>0,'mustSerialize data failed');
  assert(mustSerialize(policy,tDestruct).length>0,'mustSerialize destructive failed');

  // Test benefitJustified
  assert(benefitJustified(policy,[{scope:{write:[]}}]).justified===true,'read-only benefit failed');
  assert(benefitJustified(policy,[{scope:{write:['a']}},{scope:{write:['b']},execution:{estimated_seconds:5}}]).justified===false,'short task no-benefit failed');
  assert(benefitJustified(policy,[{scope:{write:['a']}},{scope:{write:['b']},execution:{estimated_seconds:15}}]).justified===true,'long task benefit failed');

  // Test tasks in store
  const t1={
    run_id:run.run_id,
    task_id:'TASK-001',
    category:'MIGRATION',
    status:'READY',
    scope:{write:['src/a.js'],interfaces:['UserApi']},
    execution:{parallel_candidate:true,estimated_seconds:20}
  };
  const t2={
    run_id:run.run_id,
    task_id:'TASK-002',
    category:'FEATURE',
    status:'READY',
    scope:{write:['src/a.js'],interfaces:['UserApi']},
    execution:{parallel_candidate:true,estimated_seconds:20}
  };
  const t3={
    run_id:run.run_id,
    task_id:'TASK-003',
    category:'FEATURE',
    status:'PENDING',
    dependencies:['TASK-999'],
    scope:{write:[],interfaces:[]}
  };
  saveTask(d,t1);
  saveTask(d,t2);
  saveTask(d,t3);

  // readySet test
  const rs=readySet(d,run.run_id,{outerStage:'EXECUTE',root:ROOT});
  assert(rs.ready.includes('TASK-001'),'readySet missing TASK-001');
  assert(rs.excluded.some(x=>x.task_id==='TASK-003'),'readySet should exclude TASK-003');

  // scheduleTasks with budget exhausted
  const schedExhausted=scheduleTasks(ROOT,d,run,{
    outerStage:'EXECUTE',
    budget:{remaining_model_calls:0}
  });
  assert(schedExhausted.reason==='budget-exhausted','budget-exhausted check failed');

  // scheduleTasks with serialized boundary
  const schedNorm=scheduleTasks(ROOT,d,run,{outerStage:'EXECUTE'});
  assert(schedNorm.selected.includes('TASK-001'),'scheduleTasks should select TASK-001');
  assert(schedNorm.deferred.some(d=>d.task_id==='TASK-002'),'scheduleTasks should defer TASK-002 on serialized boundary');

  // scheduleView
  const view=scheduleView(d,run.run_id);
  assert(view.schema==='agent-sdlc/task-graph-view/v1','scheduleView schema failed');

  // renderTaskDagMermaid
  const mmEmpty=renderTaskDagMermaid([]);
  assert(mmEmpty.includes('Empty'),'mermaid empty failed');
  const mmTasks=renderTaskDagMermaid([
    {task_id:'TASK-001',title:'First Task',status:'DONE',dependencies:[]},
    {task_id:'TASK-002',title:'Second Task',status:'IN_PROGRESS',dependencies:['TASK-001']},
    {task_id:'TASK-003',title:'Third Task',status:'BLOCKED',dependencies:['TASK-002']},
    {task_id:'TASK-004',title:'Fourth Task',status:'FAILED',dependencies:['TASK-003']},
    {task_id:'TASK-005',title:'Fifth Task',status:'CLAIMED',dependencies:[]},
    {task_id:'TASK-006',title:'Sixth Task',status:'VERIFYING',dependencies:[]},
    {task_id:'TASK-007',title:'Seventh Task',status:'REVIEWING',dependencies:[]}
  ]);
  assert(mmTasks.includes('TASK_001 --> TASK_002'),'mermaid dependencies failed');
  assert(mmTasks.includes('style TASK_001 fill:#2ecc71'),'mermaid DONE style failed');
});

await test('mcp-server-prompts-resources-and-unified-tasks',async ()=>{
  const d=fixture();
  const r=route(ROOT,'MCP Deep Test');
  const run=newRun(ROOT,d,{objective:'MCP Deep Test',route:r});

  const {
    getPrompt,
    readResource,
    execute
  }=await import('../runtime/mcp-server.mjs');
  const {saveTask}=await import('../runtime/store.mjs');

  saveTask(d,{
    run_id:run.run_id,
    task_id:'TASK-001',
    status:'READY',
    category:'FEATURE',
    attempt:1,
    dependencies:[],
    scope:{write:['src/index.js'],interfaces:[]}
  });

  // Prompts
  const p1=getPrompt('sdlc_feature_kickoff',{objective:'build auth'});
  assert(p1&&p1.messages[0].content.text.includes('build auth'),'getPrompt kickoff failed');
  const p2=getPrompt('sdlc_pr_review',{run_id:run.run_id});
  assert(p2&&p2.messages[0].content.text.includes(run.run_id),'getPrompt pr review failed');
  const p3=getPrompt('sdlc_incident_triage',{symptoms:'database timeout'});
  assert(p3&&p3.messages[0].content.text.includes('database timeout'),'getPrompt incident triage failed');

  let promptErr=null;
  try{getPrompt('unknown_prompt');}catch(e){promptErr=e;}
  assert(promptErr&&promptErr.message.includes('Prompt not found'),'unknown prompt should throw');

  // Resources
  const resProj=readResource('sdlc://project/status',d);
  assert(resProj&&resProj.text,'resource project status failed');
  const resIntel=readResource('sdlc://intelligence/summary',d);
  assert(resIntel&&resIntel.text,'resource intel summary failed');
  const resRun=readResource(`sdlc://runs/${run.run_id}/state`,d);
  assert(resRun&&resRun.text,'resource run state failed');
  const resTasks=readResource(`sdlc://runs/${run.run_id}/tasks`,d);
  assert(resTasks&&resTasks.text,'resource run tasks failed');
  const resDag=readResource(`sdlc://runs/${run.run_id}/dag`,d);
  assert(resDag&&resDag.text.includes('graph TD'),'resource run tasks dag mermaid failed');

  let resErr=null;
  try{readResource('sdlc://unknown/resource',d);}catch(e){resErr=e;}
  assert(resErr&&resErr.message.includes('Resource not found'),'unknown resource should throw');

  // Unified Task tool operations
  const opList=execute('agent_sdlc_task',{project_root:d,run_id:run.run_id,op:'list'});
  assert(Array.isArray(opList)&&opList.length>0,'agent_sdlc_task list failed');

  const opStatus=execute('agent_sdlc_task',{project_root:d,run_id:run.run_id,op:'status'});
  assert(opStatus&&opStatus.total>=1,'agent_sdlc_task status progress failed');

  const opTaskStatus=execute('agent_sdlc_task',{project_root:d,run_id:run.run_id,op:'status',task_id:'TASK-001'});
  assert(opTaskStatus&&opTaskStatus.task_id==='TASK-001','agent_sdlc_task single status failed');

  const opReady=execute('agent_sdlc_task',{project_root:d,run_id:run.run_id,op:'ready'});
  assert(opReady&&opReady.schema==='agent-sdlc/task-ready-set/v1','agent_sdlc_task ready failed');

  const opSched=execute('agent_sdlc_task',{project_root:d,run_id:run.run_id,op:'schedule'});
  assert(opSched&&opSched.schema==='agent-sdlc/task-schedule-decision/v1','agent_sdlc_task schedule failed');

  const opCtx=execute('agent_sdlc_task',{project_root:d,run_id:run.run_id,op:'context',task_id:'TASK-001'});
  assert(opCtx&&opCtx.context_hash,'agent_sdlc_task context failed');

  const opCtxPrompt=execute('agent_sdlc_task',{project_root:d,run_id:run.run_id,op:'context',task_id:'TASK-001',prompt:true});
  assert(opCtxPrompt&&opCtxPrompt.prompt,'agent_sdlc_task context prompt failed');

  const opEvid=execute('agent_sdlc_task',{project_root:d,run_id:run.run_id,op:'evidence',task_id:'TASK-001'});
  assert(opEvid&&opEvid.status,'agent_sdlc_task evidence failed');

  const opGraph=execute('agent_sdlc_task',{project_root:d,run_id:run.run_id,op:'graph'});
  assert(opGraph&&opGraph.schema==='agent-sdlc/task-graph-view/v1','agent_sdlc_task graph failed');

  const opGraphMermaid=execute('agent_sdlc_task',{project_root:d,run_id:run.run_id,op:'graph',mermaid:true});
  assert(opGraphMermaid&&opGraphMermaid.mermaid,'agent_sdlc_task graph mermaid failed');

  let opUnknownErr=null;
  try{execute('agent_sdlc_task',{project_root:d,run_id:run.run_id,op:'invalid_op'});}catch(e){opUnknownErr=e;}
  assert(opUnknownErr&&opUnknownErr.message.includes('unknown op'),'unknown op should throw');

  // Transition force disabled rejection check
  let forceErr=null;
  try{execute('agent_sdlc_transition',{project_root:d,run_id:run.run_id,to:'REQUIREMENTS',force:true});}catch(e){forceErr=e;}
  assert(forceErr&&forceErr.message.includes('FORCE_DISABLED'),'force transition should throw');

  // Artifact put via MCP
  const art=execute('agent_sdlc_artifact_put',{project_root:d,run_id:run.run_id,kind:'test-artifact',content:'sample text'});
  assert(art&&art.artifact_id,'agent_sdlc_artifact_put failed');
});

await test('task-verification-deep-branches',async ()=>{
  const d=fixture();
  const r=route(ROOT,'Task Verification Deep Test');
  const run=newRun(ROOT,d,{objective:'Task Verification Deep Test',route:r});

  const {
    environmentFingerprint,
    verificationStrategy,
    plannedCommands,
    scopeAudit,
    verifyTask
  }=await import('../runtime/task-verification.mjs');
  const {saveTask}=await import('../runtime/store.mjs');

  const env=environmentFingerprint();
  assert(env&&env.platform,'environmentFingerprint failed');

  // Strategies
  assert(verificationStrategy({category:'integration'},{escalate:true})==='BROAD_SUITE','escalate strategy failed');
  assert(verificationStrategy({category:'integration'},{escalate:false})==='AFFECTED_INTEGRATION','integration category strategy failed');
  assert(verificationStrategy({category:'feature',risk:{security:'HIGH'}},{escalate:false})==='AFFECTED_INTEGRATION','security high strategy failed');
  assert(verificationStrategy({category:'feature',scope:{interfaces:['Api']}},{escalate:false})==='AFFECTED_INTEGRATION','interfaces strategy failed');
  assert(verificationStrategy({category:'feature',scope:{interfaces:[]}},{escalate:false})==='TARGETED','targeted strategy failed');

  // Scope Audit
  const audit1=scopeAudit({scope:{write:['src/*'],forbidden:['src/secret.js']}},['src/index.js','src/secret.js','other.js']);
  assert(audit1.respected===false,'scopeAudit should flag forbidden and other');
  assert(audit1.out_of_scope_paths.includes('src/secret.js'),'scopeAudit should catch secret.js');
  assert(audit1.out_of_scope_paths.includes('other.js'),'scopeAudit should catch other.js');

  const audit2=scopeAudit({scope:{write:['src/index.js'],forbidden:[]}},['src/index.js']);
  assert(audit2.respected===true,'scopeAudit respected failed');

  // verifyTask dryRun
  const tDry={
    run_id:run.run_id,
    task_id:'TASK-001',
    status:'READY',
    category:'feature',
    verification:{targeted_tests:['tests/a.test.js']},
    scope:{write:['src/a.js']}
  };
  saveTask(d,tDry);
  const dryRes=verifyTask(ROOT,d,run,tDry,{dryRun:true});
  assert(dryRes.evidence.status==='PENDING','verifyTask dryRun status failed');

  // verifyTask with unsatisfied selector
  const tUnsat={
    run_id:run.run_id,
    task_id:'TASK-002',
    status:'READY',
    category:'feature',
    verification:{targeted_tests:[]},
    scope:{write:['src/a.js']}
  };
  saveTask(d,tUnsat);
  const unsatRes=verifyTask(ROOT,d,run,tUnsat,{commands:[{kind:'test_targeted',command:['node','{selector}'],unsatisfied_selector:true}]});
  assert(unsatRes.evidence.status==='FAIL','unsatisfied selector should fail verification');
});

await test('task-migration-deep-branches',async ()=>{
  const d=fixture();
  const r=route(ROOT,'Migration Deep Test');
  const run=newRun(ROOT,d,{objective:'Migration Deep Test',route:r});

  const {
    findPlanArtifact,
    assignStableTaskIds,
    migrateRunToTaskRuntime
  }=await import('../runtime/task-migration.mjs');
  const {putArtifact}=await import('../runtime/store.mjs');

  // assignStableTaskIds
  const planRaw={
    schema:'agent-sdlc/task-plan/v1',
    plan_id:'PLAN-001',
    tasks:[
      {task_id:'TASK-001',title:'First'},
      {title:'Second without id'}
    ]
  };
  const {plan:planAssigned,assigned}=assignStableTaskIds(planRaw);
  assert(assigned.length===1,'assignStableTaskIds assigned count failed');
  assert(planAssigned.tasks[1].task_id==='TASK-002','assignStableTaskIds id sequence failed');

  // migrateRunToTaskRuntime without plan artifact
  const migNoPlan=migrateRunToTaskRuntime(ROOT,d,run);
  assert(migNoPlan.status==='NO_PLAN_ARTIFACT','migrateRun should report NO_PLAN_ARTIFACT');

  // Record a valid task plan artifact
  putArtifact(d,{
    kind:'task-plan',
    content:JSON.stringify(planRaw),
    runId:run.run_id,
    stage:run.state
  });

  const found=findPlanArtifact(d,run.run_id);
  assert(found&&found.plan,'findPlanArtifact failed');

  // migrateRunToTaskRuntime dryRun
  const migDry=migrateRunToTaskRuntime(ROOT,d,run,{dryRun:true});
  assert(migDry.status==='DRY_RUN','migrateRun dryRun status failed');

  // migrateRunToTaskRuntime with invalid schema fail-closed
  const runInvalid=newRun(ROOT,d,{objective:'Invalid Plan Test',route:r});
  putArtifact(d,{
    kind:'task-plan',
    content:JSON.stringify({schema:'agent-sdlc/unknown-plan/v99',tasks:[]}),
    runId:runInvalid.run_id,
    stage:runInvalid.state
  });
  const migInvalid=migrateRunToTaskRuntime(ROOT,d,runInvalid);
  assert(migInvalid.status==='FAILED_CLOSED','migrateRun unknown schema should FAIL_CLOSED');
});

await test('webhook-system-deep-branches',async ()=>{
  const d=fixture();
  const {
    sendWebhook,
    sendWebhookWithRetry,
    recordWebhookDelivery,
    getWebhookDeliveries
  }=await import('../runtime/webhook.mjs');

  // sendWebhook invalid URL
  const invRes=await sendWebhook('not-a-valid-url',{test:true});
  assert(invRes.status==='INVALID_URL','sendWebhook invalid url failed');

  // recordWebhookDelivery bounding at 100
  for(let i=0;i<105;i++){
    recordWebhookDelivery(d,{
      delivery_id:`wh_test_${i}`,
      status:'DELIVERED',
      url:'http://localhost:9999/hook',
      created_at:new Date().toISOString()
    });
  }
  const dels=getWebhookDeliveries(d,{limit:200});
  assert(dels.length===100,'recordWebhookDelivery bounding at 100 failed');

  const delsLimit=getWebhookDeliveries(d,{limit:10});
  assert(delsLimit.length===10,'getWebhookDeliveries limit failed');
});

finish();
