// Unit test for the .agent-sdlc layout authority.
//
// What this pins is not "the paths are these strings" -- that would just
// restate layout.mjs. It pins the invariants the rest of the runtime depends on
// and that a future edit to the layout table could silently break:
//
//   * every accessor resolves inside the state directory, never outside it;
//   * every id that becomes a path segment is validated, including the win32
//     hazards (reserved device names, trailing dot/space);
//   * `runPaths` covers every run-scoped row, overlaps nothing, and is never a
//     directory shared with other runs -- retention deletes exactly this list,
//     so a wrong answer here is data loss;
//   * the object store's shard partition round-trips;
//   * `describeLayout` stays a complete, duplicate-free description, because it
//     is what the generated documentation renders.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import * as layout from '../runtime/layout.mjs';
import {writeReport} from './lib/report-io.mjs';
import {makeTempDir} from './lib/tempdir.mjs';
import {listArtifacts,putArtifact,getArtifact} from '../runtime/store.mjs';
import {planGc,applyGc} from '../runtime/retention.mjs';
import {writeJson} from '../runtime/util.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const RID='run_11111111-2222-3333-4444-555555555555';
const HASH='a'.repeat(64);
const results=[];
let failures=0;

function test(name,fn){
  try{fn();results.push({name,status:'PASS'});}
  catch(e){failures++;results.push({name,status:'FAIL',error:String(e.message).slice(0,500)});}
}

// Through the shared helper, which registers the directory for removal on
// process exit -- the suite creates a fixture per case and could not otherwise
// clean up the ones a throw skipped.
const fixture=()=>makeTempDir('layout-');
const rel=(root,p)=>path.relative(root,p).split(path.sep).join('/');

test('every-accessor-resolves-inside-the-state-directory',()=>{
  const R=fixture();
  try{
    const paths=[
      layout.layoutFile(R),layout.projectConfigFile(R),layout.stateFile(R),
      layout.stateBackupFile(R,'1700000000000'),layout.customWorkflowFile(R,'flow.json'),
      layout.runFile(R,RID),layout.runEventsFile(R,RID),layout.runCostFile(R,RID),
      layout.runEvidenceFile(R,RID),layout.runCiEvidenceFile(R,RID),layout.runCiEvidenceLogFile(R,RID),
      layout.runDeliveryFile(R,RID),layout.runRequirementUpdateFile(R,RID),
      layout.taskFile(R,RID,'TASK-001'),layout.taskGraphFile(R,RID),layout.taskMigrationFile(R,RID),
      layout.taskContextFile(R,RID,'TASK-001'),layout.taskEvidenceDir(R,RID,'TASK-001'),
      layout.taskWorkspaceRecordFile(R,RID,'TASK-001'),layout.taskWorkspaceTreeDir(R,RID,'TASK-001'),
      layout.traceabilityGraphFile(R,RID),layout.traceabilityInvalidationsFile(R,RID),
      layout.objectPath(R,HASH),layout.objectMetaPath(R,HASH),
      layout.handoffFile(R,'handoff_x'),layout.featureFile(R,'feature_a'),
      layout.featurePhaseFile(R,'feature_a','phase_1'),layout.failureIndexFile(R),
      layout.webhookDeliveriesFile(R),layout.intentTemplateFile(R),layout.intentFile(R,'x.md'),
      layout.backupDir(R,'b'),layout.taskMigrationBackupDir(R,RID),
      layout.quarantineFile(R),layout.activationLogFile(R),
      layout.repoIndexFile(R),layout.dashboardFile(R),
      layout.summaryFile(R),layout.reviewFile(R),layout.guideFile(R,'README.md'),
      layout.reportFile(R,'x.md'),layout.runReportFile(R,RID)
    ];
    assert.ok(paths.length>=40,`expected the full surface, got ${paths.length}`);
    for(const p of paths){
      const r=rel(R,p);
      assert.ok(r.startsWith(`${layout.STATE_DIRNAME}/`),`escaped the tree: ${r}`);
      assert.ok(!r.split('/').includes('..'),`contains a traversal: ${r}`);
    }
  }finally{fs.rmSync(R,{recursive:true,force:true});}
});

