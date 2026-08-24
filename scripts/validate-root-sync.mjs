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
// The adapter file is the source of truth; the fix is always to re-copy.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const VERSION=JSON.parse(fs.readFileSync(path.join(ROOT,'agent-sdlc.manifest.json'),'utf8')).version;

// source (authoritative) -> root install surface (copy)
const MIRRORS=[
  ['adapters/hooks/pretool-guard.mjs','hooks/pretool-guard.mjs'],
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
  if(a&&b&&a!==b)problems.push(`root copy is stale; re-run: cp ${src} ${dst}`);
  return {source:src,root_copy:dst,status:problems.length?'FAIL':'PASS',
    source_sha256:a?a.slice(0,16):null,root_sha256:b?b.slice(0,16):null,problems};
});

const failures=rows.filter(r=>r.status==='FAIL');
const report={
  schema:'agent-sdlc/root-sync-validation/v1',
  version:VERSION,
  checks:rows.length,
  passes:rows.length-failures.length,
  failures:failures.length,
  mirrors:rows,
  status:failures.length?'FAIL':'PASS'
};
fs.writeFileSync(path.join(ROOT,'evals','ROOT-SYNC-VALIDATION.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({...report,mirrors:failures.length?failures:'all-in-sync'},null,2));
process.exit(failures.length?1:0);
