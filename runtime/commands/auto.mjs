// Automated SDLC Runner & CI Guard command handlers.
import path from 'node:path';
import {truthy} from '../util.mjs';

export const commands={
  auto:async ctx=>{
    const {args,ROOT,projectRoot,print,needRun}=ctx;
    let run;
    const rawObjective=args.objective||(args._?.length>1?args._.slice(1).join(' '):null);
    const objective=rawObjective&&!['status','check'].includes(rawObjective.trim())?rawObjective.trim():null;

    if(objective){
      const fs=await import('node:fs');
      const {detectProject}=await import('../init.mjs');
      const {initProject,loadRun}=await import('../store.mjs');
      const {route,routeSemantic}=await import('../router.mjs');
      const {newRun}=await import('../orchestrator.mjs');
      const {resolveFeatureBinding}=await import('../features.mjs');

      if(!fs.existsSync(path.join(projectRoot,'.agent-sdlc','project.json'))){
        initProject(projectRoot,detectProject(projectRoot));
      }
      const isSemantic=truthy(args.semantic)||truthy(args.ai);
      const r=isSemantic
        ?await routeSemantic(ROOT,objective,args.workflow||null,args.profile||null,{semantic:true,provider:args.provider||'auto'})
        :route(ROOT,objective,args.workflow||null,args.profile||null);

      const skipBinding=r.workflow==='new-feature'&&!args['feature-id']&&!truthy(args['track-feature']);
      const binding=skipBinding?{featureId:null,phaseId:null}:resolveFeatureBinding(projectRoot,
        {workflow:r.workflow,featureId:args['feature-id']||null,phaseId:args['phase-id']||null,title:args['feature-title']||objective});
      run=newRun(ROOT,projectRoot,{
        objective,route:r,featureId:binding.featureId,phaseId:binding.phaseId,
        parentRunId:args['parent-run-id']||null,runKind:args['run-kind']||null
      });
    }else{
      run=await needRun();
    }

    if(truthy(args.approve)||args['approve-gate']||args['grant-ticket']){
      const {grantApprovalTicket}=await import('../approvals.mjs');
      const {loadRun}=await import('../store.mjs');
      const targetTicketId=args['grant-ticket']||args['ticket-id'];
      const pendingTickets=(run.approval_tickets||[]).filter(t=>t.status==='PENDING');
      const ticketToGrant=targetTicketId
        ?pendingTickets.find(t=>t.ticket_id===targetTicketId)
        :pendingTickets.at(-1);

      if(ticketToGrant){
        grantApprovalTicket(ROOT,projectRoot,run,{
          ticketId:ticketToGrant.ticket_id,
          actor:args.actor||'USER_INTERACTIVE',
          reason:args.reason||`Approved ticket ${ticketToGrant.ticket_id} via auto --approve`
        });
        run=loadRun(projectRoot,run.run_id);
      }
    }

    const {runAutoPipeline}=await import('../autonomous-runner.mjs');
    const result=runAutoPipeline(ROOT,projectRoot,run,{
      spawnWorker:!truthy(args['no-worker']),
      spawnReviewer:!truthy(args['no-reviewer']),
      skipCiCheck:truthy(args['skip-ci'])
    });
    print(result);
  },
  'auto-task':async ctx=>{
    const {args,ROOT,projectRoot,print,needRun}=ctx;
    const run=await needRun();
    const {runAutoTaskLoop}=await import('../autonomous-runner.mjs');
    const result=runAutoTaskLoop(ROOT,projectRoot,run,{
      customWriter:args.writer||null,
      spawnWorker:!truthy(args['no-worker']),
      spawnReviewer:!truthy(args['no-reviewer'])
    });
    print(result);
  },
  'ci-check':async ctx=>{
    const {args,ROOT,projectRoot,print,needRun}=ctx;
    const run=await needRun();
    const {runLocalCiValidation,detectProjectCi}=await import('../ci-guard.mjs');
    const detection=detectProjectCi(projectRoot);
    if(args.detect){
      print(detection);
      return;
    }
    const result=runLocalCiValidation(ROOT,projectRoot,run,{
      commandOverride:args.command?String(args.command).split(' '):null
    });
    print(result);
    if(!result.is_pass)process.exitCode=1;
  }
};
