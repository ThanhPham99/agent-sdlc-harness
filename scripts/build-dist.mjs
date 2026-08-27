#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {zipDir} from './archive.mjs';
import {getActivationPolicy,bootstrapHash,estimateBootstrapCost} from '../runtime/activation.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const manifest=JSON.parse(fs.readFileSync(path.join(ROOT,'agent-sdlc.manifest.json'),'utf8'));
const skillRegistry=JSON.parse(fs.readFileSync(path.join(ROOT,'config','skills.json'),'utf8'));
const dist=path.join(ROOT,'dist');
const activationPolicy=getActivationPolicy();

fs.rmSync(dist,{recursive:true,force:true});
fs.mkdirSync(dist,{recursive:true});

// Never place internal skills under a host-native `skills/` discovery root.
// Only the two public entry skills are discoverable. Internal stage guidance is
// copied under harness/internal-skills and referenced by a generated registry.
// The canonical tool registry lives at config/tools.json; there is no top-level
// tools/ directory to copy.
const common=['bin','runtime','protocol','config','policies','prompts','workflows','roles','templates','overlays','docs','agent-sdlc.manifest.json'];
function cp(src,dst){
  const from=path.join(ROOT,src);
  if(!fs.existsSync(from))throw new Error(`build input missing: ${src}`);
  fs.cpSync(from,path.join(dst,src),{recursive:true});
}
function copyInternalSkills(out){
  const internalDir=path.join(out,'harness','internal-skills');
  fs.mkdirSync(internalDir,{recursive:true});
  const generated=structuredClone(skillRegistry);
  for(const [id,spec] of Object.entries(generated.internal||{})){
    const src=path.join(ROOT,spec.instructions);
    if(!fs.existsSync(src))throw new Error(`missing internal skill instructions for ${id}: ${spec.instructions}`);
    const basename=`${id}.md`;
    fs.copyFileSync(src,path.join(internalDir,basename));
    spec.instructions=`harness/internal-skills/${basename}`;
  }
  fs.writeFileSync(path.join(out,'config','skills.json'),JSON.stringify(generated,null,2)+'\n');
}
function host(name){
  const out=path.join(dist,`agent-sdlc-${name}-${manifest.version}`);
  fs.mkdirSync(out,{recursive:true});
  for(const c of common)cp(c,out);
  copyInternalSkills(out);
  fs.mkdirSync(path.join(out,'skills'),{recursive:true});
  for(const pub of ['sdlc-router','sdlc-orchestrator']){
    fs.cpSync(path.join(ROOT,'skills',pub),path.join(out,'skills',pub),{recursive:true});
  }
  fs.copyFileSync(path.join(ROOT,'README.md'),path.join(out,'README.md'));
  fs.copyFileSync(path.join(ROOT,'VERSION'),path.join(out,'VERSION'));
  if(fs.existsSync(path.join(ROOT,'LICENSE')))fs.copyFileSync(path.join(ROOT,'LICENSE'),path.join(out,'LICENSE'));
  if(fs.existsSync(path.join(ROOT,'SECURITY.md')))fs.copyFileSync(path.join(ROOT,'SECURITY.md'),path.join(out,'SECURITY.md'));
  if(fs.existsSync(path.join(ROOT,'CONTRIBUTING.md')))fs.copyFileSync(path.join(ROOT,'CONTRIBUTING.md'),path.join(out,'CONTRIBUTING.md'));
  if(fs.existsSync(path.join(ROOT,'CHANGELOG.md')))fs.copyFileSync(path.join(ROOT,'CHANGELOG.md'),path.join(out,'CHANGELOG.md'));
  return out;
}

