#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {execFileSync,spawnSync} from 'node:child_process';
import {unzipTo} from './archive.mjs';
import {BOOTSTRAP_TEXT,bootstrapHash,getActivationPolicy,estimateBootstrapCost} from '../runtime/activation.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const DIST=path.join(ROOT,'dist');
const manifest=JSON.parse(fs.readFileSync(path.join(ROOT,'agent-sdlc.manifest.json'),'utf8'));
const version=manifest.version;
const hosts=['claude','codex','antigravity'];
const sha256File=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const rows=[];
let failures=0;
function check(host,id,fn){
  try{const detail=fn();rows.push({host,id,status:'PASS',...(detail?{detail}:{})});}
  catch(e){failures++;rows.push({host,id,status:'FAIL',detail:e.message});}
}
function jsonCmd(bin,args,cwd){
  const r=spawnSync(bin,args,{cwd,encoding:'utf8',timeout:15000,maxBuffer:5*1024*1024});
  if(r.status!==0)throw new Error((r.stderr||r.stdout||`exit ${r.status}`).trim().slice(0,1200));
  return JSON.parse(r.stdout.trim());
}
// The POSIX shell entrypoint is not executable on Windows; fall back to the same
// CLI module the entrypoint execs so the packaged tree is verifiable everywhere.
function cli(root,args,cwd){
  return process.platform==='win32'
    ? jsonCmd(process.execPath,[path.join(root,'runtime','cli.mjs'),...args],cwd)
    : jsonCmd(path.join(root,'bin','agent-sdlc'),args,cwd);
}
function immediateDirs(dir){return fs.readdirSync(dir,{withFileTypes:true}).filter(x=>x.isDirectory()).map(x=>x.name).sort();}

const packageDigests={};
for(const host of hosts){
  const zip=path.join(DIST,`agent-sdlc-${host}-${version}.zip`);
  check(host,'zip-exists',()=>{if(!fs.existsSync(zip))throw Error('missing zip');packageDigests[path.basename(zip)]=sha256File(zip);return {bytes:fs.statSync(zip).size,sha256:packageDigests[path.basename(zip)]};});
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),`agent-sdlc-dist-${host}-`));
  try{
    unzipTo(zip,tmp);
    const root=path.join(tmp,`agent-sdlc-${host}-${version}`);
    check(host,'package-root',()=>{if(!fs.existsSync(root))throw Error('expected package root missing');});
    check(host,'manifest-version',()=>{const m=JSON.parse(fs.readFileSync(path.join(root,'agent-sdlc.manifest.json'),'utf8'));if(m.version!==version)throw Error(`${m.version} != ${version}`);});
    check(host,'public-discovery-surface',()=>{
      const dirs=immediateDirs(path.join(root,'skills'));
      const expected=['sdlc-orchestrator','sdlc-router'];
      if(JSON.stringify(dirs)!==JSON.stringify(expected))throw Error(`skills root contains ${dirs.join(', ')}`);
      for(const d of expected)if(!fs.existsSync(path.join(root,'skills',d,'SKILL.md')))throw Error(`missing ${d}/SKILL.md`);
      if(fs.existsSync(path.join(root,'skills','internal')))throw Error('internal skills exposed under native discovery root');
      return {skills:dirs};
    });
    check(host,'internal-skill-registry',()=>{
      const reg=JSON.parse(fs.readFileSync(path.join(root,'config','skills.json'),'utf8'));
      const internal=Object.values(reg.internal||{});
      if(internal.length!==18)throw Error(`expected 18 internal skills, got ${internal.length}`);
      for(const s of internal){
        if(!s.instructions.startsWith('harness/internal-skills/'))throw Error(`unsafe discovery path: ${s.instructions}`);
        if(!fs.existsSync(path.join(root,s.instructions)))throw Error(`missing ${s.instructions}`);
      }
      return {internal_skills:internal.length};
    });
    check(host,'native-adapter-assets',()=>{
      const required=host==='claude'?['.claude-plugin/plugin.json','.mcp.json','hooks/hooks.json']:
        host==='codex'?['.codex-plugin/plugin.json','.mcp.json','hooks/hooks.json']:
        ['plugin.json','mcp_config.json','hooks.json','rules/agent-sdlc.md'];
      for(const rel of required)if(!fs.existsSync(path.join(root,rel)))throw Error(`missing ${rel}`);
      for(const rel of required.filter(x=>x.endsWith('.json')))JSON.parse(fs.readFileSync(path.join(root,rel),'utf8'));
      return {required};
    });
    check(host,'auto-activation-assets',()=>{
      const policy=getActivationPolicy();
      const required=host==='claude'?['hooks/hooks.json','hooks/claude-session-start.mjs','hooks/pretool-guard.mjs']:
        host==='antigravity'?['hooks.json','hooks/antigravity-preinvocation.mjs','rules/agent-sdlc.md']:
        ['policies/auto-activation.json','runtime/codex-bootstrap.mjs'];
      for(const rel of required){
        const p=path.join(root,rel);
        if(!fs.existsSync(p))throw Error(`missing bootstrap asset ${rel}`);
        if(rel.endsWith('.mjs')||rel.endsWith('.md')){
          const text=fs.readFileSync(p,'utf8');
          if(rel.includes('session-start')||rel.includes('preinvocation')||rel.endsWith('rules/agent-sdlc.md')){
            if(!text.includes(BOOTSTRAP_TEXT))throw Error(`${rel} does not carry the canonical bootstrap text`);
          }
        }
      }
      if(host==='claude'){
        const cfg=JSON.parse(fs.readFileSync(path.join(root,'hooks','hooks.json'),'utf8'));
        const ss=cfg.hooks?.SessionStart?.[0];
        if(!ss)throw Error('packaged Claude hooks.json lacks SessionStart');
        for(const source of policy.hosts.claude.reinjection_sources)if(!ss.matcher.includes(source))throw Error(`SessionStart matcher missing ${source}`);
        if(!cfg.hooks?.PreToolUse?.length)throw Error('packaged Claude hooks.json lost the destructive-command guard');
      }
      const cost=estimateBootstrapCost();
      const budget=policy.hosts[host].max_bootstrap_rough_tokens;
      if(cost.rough_tokens>budget)throw Error(`bootstrap ${cost.rough_tokens} rough tokens over ${host} budget ${budget}`);
      return {required,bootstrap_hash:bootstrapHash(),rough_tokens:cost.rough_tokens,budget_rough_tokens:budget};
    });
    check(host,'activation-status-smoke',()=>{
      // A throwaway CODEX_HOME keeps the check independent of the developer's own bootstrap state.
      const codexHome=fs.mkdtempSync(path.join(os.tmpdir(),'agent-sdlc-verify-codex-'));
      const out=cli(root,['activation','status','--host',host,'--codex-home',codexHome],root);
      fs.rmSync(codexHome,{recursive:true,force:true});
      if(out.schema!=='agent-sdlc/activation-status/v1')throw Error(JSON.stringify(out));
      if(out.version!==version)throw Error(`activation status version ${out.version}`);
      if(out.strong_activation!==false)throw Error('packaged CLI claims strong activation without live evidence');
      const expected=getActivationPolicy().hosts[host];
      if(out.delivery_mode!==expected.delivery_mode)throw Error(`delivery_mode ${out.delivery_mode}`);
      return {delivery_mode:out.delivery_mode,activation_class:out.activation_class,rough_tokens:out.rough_tokens};
    });
    check(host,'cli-route-smoke',()=>{
      const out=cli(root,['route','--objective','Perform a database migration'],root);
      if(out.workflow!=='database-migration')throw Error(JSON.stringify(out));
      return {workflow:out.workflow,profile:out.profile};
    });
    check(host,'cli-context-smoke',()=>{
      const proj=fs.mkdtempSync(path.join(os.tmpdir(),`agent-sdlc-proj-${host}-`));
      execFileSync('git',['init','-q'],{cwd:proj});
      fs.writeFileSync(path.join(proj,'README.md'),'fixture\n');
      execFileSync('git',['add','.'],{cwd:proj});
      execFileSync('git',['-c','user.email=fixture@example.test','-c','user.name=fixture','commit','-qm','init'],{cwd:proj});
      cli(root,['init','--project',proj],proj);
      const run=cli(root,['start','--project',proj,'--objective','Add idempotent refund processing'],proj);
      const ctx=cli(root,['context','--project',proj,'--run-id',run.run_id],proj);
      if(ctx.context_budget_status!=='WITHIN_BUDGET')throw Error(`context ${ctx.context_budget_status}`);
      if(!ctx.skill_instructions?.length)throw Error('internal skill instructions not resolved from packaged layout');
      return {state:run.state,estimated_tokens:ctx.estimated_tokens,skills:ctx.skills.map(x=>x.id)};
    });
    check(host,'doctor-smoke',()=>{
      const d=cli(root,['doctor'],root);
      if(d.version!==version)throw Error('doctor version mismatch');
      if(!Array.isArray(d.providers)||d.providers.length!==3)throw Error('provider probe missing');
      return {providers:d.providers.map(x=>({host:x.host,available:x.available,version:x.version}))};
    });
  } finally {fs.rmSync(tmp,{recursive:true,force:true});}
}

