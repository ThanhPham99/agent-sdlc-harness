// Auto-activation policy and per-host bootstrap.
//
// Handlers are data: each takes the CLI context and prints its own result.
// Extracting them from the dispatcher is what makes them reachable from a test
// without spawning a process. Everything heavy is still imported inside the
// handler that needs it, so a single command loads only its own dependencies.
import fs from 'node:fs';
import path from 'node:path';
import {readJson,writeJson,appendJsonl,globalConfigPath} from '../util.mjs';

export const commands={
  activation:async ctx=>{
    const {args,ROOT,projectRoot,print}=ctx;
    const sub=args._[1]||'status';
    const version=readJson(path.join(ROOT,'agent-sdlc.manifest.json')).version;
    const {resolveConfig}=await import('../config.mjs');
    const {activationStatus,getBootstrapInstruction,getActivationPolicy,estimateBootstrapCost,classifyActivationFixture,buildActivationEvent,ACTIVATION_EVENTS}=await import('../activation.mjs');
    const codexBootstrap=await import('../codex-bootstrap.mjs');
    const cfg=()=>resolveConfig(projectRoot).effective;
    const codexState=host=>host==='codex'?codexBootstrap.status({home:args['codex-home']||null,version}):null;
    const setEnabled=(value)=>{
      const target=args.global?globalConfigPath():path.join(projectRoot,'.agent-sdlc','project.json');
      const current=fs.existsSync(target)?readJson(target):{};
      current.auto_activation={...(current.auto_activation||{}),enabled:value};
      writeJson(target,current);
      return {status:value?'ENABLED':'DISABLED',scope:args.global?'global':'project',config_file:target,note:`environment ${getActivationPolicy().env_override} still overrides this layer`};
    };
    if(sub==='status')print(activationStatus({host:args.host||'unknown',config:cfg(),codexManagedBootstrap:codexState(args.host),version}));
    else if(sub==='print-bootstrap')print(getBootstrapInstruction());
    else if(sub==='policy')print(getActivationPolicy());
    else if(sub==='cost')print({schema:'agent-sdlc/bootstrap-budget/v1',...estimateBootstrapCost(),budget:getActivationPolicy().max_bootstrap_rough_tokens});
    else if(sub==='enable')print(setEnabled(true));
    else if(sub==='disable')print(setEnabled(false));
    else if(sub==='classify')print(classifyActivationFixture({prompt:args.prompt||args._.slice(2).join(' '),repositoryContext:{repository_target:!!args['repository-target']}}));
    else if(sub==='events')print({schema:'agent-sdlc/activation-events/v1',events:ACTIVATION_EVENTS});
    else if(sub==='record'){
      const ev={...buildActivationEvent(args.event||'activation.bootstrap_delivered',{host:args.host||null,delivery_mode:args['delivery-mode']||null,reason:args.reason||null,run_id:args['run-id']||null,fixture_id:args.fixture||null}),timestamp:new Date().toISOString()};
      const p=path.join(projectRoot,'.agent-sdlc','activation.jsonl');
      if(!args['dry-run'])appendJsonl(p,ev);
      print({status:args['dry-run']?'DRY_RUN':'RECORDED',log:p,event:ev});
    }
    else if(sub==='doctor'){
      const hosts=args.host?[args.host]:['claude','codex','antigravity'];
      print({schema:'agent-sdlc/activation-doctor/v1',version,bootstrap:{...estimateBootstrapCost(),text:getBootstrapInstruction()},hosts:hosts.map(h=>({...activationStatus({host:h,config:cfg(),codexManagedBootstrap:codexState(h),version}),...(h==='codex'?{codex_managed_bootstrap:codexBootstrap.status({home:args['codex-home']||null,version})}:{})}))});
    }
    else if(sub==='codex-bootstrap'){
      const action=args._[2]||'status';
      const opts={home:args['codex-home']||null,version,dryRun:!!args['dry-run']};
      if(action==='install')print(codexBootstrap.install(opts));
      else if(action==='uninstall')print(codexBootstrap.uninstall(opts));
      else print(codexBootstrap.status(opts));
    }
    else throw new Error(`unknown activation subcommand ${sub}`);
  }
};