let c=host('claude');
fs.mkdirSync(path.join(c,'.claude-plugin'),{recursive:true});
fs.copyFileSync(path.join(ROOT,'adapters/claude/plugin.json'),path.join(c,'.claude-plugin','plugin.json'));
fs.copyFileSync(path.join(ROOT,'adapters/claude/.mcp.json'),path.join(c,'.mcp.json'));
if(fs.existsSync(path.join(ROOT,'commands'))){
  fs.mkdirSync(path.join(c,'commands'),{recursive:true});
  fs.cpSync(path.join(ROOT,'commands'),path.join(c,'commands'),{recursive:true});
}
fs.mkdirSync(path.join(c,'hooks'),{recursive:true});
fs.copyFileSync(path.join(ROOT,'adapters/claude/hooks.json'),path.join(c,'hooks','hooks.json'));
fs.copyFileSync(path.join(ROOT,'adapters/hooks/pretool-guard.mjs'),path.join(c,'hooks','pretool-guard.mjs'));
fs.copyFileSync(path.join(ROOT,'adapters/hooks/test-output-guard.mjs'),path.join(c,'hooks','test-output-guard.mjs'));
fs.copyFileSync(path.join(ROOT,'adapters/hooks/statusline.mjs'),path.join(c,'hooks','statusline.mjs'));
// Auto-activation bootstrap: SessionStart re-delivers the compact invariant on
// startup/resume/clear/compact/fork without preloading any skill body.
fs.copyFileSync(path.join(ROOT,'adapters/hooks/claude-session-start.mjs'),path.join(c,'hooks','claude-session-start.mjs'));
fs.mkdirSync(path.join(c,'agents'),{recursive:true});
fs.copyFileSync(path.join(ROOT,'adapters/common-scoped-investigator.md'),path.join(c,'agents','scoped-investigator.md'));
fs.copyFileSync(path.join(ROOT,'adapters/common-independent-reviewer.md'),path.join(c,'agents','independent-reviewer.md'));

let x=host('codex');
fs.mkdirSync(path.join(x,'.codex-plugin'),{recursive:true});
fs.copyFileSync(path.join(ROOT,'adapters/codex/plugin.json'),path.join(x,'.codex-plugin','plugin.json'));
fs.copyFileSync(path.join(ROOT,'adapters/codex/.mcp.json'),path.join(x,'.mcp.json'));
fs.mkdirSync(path.join(x,'hooks'),{recursive:true});
fs.copyFileSync(path.join(ROOT,'adapters/codex/hooks.json'),path.join(x,'hooks','hooks.json'));
fs.copyFileSync(path.join(ROOT,'adapters/hooks/pretool-guard.mjs'),path.join(x,'hooks','pretool-guard.mjs'));
fs.copyFileSync(path.join(ROOT,'adapters/hooks/test-output-guard.mjs'),path.join(x,'hooks','test-output-guard.mjs'));

let a=host('antigravity');
fs.copyFileSync(path.join(ROOT,'adapters/antigravity/plugin.json'),path.join(a,'plugin.json'));
fs.copyFileSync(path.join(ROOT,'adapters/antigravity/mcp_config.json'),path.join(a,'mcp_config.json'));
fs.copyFileSync(path.join(ROOT,'adapters/antigravity/hooks.json'),path.join(a,'hooks.json'));
fs.mkdirSync(path.join(a,'hooks'),{recursive:true});
fs.copyFileSync(path.join(ROOT,'adapters/hooks/antigravity-preinvocation.mjs'),path.join(a,'hooks','antigravity-preinvocation.mjs'));
fs.mkdirSync(path.join(a,'agents','scoped-investigator'),{recursive:true});
fs.copyFileSync(path.join(ROOT,'adapters/common-scoped-investigator.md'),path.join(a,'agents','scoped-investigator','agent.md'));
fs.mkdirSync(path.join(a,'agents','independent-reviewer'),{recursive:true});
fs.copyFileSync(path.join(ROOT,'adapters/common-independent-reviewer.md'),path.join(a,'agents','independent-reviewer','agent.md'));
fs.mkdirSync(path.join(a,'rules'),{recursive:true});
fs.copyFileSync(path.join(ROOT,'adapters/antigravity/rules.md'),path.join(a,'rules','agent-sdlc.md'));

let archiver=null;
for(const name of ['claude','codex','antigravity']){
  const dir=path.join(dist,`agent-sdlc-${name}-${manifest.version}`);
  const zip=path.join(dist,`agent-sdlc-${name}-${manifest.version}.zip`);
  archiver=zipDir(dir,zip).tool;
}
console.log(JSON.stringify({status:'BUILT',version:manifest.version,dist,public_discovery_skills:2,internal_skills:Object.keys(skillRegistry.internal||{}).length,archiver,bootstrap:{version:activationPolicy.bootstrap_version,hash:bootstrapHash(),rough_tokens:estimateBootstrapCost().rough_tokens}},null,2));
