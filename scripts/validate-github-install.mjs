#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {BOOTSTRAP_TEXT as bootstrapText,estimateBootstrapCost} from '../runtime/activation.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const activationCost=estimateBootstrapCost();
const readJson=(p)=>JSON.parse(fs.readFileSync(path.join(ROOT,p),'utf8'));
const exists=(p)=>fs.existsSync(path.join(ROOT,p));
const checks=[];
function check(id,fn){try{fn();checks.push({id,status:'PASS'});}catch(e){checks.push({id,status:'FAIL',detail:String(e.message||e)});}}
function assert(v,msg){if(!v)throw new Error(msg);}

const version=fs.readFileSync(path.join(ROOT,'VERSION'),'utf8').trim();
const manifest=readJson('agent-sdlc.manifest.json');
const claude=readJson('.claude-plugin/plugin.json');
const claudeMarket=readJson('.claude-plugin/marketplace.json');
const codex=readJson('.codex-plugin/plugin.json');
const codexMarket=readJson('.agents/plugins/marketplace.json');
const agy=readJson('plugin.json');

check('version-sync',()=>{
  for(const [name,v] of Object.entries({package:readJson('package.json').version,canonical:manifest.version,claude:claude.version,codex:codex.version,claude_market:claudeMarket.plugins?.[0]?.version})) assert(v===version,`${name}=${v} != ${version}`);
});
check('public-skills-exactly-two',()=>{
  const dirs=fs.readdirSync(path.join(ROOT,'skills'),{withFileTypes:true}).filter(x=>x.isDirectory()&&exists(`skills/${x.name}/SKILL.md`)).map(x=>x.name).sort();
  assert(JSON.stringify(dirs)===JSON.stringify(['sdlc-orchestrator','sdlc-router']),`discoverable skills=${dirs.join(',')}`);
});
check('internal-skills-outside-native-root',()=>{
  assert(exists('harness/internal-skills/requirements.md'),'internal skills missing');
  const nested=[];
  for(const name of fs.readdirSync(path.join(ROOT,'skills'))) if(name==='internal'||name==='public') nested.push(name);
  assert(nested.length===0,`legacy discovery dirs remain: ${nested}`);
});
check('claude-marketplace-same-root',()=>{
  assert(claudeMarket.name==='agent-sdlc-github','wrong Claude marketplace name');
  assert(claudeMarket.plugins?.length===1,'Claude marketplace must expose one plugin');
  assert(claudeMarket.plugins[0].source==='./','Claude marketplace source must be ./');
  assert(claudeMarket.plugins[0].name==='agent-sdlc-harness','wrong Claude plugin name');
});
check('claude-component-paths',()=>{
  for(const p of [claude.skills,claude.hooks,claude.mcpServers,...(claude.agents||[])]) assert(exists(p.replace(/^\.\//,'')),`missing Claude path ${p}`);
});
check('codex-marketplace-same-root',()=>{
  const p=codexMarket.plugins?.[0];
  assert(codexMarket.name==='agent-sdlc-github','wrong Codex marketplace name');
  assert(p?.name==='agent-sdlc-harness','wrong Codex plugin name');
  assert(p?.source?.source==='local'&&p?.source?.path==='.',`unexpected Codex same-root source ${JSON.stringify(p?.source)}`);
  assert(p?.policy?.installation==='AVAILABLE','Codex install policy missing');
  assert(p?.policy?.authentication==='ON_INSTALL','Codex auth policy missing');
});
check('codex-component-paths',()=>{
  assert(codex.skills==='./skills/','Codex skills root must be ./skills/');
  assert(exists(codex.mcpServers.replace(/^\.\//,'')),`missing Codex MCP ${codex.mcpServers}`);
  assert(!Object.prototype.hasOwnProperty.call(codex,'hooks'),'Codex manifest intentionally omits hooks until validator contract is stable');
});
check('antigravity-root-schema',()=>{
  assert(agy.$schema==='https://antigravity.google/schemas/v1/plugin.json','wrong Antigravity schema');
  const allowed=new Set(['$schema','name','description']);
  assert(Object.keys(agy).every(k=>allowed.has(k)),`Antigravity manifest has unsupported keys: ${Object.keys(agy).filter(k=>!allowed.has(k))}`);
  for(const p of ['mcp_config.json','hooks.json','skills/sdlc-router/SKILL.md','skills/sdlc-orchestrator/SKILL.md','agents/scoped-investigator/agent.md','agents/independent-reviewer/agent.md','rules/agent-sdlc.md']) assert(exists(p),`missing Antigravity root component ${p}`);
});
check('installers-present',()=>{
  for(const p of ['install.sh','update.sh','uninstall.sh','install.ps1']) assert(exists(p),`missing ${p}`);
});
check('github-workflows-present',()=>{
  for(const p of ['.github/workflows/ci.yml','.github/workflows/release.yml','.github/workflows/live-qualification.yml']) assert(exists(p),`missing ${p}`);
});
check('no-version-stale-in-public-manifests',()=>{
  for(const p of ['.claude-plugin/plugin.json','.claude-plugin/marketplace.json','.codex-plugin/plugin.json','skills/sdlc-router/SKILL.md','skills/sdlc-orchestrator/SKILL.md']) {
    const t=fs.readFileSync(path.join(ROOT,p),'utf8');
    for(const stale of ['3.0.0-alpha2','3.0.0-alpha3'])assert(!t.includes(stale),`${p} still references ${stale}`);
  }
});
check('auto-activation-contract-present',()=>{
  for(const p of ['policies/auto-activation.json','runtime/activation.mjs','runtime/codex-bootstrap.mjs','scripts/codex-bootstrap.mjs','scripts/gen-activation-assets.mjs','docs/AUTO-ACTIVATION.md']) assert(exists(p),`missing ${p}`);
  const policy=readJson('policies/auto-activation.json');
  assert(policy.public_entry_skill==='sdlc-router'&&policy.next_skill==='sdlc-orchestrator','wrong activation entry chain');
  assert(activationCost.rough_tokens<=policy.max_bootstrap_rough_tokens,`bootstrap ${activationCost.rough_tokens} > ${policy.max_bootstrap_rough_tokens}`);
  for(const [host,h] of Object.entries(policy.hosts)) assert(activationCost.rough_tokens<=h.max_bootstrap_rough_tokens,`bootstrap over ${host} budget`);
});
check('claude-hooks-sessionstart-and-pretooluse',()=>{
  const cfg=readJson('adapters/claude/hooks.json');
  const ss=cfg.hooks?.SessionStart?.[0];
  assert(ss,'SessionStart hook missing');
  for(const source of readJson('policies/auto-activation.json').hosts.claude.reinjection_sources) assert(ss.matcher.includes(source),`SessionStart matcher missing ${source}`);
  assert(ss.hooks?.[0]?.command.includes('hooks/claude-session-start.mjs'),'SessionStart command path wrong');
  assert(cfg.hooks?.PreToolUse?.[0]?.hooks?.[0]?.command.includes('hooks/pretool-guard.mjs'),'destructive-command guard removed');
  // Same-root GitHub installs resolve ${CLAUDE_PLUGIN_ROOT}/hooks/<file>.
  for(const p of ['hooks/claude-session-start.mjs','hooks/pretool-guard.mjs']) assert(exists(p),`missing mirrored hook ${p}`);
});
check('antigravity-hook-auto-bootstrap-semantics',()=>{
  for(const p of ['hooks/antigravity-preinvocation.mjs','adapters/hooks/antigravity-preinvocation.mjs','rules/agent-sdlc.md','adapters/antigravity/rules.md']){
    const t=fs.readFileSync(path.join(ROOT,p),'utf8');
    assert(t.includes(bootstrapText),`${p} lacks the canonical auto-activation bootstrap`);
    assert(!/active sdlc workflow/i.test(t),`${p} still carries the alpha3 active-workflow-only reminder`);
  }
});
check('generated-activation-assets-are-current',()=>{
  const r=spawnSync(process.execPath,[path.join(ROOT,'scripts','gen-activation-assets.mjs')],{encoding:'utf8'});
  assert(r.status===0,`generator failed: ${r.stderr}`);
  const changed=JSON.parse(r.stdout).outputs.filter(x=>x.changed).map(x=>x.file);
  assert(!changed.length,`generated assets were stale: ${changed.join(', ')}`);
});
check('installers-expose-auto-activation-options',()=>{
  const sh=fs.readFileSync(path.join(ROOT,'install.sh'),'utf8');
  const ps=fs.readFileSync(path.join(ROOT,'install.ps1'),'utf8');
  const un=fs.readFileSync(path.join(ROOT,'uninstall.sh'),'utf8');
  for(const flag of ['--auto-activate','--no-auto-activate','--dry-run']) assert(sh.includes(flag),`install.sh missing ${flag}`);
  for(const param of ['AutoActivate','NoAutoActivate','DryRun']) assert(ps.includes(param),`install.ps1 missing ${param}`);
  assert(sh.includes('codex-bootstrap.mjs')&&ps.includes('codex-bootstrap.mjs'),'installers do not manage the Codex bootstrap');
  assert(un.includes('codex-bootstrap.mjs'),'uninstall.sh does not remove the managed Codex bootstrap');
});
check('no-unsupported-codex-hook-claim',()=>{
  assert(!Object.prototype.hasOwnProperty.call(codex,'hooks'),'Codex manifest must not claim hooks');
  const exp=readJson('evals/activation/provider-expectations.json');
  assert(exp.hosts.codex.offline_activation_class==='SOFT','Codex activation must be labelled soft offline');
});
check('activation-eval-corpus-present',()=>{
  for(const p of ['evals/activation/deterministic-cases.json','evals/activation/multi-turn-cases.json','evals/activation/adversarial-cases.json','evals/activation/provider-expectations.json']) assert(exists(p),`missing ${p}`);
  assert(readJson('evals/activation/deterministic-cases.json').cases.length>=30,'deterministic activation corpus too small');
});

const failed=checks.filter(x=>x.status==='FAIL');
const out={schema:'agent-sdlc/github-install-validation/v1',version,checks:checks.length,passes:checks.length-failed.length,failures:failed.length,results:checks};
console.log(JSON.stringify(out,null,2));
process.exit(failed.length?1:0);
