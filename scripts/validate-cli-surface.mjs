#!/usr/bin/env node
// CLI help text vs. the commands the CLI actually dispatches.
//
// runtime/cli.mjs answers an unknown command with a hand-written help string
// listing every command and subcommand. Nothing kept that string honest, and it
// had already drifted: three implemented `task` subcommands were absent from it.
// The help text is the only discovery surface an agent has for the CLI, so a
// missing entry means a capability the model never learns it can use.
//
// Both directions fail: an implemented command missing from help, and a help
// entry that dispatches nowhere.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const CLI=path.join(ROOT,'runtime','cli.mjs');
const VERSION=JSON.parse(fs.readFileSync(path.join(ROOT,'agent-sdlc.manifest.json'),'utf8')).version;
const src=fs.readFileSync(CLI,'utf8');

// Commands the dispatcher compares against, in source order.
const dispatched=[...src.matchAll(/cmd===' ?([a-z-]+)'/g)].map(m=>m[1]);
// Subcommands, grouped by the command block they appear in.
const groups=new Map();
let current=null;
for(const line of src.split('\n')){
  const cmd=line.match(/cmd==='([a-z-]+)'/);
  if(cmd){current=cmd[1];continue;}
  if(!current)continue;
  for(const m of line.matchAll(/sub===' ?([a-z-]+)'/g)){
    if(!groups.has(current))groups.set(current,new Set());
    groups.get(current).add(m[1]);
  }
  for(const m of line.matchAll(/action===' ?([a-z-]+)'/g)){
    if(!groups.has(current))groups.set(current,new Set());
    groups.get(current).add(m[1]);
  }
}

// The help block is the final else branch: a single template string.
const helpMatch=src.match(/print\(`agent-sdlc \$\{[^`]*`\)/s);
if(!helpMatch){console.error('could not locate the help text in runtime/cli.mjs');process.exit(1);}
const help=helpMatch[0];
const helpTokens=new Set([...help.matchAll(/[a-z][a-z-]+/g)].map(m=>m[0]));
// The help text compresses families as `artifact-put/get/list`; expand them so
// each member counts as documented.
for(const m of help.matchAll(new RegExp("([a-z]+)-([a-z-]+(?:/[a-z-]+)+)","g"))){
  for(const part of m[2].split("/"))helpTokens.add(`${m[1]}-${part}`);
}

const problems=[];
for(const cmd of new Set(dispatched)){
  if(!helpTokens.has(cmd))problems.push(`command \`${cmd}\` is dispatched but absent from the help text`);
}
const subRows=[];
for(const [cmd,subs] of groups){
  // The help lists subcommands on a line naming the command.
  // The help text is source code: its line breaks are the two-character
  // escape sequence, not real newlines, so the list is matched directly.
  const listMatch=help.match(new RegExp(cmd+" subcommands: ([a-z0-9 ,|-]+)"));
  const line=listMatch?listMatch[1]:"";
  const listed=new Set([...line.matchAll(/[a-z][a-z-]+/g)].map(m=>m[0]));
  const missing=[...subs].filter(s=>!listed.has(s)).sort();
  const phantom=[...listed].filter(s=>!['subcommands',cmd].includes(s)&&!subs.has(s)
    // `codex-bootstrap install|uninstall|status` documents actions, not subcommands.
    &&!(groups.get(cmd)?.has(s))).sort();
  subRows.push({command:cmd,implemented:subs.size,documented:listed.size?listed.size-1:0,missing,phantom});
  for(const s of missing)problems.push(`\`${cmd} ${s}\` is implemented but absent from the help text`);
  for(const s of phantom)problems.push(`\`${cmd} ${s}\` is documented in the help text but dispatches nowhere`);
}

const report={
  schema:'agent-sdlc/cli-surface-validation/v1',
  version:VERSION,
  commands:[...new Set(dispatched)].sort(),
  command_count:new Set(dispatched).size,
  subcommand_groups:subRows.sort((a,b)=>a.command.localeCompare(b.command)),
  problems,
  status:problems.length?'FAIL':'PASS'
};
fs.writeFileSync(path.join(ROOT,'evals','CLI-SURFACE-VALIDATION.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(problems.length?report:{...report,subcommand_groups:'all-documented'},null,2));
process.exit(problems.length?1:0);