test('unsafe-id-segments-are-rejected-including-the-win32-hazards',()=>{
  const R=fixture();
  try{
    // A reserved device name is the dangerous one: on win32 `NUL.json` IS the
    // null device, so a task record written there is accepted and then reads
    // back as absent -- the task vanishes with no error anywhere.
    const unsafe=['../escape','a/b','a\\b','..','.','','x\0y',
      'NUL','nul.json','CON','con.txt','com1','LPT9.md','AUX','PRN',
      'trailing.','trailing ','x'.repeat(201)];
    for(const bad of unsafe){
      assert.throws(()=>layout.runDir(R,bad),/unsafe run_id/,`runDir accepted ${JSON.stringify(bad)}`);
      assert.throws(()=>layout.taskFile(R,RID,bad),/unsafe/,`taskFile accepted ${JSON.stringify(bad)}`);
      assert.throws(()=>layout.featureFile(R,bad),/unsafe/,`featureFile accepted ${JSON.stringify(bad)}`);
      assert.throws(()=>layout.featurePhaseFile(R,'feature_a',bad),/unsafe/,`featurePhaseFile accepted ${JSON.stringify(bad)}`);
      assert.throws(()=>layout.guideFile(R,bad),/unsafe/,`guideFile accepted ${JSON.stringify(bad)}`);
      assert.throws(()=>layout.intentFile(R,bad),/unsafe/,`intentFile accepted ${JSON.stringify(bad)}`);
      assert.throws(()=>layout.customWorkflowFile(R,bad),/unsafe/,`customWorkflowFile accepted ${JSON.stringify(bad)}`);
    }
    // A name that merely contains a device name is an ordinary name.
    for(const ok of ['CONSOLE','nul-ish','company','AUXILIARY','TASK-001','feature_abc'])
      assert.doesNotThrow(()=>layout.taskFile(R,RID,ok),`rejected the ordinary name ${ok}`);
    for(const bad of ['zz','A'.repeat(64),'a'.repeat(63),'a'.repeat(65),''])
      assert.throws(()=>layout.objectPath(R,bad),/sha256/,`objectPath accepted ${JSON.stringify(bad)}`);
  }finally{fs.rmSync(R,{recursive:true,force:true});}
});

test('every-run-scoped-row-outside-the-run-directory-names-the-run',()=>{
  // A row on a base other than `run` sits in a directory shared with every
  // other run. If its `rel` does not name the run, the path it resolves to
  // belongs to all of them -- and `runPaths` would then hand retention a shared
  // directory to delete. The accessor throws, but a row can sit in the table
  // unresolved for a long time before gc finds it, so the table is checked
  // directly here rather than through a call.
  for(const row of layout.RUN_SCOPED){
    assert.ok(['file','dir'].includes(row.type),`row ${row.key} has type ${row.type}`);
    assert.ok(row.purpose,`row ${row.key} has no purpose`);
    if(row.base!=='run')
      assert.ok(row.rel.includes('<run_id>'),
        `row ${row.key} is on the ${row.base} base but does not name <run_id>`);
  }
});

