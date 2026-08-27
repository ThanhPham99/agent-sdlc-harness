// Feature/phase identity and requirement deltas.
//
// Handlers are data: each takes the CLI context and prints its own result.
// Extracting them from the dispatcher is what makes them reachable from a test
// without spawning a process. Everything heavy is still imported inside the
// handler that needs it, so a single command loads only its own dependencies.
import {truthy} from '../util.mjs';

export const commands={
  feature:async ctx=>{
    const {args,projectRoot,print}=ctx;
    const sub=args._[1]||'list';
    const {createFeature,loadFeature,updateFeature,listFeatures,createPhase,loadPhase,updatePhase,listPhases,resolveActiveFeature}=await import('../features.mjs');
    if(sub==='create')print(createFeature(projectRoot,{title:args.title,workflowFamily:args.workflow||'new-feature',sourceRefs:args['source-refs']?String(args['source-refs']).split(','):[]}));
    else if(sub==='show'){
      if(!args['feature-id'])throw new Error('--feature-id required');
      print(loadFeature(projectRoot,args['feature-id']));
    }
    else if(sub==='list')print(listFeatures(projectRoot));
    else if(sub==='active')print(resolveActiveFeature(projectRoot,{featureId:args['feature-id']||null}));
    else if(sub==='update'){
      if(!args['feature-id'])throw new Error('--feature-id required');
      const patch={};
      if(args.status)patch.status=args.status;
      if(args['open-questions'])patch.open_questions=String(args['open-questions']).split(',');
      if(args['deferred-items'])patch.deferred_items=String(args['deferred-items']).split(',');
      print(updateFeature(projectRoot,args['feature-id'],patch));
    }
    else if(sub==='phase-create'){
      if(!args['feature-id'])throw new Error('--feature-id required');
      print(createPhase(projectRoot,args['feature-id'],{name:args.name||null,objective:args.objective||null}));
    }
    else if(sub==='phase-show'){
      if(!args['feature-id']||!args['phase-id'])throw new Error('--feature-id and --phase-id required');
      print(loadPhase(projectRoot,args['feature-id'],args['phase-id']));
    }
    else if(sub==='phase-list'){
      if(!args['feature-id'])throw new Error('--feature-id required');
      print(listPhases(projectRoot,args['feature-id']));
    }
    else if(sub==='phase-complete'){
      if(!args['feature-id']||!args['phase-id'])throw new Error('--feature-id and --phase-id required');
      print(updatePhase(projectRoot,args['feature-id'],args['phase-id'],{status:'COMPLETE',completed_at:new Date().toISOString()}));
    }
    else throw new Error(`unknown feature subcommand ${sub}`);
  },
  'requirement-update':async ctx=>{
    const {args,projectRoot,print,needRun}=ctx;
    const sub=args._[1]||'show';
    const {planRequirementUpdate,loadRequirementUpdatePlan}=await import('../requirement-update.mjs');
    if(sub==='plan'){
      const run=await needRun();
      const plan=planRequirementUpdate(projectRoot,run,{continuesRunId:args.continues,nodeId:args.node,
        deltaClass:args.delta||'BEHAVIOR_CHANGE',reason:args.reason||'requirement update',dryRun:truthy(args['dry-run'])});
      print(plan);
    }
    else if(sub==='show'){const r=await needRun();print(loadRequirementUpdatePlan(projectRoot,r.run_id)||{status:'NO_PLAN_RECORDED'});}
    else throw new Error(`unknown requirement-update subcommand ${sub}`);
  }
};
