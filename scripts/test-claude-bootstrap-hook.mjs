#!/usr/bin/env node
// Simulates Claude Code SessionStart events against the packaged hook.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {BOOTSTRAP_TEXT,getActivationPolicy,estimateBootstrapCost} from '../runtime/activation.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const policy=getActivationPolicy();
const rows=[];let fail=0;
const test=(name,fn)=>{try{fn();rows.push({name,status:'PASS'});}catch(e){fail++;rows.push({name,status:'FAIL',error:e.message});}};
const assert=(v,m)=>{if(!v)throw new Error(m);};

function runHook(hookPath,payload,env={}){
  const r=spawnSync(process.execPath,[hookPath],{input:JSON.stringify(payload),encoding:'utf8',timeout:10000,env:{...process.env,AGENT_SDLC_AUTO_ACTIVATE:'',AGENT_SDLC_AUTO_ACTIVATE_ENFORCED:'',...env}});
  return {exit:r.status,stdout:(r.stdout||'').trim(),stderr:(r.stderr||'').trim()};
}
const HOOKS=['adapters/hooks/claude-session-start.mjs','hooks/claude-session-start.mjs'].map(p=>path.join(ROOT,p));

for(const hook of HOOKS){
  const label=path.relative(ROOT,hook).split(path.sep).join('/');
  for(const source of policy.hosts.claude.reinjection_sources){
    test(`${label}:${source}-delivers-bootstrap`,()=>{
      const r=runHook(hook,{hook_event_name:'SessionStart',session_start_reason:source,cwd:ROOT});
      assert(r.exit===0,`exit ${r.exit}: ${r.stderr}`);
      const out=JSON.parse(r.stdout);
      assert(out.hookSpecificOutput?.hookEventName==='SessionStart','wrong hookEventName');
      assert(out.hookSpecificOutput?.additionalContext===BOOTSTRAP_TEXT,'additionalContext is not the canonical bootstrap');
      assert(Object.keys(out).length===1,'hook emitted fields beyond hookSpecificOutput');
      assert(!r.stderr,`hook wrote diagnostics: ${r.stderr}`);
    });
  }
  test(`${label}:unknown-source-is-silent`,()=>{
    const r=runHook(hook,{hook_event_name:'SessionStart',session_start_reason:'subagent'});
    assert(r.exit===0&&r.stdout==='',`unexpected output: ${r.stdout}`);
  });
  test(`${label}:malformed-stdin-is-safe`,()=>{
    const r=spawnSync(process.execPath,[hook],{input:'not json',encoding:'utf8',timeout:10000});
    assert(r.status===0,`exit ${r.status}`);
    const out=JSON.parse((r.stdout||'').trim());
    assert(out.hookSpecificOutput.additionalContext===BOOTSTRAP_TEXT,'default startup path broken');
  });
  test(`${label}:env-disable-emits-nothing`,()=>{
    for(const value of ['0','false','off']){
      const r=runHook(hook,{session_start_reason:'startup'},{AGENT_SDLC_AUTO_ACTIVATE:value});
      assert(r.exit===0&&r.stdout==='',`disabled hook emitted: ${r.stdout}`);
    }
    const enforced=runHook(hook,{session_start_reason:'startup'},{AGENT_SDLC_AUTO_ACTIVATE_ENFORCED:'0'});
    assert(enforced.stdout==='','enforced disable ignored');
  });
  test(`${label}:no-repo-read-no-network-no-install`,()=>{
    const code=fs.readFileSync(hook,'utf8').split('\n').filter(l=>!l.trim().startsWith('//')).join('\n');
    for(const forbidden of ['readFileSync','readdirSync','fetch(','http','npm ','execSync','spawnSync','child_process'])
      assert(!code.includes(forbidden),`hook references ${forbidden}`);
  });
  test(`${label}:fast-and-small`,()=>{
    const start=Date.now();
    runHook(hook,{session_start_reason:'startup'});
    const ms=Date.now()-start;
    assert(ms<5000,`hook took ${ms}ms, exceeding the 5s hook timeout`);
    assert(estimateBootstrapCost().rough_tokens<=policy.hosts.claude.max_bootstrap_rough_tokens,'bootstrap over Claude budget');
  });
}

test('claude-hooks-json-declares-sessionstart-and-pretooluse',()=>{
  const cfg=JSON.parse(fs.readFileSync(path.join(ROOT,'adapters','claude','hooks.json'),'utf8'));
  const ss=cfg.hooks?.SessionStart?.[0];
  assert(ss,'SessionStart missing');
  for(const source of policy.hosts.claude.reinjection_sources)assert(ss.matcher.includes(source),`matcher missing ${source}`);
  assert(ss.hooks[0].command.includes('hooks/claude-session-start.mjs'),'wrong SessionStart command');
  assert(ss.hooks[0].timeout<=5,'SessionStart timeout too generous');
  const guard=cfg.hooks?.PreToolUse?.[0];
  assert(guard?.hooks?.[0]?.command.includes('pretool-guard.mjs'),'destructive-command guard lost');
  // The matcher must cover every shell-capable tool the host exposes, not just
  // Bash: a Windows session drives PowerShell, and an unmatched tool bypasses
  // the guard entirely. scripts/validate-guard.mjs enforces the same property
  // against the guard corpus.
  for(const tool of ['Bash','PowerShell'])
    assert(new RegExp(`^(?:${guard.matcher})$`).test(tool),`guard matcher does not cover ${tool}`);
});

const report={schema:'agent-sdlc/claude-bootstrap-hook-test/v1',checks:rows.length,passes:rows.length-fail,failures:fail,status:fail?'FAIL':'PASS',results:rows};
console.log(JSON.stringify(report,null,2));
process.exit(fail?1:0);