test('runPaths-covers-every-run-scoped-namespace-and-nothing-shared',()=>{
  const R=fixture();
  try{
    layout.ensureLayout(R);
    const namespaces=layout.runNamespaces(R,RID);
    assert.equal(namespaces.length,layout.RUN_SCOPED.length);
    for(const ns of namespaces){
      fs.mkdirSync(path.dirname(ns.path),{recursive:true});
      if(ns.type==='dir')fs.mkdirSync(ns.path,{recursive:true});
      else fs.writeFileSync(ns.path,'x');
    }
    const roots=layout.runPaths(R,RID);

    // Complete: nothing the run owns is outside a prune root.
    for(const ns of namespaces){
      const covered=roots.some(r=>ns.path===r||ns.path.startsWith(r+path.sep));
      assert.ok(covered,`${ns.key} (${rel(R,ns.path)}) is not covered by any prune root`);
    }
    // Disjoint: a nested root would double-count bytes in a gc size plan.
    for(const a of roots)for(const b of roots)
      if(a!==b)assert.ok(!a.startsWith(b+path.sep),`prune root ${rel(R,a)} nests inside ${rel(R,b)}`);
    // Never shared: deleting one of these would take other runs with it.
    const shared=[layout.runsDir(R),layout.cacheDir(R),layout.sharedDir(R),layout.docsDir(R),
      layout.storeDir(R),layout.workspacesDir(R),layout.backupsDir(R),layout.reportsDir(R),
      layout.handoffsDir(R),layout.featuresDir(R),layout.stateDir(R)];
    for(const r of roots)
      assert.ok(!shared.includes(r),`prune root ${rel(R,r)} is a directory shared with other runs`);
    // Exhaustive: removing the roots leaves nothing of the run behind.
    for(const r of roots)fs.rmSync(r,{recursive:true,force:true});
    assert.deepEqual(layout.runPaths(R,RID),[],'runPaths still reports paths after removal');
  }finally{fs.rmSync(R,{recursive:true,force:true});}
});

test('the-object-store-shard-partition-round-trips',()=>{
  const R=fixture();
  try{
    const hashes=['a'.repeat(64),'b'.repeat(64),`ab${'c'.repeat(62)}`,`ab${'d'.repeat(62)}`];
    for(const h of hashes){
      fs.mkdirSync(layout.objectShardDir(R,h),{recursive:true});
      fs.writeFileSync(layout.objectPath(R,h),`content-${h.slice(0,4)}`);
      fs.writeFileSync(layout.objectMetaPath(R,h),'{}');
    }
    assert.deepEqual(layout.listObjectHashes(R),[...hashes].sort(),'listObjectHashes did not round-trip');
    // Two objects in one shard stay distinct, and metadata is never mistaken
    // for an object.
    assert.equal(new Set(hashes.map(h=>layout.objectShardDir(R,h))).size,3);
    assert.equal(layout.objectPath(R,hashes[0]).length,layout.objectPath(R,hashes[1]).length);
    assert.ok(layout.objectMetaPath(R,hashes[0]).endsWith(layout.META_SUFFIX));
  }finally{fs.rmSync(R,{recursive:true,force:true});}
});

test('ensureLayout-is-idempotent-and-reports-only-what-it-created',()=>{
  const R=fixture();
  try{
    fs.rmSync(R,{recursive:true,force:true});
    const first=layout.ensureLayout(R);
    assert.ok(first.length>0,'the first call created nothing');
    assert.deepEqual(layout.ensureLayout(R),[],'the second call claimed to create directories');
    for(const p of first)assert.ok(fs.existsSync(p),`${rel(R,p)} was reported created but does not exist`);
  }finally{fs.rmSync(R,{recursive:true,force:true});}
});

test('describeLayout-is-a-complete-duplicate-free-description',()=>{
  const d=layout.describeLayout();
  assert.equal(d.layout_version,layout.LAYOUT_VERSION);
  assert.equal(d.top_level.length,layout.TOP_LEVEL.length);
  assert.equal(d.run_scoped.length,layout.RUN_SCOPED.length);
  assert.equal(d.shared.length,layout.SHARED.length);
  assert.equal(d.cache.length,layout.CACHE_ENTRIES.length);
  assert.equal(d.docs.length,layout.DOCS_ENTRIES.length);
  for(const e of d.top_level)
    assert.ok(layout.LIFETIMES.includes(e.lifetime),`${e.key} has no lifetime`);
  for(const key of layout.LIFETIMES)
    assert.ok(d.lifetimes[key],`lifetime ${key} has no description`);
  const paths=[...d.top_level,...d.run_scoped,...d.shared,...d.cache,...d.docs].map(e=>e.path);
  assert.equal(new Set(paths).size,paths.length,'the description lists the same path twice');
  for(const e of [...d.top_level,...d.run_scoped,...d.shared,...d.cache,...d.docs])
    assert.ok(e.purpose,`${e.key} has no purpose in the description`);
});

