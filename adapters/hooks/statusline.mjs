#!/usr/bin/env node
// Claude Code status line: keeps model, context pressure and cost visible on
// every turn instead of only at end-of-month billing review -- the
// observability half of policies/cost-context-governance.json, which is
// otherwise enforced without the developer ever seeing the pressure it is
// reacting to.
//
// MIRRORED FILE. adapters/hooks/statusline.mjs is authoritative and
// hooks/statusline.mjs is a byte-for-byte copy kept in step by
// scripts/gen-activation-assets.mjs and checked by scripts/validate-root-sync.mjs.
// Edit the adapters/ copy.
//
// Not wired automatically: a status line is a per-user/per-project display
// preference, not something a plugin manifest can impose on a host. Opt in
// from .claude/settings.json (project) or ~/.claude/settings.json (user):
//   { "statusLine": { "type": "command",
//       "command": "node \"${CLAUDE_PLUGIN_ROOT}/hooks/statusline.mjs\"" } }
//
// Dependency-free and reads only its stdin payload plus the local .git
// metadata, so it starts fast enough to run on every prompt render. Fields
// that are not present in a given host/version's status payload are simply
// omitted from the line rather than shown as an error -- the schema for
// status payloads is not part of the stable Claude Code contract yet.
import fs from 'node:fs';
import path from 'node:path';

let raw='';for await (const c of process.stdin)raw+=c;
let p={};try{p=JSON.parse(raw||'{}')}catch{p={}}

const model=p.model?.display_name||p.model?.id||p.model_id||null;

const pct=p.context?.used_percentage??p.context?.percentage??p.context_usage_percent??null;
const ctx=pct==null||Number.isNaN(Number(pct))?null:`ctx ${Math.round(Number(pct))}%`;

const cost=p.cost?.total_cost_usd??p.total_cost_usd;
const costText=typeof cost==='number'?`cost $${cost.toFixed(2)}`:null;

// Walks up from cwd to find a .git entry (directory, or a `gitdir:` pointer
// file for a worktree/submodule), then reads HEAD directly -- no `git`
// subprocess, so this stays cheap enough to run on every render.
function gitBranch(startDir){
  try{
    let dir=startDir;
    for(let i=0;i<8;i++){
      const gitPath=path.join(dir,'.git');
      if(fs.existsSync(gitPath)){
        const isDir=fs.statSync(gitPath).isDirectory();
        let gitDir=gitPath;
        if(!isDir){
          const pointer=fs.readFileSync(gitPath,'utf8').trim();
          const m=/^gitdir:\s*(.+)$/.exec(pointer);
          if(!m)return null;
          gitDir=path.isAbsolute(m[1])?m[1]:path.join(dir,m[1]);
        }
        const headPath=path.join(gitDir,'HEAD');
        if(!fs.existsSync(headPath))return null;
        const head=fs.readFileSync(headPath,'utf8').trim();
        const ref=/^ref:\s*refs\/heads\/(.+)$/.exec(head);
        return ref?ref[1]:head.slice(0,7);
      }
      const parent=path.dirname(dir);
      if(parent===dir)return null;
      dir=parent;
    }
  }catch{}
  return null;
}

// The statusline names the run the project is on, which is the run `start`
// recorded as active. Run ids are UUIDs, so the readdir order is alphabetical
// and unrelated to age -- picking the last filename showed whichever run
// happened to sort highest, not the current one. The fallback for a project
// whose state predates `active_run_id` sorts on `created_at` instead.
//
// This hook stays free of runtime imports so it cannot slow down or break a
// prompt; that is why it repeats the resolution in store.mjs rather than
// importing resolveRunId.
// Layout note: these paths are spelled out rather than taken from
// runtime/layout.mjs, which is the authority for every other reader. Two things
// force it, and both are properties of this file rather than preferences:
// the module is dependency-free by contract so it starts fast enough to run on
// every prompt render, and it is byte-mirrored to hooks/statusline.mjs, so a
// relative import would have to resolve from two different directories.
//
// scripts/test-layout.mjs therefore asserts that what is written here still
// matches what layout.mjs resolves, so the duplication cannot drift silently --
// which it did: this reader was still looking for the v1 `runs/<id>.json` after
// the tree moved to `runs/<id>/run.json`, and because every failure here is
// swallowed to protect the prompt, the effect was the `sdlc:` segment quietly
// disappearing rather than any error anyone could see.
function activeSdlcStage(startDir){
  try{
    const stateDir=path.join(startDir,'.agent-sdlc');
    const runsDir=path.join(stateDir,'runs');
    if(!fs.existsSync(runsDir))return null;
    const readRun=id=>{try{return JSON.parse(fs.readFileSync(path.join(runsDir,id,'run.json'),'utf8'));}catch{return null;}};
    let run=null;
    try{
      const active=JSON.parse(fs.readFileSync(path.join(stateDir,'state.json'),'utf8')).active_run_id;
      if(active)run=readRun(active);
    }catch{}
    if(!run){
      // A run is a directory holding run.json; a directory without one is a
      // half-built run and not a candidate.
      const runs=fs.readdirSync(runsDir,{withFileTypes:true}).filter(e=>e.isDirectory())
        .map(e=>readRun(e.name)).filter(Boolean)
        .sort((a,b)=>String(a.created_at||'')<String(b.created_at||'')?-1:1);
      run=runs.length?runs[runs.length-1]:null;
    }
    if(run&&run.workflow&&run.state){
      return `sdlc:${run.workflow}@${run.state}`;
    }
  }catch{}
  return null;
}

const cwd=p.workspace?.current_dir||p.workspace?.project_dir||p.cwd||process.cwd();
const branch=gitBranch(cwd);
const sdlc=activeSdlcStage(cwd);

const parts=[model,ctx,costText,branch?`branch ${branch}`:null,sdlc].filter(Boolean);
console.log(parts.length?parts.join(' | '):'agent-sdlc');
