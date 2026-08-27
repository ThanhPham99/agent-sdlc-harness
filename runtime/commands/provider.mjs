// Host provider probing, invocation and fallback.
//
// Handlers are data: each takes the CLI context and prints its own result.
// Extracting them from the dispatcher is what makes them reachable from a test
// without spawning a process. Everything heavy is still imported inside the
// handler that needs it, so a single command loads only its own dependencies.
import path from 'node:path';

export const commands={
  'provider-probe':async ctx=>{
    const {args,print}=ctx;
    const {probe,capabilities}=await import('../provider.mjs');
    const hosts=args.host?[args.host]:['claude','codex','antigravity'];
    print(hosts.map(h=>{const p=probe(h);return capabilities(h,p);}));
  },
  'provider-command':async ctx=>{
    const {ROOT,projectRoot,print,needRun,need}=ctx;
    const run=await needRun();
    const host=need('host');
    const {buildContext,renderPrompt}=await import('../context.mjs');
    const {buildInvocation}=await import('../provider.mjs');
    const m=buildContext(ROOT,projectRoot,run,{artifactRefs:run.artifacts||[]});
    const prompt=renderPrompt(ROOT,m);
    print(buildInvocation(host,prompt,path.join(ROOT,'protocol','schemas','StageResult.schema.json'),{maxTurns:8,maxWallMs:900000,stage:run.state}));
  },
  'provider-run':async ctx=>{
    const {ROOT,projectRoot,print,needRun,need}=ctx;
    const run=await needRun();
    const host=need('host');
    const {buildContext,renderPrompt}=await import('../context.mjs');
    const {runHost}=await import('../provider.mjs');
    const {emit}=await import('../store.mjs');
    const m=buildContext(ROOT,projectRoot,run,{artifactRefs:run.artifacts||[]});
    const prompt=renderPrompt(ROOT,m);
    const started=Date.now();
    const out=runHost(host,prompt,path.join(ROOT,'protocol','schemas','StageResult.schema.json'),{maxTurns:8,maxWallMs:900000,stage:run.state});
    emit(projectRoot,run,{type:'provider.completed',provider:host,payload:{status:out.status,exit_code:out.exit_code??null},usage:{wall_ms:Date.now()-started}});
    print(out);
  },
  fallback:async ctx=>{
    const {args,ROOT,projectRoot,print,needRun,need}=ctx;
    const run=await needRun();
    const {resumeFromCheckpoint}=await import('../task-runner.mjs');
    print(resumeFromCheckpoint(ROOT,projectRoot,run,need('task-id'),{
      originalProvider:args.from||null,fallbackProvider:args.to||null,
      failureClass:args['failure-class']||'PROVIDER_FAILURE',reason:args.reason||null
    }));
  }
};