test('the-statusline-hooks-hardcoded-paths-still-match-the-layout',()=>{
  // adapters/hooks/statusline.mjs is the one reader allowed to spell these
  // paths out: it is dependency-free by contract so it can run on every prompt
  // render, and it is byte-mirrored to hooks/statusline.mjs, so a relative
  // import would have to resolve from two directories at once. That exemption
  // is only safe with a drift check, and without one it already failed --
  // the hook kept reading v1's `runs/<id>.json` after the tree moved, and
  // because it swallows every error to protect the prompt, the symptom was the
  // `sdlc:` segment silently disappearing.
  const copies=['adapters/hooks/statusline.mjs','hooks/statusline.mjs'];
  const R='/p';
  const expectRunFile=layout.runFile(R,RID).split(path.sep).join('/');
  const expectState=layout.stateFile(R).split(path.sep).join('/');
  const expectRuns=layout.runsDir(R).split(path.sep).join('/');
  // What the layout says, as the segments the hook must join.
  assert.equal(expectRuns,`/p/${layout.STATE_DIRNAME}/runs`);
  assert.equal(expectRunFile,`/p/${layout.STATE_DIRNAME}/runs/${RID}/run.json`);
  assert.equal(expectState,`/p/${layout.STATE_DIRNAME}/state.json`);
  // The needles are assembled from parts rather than written out whole. Spelled
  // literally they would be exactly the shape scripts/test-layout-boundary.mjs
  // forbids, and this file would need a blanket exemption from that scan --
  // which is the blind spot that let the hook drift in the first place. This
  // way the file stays fully scanned.
  const SD='stateDir';
  const needles=[
    [`path.join(startDir,'${layout.STATE_DIRNAME}')`,'derives the state directory the layout declares'],
    [`path.join(${SD},'runs')`,'reads the runs directory the layout declares'],
    [`path.join(runsDir,id,'run.json')`,'reads runs/<id>/run.json, the same file the runtime writes'],
    [`path.join(${SD},'state.json')`,'reads the state file the layout declares']
  ];
  for(const rel of copies){
    const file=path.join(ROOT,rel);
    assert.ok(fs.existsSync(file),`${rel} is missing`);
    const src=fs.readFileSync(file,'utf8');
    for(const [needle,what] of needles)
      assert.ok(src.includes(needle),`${rel} no longer ${what}`);
    // The v1 shape must be gone, not merely joined by the v2 one.
    assert.ok(!/runsDir,\s*`\$\{id\}\.json`/.test(src),
      `${rel} still contains the v1 runs/<id>.json read`);
  }
  // And the two copies must remain byte-identical, or only one of them is fixed.
  assert.equal(fs.readFileSync(path.join(ROOT,copies[0]),'utf8'),
    fs.readFileSync(path.join(ROOT,copies[1]),'utf8'),
    'the statusline copies have diverged');
});

test('listArtifacts-survives-an-object-with-no-readable-metadata',()=>{
  // putArtifact cannot write the object and its metadata atomically, so one of
  // the two half-states is always observable after a crash. This asserts the
  // listing tolerates it: the first version used readJson(p,null), which
  // RETHROWS for a null fallback, so a single half-written object permanently
  // broke listArtifacts, planGc and the project-knowledge status.
  const R=fixture();
  try{
    layout.ensureLayout(R);
    const good='c'.repeat(64);
    fs.mkdirSync(layout.objectShardDir(R,good),{recursive:true});
    fs.writeFileSync(layout.objectPath(R,good),'good');
    fs.writeFileSync(layout.objectMetaPath(R,good),JSON.stringify({artifact_id:`artifact://sha256/${good}`,sha256:good,kind:'k'}));
    // An object with no metadata at all.
    const bare='d'.repeat(64);
    fs.mkdirSync(layout.objectShardDir(R,bare),{recursive:true});
    fs.writeFileSync(layout.objectPath(R,bare),'bare');
    // An object whose metadata is unreadable.
    const broken='e'.repeat(64);
    fs.mkdirSync(layout.objectShardDir(R,broken),{recursive:true});
    fs.writeFileSync(layout.objectPath(R,broken),'broken');
    fs.writeFileSync(layout.objectMetaPath(R,broken),'{not json');

    assert.deepEqual(layout.listObjectHashes(R),[good,bare,broken].sort(),
      'the store enumeration itself changed');
    const listed=listArtifacts(R);
    assert.equal(listed.length,1,`expected only the complete artifact, got ${listed.length}`);
    assert.equal(listed[0].sha256,good);
  }finally{fs.rmSync(R,{recursive:true,force:true});}
});

