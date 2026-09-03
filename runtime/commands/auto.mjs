// Automated SDLC Runner & CI Guard command handlers.
import path from 'node:path';
import {truthy} from '../util.mjs';

export const commands={
  auto:async ctx=>{
    const {args,ROOT,projectRoot,print,needRun}=ctx;
    const run=await needRun();
    const {runAutoPipeline}=await import('../autonomous-runner.mjs');
    const result=runAutoPipeline(ROOT,projectRoot,run,{
      skipCiCheck:truthy(args['skip-ci'])
    });
    print(result);
  },
  'auto-task':async ctx=>{
    const {args,ROOT,projectRoot,print,needRun}=ctx;
    const run=await needRun();
    const {runAutoTaskLoop}=await import('../autonomous-runner.mjs');
    const result=runAutoTaskLoop(ROOT,projectRoot,run,{
      customWriter:args.writer||null
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
