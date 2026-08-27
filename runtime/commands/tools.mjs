// The tool gateway and the cost ledger.
//
// Handlers are data: each takes the CLI context and prints its own result.
// Extracting them from the dispatcher is what makes them reachable from a test
// without spawning a process. Everything heavy is still imported inside the
// handler that needs it, so a single command loads only its own dependencies.


export const commands={
  'tool-check':async ctx=>{
    const {ROOT,print,needRun,need}=ctx;
    const run=await needRun();
    const tool=need('tool');
    const {checkTool}=await import('../policy.mjs');
    print(checkTool(ROOT,run,tool));
  },
  'tool-run':async ctx=>{
    const {args,ROOT,projectRoot,print,needRun,need}=ctx;
    const run=await needRun();
    const tool=need('tool');
    const {invokeTool}=await import('../tools.mjs');
    const a=args.args?JSON.parse(args.args):{};
    print(invokeTool(ROOT,projectRoot,run,tool,a));
  },
  'usage-add':async ctx=>{
    const {args,projectRoot,print,needRun}=ctx;
    const run=await needRun();
    const {addUsage}=await import('../cost.mjs');
    print(addUsage(projectRoot,run,{provider:args.provider,model:args.model,input_tokens:args.input||0,cached_input_tokens:args.cached||0,output_tokens:args.output||0,reasoning_tokens:args.reasoning||0,wall_ms:args['wall-ms']||0,source:args.source}));
  },
  'usage-report':async ctx=>{
    const {args,projectRoot,print}=ctx;
    const {reportUsage}=await import('../cost.mjs');
    print(reportUsage(projectRoot,args['run-id']));
  },
  'model-route':async ctx=>{
    const {args,ROOT,projectRoot,print,needRun}=ctx;
    const run=await needRun();
    const {routeModel}=await import('../model-router.mjs');
    print(routeModel(ROOT,projectRoot,run,{task:args.task||'stage',provider:args.provider||'auto',requireStructured:!!args.structured}));
  }
};