test('both-store-half-states-are-enumerable-and-reclaimable',()=>{
  // The half-state `putArtifact` actually produces is metadata without an
  // object, because it writes metadata first. The earlier test covered only the
  // states that ordering made unreachable, which is the wrong half to cover:
  // a half nothing enumerates is a half nothing can ever delete, and gc plans
  // from `listArtifacts`, which reports complete pairs only.
  //
  // So both halves are asserted here, through the physical enumeration gc uses.
  const R=fixture();
  try{
    layout.ensureLayout(R);
    const pair='1'.repeat(64);
    const metaOnly='2'.repeat(64);
    const objectOnly='3'.repeat(64);
    for(const h of [pair,metaOnly,objectOnly]){
      fs.mkdirSync(layout.objectShardDir(R,h),{recursive:true});
    }
    fs.writeFileSync(layout.objectPath(R,pair),'both');
    fs.writeFileSync(layout.objectMetaPath(R,pair),JSON.stringify({artifact_id:`artifact://sha256/${pair}`,sha256:pair,kind:'k'}));
    fs.writeFileSync(layout.objectMetaPath(R,metaOnly),JSON.stringify({artifact_id:`artifact://sha256/${metaOnly}`,sha256:metaOnly,kind:'k'}));
    fs.writeFileSync(layout.objectPath(R,objectOnly),'orphan object');

    // The reader's view stays strict: only the complete pair is an artifact.
    assert.deepEqual(layout.listObjectHashes(R).sort(),[pair,objectOnly].sort(),
      'listObjectHashes should report objects only');
    assert.deepEqual(listArtifacts(R).map(m=>m.sha256),[pair],
      'listArtifacts should report the complete pair only');

    // The physical view sees all three, and says which half each is.
    const entries=layout.listStoreEntries(R);
    const byHash=new Map(entries.map(e=>[e.hash,e]));
    assert.equal(entries.length,3,`expected 3 store entries, got ${entries.length}`);
    assert.deepEqual(byHash.get(pair),{hash:pair,has_object:true,has_meta:true});
    assert.deepEqual(byHash.get(metaOnly),{hash:metaOnly,has_object:false,has_meta:true});
    assert.deepEqual(byHash.get(objectOnly),{hash:objectOnly,has_object:true,has_meta:false});

    // And gc can therefore reclaim every one of them. Nothing references any
    // artifact here, so all three are orphans.
    const plan=planGc(R,{olderThanDays:0});
    const planned=new Set(plan.orphaned_artifacts.map(o=>o.sha256));
    for(const h of [pair,metaOnly,objectOnly])
      assert.ok(planned.has(h),`gc did not plan to reclaim ${h.slice(0,4)}...`);
    const half=plan.orphaned_artifacts.filter(o=>o.incomplete).map(o=>o.sha256).sort();
    assert.deepEqual(half,[metaOnly,objectOnly].sort(),'incomplete pairs are not marked as such');

    const result=applyGc(R,plan);
    assert.deepEqual(result.errors,[],`applyGc reported errors: ${JSON.stringify(result.errors)}`);
    assert.deepEqual(layout.listStoreEntries(R),[],'the store still holds debris after gc');
  }finally{fs.rmSync(R,{recursive:true,force:true});}
});

