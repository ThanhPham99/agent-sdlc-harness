// Repository intelligence and traceability.
//
// Handlers are data: each takes the CLI context and prints its own result.
// Extracting them from the dispatcher is what makes them reachable from a test
// without spawning a process. Everything heavy is still imported inside the
// handler that needs it, so a single command loads only its own dependencies.
import path from 'node:path';
import {readJson,gitSha,truthy} from '../util.mjs';

export const commands={
  repo:async ctx=>{
    const {args,projectRoot,print}=ctx;
    const sub=args._[1]||'status';
    const {openIntelligence,findSymbol,findReferences,findTestsForSymbol,findTestsForFiles,findModuleBoundary,findDependents,findPublicInterfaces,findDataEntities,findEventContracts,findRecentChanges,getMinimalChangeSurface,findTransitiveImpact,findImpactedTests}=await import('../repo-intelligence.mjs');
    const {buildIndex,loadIndex,indexStale,detectCapability}=await import('../repo-index.mjs');
    const intel=()=>openIntelligence(projectRoot,{refresh:!!args.refresh});
    const paths=()=>args.paths?String(args.paths).split(',').map(s=>s.trim()).filter(Boolean):(args.path?[args.path]:[]);
    if(sub==='index'){const idx=buildIndex(projectRoot,{force:truthy(args.force)});print({schema:idx.schema,revision:idx.revision,capability:idx.capability,counts:idx.counts,built_at:idx.built_at});}
    else if(sub==='status'){const idx=loadIndex(projectRoot,{build:false});print({indexed:!!idx,capability:detectCapability(projectRoot),counts:idx?.counts||null,revision:idx?.revision||null,stale:indexStale(projectRoot,idx)});}
    else if(sub==='capability')print(detectCapability(projectRoot));
    else if(sub==='symbol')print(findSymbol(intel(),args.name||args._[2]));
    else if(sub==='references')print(findReferences(intel(),args.name||args._[2]));
    else if(sub==='tests')print(args.name?findTestsForSymbol(intel(),args.name):findTestsForFiles(intel(),paths()));
    else if(sub==='impact')print(findTransitiveImpact(intel(),{paths:paths(),symbols:args.symbol?[args.symbol]:(args.symbols?String(args.symbols).split(','):[]),maxDepth:Number(args.depth||10)}));
    else if(sub==='impacted-tests')print(findImpactedTests(intel(),{paths:paths(),symbols:args.symbol?[args.symbol]:(args.symbols?String(args.symbols).split(','):[]),maxDepth:Number(args.depth||10)}));
    else if(sub==='module')print(findModuleBoundary(intel(),args.path||args._[2]));
    else if(sub==='dependents')print(findDependents(intel(),args.path||args._[2],{maxDepth:Number(args.depth||3)}));
    else if(sub==='interfaces')print(findPublicInterfaces(intel(),paths()));
    else if(sub==='entities')print(findDataEntities(intel(),paths()));
    else if(sub==='events')print(findEventContracts(intel(),paths()));
    else if(sub==='recent')print(findRecentChanges(intel(),paths(),{limit:Number(args.limit||50),since:String(args.since||'30')}));
    else if(sub==='surface')print(getMinimalChangeSurface(intel(),args.objective||args._.slice(2).join(' ')));
    else if(sub==='mutate'){
      const targetFile=args.file||args._[2];
      if(!targetFile)throw new Error('--file <path> required for mutation analysis');
      const {runMutationSuite}=await import('../mutation.mjs');
      print(runMutationSuite(projectRoot,{targetFile,maxMutants:Number(args['max-mutants']||15)}));
    }
    else if(sub==='dead-code'){
      const {findDeadCode}=await import('../dead-code.mjs');
      print(findDeadCode(projectRoot,{openIntel:intel()}));
    }
    else throw new Error(`unknown repo subcommand ${sub}`);
  },
  trace:async ctx=>{
    const {args,projectRoot,print,needRun}=ctx;
    const sub=args._[1]||'show';
    const {buildTraceabilityGraph,loadTraceabilityGraph,validateTraceabilityGraph,computeTraceCoverage,computeInvalidationClosure,applyInvalidation,invalidationHistory,DELTA_CLASSES,NODE_KINDS,EDGE_KINDS}=await import('../traceability.mjs');
    const need=async()=>{const r=await needRun();const g=loadTraceabilityGraph(projectRoot,r.run_id);if(!g)throw new Error('no traceability graph; run `trace build` first');return g;};
    if(sub==='build'){
      const run=await needRun();
      const design=args.design?[readJson(path.resolve(args.design))].flat():[];
      const release=args.release?readJson(path.resolve(args.release)):null;
      const g=buildTraceabilityGraph(projectRoot,run.run_id,{run,revision:gitSha(projectRoot),designDecisions:design,release});
      print({schema:g.schema,run_id:g.run_id,nodes:g.nodes.length,edges:g.edges.length,validation:validateTraceabilityGraph(g)});
    }
    else if(sub==='show'){
      const g=await need();
      if(args.mermaid){
        const {renderTraceabilityMermaid}=await import('../traceability.mjs');
        print(renderTraceabilityMermaid(g));
      } else {
        print(g);
      }
    }
    else if(sub==='kinds')print({node_kinds:NODE_KINDS,edge_kinds:EDGE_KINDS,delta_classes:DELTA_CLASSES});
    else if(sub==='validate'){const v=validateTraceabilityGraph(await need());print(v);if(!v.valid)process.exitCode=1;}
    else if(sub==='coverage')print(computeTraceCoverage(await need()));
    else if(sub==='closure'){
      if(!args.node)throw new Error('--node required (e.g. ACCEPTANCE_CRITERION:AC-001)');
      print(computeInvalidationClosure(await need(),args.node,args.delta||'BEHAVIOR_CHANGE'));
    }
    else if(sub==='invalidate'){
      if(!args.node)throw new Error('--node required');
      const run=await needRun();const g=await need();
      const closure=computeInvalidationClosure(g,args.node,args.delta||'BEHAVIOR_CHANGE');
      if(args['dry-run'])print(closure);
      else print(applyInvalidation(projectRoot,g,closure,{reason:args.reason||'upstream change'}));
    }
    else if(sub==='history'){const r=await needRun();print(invalidationHistory(projectRoot,r.run_id));}
    else throw new Error(`unknown trace subcommand ${sub}`);
  }
};
