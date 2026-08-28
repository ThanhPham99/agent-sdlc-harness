#!/usr/bin/env node
// Root install surface vs. adapter sources.
//
// The repository root doubles as an Antigravity plugin root, so five files at
// the root are byte-for-byte copies of files under adapters/. Nothing generated
// them and nothing kept them honest: an edit to the adapter copy alone shipped
// a stale root, and the GitHub-install validator only checked that the root
// files existed.
//
// This asserts the copies are identical, so drift fails CI instead of shipping.
// The adapter file is the source of truth, and re-copying is mechanical, so it
// is a flag rather than instructions: `npm run sync:root` (--fix) rewrites every
// stale root copy from its source. The copies stay tracked files -- the repo
// checkout doubles as an Antigravity plugin root, so they have to exist in git
// and cannot be produced at install time.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {writeReport} from './lib/report-io.mjs';

// AGENT_SDLC_ROOT_SYNC_ROOT points this at a throwaway fixture tree instead of
// the real checkout: --fix overwrites tracked files for real, so it is tested
// against a synthetic root, not the developer's own. Same pattern as
// AGENT_SDLC_REPORT_ROOT in scripts/restore-tracked-reports.mjs.
const ROOT=process.env.AGENT_SDLC_ROOT_SYNC_ROOT||path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const FIX=process.argv.includes('--fix');
const VERSION=JSON.parse(fs.readFileSync(path.join(ROOT,'agent-sdlc.manifest.json'),'utf8')).version;

// source (authoritative) -> root install surface (copy)
const MIRRORS=[
  ['adapters/hooks/pretool-guard.mjs','hooks/pretool-guard.mjs'],
  ['adapters/hooks/test-output-guard.mjs','hooks/test-output-guard.mjs'],
  ['adapters/hooks/statusline.mjs','hooks/statusline.mjs'],
  ['adapters/hooks/claude-session-start.mjs','hooks/claude-session-start.mjs'],
  ['adapters/hooks/antigravity-preinvocation.mjs','hooks/antigravity-preinvocation.mjs'],
  ['adapters/antigravity/hooks.json','hooks.json'],
  ['adapters/antigravity/mcp_config.json','mcp_config.json'],
  ['adapters/antigravity/plugin.json','plugin.json'],
  ['adapters/antigravity/rules.md','rules/agent-sdlc.md']
];

// Line endings are normalized before hashing: .gitattributes may check these
// out differently on Windows, and that is not drift.
const hash=rel=>{
  const abs=path.join(ROOT,rel);
  if(!fs.existsSync(abs))return null;
  return crypto.createHash('sha256').update(fs.readFileSync(abs,'utf8').replace(/\r\n/g,'\n')).digest('hex');
};

const rows=MIRRORS.map(([src,dst])=>{
  const a=hash(src),b=hash(dst);
  const problems=[];
  if(!a)problems.push(`missing source ${src}`);
  if(!b)problems.push(`missing root copy ${dst}`);
  if(a&&b&&a!==b)problems.push('root copy is stale; re-run: npm run sync:root');
  return {source:src,root_copy:dst,status:problems.length?'FAIL':'PASS',
    source_sha256:a?a.slice(0,16):null,root_sha256:b?b.slice(0,16):null,problems};
});

// --fix rewrites the stale copies from their sources instead of only naming
// them. Raw bytes, not the normalized text used for hashing: how the file is
// checked out is git's business (.gitattributes), not this script's.
if(FIX){
  for(const row of rows){
    if(row.status!=='FAIL')continue;
    if(row.problems.some(p=>p.startsWith('missing source')))continue;
    fs.mkdirSync(path.dirname(path.join(ROOT,row.root_copy)),{recursive:true});
    fs.copyFileSync(path.join(ROOT,row.source),path.join(ROOT,row.root_copy));
    row.status='FIXED';
    row.root_sha256=hash(row.root_copy).slice(0,16);
    row.problems=[];
  }
}

const fixed=rows.filter(r=>r.status==='FIXED');
const failures=rows.filter(r=>r.status==='FAIL');
const report={
  schema:'agent-sdlc/root-sync-validation/v1',
  version:VERSION,
  checks:rows.length,
  passes:rows.length-failures.length-fixed.length,
  fixed:fixed.length,
  failures:failures.length,
  mirrors:rows,
  status:failures.length?'FAIL':'PASS'
};
writeReport(path.join(ROOT,'evals','ROOT-SYNC-VALIDATION.json'),report);
console.log(JSON.stringify({...report,mirrors:failures.length||fixed.length?[...failures,...fixed]:'all-in-sync'},null,2));
process.exit(failures.length?1:0);