test('gc-never-plans-a-half-state-that-a-surviving-run-references',()=>{
  // The rule that matters most here, because breaking it destroys data rather
  // than leaking it. Artifact ids are content-addressed, so a metadata-less
  // entry still has a known id and must be checked against the keep set like
  // any other. Skipping that check planned every half entry as an orphan
  // unconditionally, and the orphan sweep does not depend on run eligibility --
  // so an OPEN, non-terminal run's artifact was deleted with no ageing at all.
  const R=fixture();
  try{
    layout.ensureLayout(R);
    const content='requirements a live run still needs\n';
    const artifact=putArtifact(R,{kind:'confirmed-requirements',content,runId:'run_open',stage:'REQUIREMENTS'});
    // An open run, deliberately NOT terminal, that references it.
    writeJson(layout.runFile(R,'run_open'),{
      schema:'agent-sdlc/run/v1',run_id:'run_open',state:'INTAKE',
      stages:['INTAKE','REQUIREMENTS','PLAN','IMPLEMENT','VERIFY','REVIEW','CLOSE'],
      artifacts:[artifact.artifact_id],updated_at:new Date().toISOString(),revision:1
    });
    // Now lose the metadata, leaving exactly the half-state putArtifact
    // produces after a crash.
    fs.unlinkSync(layout.objectMetaPath(R,artifact.sha256));

    const plan=planGc(R,{olderThanDays:0});
    const planned=plan.orphaned_artifacts.map(o=>o.sha256);
    assert.ok(!planned.includes(artifact.sha256),
      `gc planned to delete an artifact an open run references: ${JSON.stringify(plan.orphaned_artifacts)}`);
    applyGc(R,plan);
    assert.ok(fs.existsSync(layout.objectPath(R,artifact.sha256)),
      'gc deleted the object of a referenced artifact');
  }finally{fs.rmSync(R,{recursive:true,force:true});}
});

test('gc-planning-survives-unparseable-metadata-in-the-store',()=>{
  // `readJson(p,null)` RETHROWS, so one unparseable .meta.json anywhere in the
  // store threw out of planGc and left `gc status` and `gc apply` dead
  // project-wide -- the debris the union enumeration exists to reclaim becoming
  // the thing that blocks reclaiming anything.
  const R=fixture();
  try{
    layout.ensureLayout(R);
    const good=putArtifact(R,{kind:'k',content:'good\n',runId:'run_x',stage:'PLAN'});
    const broken='9'.repeat(64);
    fs.mkdirSync(layout.objectShardDir(R,broken),{recursive:true});
    fs.writeFileSync(layout.objectPath(R,broken),'broken');
    fs.writeFileSync(layout.objectMetaPath(R,broken),'{not json');

    let plan;
    assert.doesNotThrow(()=>{plan=planGc(R,{olderThanDays:0});},'planGc threw on unparseable metadata');
    const planned=plan.orphaned_artifacts.map(o=>o.sha256);
    assert.ok(planned.includes(broken),'the unparseable entry was not planned for reclamation');
    assert.ok(planned.includes(good.sha256),'the unreferenced good artifact was not planned');
    const result=applyGc(R,plan);
    assert.deepEqual(result.errors,[],`applyGc reported errors: ${JSON.stringify(result.errors)}`);
    assert.deepEqual(layout.listStoreEntries(R),[],'the store still holds debris after gc');
  }finally{fs.rmSync(R,{recursive:true,force:true});}
});

