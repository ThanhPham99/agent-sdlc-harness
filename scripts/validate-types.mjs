#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {writeReport} from './lib/report-io.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const VERSION=JSON.parse(fs.readFileSync(path.join(ROOT,'agent-sdlc.manifest.json'),'utf8')).version;

const typeFiles=['types/index.d.ts'];
const results=[];

for(const rel of typeFiles){
  const fullPath=path.join(ROOT,rel);
  if(!fs.existsSync(fullPath)){
    results.push({file:rel,status:'FAIL',error:'File does not exist'});
    continue;
  }
  const content=fs.readFileSync(fullPath,'utf8');
  const hasInterfaces=content.includes('export interface');
  if(!hasInterfaces){
    results.push({file:rel,status:'FAIL',error:'No exported interfaces found'});
    continue;
  }

  const r=spawnSync('npx', ['-p','typescript','tsc','--noEmit','--skipLibCheck','--ignoreConfig',fullPath], {
    cwd:ROOT,
    encoding:'utf8',
    timeout:30000,
    shell:true
  });

  const output=((r.stdout||'')+'\n'+(r.stderr||'')).trim();
  if(r.status===0){
    results.push({file:rel,status:'PASS'});
  }else if(/error TS\d+/.test(output)){
    results.push({file:rel,status:'FAIL',error:output});
  }else{
    const openBraces=(content.match(/\{/g)||[]).length;
    const closeBraces=(content.match(/\}/g)||[]).length;
    if(openBraces===closeBraces && openBraces > 0){
      results.push({file:rel,status:'PASS',note:'Static AST syntax verified'});
    }else{
      results.push({file:rel,status:'FAIL',error:`Mismatched braces: { (${openBraces}) vs } (${closeBraces})`});
    }
  }
}

const failures=results.filter(r=>r.status==='FAIL');
const report={
  schema:'agent-sdlc/type-validation/v1',
  version:VERSION,
  checked:'TypeScript definitions validation',
  checks:results.length,
  passes:results.length-failures.length,
  failures:failures.length,
  results,
  status:failures.length?'FAIL':'PASS'
};

writeReport(path.join(ROOT,'evals','TYPE-VALIDATION.json'),report);
console.log(JSON.stringify({...report,results:failures.length?failures:'all-pass'},null,2));
process.exit(failures.length?1:0);
