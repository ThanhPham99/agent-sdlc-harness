#!/usr/bin/env node
// scripts/restore-tracked-reports.mjs runs `git checkout` for real, so it is
// exercised against a throwaway git fixture rather than this repository's own
// working tree -- a bug here would otherwise discard real, uncommitted work.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createSuite} from './lib/suite.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const SCRIPT=path.join(ROOT,'scripts','restore-tracked-reports.mjs');
const {test,assert,finish}=createSuite('agent-sdlc/report-hygiene-validation/v1','REPORT-HYGIENE-VALIDATION.json');

/** A repo with one committed report and nothing else tracked under evals/. */
function fixture(){
  const d=fs.mkdtempSync(path.join(os.tmpdir(),'agent-sdlc-report-hygiene-'));
  execFileSync('git',['init','-q'],{cwd:d});
  execFileSync('git',['config','user.email','a@b.c'],{cwd:d});
  execFileSync('git',['config','user.name','t'],{cwd:d});
  fs.mkdirSync(path.join(d,'evals'),{recursive:true});
  fs.writeFileSync(path.join(d,'evals','REPORT.json'),JSON.stringify({checks:1},null,2)+'\n');
  // A hand-authored corpus file one level down. No suite writes this; it stands
  // in for evals/live/qualification-lock.json and the live case sets.
  fs.mkdirSync(path.join(d,'evals','live'),{recursive:true});
  fs.writeFileSync(path.join(d,'evals','live','CORPUS.json'),JSON.stringify({version:'committed'},null,2)+'\n');
  execFileSync('git',['add','.'],{cwd:d});
  execFileSync('git',['commit','-qm','init'],{cwd:d});
  return d;
}

// CI and AGENT_SDLC_KEEP_REPORTS are cleared unless a case sets them: this
// suite may itself be running inside CI, or under `AGENT_SDLC_KEEP_REPORTS=1
// npm run check` (which is exactly how its own report gets committed), and
// every case here needs the "restore by default" baseline unless it is
// specifically testing one of those override branches.
const run=(root,{args=[],env={}}={})=>JSON.parse(execFileSync(process.execPath,[SCRIPT,...args],
  {encoding:'utf8',env:{...process.env,CI:'',AGENT_SDLC_KEEP_REPORTS:'',AGENT_SDLC_REPORT_ROOT:root,...env}}));

const reportPath=root=>path.join(root,'evals','REPORT.json');
const dirty=root=>execFileSync('git',['status','--porcelain','--','evals/REPORT.json'],{cwd:root,encoding:'utf8'}).trim();

test('default-restores-a-modified-tracked-report',()=>{
  const d=fixture();
  fs.writeFileSync(reportPath(d),JSON.stringify({checks:999},null,2)+'\n');
  assert(dirty(d).length>0,'fixture assumption broke: report was not dirty before running');
  const out=run(d);
  assert(out.action==='RESTORED',JSON.stringify(out));
  assert(out.restored.includes('evals/REPORT.json'),JSON.stringify(out));
  assert(dirty(d)==='','report was not actually restored on disk');
  assert(JSON.parse(fs.readFileSync(reportPath(d),'utf8')).checks===1,'restored content is not the committed content');
});

test('nothing-to-restore-when-the-report-was-not-touched',()=>{
  const d=fixture();
  const out=run(d);
  assert(out.action==='NOTHING_TO_RESTORE',JSON.stringify(out));
  assert(out.restored.length===0,JSON.stringify(out));
});

test('update-flag-keeps-the-fresh-report',()=>{
  const d=fixture();
  fs.writeFileSync(reportPath(d),JSON.stringify({checks:999},null,2)+'\n');
  const out=run(d,{args:['--update']});
  assert(out.action==='KEPT_FRESH_REPORTS_UPDATE_REQUESTED',JSON.stringify(out));
  assert(JSON.parse(fs.readFileSync(reportPath(d),'utf8')).checks===999,'the fresh report was restored despite --update');
});

test('keep-reports-env-var-keeps-the-fresh-report',()=>{
  const d=fixture();
  fs.writeFileSync(reportPath(d),JSON.stringify({checks:999},null,2)+'\n');
  const out=run(d,{env:{AGENT_SDLC_KEEP_REPORTS:'1'}});
  assert(out.action==='KEPT_FRESH_REPORTS_UPDATE_REQUESTED',JSON.stringify(out));
  assert(JSON.parse(fs.readFileSync(reportPath(d),'utf8')).checks===999,'the fresh report was restored despite AGENT_SDLC_KEEP_REPORTS');
});

test('ci-env-var-keeps-the-fresh-report',()=>{
  const d=fixture();
  fs.writeFileSync(reportPath(d),JSON.stringify({checks:999},null,2)+'\n');
  const out=run(d,{env:{CI:'true'}});
  assert(out.action==='KEPT_FRESH_REPORTS_CI',JSON.stringify(out));
  assert(JSON.parse(fs.readFileSync(reportPath(d),'utf8')).checks===999,'the fresh report was restored despite CI=true');
});

test('an-untracked-report-is-left-alone',()=>{
  const d=fixture();
  fs.writeFileSync(path.join(d,'evals','NEW-REPORT.json'),JSON.stringify({checks:1},null,2)+'\n');
  const out=run(d);
  assert(out.action==='NOTHING_TO_RESTORE',JSON.stringify(out));
  assert(fs.existsSync(path.join(d,'evals','NEW-REPORT.json')),'an untracked report must not be deleted');
});

// `evals/*.json` as a plain pathspec let git's `*` cross `/`, so this step --
// meant to undo generated reports -- also reverted hand-edited files under
// evals/live and evals/activation. Those are digest-bound qualification inputs,
// so an edit vanished silently and only surfaced as a mismatched evidence
// digest much later.
test('a-hand-edited-file-in-a-subdirectory-is-left-alone',()=>{
  const d=fixture();
  const corpus=path.join(d,'evals','live','CORPUS.json');
  fs.writeFileSync(corpus,JSON.stringify({version:'edited-by-hand'},null,2)+'\n');
  const out=run(d);
  assert(!out.restored.some(f=>f.includes('evals/live/')),`subdirectory file was clobbered: ${JSON.stringify(out)}`);
  assert(JSON.parse(fs.readFileSync(corpus,'utf8')).version==='edited-by-hand','the hand edit was reverted');
});

test('a-staged-modification-is-also-restored',()=>{
  const d=fixture();
  fs.writeFileSync(reportPath(d),JSON.stringify({checks:999},null,2)+'\n');
  execFileSync('git',['add','evals/REPORT.json'],{cwd:d});
  const out=run(d);
  assert(out.action==='RESTORED',JSON.stringify(out));
  assert(JSON.parse(fs.readFileSync(reportPath(d),'utf8')).checks===1,'a staged modification was not restored');
});

finish();
