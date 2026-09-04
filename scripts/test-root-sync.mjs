#!/usr/bin/env node
// Root-sync validator, including its --fix side.
//
// validate-root-sync.mjs had no test of its own: it was a check nobody checked.
// That was tolerable while it only compared hashes, but --fix overwrites tracked
// files at the repository root, and an overwrite that picks the wrong direction
// -- root over adapter -- silently destroys the source of truth instead of the
// stale copy. So it is exercised here against a synthetic root
// (AGENT_SDLC_ROOT_SYNC_ROOT), never the real checkout.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createSuite} from './lib/suite.mjs';
import {makeTempDir} from './lib/tempdir.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const VALIDATOR=path.join(ROOT,'scripts','validate-root-sync.mjs');
const {test,assert,finish}=createSuite('agent-sdlc/root-sync-suite/v1','ROOT-SYNC-SUITE.json');

// One mirror pair is enough to pin the behaviour; the real MIRRORS list is the
// validator's own data, and validate-root-sync.mjs running for real in
// test:integrity is what asserts that list is complete.
const SOURCE='adapters/hooks/pretool-guard.mjs';
const COPY='hooks/pretool-guard.mjs';

/** A throwaway root holding every file the validator reads. */
function fixture({copyBody=null}={}){
  const d=makeTempDir('agent-sdlc-rootsync-');
  fs.mkdirSync(path.join(d,'evals'),{recursive:true});
  fs.writeFileSync(path.join(d,'agent-sdlc.manifest.json'),JSON.stringify({version:'0.0.0-fixture'}));
  for(const [src,dst] of [[SOURCE,COPY],['adapters/antigravity/hooks.json','hooks.json'],
    ['adapters/antigravity/mcp_config.json','mcp_config.json'],['adapters/antigravity/plugin.json','plugin.json'],
    ['adapters/antigravity/rules.md','rules/agent-sdlc.md'],['adapters/hooks/test-output-guard.mjs','hooks/test-output-guard.mjs'],
    ['adapters/hooks/statusline.mjs','hooks/statusline.mjs'],['adapters/hooks/claude-session-start.mjs','hooks/claude-session-start.mjs'],
    ['adapters/hooks/antigravity-preinvocation.mjs','hooks/antigravity-preinvocation.mjs']]){
    for(const rel of new Set([src,dst])){
      const abs=path.join(d,rel);
      fs.mkdirSync(path.dirname(abs),{recursive:true});
      fs.copyFileSync(path.join(ROOT,src),abs);
    }
  }
  if(copyBody!==null)fs.writeFileSync(path.join(d,COPY),copyBody);
  return d;
}
const run=(d,args=[])=>{
  const r=spawnSync(process.execPath,[VALIDATOR,...args],
    {cwd:d,encoding:'utf8',timeout:60000,env:{...process.env,AGENT_SDLC_ROOT_SYNC_ROOT:d}});
  let doc=null;try{doc=JSON.parse(r.stdout);}catch{}
  return {status:r.status,doc,stdout:r.stdout||'',stderr:r.stderr||''};
};
const read=(d,rel)=>fs.readFileSync(path.join(d,rel),'utf8');

test('an-in-sync-root-passes',()=>{
  const d=fixture();
  const r=run(d);
  assert(r.status===0,`exited ${r.status}: ${(r.stderr||r.stdout).slice(0,200)}`);
  assert(r.doc?.status==='PASS'&&r.doc.failures===0,JSON.stringify(r.doc).slice(0,200));
});

test('a-stale-root-copy-fails-and-names-the-fix-command',()=>{
  const d=fixture({copyBody:'// drifted\n'});
  const r=run(d);
  assert(r.status===1,`exited ${r.status}`);
  const row=r.doc?.mirrors?.find(m=>m.root_copy===COPY);
  assert(row?.status==='FAIL',JSON.stringify(r.doc?.mirrors).slice(0,200));
  assert(row.problems.some(p=>p.includes('npm run sync:root')),JSON.stringify(row.problems));
});

test('fix-rewrites-the-stale-copy-from-its-source-and-leaves-the-source-alone',()=>{
  const d=fixture({copyBody:'// drifted\n'});
  const source=read(d,SOURCE);
  const r=run(d,['--fix']);
  assert(r.status===0,`--fix exited ${r.status}: ${(r.stderr||r.stdout).slice(0,200)}`);
  // The direction matters more than the exit code: adapter wins, not root.
  assert(read(d,COPY)===source,'the root copy was not rewritten from its source');
  assert(read(d,SOURCE)===source,'--fix modified the source of truth');
  assert(r.doc?.fixed===1,JSON.stringify({fixed:r.doc?.fixed,failures:r.doc?.failures}));
});

test('fix-is-idempotent-and-a-second-plain-run-passes',()=>{
  const d=fixture({copyBody:'// drifted\n'});
  run(d,['--fix']);
  const again=run(d,['--fix']);
  assert(again.doc?.fixed===0&&again.doc?.failures===0,JSON.stringify(again.doc).slice(0,200));
  const plain=run(d);
  assert(plain.status===0&&plain.doc?.status==='PASS',JSON.stringify(plain.doc).slice(0,200));
});

test('fix-does-not-invent-a-copy-when-the-source-is-missing',()=>{
  // A missing source is a repository problem, not drift: writing the root copy
  // from nothing, or deleting it, would both be wrong.
  const d=fixture();
  fs.rmSync(path.join(d,SOURCE));
  const r=run(d,['--fix']);
  assert(r.status===1,`--fix exited ${r.status} on a missing source`);
  const row=r.doc?.mirrors?.find(m=>m.root_copy===COPY);
  assert(row?.status==='FAIL'&&row.problems.some(p=>p.startsWith('missing source')),JSON.stringify(row));
  assert(fs.existsSync(path.join(d,COPY)),'--fix deleted the root copy');
});

finish();
