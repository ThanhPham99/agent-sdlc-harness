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
import {writeReport} from './lib/report-io.mjs';

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

// --- registry vs the documentation -----------------------------------------
// Nine top-level commands (auto, auto-task, ci-check, rewind, serve, dashboard,
// webhook, completion, review) shipped with no mention in any file a user
// actually reads for reference, including auto and ci-check, the headline of
// the release they shipped in. Nothing caught it because this suite checked
// the registry against the code and the generated help, never against the
// docs. A first pass over all of docs/ produced a different, non-overlapping
// list of twelve, because docs/superpowers/plans/2026-09-07-surface-coverage.md
// -- an SDD planning artifact, not reference documentation -- already
// contained this very brief's skeleton text and so satisfied the check for
// those nine by accident.
//
// A naive "everything under docs/ except docs/superpowers/" rule repeated
// that mistake one layer up: docs/releases/*.md and status documents like
// docs/IMPLEMENTATION-STATUS.md and docs/CORPUS-DECISIONS.md also narrate
// commands in passing without teaching an operator how to use them, and a
// release note is the single likeliest place a brand-new command gets its
// first `agent-sdlc <name>` mention -- which would turn this gate green
// before docs/USAGE.md ever learns the command exists. That is the exact
// failure this gate exists to catch, so selection is by explicit
// classification, not by exclusion: every markdown file under docs/ is
// either in REFERENCE_TREES (an operator-facing manual an operator actually
// reads to learn a command) or NON_REFERENCE_PATHS (a working document about
// the project -- plans, specs, release announcements, status snapshots --
// that mentions commands without documenting them). A path matching neither
// list fails the gate outright: adding a new subtree under docs/ must force
// a decision about which bucket it belongs to, not silently widen what
// counts as documentation.
//
// A command is documented when some reference file mentions it as
// `agent-sdlc <name>` with nothing else -- not even a hyphen -- immediately
// after the name, so `ci-check` cannot satisfy the check for `ci` and
// `auto-task` cannot satisfy it for `auto`.
const docsDir=path.join(ROOT,'docs');
const REFERENCE_TREES=['architecture/','compatibility/','guides/','runbooks/','threat-model/'];
const REFERENCE_FILES=new Set([
  'AUTO-ACTIVATION.md','CONFIGURATION.md','GITHUB-DISTRIBUTION.md','INSTALLATION.md',
  'MCP-AND-TOOLS.md','MIGRATION.md','QUICKSTART.md','TUTORIAL-STEP-BY-STEP.md','USAGE.md',
]);
const NON_REFERENCE_TREES=['superpowers/','releases/'];
const NON_REFERENCE_FILES=new Set([
  'IMPLEMENTATION-STATUS.md','CORPUS-DECISIONS.md','EVALS.md','QUALIFICATION.md',
]);
function classify(rel){
  const posixRel=rel.split(path.sep).join('/');
  if(NON_REFERENCE_TREES.some(t=>posixRel.startsWith(t))||NON_REFERENCE_FILES.has(posixRel))return'non-reference';
  if(REFERENCE_TREES.some(t=>posixRel.startsWith(t))||REFERENCE_FILES.has(posixRel))return'reference';
  return null;
}
const docFiles=[];
const nonReferenceFiles=[];
const unclassifiedFiles=[];
(function walk(dir){
  for(const e of fs.readdirSync(dir,{withFileTypes:true})){
    const p=path.join(dir,e.name);
    if(e.isDirectory()){walk(p);continue;}
    if(!e.name.endsWith('.md'))continue;
    const rel=path.relative(docsDir,p);
    const kind=classify(rel);
    if(kind==='reference')docFiles.push(p);
    else if(kind==='non-reference')nonReferenceFiles.push(rel);
    else unclassifiedFiles.push(rel);
  }
})(docsDir);
for(const rel of unclassifiedFiles){
  problems.push(`docs/${rel.split(path.sep).join('/')} is neither a known reference tree nor a known non-reference path -- classify it in scripts/validate-cli-surface.mjs before it can count toward the documentation gate`);
}
const docsText=docFiles.map(f=>fs.readFileSync(f,'utf8')).join('\n');
const documented=[];const undocumented=[];
for(const name of COMMAND_NAMES){
  (new RegExp(`agent-sdlc\\s+${name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}(?![-\\w])`).test(docsText)?documented:undocumented).push(name);
}
for(const name of undocumented){
  problems.push(`command \`${name}\` is registered but appears in no reference file under docs/ as \`agent-sdlc ${name}\``);
}

const report={
  schema:'agent-sdlc/cli-surface-validation/v1',
  version:VERSION,
  commands:[...COMMAND_NAMES].sort(),
  command_count:COMMAND_NAMES.length,
  documented_count:documented.length,
  undocumented:undocumented.sort(),
  reference_docs:docFiles.map(f=>path.relative(docsDir,f).split(path.sep).join('/')).sort(),
  non_reference_docs:nonReferenceFiles.map(f=>f.split(path.sep).join('/')).sort(),
  groups:GROUP_NAMES,
  help_generated:true,
  subcommand_groups:subRows.sort((a,b)=>a.command.localeCompare(b.command)),
  problems,
  status:problems.length?'FAIL':'PASS'
};
writeReport(path.join(ROOT,'evals','CLI-SURFACE-VALIDATION.json'),report);
console.log(JSON.stringify(problems.length?report:{...report,subcommand_groups:'all-documented'},null,2));
process.exit(problems.length?1:0);
