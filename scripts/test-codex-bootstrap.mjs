#!/usr/bin/env node
// Managed Codex bootstrap tests. Every case runs against a temporary CODEX_HOME;
// no real user instruction file is ever touched.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {BOOTSTRAP_TEXT,bootstrapHash} from '../runtime/activation.mjs';
import * as cb from '../runtime/codex-bootstrap.mjs';
import {makeTempDir} from './lib/tempdir.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const VERSION=JSON.parse(fs.readFileSync(path.join(ROOT,'agent-sdlc.manifest.json'),'utf8')).version;
const rows=[];let fail=0;
const test=(name,fn)=>{try{fn();rows.push({name,status:'PASS'});}catch(e){fail++;rows.push({name,status:'FAIL',error:e.message});}};
const assert=(v,m)=>{if(!v)throw new Error(m);};
const homes=[];
function home(files={}){
  const d=makeTempDir('agent-sdlc-codex-home-');
  homes.push(d);
  for(const [rel,text] of Object.entries(files))fs.writeFileSync(path.join(d,rel),text);
  return d;
}
const agents=h=>path.join(h,'AGENTS.md');
const read=h=>fs.readFileSync(agents(h),'utf8');
const install=(h,extra={})=>cb.install({home:h,version:VERSION,...extra});
const uninstall=(h,extra={})=>cb.uninstall({home:h,version:VERSION,...extra});
const blockCount=t=>(t.match(/agent-sdlc:auto-bootstrap:start/g)||[]).length;

