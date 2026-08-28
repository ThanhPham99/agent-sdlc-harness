#!/usr/bin/env node
// Skill registry integrity.
//
// config/skills.json is the only thing that makes an internal skill real:
// build-dist copies exactly the registered entries, and the orchestrator loads
// exactly the registered ids. A file under harness/internal-skills/ that no
// entry points at is invisible to every host — it is not "almost shipped", it
// is dead weight that reads like live guidance to whoever edits it next.
//
// Three properties, in decreasing order of severity:
//   MISSING_FILE      a registry entry points at a file that does not exist.
//                     Fatal: the stage would load nothing.
//   BAD_ENTRY         an entry is missing the fields the loader needs, names a
//                     stage the state machine does not have, or points at a
//                     schema/tool that does not exist.
//   UNREGISTERED_FILE a file no entry points at. Fatal for new files; the
//                     pre-existing ones are listed as accepted debt below, so
//                     the count can only go down.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {writeReport} from './lib/report-io.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const rj=p=>JSON.parse(fs.readFileSync(path.join(ROOT,p),'utf8'));
const VERSION=rj('agent-sdlc.manifest.json').version;
const skills=rj('config/skills.json');
const stateMachine=rj('config/state-machine.json');
const tools=rj('config/tools.json');
const workflows=rj('config/workflows.json');

// All internal skills are now registered. The list is empty so any orphan fails CI.
const ACCEPTED_UNREGISTERED=[];

const problems=[];
const fail=(kind,subject,detail)=>problems.push({kind,subject,detail});

// The run state machine has no flat state list: its states are the lifecycle
// order plus terminal and side states plus whatever the edges reference.
const knownStates=new Set([
  ...(stateMachine.lifecycle_order||[]),
  ...(stateMachine.terminal||[]),
  ...(stateMachine.side_states||[]),
  ...(stateMachine.edges||[]).flatMap(e=>[e.from,e.to])
].filter(Boolean));
const knownTools=new Set(Object.keys(tools.tools||tools));
const entries=Object.entries(skills.internal||{});

for(const [id,spec] of entries){
  if(spec.id!==id)fail('BAD_ENTRY',id,`entry id "${spec.id}" does not match its key`);
  if(!spec.instructions)fail('BAD_ENTRY',id,'no instructions path');
  else if(!fs.existsSync(path.join(ROOT,spec.instructions)))fail('MISSING_FILE',id,`instructions not found: ${spec.instructions}`);
  if(!Array.isArray(spec.stages)||!spec.stages.length)fail('BAD_ENTRY',id,'no stages declared');
  for(const stage of spec.stages||[])
    if(knownStates.size&&!knownStates.has(stage))fail('BAD_ENTRY',id,`stage "${stage}" is not in the run state machine`);
  for(const tool of spec.tools||[])
    if(knownTools.size&&!knownTools.has(tool))fail('BAD_ENTRY',id,`tool "${tool}" is not in the tool registry`);
  if(spec.output_schema&&!fs.existsSync(path.join(ROOT,spec.output_schema)))
    fail('MISSING_FILE',id,`output_schema not found: ${spec.output_schema}`);
}

// Public skills must exist as discoverable SKILL.md files, and nothing else may.
for(const pub of skills.public||[]){
  const p=path.join(ROOT,'skills',pub,'SKILL.md');
  if(!fs.existsSync(p))fail('MISSING_FILE',pub,`public skill body not found: skills/${pub}/SKILL.md`);
}
const publicDirs=fs.readdirSync(path.join(ROOT,'skills'),{withFileTypes:true}).filter(e=>e.isDirectory()).map(e=>e.name);
for(const dir of publicDirs)
  if(!(skills.public||[]).includes(dir))
    fail('BAD_ENTRY',dir,'discoverable skill directory is not declared in config/skills.json public list');

// Orphan detection.
const registeredFiles=new Set(entries.map(([,s])=>path.basename(s.instructions||'')));
const files=fs.readdirSync(path.join(ROOT,'harness','internal-skills')).filter(f=>f.endsWith('.md'));
const unregistered=files.filter(f=>!registeredFiles.has(f));
const newOrphans=unregistered.filter(f=>!ACCEPTED_UNREGISTERED.includes(f));
const clearedDebt=ACCEPTED_UNREGISTERED.filter(f=>!unregistered.includes(f));
for(const f of newOrphans)
  fail('UNREGISTERED_FILE',f,'not referenced by config/skills.json: register it or delete it');
// Keep the allowlist honest in both directions: a file that got registered or
// deleted must leave the list, or the list slowly stops describing reality.
for(const f of clearedDebt)
  fail('BAD_ENTRY',f,'listed as accepted-unregistered debt but is no longer an orphan: remove it from ACCEPTED_UNREGISTERED');

// Every workflow stage must have at least one skill that can serve it,
// otherwise the orchestrator reaches a stage with no guidance to load.
const stagesCovered=new Set(entries.flatMap(([,s])=>s.stages||[]));
const workflowStages=new Set(Object.values(workflows.workflows||workflows).flatMap(w=>w.stages||[]));
const uncoveredStages=[...workflowStages].filter(s=>!stagesCovered.has(s));
for(const s of uncoveredStages)
  fail('BAD_ENTRY',s,'workflow stage has no internal skill registered for it');

const report={
  schema:'agent-sdlc/registry-validation/v1',
  version:VERSION,
  counts:{
    registered_internal_skills:entries.length,
    internal_skill_files:files.length,
    public_skills:(skills.public||[]).length,
    unregistered_files:unregistered.length,
    accepted_unregistered:ACCEPTED_UNREGISTERED.length,
    new_orphans:newOrphans.length
  },
  // Visible debt, not a silent pass: these files ship to no host.
  unregistered_files:unregistered,
  problems,
  status:problems.length?'FAIL':'PASS'
};
writeReport(path.join(ROOT,'evals','REGISTRY-VALIDATION.json'),report);
console.log(JSON.stringify(report,null,2));
process.exit(problems.length?1:0);
