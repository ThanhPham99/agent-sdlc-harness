#!/usr/bin/env node
// F14: `npm run check` runs ~25 suites that each rewrite their own tracked
// evals/*.json report, so every local run left the working tree dirty even
// when nothing meaningful changed -- a spurious diff waiting to surface in
// the next delivery check.
//
// Every suite still writes its report unconditionally, exactly as before:
// that is what makes its console output live, and what lets a later step in
// the SAME run (nothing currently does, but nothing should have to avoid it
// either) read a peer's fresh report rather than a stale one. This step runs
// last and restores the TRACKED copy of any report that changed, unless told
// to keep the fresh one. An untracked report (a brand new suite's first run)
// is left alone; there is nothing to restore it to.
//
// Three ways to keep the fresh reports instead of restoring:
//   node scripts/restore-tracked-reports.mjs --update   (direct invocation)
//   npm run check -- --update                           (through the runner)
//   AGENT_SDLC_KEEP_REPORTS=1 npm run check             (env, any shell)
// The middle form only works because `check` is now a single runner
// (scripts/run-check.mjs), which reads the flag and forwards it as the env var.
// While `check` was an `&&` chain it could not: npm appends extra args to the
// END of the whole chain's text, so they landed on this script's own
// invocation without the `--` npm needs to not treat them as its own CLI flags
// (`--update` silently expanded to `--update-notifier` and never reached this
// script's argv -- confirmed empirically, not assumed).
//
// A no-op in CI: the checkout is discarded after the job, CI never invokes
// `npm run check` as a whole (each suite is its own step, for granular
// pass/fail visibility), and the freshly-written reports are what CI uploads
// as artifacts -- restoring them there would be actively wrong.
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';

// AGENT_SDLC_REPORT_ROOT lets a test point this at a throwaway git fixture
// instead of the real checkout -- this script runs `git checkout` for real,
// so it is tested against a synthetic repo, not the developer's own tree.
const ROOT=process.env.AGENT_SDLC_REPORT_ROOT||path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const truthy=v=>!!v&&!['0','false','no'].includes(String(v).toLowerCase());
const update=process.argv.includes('--update')||truthy(process.env.AGENT_SDLC_KEEP_REPORTS);

if(update||process.env.CI){
  console.log(JSON.stringify({schema:'agent-sdlc/report-hygiene/v1',action:update?'KEPT_FRESH_REPORTS_UPDATE_REQUESTED':'KEPT_FRESH_REPORTS_CI',restored:[],status:'PASS'},null,2));
  process.exit(0);
}

// Git's own pathspec glob, not shell expansion -- this is a single argv
// element, never passed through a shell.
//
// `:(glob)` matters: in a plain pathspec git's `*` crosses `/`, so
// `evals/*.json` also matched `evals/live/*.json` and `evals/activation/*.json`
// -- the hand-authored qualification corpora and the tier lock, none of which
// any suite writes. Running `npm run check` after editing one silently reverted
// the edit, and those files are digest-bound inputs to live qualification, so
// the loss was invisible until an evidence digest disagreed. With `:(glob)` the
// `*` stays inside one path segment and only the top-level reports match.
const porcelain=execFileSync('git',['status','--porcelain','--',':(glob)evals/*.json'],{cwd:ROOT,encoding:'utf8'});
const restored=porcelain.split('\n').filter(Boolean)
  // Modified-and-tracked only ('M' in either column). '??' is untracked --
  // git checkout on a path git has never seen errors instead of no-op-ing.
  .filter(line=>line[0]==='M'||line[1]==='M')
  .map(line=>line.slice(3).trim());

// `HEAD --`, not bare `--`: a bare `git checkout -- path` restores the
// worktree from the INDEX, so a report someone had already `git add`ed would
// keep its staged (fresh) content instead of reverting to what is committed.
if(restored.length)execFileSync('git',['checkout','HEAD','--',...restored],{cwd:ROOT});

console.log(JSON.stringify({schema:'agent-sdlc/report-hygiene/v1',action:restored.length?'RESTORED':'NOTHING_TO_RESTORE',restored,status:'PASS'},null,2));