test('empty-home-creates-instruction-file',()=>{
  const h=home();
  const r=install(h);
  assert(r.status==='INSTALLED'&&r.installed&&r.blocks===1,JSON.stringify(r));
  const text=read(h);
  assert(text.includes(BOOTSTRAP_TEXT)&&text.includes(bootstrapHash()),'block content missing');
  assert(cb.status({home:h}).created_by_agent_sdlc===true,'creation not recorded');
});
test('install-is-idempotent',()=>{
  const h=home();
  install(h);
  const first=read(h);
  const again=install(h);
  assert(again.status==='ALREADY_CURRENT'&&again.changed===false,JSON.stringify(again));
  assert(read(h)===first,'second install rewrote the file');
  assert(blockCount(read(h))===1,'duplicate block appended');
});
test('existing-user-content-is-preserved-byte-for-byte',()=>{
  const user='# My rules\n\nAlways run `make lint`.\n\n- keep commits small\n';
  const h=home({'AGENTS.md':user});
  install(h);
  const text=read(h);
  assert(text.startsWith(user.replace(/\s+$/,'')),'user content altered');
  assert(text.includes(BOOTSTRAP_TEXT),'block missing');
  assert(fs.existsSync(`${agents(h)}.agent-sdlc-backup`),'no backup created');
  assert(fs.readFileSync(`${agents(h)}.agent-sdlc-backup`,'utf8')===user,'backup does not match original');
});
test('duplicate-blocks-are-repaired',()=>{
  const dupe=`${'<!-- agent-sdlc:auto-bootstrap:start version=old hash=sha256:dead -->'}\nstale one\n<!-- agent-sdlc:auto-bootstrap:end -->\nkeep me\n<!-- agent-sdlc:auto-bootstrap:start version=old2 hash=sha256:beef -->\nstale two\n<!-- agent-sdlc:auto-bootstrap:end -->\n`;
  const h=home({'AGENTS.md':dupe});
  const before=cb.status({home:h});
  assert(before.blocks===2&&before.warnings.some(w=>/managed blocks/.test(w)),JSON.stringify(before));
  const r=install(h);
  assert(r.blocks===1&&r.up_to_date,JSON.stringify(r));
  const text=read(h);
  assert(text.includes('keep me')&&!text.includes('stale one')&&!text.includes('stale two'),'repair lost or kept wrong content');
});
test('stale-block-is-refreshed',()=>{
  const h=home({'AGENTS.md':'<!-- agent-sdlc:auto-bootstrap:start version=3.0.0-alpha3 hash=sha256:0000 -->\nold text\n<!-- agent-sdlc:auto-bootstrap:end -->\n'});
  assert(cb.status({home:h}).warnings.some(w=>/stale/.test(w)),'stale block not detected');
  const r=install(h);
  assert(r.up_to_date&&read(h).includes(BOOTSTRAP_TEXT)&&!read(h).includes('old text'),JSON.stringify(r));
});
test('override-file-masking-is-detected',()=>{
  const h=home({'AGENTS.override.md':'global override wins\n'});
  const r=install(h);
  assert(r.masked===true&&r.masked_by.endsWith('AGENTS.override.md'),JSON.stringify(r));
  assert(r.warnings.some(w=>/masked/.test(w)),'masking not warned');
});
test('dry-run-changes-nothing',()=>{
  const h=home({'AGENTS.md':'keep\n'});
  const r=install(h,{dryRun:true});
  assert(r.status==='DRY_RUN'&&r.would_change===true&&r.changed===false,JSON.stringify(r));
  assert(read(h)==='keep\n','dry run mutated the file');
  const u=uninstall(h,{dryRun:true});
  assert(u.dry_run&&u.changed===false&&read(h)==='keep\n','dry-run uninstall mutated the file');
});
test('uninstall-removes-only-managed-block',()=>{
  const user='# Keep\n\nmy rule\n';
  const h=home({'AGENTS.md':user});
  install(h);
  const r=uninstall(h);
  assert(r.status==='REMOVED'&&r.removed_file===false&&r.preserved_user_content===true,JSON.stringify(r));
  const text=read(h);
  assert(text.includes('my rule')&&!text.includes(BOOTSTRAP_TEXT),'uninstall left or removed the wrong content');
  assert(cb.status({home:h}).installed===false,'still reported installed');
});
test('uninstall-deletes-only-a-file-agent-sdlc-created',()=>{
  const created=home();
  install(created);
  const r=uninstall(created);
  assert(r.removed_file===true&&!fs.existsSync(agents(created)),JSON.stringify(r));
  const adopted=home({'AGENTS.md':''});
  install(adopted);
  const r2=uninstall(adopted);
  assert(r2.removed_file===false&&fs.existsSync(agents(adopted)),'deleted a pre-existing user file');
});
test('uninstall-on-clean-home-is-a-noop',()=>{
  const h=home();
  const r=uninstall(h);
  assert(r.status==='NOT_PRESENT'&&r.changed===false,JSON.stringify(r));
});
test('crlf-line-endings-are-preserved',()=>{
  const h=home({'AGENTS.md':'# Windows rules\r\n\r\nuse pwsh\r\n'});
  install(h);
  const text=read(h);
  assert(!/[^\r]\n/.test(text),'CRLF file gained LF-only line endings');
  assert(text.includes(BOOTSTRAP_TEXT),'block missing');
  uninstall(h);
  assert(!/[^\r]\n/.test(read(h)),'uninstall broke CRLF endings');
});
test('no-repository-local-agents-md-is-touched',()=>{
  const repo=makeTempDir('agent-sdlc-codex-repo-');
  homes.push(repo);
  const local=path.join(repo,'AGENTS.md');
  fs.writeFileSync(local,'repo rules\n');
  const h=home();
  const cwd=process.cwd();
  process.chdir(repo);
  try{install(h);}finally{process.chdir(cwd);}
  assert(fs.readFileSync(local,'utf8')==='repo rules\n','repository-local AGENTS.md was modified');
});
test('cli-surface-matches-runtime',()=>{
  const h=home();
  const r=spawnSync(process.execPath,[path.join(ROOT,'scripts','codex-bootstrap.mjs'),'install','--codex-home',h],{encoding:'utf8'});
  assert(r.status===0,`exit ${r.status}: ${r.stderr}`);
  const out=JSON.parse(r.stdout);
  assert(out.installed&&out.blocks===1,r.stdout);
  const s=spawnSync(process.execPath,[path.join(ROOT,'runtime','cli.mjs'),'activation','codex-bootstrap','status','--codex-home',h],{encoding:'utf8'});
  assert(s.status===0&&JSON.parse(s.stdout).up_to_date,s.stdout||s.stderr);
});

for(const d of homes)fs.rmSync(d,{recursive:true,force:true});
const report={schema:'agent-sdlc/codex-bootstrap-test/v1',checks:rows.length,passes:rows.length-fail,failures:fail,status:fail?'FAIL':'PASS',results:rows};
console.log(JSON.stringify(report,null,2));
process.exit(fail?1:0);
