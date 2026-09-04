// Delivery, CI evidence, governance and learning.
//
// Handlers are data: each takes the CLI context and prints its own result.
// Extracting them from the dispatcher is what makes them reachable from a test
// without spawning a process. Everything heavy is still imported inside the
// handler that needs it, so a single command loads only its own dependencies.
import fs from 'node:fs';
import path from 'node:path';
import {readJson,truthy} from '../util.mjs';

export const commands={
  delivery:async ctx=>{
    const {args,projectRoot,print,needRun}=ctx;
    const sub=args._[1]||'status';
    const {recordDelivery,loadDelivery,baseDrift,checkPushTarget,branchFor,groupTaskBranches,DELIVERY_TARGETS}=await import('../git-delivery.mjs');
    const {loadCiEvidence}=await import('../ci-evidence.mjs');
    const {activeCapabilities}=await import('../approvals.mjs');
    const {listTasks}=await import('../store.mjs');
    if(sub==='status'){const r=await needRun();print(loadDelivery(projectRoot,r.run_id)||{status:'NO_DELIVERY_RECORD'});}
    else if(sub==='targets')print({targets:DELIVERY_TARGETS,note:'a prepared PR is PR_READY, never MERGED'});
    else if(sub==='branch'){const r=await needRun();print({branch:branchFor(r.run_id,args['task-id']||null)});}
    else if(sub==='push-check'){const r=await needRun();print(checkPushTarget(args.branch||branchFor(r.run_id),{approvals:activeCapabilities(r)}));}
    else if(sub==='drift')print(baseDrift(projectRoot,{base:args.base||'main',recordedBaseRevision:args.revision||null}));
    else if(sub==='group'){const r=await needRun();print(groupTaskBranches(listTasks(projectRoot,r.run_id),{allowInterfaceGrouping:truthy(args['allow-interface-grouping'])}));}
    else if(sub==='record'){
      const run=await needRun();
      const out=recordDelivery(projectRoot,run,{
        target:args.target||'PR_READY',branch:args.branch||null,base:args.base||'main',
        recordedBaseRevision:args['base-revision']||null,
        taskBranches:args['task-branches']?String(args['task-branches']).split(',').filter(Boolean):[],
        stacked:args.stacked?readJson(path.resolve(args.stacked)):[],
        ciEvidence:loadCiEvidence(projectRoot,run.run_id),
        mergeCommit:args['merge-commit']||null,
        approvals:activeCapabilities(run)
      });
      print(out);if(out.status!=='READY')process.exitCode=1;
    }
    else if(sub==='pr-body'){
      const r=await needRun();
      const {generatePrBody}=await import('../pr-generator.mjs');
      print(generatePrBody(projectRoot,r,{format:args.format||'markdown'}));
    }
    else if(sub==='changelog'){
      const {generateChangelog}=await import('../pr-generator.mjs');
      const {listTasks,loadState}=await import('../store.mjs');
      const state=loadState(projectRoot);
      const tasks=state.active_run_id?listTasks(projectRoot,state.active_run_id):[];
      print(generateChangelog(projectRoot,{version:args.version||'Unreleased',tasks}));
    }
    else throw new Error(`unknown delivery subcommand ${sub}`);
  },
  ci:async ctx=>{
    const {args,projectRoot,print,needRun}=ctx;
    const sub=args._[1]||'status';
    const {recordCiEvidence,loadCiEvidence,ciEvidenceCurrent,ciEvidenceHistory}=await import('../ci-evidence.mjs');
    if(sub==='record'){
      const run=await needRun();const payload=args.file?readJson(path.resolve(args.file)):{};
      print(recordCiEvidence(projectRoot,run,{
        revision:args.revision||payload.revision||null,
        provider:args.provider||payload.provider||'unknown',
        workflow:args.workflow||payload.workflow||null,
        run_url:args.url||payload.run_url||null,
        checks:payload.checks||[],
        logs:args.logs?fs.readFileSync(path.resolve(args.logs),'utf8'):null
      }));
    }
    else if(sub==='status'){const r=await needRun();const c=ciEvidenceCurrent(projectRoot,r.run_id,{revision:args.revision||null});print(c);if(!c.current)process.exitCode=1;}
    else if(sub==='show'){const r=await needRun();print(loadCiEvidence(projectRoot,r.run_id)||{status:'NO_CI_EVIDENCE'});}
    else if(sub==='history'){const r=await needRun();print(ciEvidenceHistory(projectRoot,r.run_id));}
    else if(sub==='verify-chain'){
      const r=await needRun();
      const {verifyEventChain}=await import('../store.mjs');
      const res=verifyEventChain(projectRoot,r.run_id);
      print(res);
      if(!res.valid)process.exitCode=1;
    }
    else if(sub==='quarantine'){
      const act=args._[2]||'list';
      const {quarantineStatus,addToQuarantine,removeFromQuarantine}=await import('../quarantine.mjs');
      if(act==='list')print(quarantineStatus(projectRoot));
      else if(act==='add'){
        const testPath=args.test||args._[3];
        if(!testPath)throw new Error('--test <path> required');
        print(addToQuarantine(projectRoot,{testPath,reason:args.reason||'FLAKY_TEST'}));
      }else if(act==='remove'){
        const testPath=args.test||args._[3];
        if(!testPath)throw new Error('--test <path> required');
        print(removeFromQuarantine(projectRoot,testPath));
      }else throw new Error(`unknown quarantine action ${act}`);
    }
    else throw new Error(`unknown ci subcommand ${sub}`);
  },
  govern:async ctx=>{
    const {args,ROOT,projectRoot,print,needRun,need}=ctx;
    const sub=args._[1]||'report';
    const {governTask,governorReport,getGovernancePolicy,taskComplexity}=await import('../governor.mjs');
    const {requireTask}=await import('../task-engine.mjs');
    if(sub==='policy')print(getGovernancePolicy(ROOT));
    else if(sub==='report'){const r=await needRun();print(governorReport(ROOT,projectRoot,r));}
    else if(sub==='complexity'){const r=await needRun();print(taskComplexity(ROOT,requireTask(projectRoot,r.run_id,need('task-id'))));}
    else if(sub==='boundaries'){
      const {auditArchitecture}=await import('../arch-linter.mjs');
      const res=auditArchitecture(projectRoot,{strict:truthy(args.strict)});
      print(res);
      if(res.status==='FAIL')process.exitCode=1;
    }
    else if(sub==='simulate'){
      const r=await needRun();
      const {simulateRunBudget}=await import('../simulator.mjs');
      print(simulateRunBudget(ROOT,projectRoot,r));
    }
    else if(sub==='task'){
      const run=await needRun();const task=requireTask(projectRoot,run.run_id,need('task-id'));
      print(governTask(ROOT,projectRoot,run,task,{
        contextEstimate:args['context-estimate']?Number(args['context-estimate']):null,
        contextBudget:args['context-budget']?Number(args['context-budget']):null,
        remainingModelCalls:args['remaining-model-calls']!==undefined?Number(args['remaining-model-calls']):null,
        cacheAvailable:!!args['cache-available'],deterministicToolAvailable:args['no-deterministic-tool']?false:true
      }));
    }
    else throw new Error(`unknown govern subcommand ${sub}`);
  },
  learn:async ctx=>{
    const {args,projectRoot,print,need}=ctx;
    const sub=args._[1]||'sources';
    const {buildRegressionCandidate,validateRegressionCandidate,toEvalCase,LEARNING_SOURCES}=await import('../learning.mjs');
    if(sub==='sources')print({sources:LEARNING_SOURCES,note:'a candidate is proposed for eval validation; nothing here mutates policy'});
    else if(sub==='candidate'){
      const list=k=>args[k]?String(args[k]).split(',').map(s=>s.trim()).filter(Boolean):[];
      const candidate=buildRegressionCandidate({
        source:need('source'),title:args.title,observed:args.observed,expected:args.expected,
        failureClass:args['failure-class']||null,runId:args['run-id']||null,taskId:args['task-id']||null,
        paths:list('paths'),evidence:list('evidence'),diagnostic:args.diagnostic||null,
        policyHypothesis:args['policy-hypothesis']||null,projectRoot
      });
      const validation=validateRegressionCandidate(candidate);
      print({candidate,validation,eval_case:toEvalCase(candidate)});
      if(!validation.valid)process.exitCode=1;
    }
    else throw new Error(`unknown learn subcommand ${sub}`);
  },
  review:async ctx=>{
    const {args,projectRoot,print}=ctx;
    const sub=args._[1]||'audit';
    if(sub==='audit'){
      const {auditCodebase}=await import('../review-engine.mjs');
      const paths=args.paths?String(args.paths).split(',').map(s=>s.trim()).filter(Boolean):(args.path?[args.path]:[]);
      const res=auditCodebase(projectRoot,{paths,strict:truthy(args.strict)});
      print(res);
      if(res.status==='FAIL')process.exitCode=1;
    }
    else throw new Error(`unknown review subcommand ${sub}`);
  }
};
