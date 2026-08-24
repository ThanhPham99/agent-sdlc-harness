#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {execFileSync,spawnSync} from 'node:child_process';

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
function immediateDirs(dir){return fs.readdirSync(dir,{withFileTypes:true}).filter(x=>x.isDirectory()).map(x=>x.name).sort();}

const packageDigests={};
for(const host of hosts){
  const zip=path.join(DIST,`agent-sdlc-${host}-${version}.zip`);
  check(host,'zip-exists',()=>{if(!fs.existsSync(zip))throw Error('missing zip');packageDigests[path.basename(zip)]=sha256File(zip);return {bytes:fs.statSync(zip).size,sha256:packageDigests[path.basename(zip)]};});
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),`agent-sdlc-dist-${host}-`));
  try{
    execFileSync('unzip',['-q',zip,'-d',tmp]);
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
    check(host,'cli-route-smoke',()=>{
      const out=jsonCmd(path.join(root,'bin','agent-sdlc'),['route','--objective','Perform a database migration'],root);
      if(out.workflow!=='database-migration')throw Error(JSON.stringify(out));
      return {workflow:out.workflow,profile:out.profile};
    });
    check(host,'cli-context-smoke',()=>{
      const proj=fs.mkdtempSync(path.join(os.tmpdir(),`agent-sdlc-proj-${host}-`));
      execFileSync('git',['init','-q'],{cwd:proj});
      fs.writeFileSync(path.join(proj,'README.md'),'fixture\n');
      execFileSync('git',['add','.'],{cwd:proj});
      execFileSync('git',['-c','user.email=fixture@example.test','-c','user.name=fixture','commit','-qm','init'],{cwd:proj});
      jsonCmd(path.join(root,'bin','agent-sdlc'),['init','--project',proj],proj);
      const run=jsonCmd(path.join(root,'bin','agent-sdlc'),['start','--project',proj,'--objective','Add idempotent refund processing'],proj);
      const ctx=jsonCmd(path.join(root,'bin','agent-sdlc'),['context','--project',proj,'--run-id',run.run_id],proj);
      if(ctx.context_budget_status!=='WITHIN_BUDGET')throw Error(`context ${ctx.context_budget_status}`);
      if(!ctx.skill_instructions?.length)throw Error('internal skill instructions not resolved from packaged layout');
      return {state:run.state,estimated_tokens:ctx.estimated_tokens,skills:ctx.skills.map(x=>x.id)};
    });
    check(host,'doctor-smoke',()=>{
      const d=jsonCmd(path.join(root,'bin','agent-sdlc'),['doctor'],root);
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
  `- Live host qualification: **not established by this static/offline validation**`,'',
  '## Package SHA-256','',
  ...sumLines.map(x=>`- \`${x}\``),'',
  '## Important boundary','',
  'This report validates the packaged tree, isolated CLI smoke flows, internal-skill progressive disclosure, manifests and checksums. It does not claim real Claude Code, Codex or Antigravity behavioral qualification; that requires the corresponding installed/authenticated host CLI.'
].join('\n');
fs.writeFileSync(path.join(DIST,'DISTRIBUTION-VALIDATION.md'),md+'\n');
console.log(JSON.stringify(report,null,2));
process.exit(failures?1:0);
