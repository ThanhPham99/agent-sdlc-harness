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
    const {driftStatus}=await import('../dev-link.mjs');
    const proj=fs.existsSync(path.join(projectRoot,'.agent-sdlc','project.json'))?'READY':'NOT_INITIALIZED';
    const version=readJson(path.join(ROOT,'agent-sdlc.manifest.json')).version;
    // Claude Code loads this plugin from its own cache directory, not from
    // ROOT directly. A cache left behind after a `git pull` here loads a
    // stale version silently -- this session once ran alpha4 skill bodies
    // against an alpha6 tree without anything saying so. `doctor` is the
    // thing an operator already runs to sanity-check the environment, so the
    // same drift check that `dev:status` reports on request runs here too.
    const dev_link=driftStatus(ROOT,version);
    print({
      version,
      node:process.version,
      project:proj,
      providers:['claude','codex','antigravity'].map(h=>capabilities(h,probe(h))),
      auto_activation:['claude','codex','antigravity'].map(h=>{
        const s=activationStatus({host:h,config:resolveConfig(projectRoot).effective,codexManagedBootstrap:h==='codex'?codexBootstrap.status({}):null});
        return {host:h,enabled:s.enabled,delivery_mode:s.delivery_mode,activation_class:s.activation_class,rough_tokens:s.rough_tokens};
      }),
      dev_link:{host_record_present:dev_link.host_record_present,plugins:dev_link.plugins,...(dev_link.hint?{hint:dev_link.hint}:{})}
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
  },
  gc:async ctx=>{
    const {args,projectRoot,print}=ctx;
    const sub=args._[1]||'status';
    const {planGc,applyGc}=await import('../retention.mjs');
    // Never based on age alone from the CLI either: `--run-id` still requires
    // the run to be terminal, planGc just skips the age check for it.
    const olderThanDays=args['older-than-days']!==undefined?Number(args['older-than-days']):30;
    const runId=args['run-id']||null;
    const plan=planGc(projectRoot,{olderThanDays,runId});
    if(sub==='status')print(plan);
    else if(sub==='apply')print(applyGc(projectRoot,plan));
    else throw new Error(`unknown gc subcommand ${sub}`);
  }
};
