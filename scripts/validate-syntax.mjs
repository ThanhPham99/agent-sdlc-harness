#!/usr/bin/env node
// F8: no syntax gate over 36k lines of hand-written ESM. With a 90% coverage
// floor, up to 10% of bytes are never executed by any suite, so a syntax or
// reference error in an uncovered branch would ship silently. `node --check`
// parses without executing, so it catches a broken file even when nothing
// ever runs it.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {writeReport} from './lib/report-io.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const VERSION=JSON.parse(fs.readFileSync(path.join(ROOT,'agent-sdlc.manifest.json'),'utf8')).version;

// Same scratch/build exclusions as the legacy-reference guard
// (evals/run-deterministic.mjs) -- gitignored dirs that can hold a whole
// second copy of the repo, plus dist, which is generated output.
const skipDirs=new Set(['.git','node_modules','dist','.agent-sdlc','.claude','release','.superpowers']);

function findMjsFiles(dir){
  const out=[];
  for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
    if(entry.isDirectory()){if(!skipDirs.has(entry.name))out.push(...findMjsFiles(path.join(dir,entry.name)));continue;}
    if(entry.name.endsWith('.mjs'))out.push(path.join(dir,entry.name));
  }
  return out;
}

/**
 * Control characters a parser accepts and a human cannot see.
 *
 * A tool that wrote `\b` through a language where that escape means backspace
 * put a real 0x08 inside a regex literal in qualification-lib.mjs. `node
 * --check` passed, because a control character is legal there, and the regex
 * silently stopped matching -- so a rate-limited qualification run was recorded
 * as a genuine FAIL. Tab, newline and carriage return are the legitimate ones.
 */
function controlChars(abs){
  const buf=fs.readFileSync(abs);
  const found=new Set();
  for(const b of buf){
    if(b===0x09||b===0x0a||b===0x0d)continue;
    if(b<0x20||b===0x7f)found.add('0x'+b.toString(16).padStart(2,'0'));
  }
  return [...found].sort();
}

const files=findMjsFiles(ROOT).map(f=>path.relative(ROOT,f).split(path.sep).join('/')).sort();
const results=files.map(rel=>{
  // node --check is direct, static parsing -- always process.execPath, never
  // through resolveLaunch, since we are launching node itself, not a
  // configured project command.
  const r=spawnSync(process.execPath,['--check',rel],{cwd:ROOT,encoding:'utf8',timeout:10000});
  if(r.status!==0)return {file:rel,status:'FAIL',error:(r.stderr||'').trim().split('\n').slice(0,5).join('\n')};
  const ctl=controlChars(path.join(ROOT,rel));
  if(ctl.length)return {file:rel,status:'FAIL',error:`stray control character(s) in source: ${ctl.join(', ')}`};
  return {file:rel,status:'PASS',error:null};
});

const failures=results.filter(r=>r.status==='FAIL');
const report={
  schema:'agent-sdlc/syntax-validation/v1',
  version:VERSION,
  checked:'node --check (parse only, not executed)',
  checks:results.length,
  passes:results.length-failures.length,
  failures:failures.length,
  results,
  status:failures.length?'FAIL':'PASS'
};
writeReport(path.join(ROOT,'evals','SYNTAX-VALIDATION.json'),report);
console.log(JSON.stringify({...report,results:failures.length?failures:'all-pass'},null,2));
process.exit(failures.length?1:0);
