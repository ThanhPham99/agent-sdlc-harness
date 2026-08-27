// Project setup and environment reporting.
//
// Handlers are data: each takes the CLI context and prints its own result.
// Extracting them from the dispatcher is what makes them reachable from a test
// without spawning a process. Everything heavy is still imported inside the
// handler that needs it, so a single command loads only its own dependencies.
import fs from 'node:fs';
import path from 'node:path';
import {readJson} from '../util.mjs';

export const commands={
  init:async ctx=>{
    const {projectRoot,print}=ctx;
    const {detectProject}=await import('../init.mjs');
    const {initProject}=await import('../store.mjs');
    const cfg=detectProject(projectRoot);
    initProject(projectRoot,cfg);
    print({status:'INITIALIZED',project_root:projectRoot,config:cfg});
  },
  doctor:async ctx=>{
    const {ROOT,projectRoot,print}=ctx;
    const {capabilities,probe}=await import('../provider.mjs');
    const {resolveConfig}=await import('../config.mjs');
    const {activationStatus}=await import('../activation.mjs');
    const codexBootstrap=await import('../codex-bootstrap.mjs');
    const proj=fs.existsSync(path.join(projectRoot,'.agent-sdlc','project.json'))?'READY':'NOT_INITIALIZED';
    print({
      version:readJson(path.join(ROOT,'agent-sdlc.manifest.json')).version,
      node:process.version,
      project:proj,
      providers:['claude','codex','antigravity'].map(h=>capabilities(h,probe(h))),
      auto_activation:['claude','codex','antigravity'].map(h=>{
        const s=activationStatus({host:h,config:resolveConfig(projectRoot).effective,codexManagedBootstrap:h==='codex'?codexBootstrap.status({}):null});
        return {host:h,enabled:s.enabled,delivery_mode:s.delivery_mode,activation_class:s.activation_class,rough_tokens:s.rough_tokens};
      })
    });
  },
  'config-show':async ctx=>{
    const {args,projectRoot,print}=ctx;
    const {resolveConfig}=await import('../config.mjs');
    print(resolveConfig(projectRoot,{...(args.provider?{default_provider:args.provider}:{}),...(args.profile?{risk_profile:args.profile}:{})}));
  },
  'compat-check':async ctx=>{
    const {ROOT,projectRoot,print}=ctx;
    const {compatCheck}=await import('../compat.mjs');
    print(compatCheck(ROOT,projectRoot));
  },
  migrate:async ctx=>{
    const {ROOT,projectRoot,print}=ctx;
    const {migrateState}=await import('../compat.mjs');
    print(migrateState(ROOT,projectRoot));
  },
  knowledge:async ctx=>{
    const {args,projectRoot,print}=ctx;
    const sub=args._[1]||'status';
    const {getProjectKnowledgeStatus}=await import('../project-knowledge.mjs');
    if(sub==='status')print(getProjectKnowledgeStatus(projectRoot));
    else throw new Error(`unknown knowledge subcommand ${sub}`);
  }
};
