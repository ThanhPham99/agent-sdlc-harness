#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const manifest=JSON.parse(fs.readFileSync(path.join(ROOT,'agent-sdlc.manifest.json'),'utf8'));
const skillRegistry=JSON.parse(fs.readFileSync(path.join(ROOT,'config','skills.json'),'utf8'));
const dist=path.join(ROOT,'dist');

fs.rmSync(dist,{recursive:true,force:true});
fs.mkdirSync(dist,{recursive:true});

// Never place internal skills under a host-native `skills/` discovery root.
// Only the two public entry skills are discoverable. Internal stage guidance is
// copied under harness/internal-skills and referenced by a generated registry.
const common=['bin','runtime','protocol','config','policies','prompts','workflows','roles','tools','templates','overlays','docs','agent-sdlc.manifest.json'];
function cp(src,dst){fs.cpSync(path.join(ROOT,src),path.join(dst,src),{recursive:true});}
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
  return out;
}

let c=host('claude');
fs.mkdirSync(path.join(c,'.claude-plugin'),{recursive:true});
fs.copyFileSync(path.join(ROOT,'adapters/claude/plugin.json'),path.join(c,'.claude-plugin','plugin.json'));
fs.copyFileSync(path.join(ROOT,'adapters/claude/.mcp.json'),path.join(c,'.mcp.json'));
fs.mkdirSync(path.join(c,'hooks'),{recursive:true});
fs.copyFileSync(path.join(ROOT,'adapters/claude/hooks.json'),path.join(c,'hooks','hooks.json'));
fs.copyFileSync(path.join(ROOT,'adapters/hooks/pretool-guard.mjs'),path.join(c,'hooks','pretool-guard.mjs'));
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

for(const name of ['claude','codex','antigravity']){
  const dir=path.join(dist,`agent-sdlc-${name}-${manifest.version}`);
  const zip=path.join(dist,`agent-sdlc-${name}-${manifest.version}.zip`);
  execFileSync('zip',['-qr',zip,path.basename(dir)],{cwd:dist});
}
console.log(JSON.stringify({status:'BUILT',version:manifest.version,dist,public_discovery_skills:2,internal_skills:Object.keys(skillRegistry.internal||{}).length},null,2));
