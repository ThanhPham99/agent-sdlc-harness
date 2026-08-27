#!/usr/bin/env node
// The CLI surface: the registry, the handlers that exist, and the help text.
//
// This check used to regex `cmd==='...'` out of a 46-branch if/else chain in
// runtime/cli.mjs and compare it against a hand-written help string. That string
// was the only discovery surface an agent had for the CLI, and it had already
// drifted -- three implemented `task` subcommands were missing from it, so they
// were capabilities the model never learned it could use.
//
// The help text is now generated from runtime/commands/index.mjs, which removes
// that failure mode rather than testing for it. What remains to check is that
// the registry tells the truth about the code:
//   every entry in the registry resolves to a handler that actually exists;
//   every handler a group exports is listed in the registry;
//   every subcommand a handler dispatches is declared in the registry;
//   nothing is declared that dispatches nowhere;
//   and the generated help names all of it.
// Only the last of those was previously checkable at all, and only by regex.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {COMMANDS,COMMAND_NAMES,GROUP_NAMES,loadGroup,renderHelp} from '../runtime/commands/index.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const VERSION=JSON.parse(fs.readFileSync(path.join(ROOT,'agent-sdlc.manifest.json'),'utf8')).version;
const problems=[];

// --- registry vs the handlers that actually exist ---------------------------
const handlersByGroup=new Map();
for(const group of GROUP_NAMES){
  const mod=await loadGroup(group);
  if(!mod?.commands){problems.push(`group \`${group}\` exports no commands map`);continue;}
  handlersByGroup.set(group,new Set(Object.keys(mod.commands)));
  for(const name of Object.keys(mod.commands)){
    if(typeof mod.commands[name]!=='function')problems.push(`handler \`${name}\` in group \`${group}\` is not callable`);
    if(!COMMANDS[name])problems.push(`group \`${group}\` exports handler \`${name}\`, which the registry does not list`);
    else if(COMMANDS[name].group!==group)problems.push(`\`${name}\` is registered under group \`${COMMANDS[name].group}\` but implemented in \`${group}\``);
  }
}
for(const name of COMMAND_NAMES){
  const group=COMMANDS[name].group;
  if(!GROUP_NAMES.includes(group)){problems.push(`\`${name}\` names unknown group \`${group}\``);continue;}
  if(!handlersByGroup.get(group)?.has(name))problems.push(`\`${name}\` is in the registry but group \`${group}\` implements no such handler`);
}

// --- registry vs the subcommands each handler dispatches --------------------
// Subcommands are dispatched inside a handler body rather than declared, so this
// is the one place a source scan is still the honest check. It is scoped to a
// single handler at a time, not to a whole file.
const subRows=[];
for(const group of GROUP_NAMES){
  const src=fs.readFileSync(path.join(ROOT,'runtime','commands',`${group}.mjs`),'utf8');
  let current=null;
  const dispatched=new Map();
  for(const line of src.split('\n')){
    const head=line.match(/^ {2}'?([a-z][a-z0-9-]*)'?:async ctx=>\{/);
    if(head){current=head[1];dispatched.set(current,new Set());continue;}
    if(!current)continue;
    for(const m of line.matchAll(/(?:sub|action)===' ?([a-z0-9-]+)'/g))dispatched.get(current).add(m[1]);
  }
  for(const [name,subs] of dispatched){
    const declared=new Set(COMMANDS[name]?.subcommands||[]);
    const missing=[...subs].filter(s=>!declared.has(s)).sort();
    const phantom=[...declared].filter(s=>!subs.has(s)).sort();
    if(subs.size||declared.size)subRows.push({command:name,implemented:subs.size,declared:declared.size,missing,phantom});
    for(const s of missing)problems.push(`\`${name} ${s}\` is implemented but absent from the registry`);
    for(const s of phantom)problems.push(`\`${name} ${s}\` is declared in the registry but dispatches nowhere`);
  }
}

// --- the generated help names the whole surface -----------------------------
const help=renderHelp(VERSION);
if(!help.startsWith(`agent-sdlc ${VERSION}`))problems.push('the help text does not open with the version');
for(const name of COMMAND_NAMES){
  if(!new RegExp(`(^|[ ,])${name}([ ,]|$)`,'m').test(help))problems.push(`command \`${name}\` is absent from the generated help`);
  for(const s of COMMANDS[name].subcommands||[]){
    const line=help.split('\n').find(l=>l.startsWith(`${name} subcommands: `));
    if(!line||!line.slice(`${name} subcommands: `.length).split(', ').includes(s)){
      problems.push(`\`${name} ${s}\` is absent from the generated help`);
    }
  }
}

// --- entry-point parity -----------------------------------------------------
// The skills and docs tell the agent to run `bin/agent-sdlc` in ~120 places and
// the only shim was `#!/usr/bin/env sh`. In PowerShell that is "Cannot run a
// document in the middle of a pipeline" and in cmd.exe it is "not recognized",
// so the documented entry point did not exist for a whole supported platform.
// scripts/verify-dist.mjs had already worked around this privately.
// Assertions run against the shim body with comment lines stripped, so a
// comment merely mentioning `$args`/`LASTEXITCODE`/`cli.mjs` cannot satisfy an
// assertion whose actual code no longer does the thing described.
const stripComments=(name,body)=>body.split('\n').filter(line=>{
  const t=line.trim();
  if(name.endsWith('.ps1'))return !t.startsWith('#');
  if(name.endsWith('.cmd'))return !/^(rem\b|::)/i.test(t);
  return true;
}).join('\n');
const SHIMS=['agent-sdlc','agent-sdlc.cmd','agent-sdlc.ps1'];
const shimCode=new Map();
for(const name of SHIMS){
  const p=path.join(ROOT,'bin',name);
  if(!fs.existsSync(p)){problems.push(`bin/${name} is missing; the documented entry point must exist on every supported platform`);continue;}
  const code=stripComments(name,fs.readFileSync(p,'utf8'));
  shimCode.set(name,code);
  if(!code.includes('cli.mjs')){
    problems.push(`bin/${name} does not exec runtime/cli.mjs`);
  }
}
const cmdBody=shimCode.get('agent-sdlc.cmd')||'';
if(cmdBody&&!/%\*/.test(cmdBody))problems.push('bin/agent-sdlc.cmd does not forward its arguments (%*)');
if(cmdBody&&!/exit \/b/i.test(cmdBody))problems.push('bin/agent-sdlc.cmd does not propagate the exit code');
const ps1Body=shimCode.get('agent-sdlc.ps1')||'';
if(ps1Body&&!/\$args/.test(ps1Body))problems.push('bin/agent-sdlc.ps1 does not forward its arguments ($args)');
if(ps1Body&&!/LASTEXITCODE/.test(ps1Body))problems.push('bin/agent-sdlc.ps1 does not propagate the exit code');

const report={
  schema:'agent-sdlc/cli-surface-validation/v1',
  version:VERSION,
  commands:[...COMMAND_NAMES].sort(),
  command_count:COMMAND_NAMES.length,
  groups:GROUP_NAMES,
  help_generated:true,
  subcommand_groups:subRows.sort((a,b)=>a.command.localeCompare(b.command)),
  problems,
  status:problems.length?'FAIL':'PASS'
};
fs.writeFileSync(path.join(ROOT,'evals','CLI-SURFACE-VALIDATION.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(problems.length?report:{...report,subcommand_groups:'all-documented'},null,2));
process.exit(problems.length?1:0);
