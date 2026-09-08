// The cache/ subtree is regenerable by definition. This proves it.
//
// The v2 layout tells users which parts of .agent-sdlc they may delete: cache/
// is documented as "safe to delete at any time; gitignore it". That claim is
// only worth making if it is true, and it is the kind of claim that quietly
// stops being true -- one durable record written under cache/ and deleting the
// directory costs a user their evidence.
//
// So: build a project with real state, record what the durable subtrees contain,
// delete cache/ entirely, exercise the runtime again, and require that every
// durable byte is still there and that the run is still fully readable.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import * as layout from '../runtime/layout.mjs';
import {initProject,putArtifact,loadRun,saveRun,emit,listArtifacts,getArtifact,listRuns,latestRunId,resolveRunId} from '../runtime/store.mjs';
import {generateDashboardHtml} from '../runtime/commands/dashboard.mjs';
import {metrics} from '../runtime/telemetry.mjs';
import {syncDashboard} from '../runtime/doc-generator.mjs';
import {newRun} from '../runtime/orchestrator.mjs';
import {route} from '../runtime/router.mjs';
import {detectProject} from '../runtime/init.mjs';
import {writeReport} from './lib/report-io.mjs';
import {makeTempDir} from './lib/tempdir.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const results=[];
let failures=0;
const test=(name,fn)=>{
  try{fn();results.push({name,status:'PASS'});}
  catch(e){failures++;results.push({name,status:'FAIL',error:String(e.message).slice(0,600)});}
};

/** A git repo with a project initialized in it and one run carrying state. */
function fixture(){
  const d=makeTempDir('cache-regen-');
  const git=(...args)=>execFileSync('git',args,{cwd:d,stdio:'pipe'});
  git('init','-q');
  git('config','user.email','t@localhost');
  git('config','user.name','T');
  fs.writeFileSync(path.join(d,'package.json'),JSON.stringify({name:'fx',version:'1.0.0'},null,2));
  fs.writeFileSync(path.join(d,'src.js'),'export const a=1;\n');
  git('add','-A');
  git('commit','-q','-m','init');
  initProject(d,detectProject(d));
  const run=newRun(ROOT,d,{objective:'cache regeneration',route:route(ROOT,'Add refund capability')});
  saveRun(d,run);
  emit(d,run,{type:'test.event',payload:{n:1}});
  const artifact=putArtifact(d,{kind:'confirmed-requirements',content:'durable content\n',
    runId:run.run_id,stage:run.state});
  return {d,run,artifact};
}

/** Every file under a directory, as relative path -> sha-ish size+content pair. */
function snapshot(dir,base){
  const out={};
  if(!fs.existsSync(dir))return out;
  const walk=(p)=>{
    for(const e of fs.readdirSync(p,{withFileTypes:true})){
      const full=path.join(p,e.name);
      if(e.isDirectory())walk(full);
      else out[path.relative(base,full).split(path.sep).join('/')]=fs.readFileSync(full,'utf8');
    }
  };
  walk(dir);
  return out;
}

test('cache-is-declared-with-the-cache-lifetime-and-nothing-durable-shares-it',()=>{
  const described=layout.describeLayout();
  const cacheEntry=described.top_level.find(e=>e.key==='cache');
  assert.equal(cacheEntry.lifetime,'cache','cache/ is not declared with the cache lifetime');
  // Every row under cache/ must be regenerable. A run-scoped row is allowed
  // there (workspaces), but a DURABLE top-level row must never resolve inside
  // cache/.
  for(const e of described.top_level){
    if(e.key==='cache')continue;
    assert.ok(!e.path.startsWith('cache/'),`${e.key} is declared under cache/ but is ${e.lifetime}`);
  }
});

test('deleting-the-cache-tree-loses-no-durable-state',()=>{
  const {d,run,artifact}=fixture();
  try{
    // Give the cache something to lose.
    fs.mkdirSync(layout.repoIndexDir(d),{recursive:true});
    fs.writeFileSync(layout.repoIndexFile(d),JSON.stringify({stale:true}));
    fs.writeFileSync(layout.dashboardFile(d),'<html></html>');
    fs.mkdirSync(layout.runWorkspacesDir(d,run.run_id),{recursive:true});
    fs.writeFileSync(path.join(layout.runWorkspacesDir(d,run.run_id),'TASK-001.json'),'{}');
    assert.ok(fs.existsSync(layout.cacheDir(d)),'the fixture created no cache');

    const before={
      runs:snapshot(layout.runsDir(d),d),
      store:snapshot(layout.storeDir(d),d),
      shared:snapshot(layout.sharedDir(d),d),
      docs:snapshot(layout.docsDir(d),d),
      project:fs.readFileSync(layout.projectConfigFile(d),'utf8'),
      state:fs.readFileSync(layout.stateFile(d),'utf8')
    };
    assert.ok(Object.keys(before.runs).length>0,'the fixture recorded no run state');
    assert.ok(Object.keys(before.store).length>0,'the fixture stored no artifact');

    fs.rmSync(layout.cacheDir(d),{recursive:true,force:true});
    assert.ok(!fs.existsSync(layout.cacheDir(d)),'the cache was not deleted');

    // Durable state is byte-identical.
    assert.deepEqual(snapshot(layout.runsDir(d),d),before.runs,'run state changed');
    assert.deepEqual(snapshot(layout.storeDir(d),d),before.store,'the object store changed');
    assert.deepEqual(snapshot(layout.sharedDir(d),d),before.shared,'shared state changed');
    assert.deepEqual(snapshot(layout.docsDir(d),d),before.docs,'docs changed');
    assert.equal(fs.readFileSync(layout.projectConfigFile(d),'utf8'),before.project);
    assert.equal(fs.readFileSync(layout.stateFile(d),'utf8'),before.state);

    // And the run is still fully usable, not merely present.
    const reloaded=loadRun(d,run.run_id);
    assert.equal(reloaded.run_id,run.run_id);
    assert.equal(reloaded.objective,'cache regeneration');
    assert.equal(getArtifact(d,artifact.artifact_id).content,'durable content\n');
    assert.ok(listArtifacts(d).some(m=>m.artifact_id===artifact.artifact_id),
      'the artifact is no longer listed');
  }finally{fs.rmSync(d,{recursive:true,force:true});}
});