const report={
  schema:'agent-sdlc/distribution-validation/v1',
  version,
  generated_at:new Date().toISOString(),
  hosts,
  checks:rows.length,
  passes:rows.filter(x=>x.status==='PASS').length,
  failures,
  package_sha256:packageDigests,
  auto_activation:{bootstrap_version:getActivationPolicy().bootstrap_version,bootstrap_hash:bootstrapHash(),...estimateBootstrapCost(),strong_activation:false,strong_activation_evidence:'NOT_ESTABLISHED_BY_OFFLINE_VALIDATION'},
  live_host_qualification:'NOT_ESTABLISHED_BY_STATIC_VALIDATION',
  results:rows
};
fs.writeFileSync(path.join(DIST,'DISTRIBUTION-VALIDATION.json'),JSON.stringify(report,null,2)+'\n');
const sumLines=Object.entries(packageDigests).sort().map(([name,hash])=>`${hash}  ${name}`);
fs.writeFileSync(path.join(DIST,'SHA256SUMS.txt'),sumLines.join('\n')+'\n');
const md=[
  `# Distribution Validation — ${version}`,'',
  `- Checks: **${report.checks}**`,
  `- Pass: **${report.passes}**`,
  `- Fail: **${report.failures}**`,
  `- Public native discovery skills: **2**`,
  `- Internal on-demand skills: **18**`,
  `- Auto-activation bootstrap: **${estimateBootstrapCost().rough_tokens} rough tokens** (\`${bootstrapHash()}\`)`,
  `- Strong activation: **not established by this offline validation**`,
  `- Live host qualification: **not established by this static/offline validation**`,'',
  '## Package SHA-256','',
  ...sumLines.map(x=>`- \`${x}\``),'',
  '## Important boundary','',
  'This report validates the packaged tree, isolated CLI smoke flows, internal-skill progressive disclosure, manifests and checksums. It does not claim real Claude Code, Codex or Antigravity behavioral qualification; that requires the corresponding installed/authenticated host CLI.'
].join('\n');
fs.writeFileSync(path.join(DIST,'DISTRIBUTION-VALIDATION.md'),md+'\n');
console.log(JSON.stringify(report,null,2));
process.exit(failures?1:0);
