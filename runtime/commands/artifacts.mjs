// Content-addressed artifacts, handoffs, normalization and replay.
//
// Handlers are data: each takes the CLI context and prints its own result.
// Extracting them from the dispatcher is what makes them reachable from a test
// without spawning a process. Everything heavy is still imported inside the
// handler that needs it, so a single command loads only its own dependencies.
import fs from 'node:fs';
import path from 'node:path';
import {readJson,writeJson,gitSha} from '../util.mjs';

export const commands={
  'artifact-put':async ctx=>{
    const {args,projectRoot,print,needRun}=ctx;
    const {putArtifact,saveRun,emit}=await import('../store.mjs');
    const content=args.file?fs.readFileSync(path.resolve(args.file),'utf8'):String(args.content||'');
    const run=args['run-id']?await needRun():null;
    const a=putArtifact(projectRoot,{kind:args.kind||'generic',content,runId:run?.run_id||null,stage:run?.state||null,sourceRevision:gitSha(projectRoot),filename:args.file?path.basename(args.file):null});
    if(run){run.artifacts=[...new Set([...(run.artifacts||[]),a.artifact_id])];saveRun(projectRoot,run);emit(projectRoot,run,{type:'artifact.created',artifact_refs:[a.artifact_id],payload:{kind:a.kind}});}
    print(a);
  },
  'artifact-get':async ctx=>{
    const {projectRoot,print,need}=ctx;
    const ref=need('ref');
    const {getArtifact}=await import('../store.mjs');
    print(getArtifact(projectRoot,ref));
  },
  'artifact-list':async ctx=>{
    const {projectRoot,print}=ctx;
    const {listArtifacts}=await import('../store.mjs');
    print(listArtifacts(projectRoot));
  },
  'handoff-put':async ctx=>{
    const {args,projectRoot,print,needRun}=ctx;
    const run=await needRun();
    const {putHandoff}=await import('../handoff.mjs');
    const payload=args.file?JSON.parse(fs.readFileSync(path.resolve(args.file),'utf8')):{summary:args.summary||'',verified_facts:args.verified?String(args.verified).split('|').filter(Boolean):[],unknowns:args.unknowns?String(args.unknowns).split('|').filter(Boolean):[],next_action:args.next||null};
    print(putHandoff(projectRoot,run,payload));
  },
  'handoff-get':async ctx=>{
    const {projectRoot,print,need}=ctx;
    const {getHandoff}=await import('../handoff.mjs');
    print(getHandoff(projectRoot,need('id')));
  },
  'handoff-list':async ctx=>{
    const {args,projectRoot,print}=ctx;
    const {listHandoffs}=await import('../handoff.mjs');
    print(listHandoffs(projectRoot,args['run-id']||null));
  },
  normalize:async ctx=>{
    const {args,projectRoot,print,needRun}=ctx;
    if(!args.file)throw new Error('--file required');
    const {normalizeInput}=await import('../normalize.mjs');
    const {putArtifact,saveRun,emit}=await import('../store.mjs');
    const n=normalizeInput(path.resolve(args.file),{maxBytes:Number(args['max-bytes']||20*1024*1024)});
    let artifact=null;
    if(args['run-id']&&n.status==='NORMALIZED'){
      const run=await needRun();
      artifact=putArtifact(projectRoot,{kind:'normalized-requirement',content:n.markdown,runId:run.run_id,stage:run.state,sourceRevision:gitSha(projectRoot),filename:path.basename(args.file)+'.md'});
      run.artifacts=[...new Set([...(run.artifacts||[]),artifact.artifact_id])];
      saveRun(projectRoot,run);
      emit(projectRoot,run,{type:'input.normalized',artifact_refs:[artifact.artifact_id],payload:{source_type:n.source_type,source_sha256:n.source_sha256}});
    }
    if(args.output&&n.markdown)fs.writeFileSync(path.resolve(args.output),n.markdown);
    print({...n,artifact});
  },
  'replay-export':async ctx=>{
    const {args,projectRoot,print,needRun}=ctx;
    const run=await needRun();
    const {exportReplay}=await import('../replay.mjs');
    const b=exportReplay(projectRoot,run);
    if(args.output)writeJson(path.resolve(args.output),b);
    print(b);
  },
  'replay-validate':async ctx=>{
    const {print,need}=ctx;
    const {validateReplay}=await import('../replay.mjs');
    print(validateReplay(readJson(path.resolve(need('file')))));
  }
};
