#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {zipDir} from './archive.mjs';
import {BOOTSTRAP_TEXT,bootstrapHash,estimateBootstrapCost,getActivationPolicy} from '../runtime/activation.mjs';
import {corpusDigest} from './qualification-lib.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const version=fs.readFileSync(path.join(ROOT,'VERSION'),'utf8').trim();
const release=path.join(ROOT,'release');
fs.rmSync(release,{recursive:true,force:true});fs.mkdirSync(release,{recursive:true});
const dist=path.join(ROOT,'dist');
for(const host of ['claude','codex','antigravity']){
  const src=path.join(dist,`agent-sdlc-${host}-${version}.zip`);
  if(!fs.existsSync(src))throw new Error(`missing built artifact ${src}; run npm run build first`);
  fs.copyFileSync(src,path.join(release,path.basename(src)));
}

// Source and github-ready archives are staged through a filtered copy so the same
// exclusions apply with either archiver (Info-ZIP or PowerShell Compress-Archive).
const EXCLUDE=new Set(['.git','dist','release','node_modules']);
function stage(dstName){
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'agent-sdlc-stage-'));
  const dst=path.join(tmp,dstName);
  fs.cpSync(ROOT,dst,{recursive:true,filter:(src)=>{
    const rel=path.relative(ROOT,src).split(path.sep);
    if(!rel[0])return true;
    if(EXCLUDE.has(rel[0]))return false;
    return !(rel[0]==='evals'&&rel[1]==='qualification');
  }});
  return {tmp,dst};
}
function zipStaged(dstName,zipName){
  const {tmp,dst}=stage(dstName);
  try{zipDir(dst,path.join(release,zipName));}finally{fs.rmSync(tmp,{recursive:true,force:true});}
}
zipStaged(`agent-sdlc-harness-v${version}`,`agent-sdlc-harness-source-${version}.zip`);
zipStaged(`agent-sdlc-harness-github-ready-${version}`,`agent-sdlc-harness-github-ready-${version}.zip`);

// Offline evidence bundle.
const cost=estimateBootstrapCost();
const activationValidation=path.join(ROOT,'evals','AUTO-ACTIVATION-VALIDATION.json');
if(fs.existsSync(activationValidation))fs.copyFileSync(activationValidation,path.join(release,'AUTO-ACTIVATION-VALIDATION.json'));
for(const f of ['DISTRIBUTION-VALIDATION.json','DISTRIBUTION-VALIDATION.md'])
  if(fs.existsSync(path.join(dist,f)))fs.copyFileSync(path.join(dist,f),path.join(release,f));
const preflight=spawnSync(process.execPath,[path.join(ROOT,'scripts','host-preflight.mjs')],{encoding:'utf8',maxBuffer:8*1024*1024});
if(preflight.stdout?.trim())fs.writeFileSync(path.join(release,'HOST-PREFLIGHT.json'),preflight.stdout.trim()+'\n');

const activation=fs.existsSync(activationValidation)?JSON.parse(fs.readFileSync(activationValidation,'utf8')):null;
const policy=getActivationPolicy();
fs.writeFileSync(path.join(release,'AUTO-ACTIVATION-VALIDATION.md'),[
  `# Auto-Activation Validation — ${version}`,'',
  `- Bootstrap version: **${policy.bootstrap_version}**`,
  `- Bootstrap hash: \`${bootstrapHash()}\``,
  `- Bootstrap size: **${cost.chars} chars / ${cost.rough_tokens} rough tokens** (canonical budget ${policy.max_bootstrap_rough_tokens})`,
  ...Object.entries(policy.hosts).map(([h,v])=>`- ${h}: delivery \`${v.delivery_mode}\`, budget ${v.max_bootstrap_rough_tokens} rough tokens`),
  activation?`- Contract checks: **${activation.passes}/${activation.checks}** (${activation.status})`:'- Contract checks: **not run** (`node scripts/test-auto-bootstrap.mjs`)','',
  '## Canonical bootstrap','','```text',BOOTSTRAP_TEXT,'```','',
  '## Boundary','',
  'Strong activation is **not** established by this offline validation. Every offline status reports',
  '`strong_activation: false`. Only live Claude Code, Codex and Antigravity qualification evidence may',
  'report an activation class, and a missing host CLI or credential is `PENDING`, never PASS.'
].join('\n')+'\n');

// Evidence bundle: everything a reviewer needs without unpacking a host package.
{
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'agent-sdlc-assets-'));
  const dir=path.join(tmp,`agent-sdlc-harness-release-assets-${version}`);
  fs.mkdirSync(dir,{recursive:true});
  for(const f of fs.readdirSync(release).filter(x=>!x.endsWith('.zip')))fs.copyFileSync(path.join(release,f),path.join(dir,f));
  for(const f of ['docs/AUTO-ACTIVATION.md',`docs/releases/RELEASE-NOTES-v${version}.md`,'evals/DETERMINISTIC-VALIDATION.json'])
    if(fs.existsSync(path.join(ROOT,f)))fs.copyFileSync(path.join(ROOT,f),path.join(dir,path.basename(f)));
  try{zipDir(dir,path.join(release,`agent-sdlc-harness-release-assets-${version}.zip`));}finally{fs.rmSync(tmp,{recursive:true,force:true});}
}

