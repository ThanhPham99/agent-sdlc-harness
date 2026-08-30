// The run lifecycle: routing, the stage loop and its gates.
//
// Handlers are data: each takes the CLI context and prints its own result.
// Extracting them from the dispatcher is what makes them reachable from a test
// without spawning a process. Everything heavy is still imported inside the
// handler that needs it, so a single command loads only its own dependencies.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {truthy} from '../util.mjs';

export const commands={
  route:async ctx=>{
    const {args,ROOT,print}=ctx;
    const {route}=await import('../router.mjs');
    print(route(ROOT,args.objective||args._.slice(1).join(' '),args.workflow||null,args.profile||null));
  },
  start:async ctx=>{
    const {args,ROOT,projectRoot,print}=ctx;
    const objective=args.objective||args._.slice(1).join(' ');
    if(!objective)throw new Error('objective required');
    const {detectProject}=await import('../init.mjs');
    const {initProject}=await import('../store.mjs');
    const {route}=await import('../router.mjs');
    const {newRun}=await import('../orchestrator.mjs');
    const {resolveFeatureBinding}=await import('../features.mjs');
    if(!fs.existsSync(path.join(projectRoot,'.agent-sdlc','project.json')))initProject(projectRoot,detectProject(projectRoot));
    const r=route(ROOT,objective,args.workflow||null,args.profile||null);
    // Binding is always resolved for continue-feature/requirement-update
    // (they refuse to run unbound) and whenever --feature-id is given. For
    // plain new-feature starts it stays opt-in via --track-feature so the
    // default `start` behavior is unchanged unless a caller actually asks
    // for feature/phase tracking.
    const skipBinding=r.workflow==='new-feature'&&!args['feature-id']&&!truthy(args['track-feature']);
    const binding=skipBinding?{featureId:null,phaseId:null}:resolveFeatureBinding(projectRoot,
      {workflow:r.workflow,featureId:args['feature-id']||null,phaseId:args['phase-id']||null,title:args['feature-title']||objective});
    const run=newRun(ROOT,projectRoot,{objective,route:r,featureId:binding.featureId,phaseId:binding.phaseId,
      parentRunId:args['parent-run-id']||null,runKind:args['run-kind']||null});
    print(run);
  },
  status:async ctx=>{
    const {args,print,needRun}=ctx;
    const run=await needRun();
    if(truthy(args.pretty)){
      const lines=[
        `=== SDLC Run ${run.run_id} ===`,
        `Objective: ${run.objective}`,
        `Workflow:  ${run.workflow} [${run.profile}]`,
        `Stage:     ${run.state}`,
        `Artifacts: ${(run.artifacts||[]).length} attached`,
        `Tasks:     ${(run.tasks||[]).length} materialized`,
        `Created:   ${run.created_at}`,
        `Updated:   ${run.updated_at}`
      ];
      print(lines.join('\n'));
    } else {
      print(run);
    }
  },
  next:async ctx=>{
    const {print,needRun}=ctx;
    const run=await needRun();
    const {nextState}=await import('../orchestrator.mjs');
    print({run_id:run.run_id,state:run.state,next:nextState(run)});
  },
  transition:async ctx=>{
    const {args,ROOT,projectRoot,print,needRun,need}=ctx;
    if(args.force!==undefined||args.approval!==undefined){
      throw new Error('FORCE_DISABLED: generic transition bypass is not supported. Use a declared recovery edge (see config/state-machine.json reentry edges), or `agent-sdlc approval grant` for a privileged capability.');
    }
    const run=await needRun();
    const to=need('to');
    const {transition}=await import('../orchestrator.mjs');
    const ev=(args.evidence?String(args.evidence).split(',').filter(Boolean):[]);
    print(transition(ROOT,projectRoot,run,to,{evidence:ev}));
  },
  gate:async ctx=>{
    const {args,ROOT,projectRoot,print,needRun}=ctx;
    const sub=args._[1]||'status';
    const {evaluateGate}=await import('../gates.mjs');
    const run=await needRun();
    if(sub==='status')print(evaluateGate(ROOT,projectRoot,run,run.state));
    else if(sub==='explain')print(evaluateGate(ROOT,projectRoot,run,args.stage||run.state));
    else throw new Error(`unknown gate subcommand ${sub}`);
  },
  approval:async ctx=>{
    const {args,ROOT,projectRoot,print,needRun}=ctx;
    const sub=args._[1]||'status';
    const {recordApproval,revokeApproval,listApprovals}=await import('../approvals.mjs');
    if(sub==='status'){
      const run=await needRun();
      print(listApprovals(run));
    }
    else if(sub==='grant'){
      const run=await needRun();
      const capability=args.capability;
      if(!capability)throw new Error('--capability required');
      if(!process.stdin.isTTY)throw new Error('approval grant requires an interactive terminal');
      let expiresAt=args['expires-at']||null;
      if(!expiresAt&&args['expires-in'])expiresAt=new Date(Date.now()+Number(args['expires-in'])*60000).toISOString();
      console.error(`Grant approval for capability "${capability}" on run ${run.run_id} (${projectRoot})`);
      if(args.reason)console.error(`Reason: ${args.reason}`);
      console.error(expiresAt?`Expires: ${expiresAt}`:'Expires: never (only allowed for a non-privileged capability)');
      const readline=await import('node:readline/promises');
      const rl=readline.createInterface({input:process.stdin,output:process.stderr});
      const answer=await rl.question('Type "yes" to confirm: ');
      rl.close();
      if(answer.trim().toLowerCase()!=='yes')throw new Error('approval grant not confirmed');
      print(recordApproval(ROOT,projectRoot,run,{capability,authority:'USER_INTERACTIVE',actor:os.userInfo().username,reason:args.reason||null,expiresAt}));
    }
    else if(sub==='revoke'){
      const run=await needRun();
      const capability=args.capability;
      if(!capability)throw new Error('--capability required');
      print(revokeApproval(ROOT,projectRoot,run,capability,{reason:args.reason||null}));
    }
    else throw new Error(`unknown approval subcommand ${sub}`);
  },
  context:async ctx=>{
    const {args,ROOT,projectRoot,print,needRun}=ctx;
    const run=await needRun();
    const {buildContext,renderPrompt}=await import('../context.mjs');
    const refs=args.artifacts?String(args.artifacts).split(',').filter(Boolean):run.artifacts||[];
    const syms=args.symbols?String(args.symbols).split(',').filter(Boolean):[];
    const m=buildContext(ROOT,projectRoot,run,{artifactRefs:refs,symbols:syms});
    if(args.prompt)print(renderPrompt(ROOT,m));else print(m);
  },
  metrics:async ctx=>{
    const {projectRoot,print}=ctx;
    const {metrics}=await import('../telemetry.mjs');
    print(metrics(projectRoot));
  },
  'parallel-plan':async ctx=>{
    const {args,ROOT,print}=ctx;
    const {parallelPlan}=await import('../parallel.mjs');
    const tasks=args.tasks?JSON.parse(args.tasks):(args.file?JSON.parse(fs.readFileSync(path.resolve(args.file),'utf8')):[]);
    print(parallelPlan(ROOT,tasks));
  },
  explain:async ctx=>{
    const {ROOT,projectRoot,print,needRun}=ctx;
    const run=await needRun();
    const {evaluateGate}=await import('../gates.mjs');
    const {nextState}=await import('../orchestrator.mjs');
    const gate=evaluateGate(ROOT,projectRoot,run,run.state);
    const next=nextState(run);
    const tasks=run.tasks||[];
    const taskSummary={
      total:tasks.length,
      done:tasks.filter(t=>t.status==='DONE').length,
      in_progress:tasks.filter(t=>t.status==='IN_PROGRESS').length,
      pending:tasks.filter(t=>t.status==='PENDING').length
    };
    print({
      schema:'agent-sdlc/run-explanation/v1',
      run_id:run.run_id,
      objective:run.objective,
      workflow:run.workflow,
      profile:run.profile,
      current_stage:run.state,
      next_stage:next,
      gate_decision:gate.decision,
      gate_status:{
        satisfied:gate.satisfied,
        missing:gate.missing,
        stale:gate.stale
      },
      tasks:taskSummary,
      recommendation:gate.decision==='PASS'
        ?`Stage ${run.state} gate is satisfied. Proceed with transition to ${next||'CLOSE'}.`
        :`Stage ${run.state} gate is blocked. Provide missing evidence tokens: [${gate.missing.join(', ')}]${gate.stale.length?` (refresh stale: [${gate.stale.join(', ')}])`:''}.`
    });
  },
  diff:async ctx=>{
    const {projectRoot,print,needRun}=ctx;
    const run=await needRun();
    const {spawnSync}=await import('node:child_process');
    const r=spawnSync('git',['diff','--stat'],{cwd:projectRoot,encoding:'utf8'});
    print({
      schema:'agent-sdlc/run-diff/v1',
      run_id:run.run_id,
      stage:run.state,
      git_stat:(r.stdout||'').trim(),
      artifacts_count:(run.artifacts||[]).length
    });
  }
};
