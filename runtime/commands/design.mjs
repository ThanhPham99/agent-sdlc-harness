// Design decisions and task plans.
//
// Handlers are data: each takes the CLI context and prints its own result.
// Extracting them from the dispatcher is what makes them reachable from a test
// without spawning a process. Everything heavy is still imported inside the
// handler that needs it, so a single command loads only its own dependencies.
import path from 'node:path';
import {readJson,gitSha,truthy} from '../util.mjs';

export const commands={
  design:async ctx=>{
    const {args,ROOT,projectRoot,print,needRun}=ctx;
    const sub=args._[1]||'mode';
    const {selectDesignDiscoveryMode,validateDesignDecision,getDesignDiscoveryPolicy}=await import('../design-discovery.mjs');
    const {putArtifact,saveRun}=await import('../store.mjs');
    const {recordDesignDecision}=await import('../orchestrator.mjs');
    const loadFile=()=>{if(!args.file)throw new Error('--file required');return readJson(path.resolve(args.file));};
    if(sub==='mode'){
      const run=args['run-id']?await needRun():null;
      print(selectDesignDiscoveryMode({
        profile:args.profile||run?.profile||'STANDARD',
        objective:args.objective||run?.objective||args._.slice(2).join(' '),
        declaredSignals:args.signals?String(args.signals).split(',').map(s=>s.trim()).filter(Boolean):[],
        designAlreadyApproved:truthy(args.approved)
      }));
    }
    else if(sub==='policy')print(getDesignDiscoveryPolicy());
    else if(sub==='validate')print(validateDesignDecision(loadFile()));
    else if(sub==='scaffold'){
      const {scaffoldDesignDecision}=await import('../design-discovery.mjs');
      const run=args['run-id']?await needRun():null;
      const objective=args.objective||run?.objective||args._.slice(2).join(' ');
      const selection=selectDesignDiscoveryMode({
        profile:args.profile||run?.profile||'STANDARD',
        objective,
        declaredSignals:args.signals?String(args.signals).split(',').map(s=>s.trim()).filter(Boolean):[],
        designAlreadyApproved:truthy(args.approved)
      });
      const draft=scaffoldDesignDecision(selection,{objective});
      print({schema:'agent-sdlc/design-decision-scaffold/v1',selection,draft,validation:validateDesignDecision(draft)});
    }
    else if(sub==='record'){
      const run=await needRun();const decision=loadFile();
      let artifact=null;
      if(!args['no-artifact'])artifact=putArtifact(projectRoot,{kind:'design-decision',content:JSON.stringify(decision,null,2)+'\n',runId:run.run_id,stage:run.state,sourceRevision:gitSha(projectRoot),filename:'design-decision.json'});
      const out=recordDesignDecision(ROOT,projectRoot,run,decision,{artifactRef:artifact?.artifact_id||null});
      if(out.recorded&&artifact){run.artifacts=[...new Set([...(run.artifacts||[]),artifact.artifact_id])];saveRun(projectRoot,run);}
      print({...out,artifact});
      if(!out.recorded)process.exitCode=1;
    }
    else throw new Error(`unknown design subcommand ${sub}`);
  },
  plan:async ctx=>{
    const {args,ROOT,projectRoot,print,needRun}=ctx;
    const sub=args._[1]||'validate';
    const {validateTaskPlan,computeTaskGraph,computeReadySets,computeCoverage,computeScopeConflicts,findCycles}=await import('../plan-validator.mjs');
    const {putArtifact,saveRun}=await import('../store.mjs');
    const {recordTaskPlan}=await import('../orchestrator.mjs');
    const loadFile=()=>{if(!args.file)throw new Error('--file required');return readJson(path.resolve(args.file));};
    if(sub==='validate'){
      const v=validateTaskPlan(loadFile(),{...(args.profile?{profile:args.profile}:{})});
      print(v);if(!v.valid)process.exitCode=1;
    }
    else if(sub==='graph'){
      const plan=loadFile();
      print({...computeTaskGraph(plan),cycles:findCycles(plan),...computeReadySets(plan),coverage:computeCoverage(plan),conflicts:computeScopeConflicts(plan)});
    }
    else if(sub==='record'){
      const run=await needRun();const plan=loadFile();
      let artifact=null;
      if(!args['no-artifact'])artifact=putArtifact(projectRoot,{kind:'task-plan',content:JSON.stringify(plan,null,2)+'\n',runId:run.run_id,stage:run.state,sourceRevision:gitSha(projectRoot),filename:'task-plan.json'});
      const out=recordTaskPlan(ROOT,projectRoot,run,plan,{artifactRef:artifact?.artifact_id||null});
      if(out.recorded&&artifact){run.artifacts=[...new Set([...(run.artifacts||[]),artifact.artifact_id])];saveRun(projectRoot,run);}
      print({...out,artifact});
      if(!out.recorded)process.exitCode=1;
    }
    else throw new Error(`unknown plan subcommand ${sub}`);
  }
};