test('detectLayoutVersion-trusts-markers-over-a-stamp',()=>{
  // `commands.init` calls initProject unconditionally and initProject writes
  // the stamp, so one `agent-sdlc init` against a v1 tree would stamp it v2
  // with every v1 directory still in place. If the stamp were consulted first
  // that single command would permanently silence the guard on a tree whose
  // data is unreachable.
  const R=fixture();
  try{
    layout.ensureLayout(R);
    writeJson(layout.layoutFile(R),{schema:layout.LAYOUT_SCHEMA,layout_version:layout.LAYOUT_VERSION});
    // A fresh v2 tree: stamped, no markers.
    let d=layout.detectLayoutVersion(R);
    assert.equal(d.status,'CURRENT',`a stamped v2 tree reported ${d.status}`);
    assert.deepEqual(d.markers,[],`a v2 tree produced markers: ${JSON.stringify(d.markers)}`);
    // v2 relocates the colliding names one level down, so they must not count.
    assert.ok(fs.existsSync(layout.intentDir(R)),'shared/intent missing from the fixture');
    assert.ok(fs.existsSync(layout.repoIndexDir(R)),'cache/index missing from the fixture');

    // Now add v1 evidence beside the v2 stamp. The evidence has to win.
    //
    // The legacy segment is a variable, not a quoted literal, for the same
    // reason the statusline needles are assembled: written out it would be the
    // exact shape scripts/test-layout-boundary.mjs forbids, and this file would
    // need a blanket exemption from the scan it is meant to complement.
    const LEGACY_DIR='artifacts';
    fs.mkdirSync(path.join(layout.stateDir(R),LEGACY_DIR),{recursive:true});
    fs.writeFileSync(path.join(layout.runsDir(R),'run_legacy.json'),'{}');
    d=layout.detectLayoutVersion(R);
    assert.equal(d.status,'LAYOUT_MIGRATION_REQUIRED',
      `markers were overruled by the stamp: ${JSON.stringify(d)}`);
    assert.equal(d.migration_required,true);
    assert.ok(d.markers.includes(LEGACY_DIR),`markers missing artifacts: ${JSON.stringify(d.markers)}`);
    assert.ok(d.markers.some(m=>m.startsWith('runs/')),`markers missing the flat run: ${JSON.stringify(d.markers)}`);
  }finally{fs.rmSync(R,{recursive:true,force:true});}
});

test('a-metadata-only-half-state-self-heals-on-the-next-identical-put',()=>{
  // The ordering claim that justifies writing metadata first: the debris is
  // small AND the next put of the same content restores the pair, because the
  // address is the content hash and putArtifact is idempotent. If that were not
  // true the ordering would be a coin flip rather than a decision.
  const R=fixture();
  try{
    layout.ensureLayout(R);
    const content='self-healing content\n';
    const first=putArtifact(R,{kind:'k',content,runId:'run_x',stage:'PLAN'});
    // Simulate the crash: metadata landed, the object did not.
    fs.unlinkSync(layout.objectPath(R,first.sha256));
    assert.deepEqual(listArtifacts(R),[],'the broken pair is still reported as an artifact');

    const second=putArtifact(R,{kind:'k',content,runId:'run_x',stage:'PLAN'});
    assert.equal(second.sha256,first.sha256,'the address changed');
    assert.equal(listArtifacts(R).length,1,'the pair did not heal');
    assert.equal(getArtifact(R,second.artifact_id).content,content,'the healed content is wrong');
    // Dedup semantics survive the repair: one binding, not two.
    assert.equal(listArtifacts(R)[0].bindings.length,1,'the repair duplicated the binding');
  }finally{fs.rmSync(R,{recursive:true,force:true});}
});

test('the-layout-authority-depends-on-nothing-but-node-builtins',()=>{
  // util.mjs imports this module, so anything it imported from the runtime
  // would be a cycle. Checked as text because an import cycle in ESM resolves
  // to a partially initialised module rather than an error.
  const src=fs.readFileSync(path.join(ROOT,'runtime','layout.mjs'),'utf8');
  const imports=[...src.matchAll(/^import .* from ['"]([^'"]+)['"]/gm)].map(m=>m[1]);
  assert.ok(imports.length>0,'no imports found; the regex is wrong');
  for(const spec of imports)
    assert.ok(spec.startsWith('node:'),`layout.mjs imports ${spec}; it must depend only on node builtins`);
});

writeReport(path.join(ROOT,'evals','LAYOUT-VALIDATION.json'),{
  schema:'agent-sdlc/eval-report/v1',
  suite:'layout',
  layout_version:layout.LAYOUT_VERSION,
  checks:results.length,
  passes:results.filter(r=>r.status==='PASS').length,
  failures,
  results,
  status:failures?'FAIL':'PASS'
});

console.log(JSON.stringify({suite:'layout',checks:results.length,failures,
  status:failures?'FAIL':'PASS',
  results:failures?results.filter(r=>r.status==='FAIL'):results.map(r=>r.name)},null,2));
process.exit(failures?1:0);