const files=fs.readdirSync(release).filter(x=>x.endsWith('.zip')).sort();
const lines=[];
for(const f of files){const b=fs.readFileSync(path.join(release,f));lines.push(`${crypto.createHash('sha256').update(b).digest('hex')}  ${f}`);}
fs.writeFileSync(path.join(release,'SHA256SUMS.txt'),lines.join('\n')+'\n');

// Measured live status, read from the committed baseline. The readiness page
// used to list only the offline gates plus a flat LIVE_HOST_PENDING, which was
// true and useless: it said nothing about whether a host had ever been run at
// all. A host that has never been measured and one measured at 17/20 are not
// the same kind of pending.
const baselineDir=path.join(ROOT,'evals','live','baseline');
// A baseline is a measurement of one exact corpus. Edit a case or a decision
// schema and the numbers still parse, still look current, and no longer
// describe anything that exists -- the very failure the digest binding was
// added to prevent everywhere else. So the row is printed only while the
// evidence's own bound corpus digest still matches; otherwise it says so and
// names both digests, because "stale" without the pair is unactionable.
const currentCorpus=corpusDigest();
const liveRows=[];
let anyStale=false;
for(const h of ['claude','codex','antigravity']){
  const f=path.join(baselineDir,`${h}-smoke-${version}.json`);
  if(!fs.existsSync(f)){liveRows.push(`| ${h} | never measured | - | - |`);continue;}
  try{
    const e=JSON.parse(fs.readFileSync(f,'utf8'));
    const bound=e.bound_inputs?.corpus_sha256||null;
    if(bound!==currentCorpus){
      anyStale=true;
      liveRows.push(`| ${h} | ${e.preflight?.host_version||'-'} | **stale** — measured against corpus \`${(bound||'none').slice(0,12)}\`, current is \`${currentCorpus.slice(0,12)}\` | re-measure |`);
      continue;
    }
    const pass=(e.semantic_summary?.PASS||0)+(e.repository_e2e_summary?.PASS||0);
    const total=(e.required_semantic_case_count||0)+(e.required_repository_e2e_count||0);
    liveRows.push(`| ${h} | ${e.preflight?.host_version||'-'} | ${pass}/${total} SMOKE | ${e.status} |`);
  }catch{liveRows.push(`| ${h} | unreadable baseline | - | - |`);}
}
const staleNote=anyStale
  ? ['A row marked **stale** was measured against a corpus that no longer exists: a case or a',
     'decision schema changed after it was recorded, so its counts describe a question the harness',
     'no longer asks. Re-run the host to replace it.','']
  : [];

fs.writeFileSync(path.join(release,'RELEASE-READINESS.md'),[
  `# Release Readiness — ${version}`,'',
  '| Gate | Status |',
  '|---|---|',
  '| Deterministic offline suite | run `npm test` |',
  '| Auto-activation contract and hook simulations | run `npm run test:activation` |',
  '| GitHub install validation | run `npm run validate:github` |',
  '| Installer regression | run `npm run test:github-installers` |',
  '| Distribution validation (extracted bytes) | see `DISTRIBUTION-VALIDATION.md` |',
  '| Live host qualification | **LIVE_HOST_PENDING** until fresh FULL evidence exists per host |',
  '| Strong auto-activation claim | **not established offline**; requires live evidence |','',
  '## Live measurement','',
  'SMOKE tier only. SMOKE is not promotion-eligible by design -- see `promotion_eligible`',
  'in `evals/live/qualification-lock.json` -- so these numbers describe where the harness',
  'stands, not whether it may ship. Full evidence documents are in `evals/live/baseline/`.','',
  ...staleNote,
  '| Host | CLI version | Measured | Status |',
  '|---|---|---|---|',
  ...liveRows,'',
  '## Artifacts','',
  ...lines.map(x=>`- \`${x}\``),'',
  'Promotion to `rc1` is blocked until `scripts/qualify-release.mjs` aggregates fresh, digest-bound',
  'FULL evidence for Claude Code, Codex and Antigravity, including the auto-activation probe.'
].join('\n')+'\n');

console.log(JSON.stringify({
  schema:'agent-sdlc/release-package/v1',
  version,
  release,
  files:[...files,'SHA256SUMS.txt','RELEASE-READINESS.md','AUTO-ACTIVATION-VALIDATION.md'],
  auto_activation:{bootstrap_hash:bootstrapHash(),...cost,strong_activation:false},
  live_host_qualification:'LIVE_HOST_PENDING'
},null,2));
