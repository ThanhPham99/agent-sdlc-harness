#!/usr/bin/env node
// Simulates Antigravity PreInvocation events against the packaged hook.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {BOOTSTRAP_TEXT,getActivationPolicy,estimateBootstrapCost} from '../runtime/activation.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const policy=getActivationPolicy();
const budget=policy.hosts.antigravity.max_bootstrap_rough_tokens;
const rows=[];let fail=0;
const test=(name,fn)=>{try{fn();rows.push({name,status:'PASS'});}catch(e){fail++;rows.push({name,status:'FAIL',error:e.message});}};
const assert=(v,m)=>{if(!v)throw new Error(m);};
function runHook(hook,payload,env={}){
  const r=spawnSync(process.execPath,[hook],{input:JSON.stringify(payload),encoding:'utf8',timeout:10000,env:{...process.env,AGENT_SDLC_AUTO_ACTIVATE:'',AGENT_SDLC_AUTO_ACTIVATE_ENFORCED:'',...env}});
  return {exit:r.status,stdout:(r.stdout||'').trim(),stderr:(r.stderr||'').trim()};
}
const HOOKS=['adapters/hooks/antigravity-preinvocation.mjs','hooks/antigravity-preinvocation.mjs'].map(p=>path.join(ROOT,p));

test('root-and-adapter-hooks-are-byte-identical',()=>{
  const [a,b]=HOOKS.map(p=>fs.readFileSync(p,'utf8'));
  assert(a===b,'root and adapter Antigravity hooks have diverged; run scripts/gen-activation-assets.mjs');
});

for(const hook of HOOKS){
  const label=path.relative(ROOT,hook).split(path.sep).join('/');
  for(const payload of [{},{invocation:'user_prompt'},{workflow_active:true},{workflow_active:false}]){
    test(`${label}:auto-routing-invariant:${JSON.stringify(payload)}`,()=>{
      const r=runHook(hook,payload);
      assert(r.exit===0,`exit ${r.exit}: ${r.stderr}`);
      const out=JSON.parse(r.stdout);
      const msg=out.injectSteps?.[0]?.ephemeralMessage;
      assert(msg===BOOTSTRAP_TEXT,'ephemeralMessage is not the canonical bootstrap');
      // The alpha3 reminder only referenced an already-active workflow; alpha4 must route.
      assert(/sdlc-router/.test(msg)&&/sdlc-orchestrator/.test(msg),'hook does not carry auto-routing semantics');
      assert(!/active sdlc workflow/i.test(msg),'stale active-workflow-only reminder');
      assert(out.injectSteps.length===1&&Object.keys(out).length===1,'hook emitted extra steps or fields');
    });
  }
  test(`${label}:within-per-invocation-budget`,()=>{
    const cost=estimateBootstrapCost();
    assert(cost.rough_tokens<=budget,`${cost.rough_tokens} > ${budget}`);
  });
  test(`${label}:env-disable-emits-nothing`,()=>{
    assert(runHook(hook,{},{AGENT_SDLC_AUTO_ACTIVATE:'0'}).stdout==='','disabled hook still injected');
    assert(runHook(hook,{},{AGENT_SDLC_AUTO_ACTIVATE_ENFORCED:'0'}).stdout==='','enforced disable ignored');
  });
  test(`${label}:no-permission-widening`,()=>{
    const code=fs.readFileSync(hook,'utf8').split('\n').filter(l=>!l.trim().startsWith('//')).join('\n');
    for(const forbidden of ['permission','allowedTools','sandbox','autoApprove','readFileSync','child_process','fetch('])
      assert(!code.includes(forbidden),`hook references ${forbidden}`);
    const out=JSON.parse(runHook(hook,{}).stdout);
    assert(!('permissions' in out)&&!('tools' in out),'hook output attempts to change permissions');
  });
}

test('antigravity-hooks-json-wires-preinvocation',()=>{
  for(const rel of ['adapters/antigravity/hooks.json','hooks.json']){
    const cfg=JSON.parse(fs.readFileSync(path.join(ROOT,rel),'utf8'));
    const entries=Object.values(cfg).flatMap(v=>v.PreInvocation||[]);
    assert(entries.length===1,`${rel}: expected exactly one PreInvocation hook`);
    assert(entries[0].command.includes('antigravity-preinvocation.mjs'),`${rel}: wrong command`);
    assert(entries[0].timeout<=5,`${rel}: timeout too generous for a per-invocation hook`);
  }
});
test('antigravity-rule-carries-auto-activation',()=>{
  for(const rel of ['rules/agent-sdlc.md','adapters/antigravity/rules.md']){
    const text=fs.readFileSync(path.join(ROOT,rel),'utf8');
    assert(text.includes(BOOTSTRAP_TEXT),`${rel} lacks the canonical bootstrap`);
  }
});

const report={schema:'agent-sdlc/antigravity-bootstrap-hook-test/v1',per_invocation_budget_rough_tokens:budget,checks:rows.length,passes:rows.length-fail,failures:fail,status:fail?'FAIL':'PASS',results:rows};
console.log(JSON.stringify(report,null,2));
process.exit(fail?1:0);