test('consumers-still-enumerate-runs-after-the-layout-change',()=>{
  // A run moved from `runs/<id>.json` to `runs/<id>/run.json`, so any consumer
  // that enumerated runs with a `*.json` readdir now matches nothing -- and
  // reports zero rather than failing. The dashboard did exactly that and
  // rendered runs_count 0 for a project full of runs, which no suite noticed
  // because nothing asserted a run count through a consumer.
  const {d,run}=fixture();
  try{
    assert.deepEqual(listRuns(d),[run.run_id],'store.listRuns does not see the run');
    assert.equal(latestRunId(d),run.run_id,'latestRunId does not see the run');
    assert.equal(resolveRunId(d,null),run.run_id,'resolveRunId does not see the run');

    // A readdir over `runs/` is what broke, so the assertion is that a
    // directory listing of it yields the run -- the shape every consumer that
    // enumerates runs has to cope with now.
    const entries=fs.readdirSync(layout.runsDir(d),{withFileTypes:true});
    assert.equal(entries.filter(e=>e.isFile()&&e.name.endsWith('.json')).length,0,
      'a run is still a flat *.json file; the fixture is not on the v2 layout');
    assert.ok(entries.some(e=>e.isDirectory()&&e.name===run.run_id),
      'the run directory is not listed');

    // And rendered through the same enumeration the dashboard command uses.
    const runs=listRuns(d).map(id=>loadRun(d,id));
    assert.equal(runs.length,1,`enumeration yielded ${runs.length} runs`);
    const html=generateDashboardHtml({project:{},state:runs[0],runs,tasks:[],metrics:null,version:'test'});
    assert.ok(html.includes(run.run_id)||/>\s*1\s*</.test(html),
      'the dashboard does not report the run it should have found');

    // syncDashboard is the automatic path; it must agree.
    syncDashboard(d);
    assert.ok(fs.existsSync(layout.dashboardFile(d)),'syncDashboard wrote nothing');

    const m=metrics(d);
    assert.ok(m.runs>=1,`telemetry reports ${m.runs} runs`);
  }finally{fs.rmSync(d,{recursive:true,force:true});}
});

test('a-runtime-write-succeeds-after-the-cache-tree-is-deleted',()=>{
  // The documented promise is that cache/ can be deleted at any time. A writer
  // that assumed its cache directory existed would turn that promise into a
  // silent permanent no-op -- which syncDashboard did, writing with no
  // ensureDir inside a catch that swallows everything.
  const {d}=fixture();
  try{
    fs.rmSync(layout.cacheDir(d),{recursive:true,force:true});
    syncDashboard(d);
    assert.ok(fs.existsSync(layout.dashboardFile(d)),
      'the dashboard was not written after the cache was deleted');
  }finally{fs.rmSync(d,{recursive:true,force:true});}
});

test('the-cache-tree-is-recreated-on-demand-after-deletion',()=>{
  const {d}=fixture();
  try{
    fs.rmSync(layout.cacheDir(d),{recursive:true,force:true});
    // ensureLayout is what init and the doc generator call; it must bring the
    // cache back without touching anything durable.
    const created=layout.ensureLayout(d);
    assert.ok(created.some(p=>p===layout.cacheDir(d)||p.startsWith(layout.cacheDir(d)+path.sep)),
      `ensureLayout did not recreate the cache tree: ${JSON.stringify(created)}`);
    assert.ok(fs.existsSync(layout.repoIndexDir(d)),'the index directory was not recreated');
    assert.ok(fs.existsSync(layout.workspacesDir(d)),'the workspaces directory was not recreated');
  }finally{fs.rmSync(d,{recursive:true,force:true});}
});

const status=failures?'FAIL':'PASS';
writeReport(path.join(ROOT,'evals','CACHE-REGENERATION-VALIDATION.json'),{
  schema:'agent-sdlc/eval-report/v1',
  suite:'cache-regeneration',
  checks:results.length,
  passes:results.filter(r=>r.status==='PASS').length,
  failures,
  results,
  status
});
console.log(JSON.stringify({suite:'cache-regeneration',checks:results.length,failures,status,
  results:failures?results.filter(r=>r.status==='FAIL'):results.map(r=>r.name)},null,2));
process.exit(failures?1:0);
