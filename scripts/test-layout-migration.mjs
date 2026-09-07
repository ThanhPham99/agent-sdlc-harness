// v1 -> v2 layout migration.
//
// The assertions that matter are not "files moved" but the three properties a
// migration can silently fail:
//
//   * it MOVES rather than copies, so the v1 markers clear and the project does
//     not report `compatible: false` for the rest of its life;
//   * the backup exists, holds the pre-migration tree, and is NOT itself a
//     legacy marker;
//   * it is idempotent, and a tree that is already v2 is left alone.
//
// And the outcome that actually matters to a user: after migrating, the run is
// readable through the ordinary runtime API, not merely present on disk.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import * as layout from '../runtime/layout.mjs';
import {planLayoutMigration, migrateLayout, BACKUP_PREFIX} from '../runtime/layout-migration.mjs';
import {compatCheck, migrateState} from '../runtime/compat.mjs';
import {loadRun, listRuns, listArtifacts, getArtifact, listTasks, loadTaskGraph, initProject} from '../runtime/store.mjs';
import {makeTempDir} from './lib/tempdir.mjs';
import {createSuite} from './lib/suite.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const {test, assert: check, finish} = createSuite(
  'agent-sdlc/layout-migration-validation/v1',
  'LAYOUT-MIGRATION-VALIDATION.json'
);

const RUN = 'run_11111111-2222-3333-4444-555555555555';
const OTHER = 'run_99999999-8888-7777-6666-555555555555';
const HASH = 'ab' + 'c'.repeat(62);

/** A realistic v1 tree, written with v1's own path shapes. */
function v1Fixture() {
  const root = makeTempDir('layout-v1-');
  // The root comes from the accessor even though this fixture writes v1 shapes
  // beneath it: the state directory itself is the one path both layouts agree
  // on, and composing it by hand here would be the very thing
  // scripts/test-layout-boundary.mjs exists to forbid.
  const d = layout.stateDir(root);
  const w = (rel, content) => {
    const p = path.join(d, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  };
  w('project.json', JSON.stringify({ schema: 'agent-sdlc/project/v1', project: 'fx', commands: {} }, null, 2));
  w('state.json', JSON.stringify({ schema: 'agent-sdlc/state/v1', harness_version: '0.0.0-test', active_run_id: RUN }, null, 2));

  const run = {
    schema: 'agent-sdlc/run/v1', run_id: RUN, objective: 'v1 run to migrate', workflow: 'refactor',
    state: 'IMPLEMENT', stages: ['INTAKE', 'IMPLEMENT', 'CLOSE'], revision: 3,
    updated_at: new Date().toISOString(), artifacts: [`artifact://sha256/${HASH}`]
  };
  w(`runs/${RUN}.json`, JSON.stringify(run, null, 2));
  w(`runs/${OTHER}.json`, JSON.stringify({ ...run, run_id: OTHER, artifacts: [] }, null, 2));
  w(`events/${RUN}.jsonl`, JSON.stringify({ event_id: 'evt_1', run_id: RUN, type: 'run.created' }) + '\n');
  w(`cost/${RUN}.jsonl`, JSON.stringify({ run_id: RUN, input_tokens: 10 }) + '\n');
  w(`evidence/${RUN}.jsonl`, JSON.stringify({ run_id: RUN, claim: 'requirements_confirmed' }) + '\n');
  w(`ci-evidence/${RUN}.json`, JSON.stringify({ run_id: RUN, status: 'PASS' }, null, 2));
  w(`ci-evidence/${RUN}.jsonl`, JSON.stringify({ run_id: RUN, status: 'PASS' }) + '\n');
  w(`delivery/${RUN}.json`, JSON.stringify({ run_id: RUN, branch: 'x' }, null, 2));
  w(`requirement-update/${RUN}.json`, JSON.stringify({ run_id: RUN }, null, 2));
  w(`tasks/${RUN}/TASK-001.json`, JSON.stringify({ schema: 'agent-sdlc/task/v1', run_id: RUN, task_id: 'TASK-001', status: 'DONE' }, null, 2));
  w(`tasks/${RUN}/graph.json`, JSON.stringify({ schema: 'agent-sdlc/task-graph/v1', run_id: RUN, nodes: [], edges: [] }, null, 2));
  w(`task-events/${RUN}.jsonl`, JSON.stringify({ run_id: RUN, task_id: 'TASK-001', type: 'task.created' }) + '\n');
  w(`task-context/${RUN}/TASK-001.json`, JSON.stringify({ run_id: RUN, task_id: 'TASK-001' }, null, 2));
  w(`task-evidence/${RUN}/keep.txt`, 'evidence\n');
  w(`traceability/${RUN}.json`, JSON.stringify({ run_id: RUN, nodes: [] }, null, 2));
  w(`traceability/${RUN}-invalidations.jsonl`, JSON.stringify({ run_id: RUN }) + '\n');
  w(`workspaces/${RUN}/TASK-001.json`, JSON.stringify({ run_id: RUN, task_id: 'TASK-001' }, null, 2));

  // The content store, v1 shape: parallel objects/ and meta/ trees.
  w(`artifacts/objects/${HASH}`, 'artifact content\n');
  w(`artifacts/meta/${HASH}.json`, JSON.stringify({
    artifact_id: `artifact://sha256/${HASH}`, kind: 'confirmed-requirements', sha256: HASH,
    run_id: RUN, stage: 'REQUIREMENTS', bindings: [{ run_id: RUN, stage: 'REQUIREMENTS', kind: 'confirmed-requirements' }]
  }, null, 2));

  // Cross-run, cache and docs, all at v1's top level.
  w('handoffs/handoff_a.json', JSON.stringify({ handoff_id: 'handoff_a', run_id: RUN, time: '2026-01-01T00:00:00Z', artifact_refs: [] }, null, 2));
  w('features/feature_a.json', JSON.stringify({ feature_id: 'feature_a' }, null, 2));
  w('memory/failure-index.json', JSON.stringify({ entries: [] }, null, 2));
  w('webhooks/deliveries.json', JSON.stringify([], null, 2));
  w('intent/template.md', '# intent\n');
  w('quarantine.json', JSON.stringify({ tests: [] }, null, 2));
  w('activation.jsonl', JSON.stringify({ decision: 'ACTIVATE' }) + '\n');
  w('index/repo-index.json', JSON.stringify({ files: [] }, null, 2));
  w('dashboard.html', '<html>v1</html>');
  w('SUMMARY.md', '# summary\n');
  w('REVIEW.md', '# review\n');
  w('docs/README.md', '# docs readme\n');
  w('docs/CLI-CHEAT-SHEET.md', '# cli\n');
  w(`reports/${RUN}.md`, '# run report\n');
  return { root, d, run };
}

test('a-v1-tree-is-detected-as-requiring-migration', () => {
  const { root } = v1Fixture();
  const detected = layout.detectLayoutVersion(root);
  check(detected.migration_required === true, `expected migration_required, got ${JSON.stringify(detected)}`);
  check(detected.status === 'LAYOUT_MIGRATION_REQUIRED', `status was ${detected.status}`);
  check(detected.markers.length > 5, `expected several markers, got ${JSON.stringify(detected.markers)}`);
  // And compat-check must say so rather than reporting a state-metadata nit.
  const compat = compatCheck(ROOT, root);
  check(compat.status === 'LAYOUT_MIGRATION_REQUIRED', `compatCheck said ${compat.status}`);
  check(compat.compatible === false, 'a tree whose history is unreachable was reported compatible');
});

test('planning-is-read-only-and-names-every-move', () => {
  const { root, d } = v1Fixture();
  const before = fs.readdirSync(d).sort();
  const plan = planLayoutMigration(root);
  check(plan.move_count > 25, `expected the full v1 surface, planned ${plan.move_count}`);
  check(fs.existsSync(path.join(d, `runs/${RUN}.json`)), 'planning moved a file');
  assert.deepEqual(fs.readdirSync(d).sort(), before, 'planning changed the tree');
  // Dry run is equally inert.
  const dry = migrateLayout(root, { dryRun: true });
  check(dry.status === 'DRY_RUN' && dry.migrated === false, `dry run reported ${dry.status}`);
  assert.deepEqual(fs.readdirSync(d).sort(), before, 'a dry run changed the tree');
});

test('migration-moves-rather-than-copies-so-the-markers-clear', () => {
  // The load-bearing assertion. `detectLayoutVersion` tests EXISTENCE of the
  // legacy names, so a migration that copied out of them would leave a
  // correctly migrated project reporting compatible:false forever -- and an
  // empty leftover directory is just as fatal as a full one.
  const { root, d } = v1Fixture();
  const result = migrateLayout(root);
  check(result.status === 'MIGRATED', `migration reported ${result.status}: ${JSON.stringify(result.retained_legacy_dirs || [])}`);

  const after = layout.detectLayoutVersion(root);
  check(after.status === 'CURRENT', `post-migration status was ${after.status}`);
  assert.deepEqual(after.markers, [], `post-migration markers: ${JSON.stringify(after.markers)}`);
  check(after.migration_required === false, 'still reports migration_required');
  check(after.stamped === true, 'the migrated tree carries no version stamp');

  for (const legacy of ['runs/' + RUN + '.json', 'events', 'cost', 'evidence', 'ci-evidence',
    'delivery', 'requirement-update', 'task-events', 'task-context', 'task-evidence',
    'traceability', 'workspaces', 'artifacts', 'handoffs', 'features', 'memory',
    'webhooks', 'intent', 'index', 'reports']) {
    check(!fs.existsSync(path.join(d, legacy)), `legacy path survived: ${legacy}`);
  }
  // compat-check now agrees.
  check(compatCheck(ROOT, root).status !== 'LAYOUT_MIGRATION_REQUIRED', 'compatCheck still demands migration');
});

test('every-v1-path-arrives-at-its-v2-location', () => {
  const { root } = v1Fixture();
  migrateLayout(root);
  const expected = {
    'run document': layout.runFile(root, RUN),
    'events': layout.runEventsFile(root, RUN),
    'cost': layout.runCostFile(root, RUN),
    'evidence': layout.runEvidenceFile(root, RUN),
    'ci evidence record': layout.runCiEvidenceFile(root, RUN),
    'ci evidence log': layout.runCiEvidenceLogFile(root, RUN),
    'delivery': layout.runDeliveryFile(root, RUN),
    'requirement update': layout.runRequirementUpdateFile(root, RUN),
    'task record': layout.taskFile(root, RUN, 'TASK-001'),
    'task graph': layout.taskGraphFile(root, RUN),
    'task events': layout.runTaskEventsFile(root, RUN),
    'task context': layout.taskContextFile(root, RUN, 'TASK-001'),
    'traceability graph': layout.traceabilityGraphFile(root, RUN),
    'traceability invalidations': layout.traceabilityInvalidationsFile(root, RUN),
    'workspace record': layout.taskWorkspaceRecordFile(root, RUN, 'TASK-001'),
    'store object': layout.objectPath(root, HASH),
    'store metadata': layout.objectMetaPath(root, HASH),
    'handoff': layout.handoffFile(root, 'handoff_a'),
    'feature': layout.featureFile(root, 'feature_a'),
    'failure index': layout.failureIndexFile(root),
    'webhook deliveries': layout.webhookDeliveriesFile(root),
    'intent template': layout.intentTemplateFile(root),
    'quarantine': layout.quarantineFile(root),
    'activation log': layout.activationLogFile(root),
    'repo index': layout.repoIndexFile(root),
    'dashboard': layout.dashboardFile(root),
    'summary': layout.summaryFile(root),
    'review': layout.reviewFile(root),
    'guide': layout.guideFile(root, 'README.md'),
    'run report': layout.runReportFile(root, RUN),
    'second run document': layout.runFile(root, OTHER)
  };
  for (const [what, p] of Object.entries(expected)) {
    check(fs.existsSync(p), `${what} is missing at ${path.relative(root, p)}`);
  }
  // Content is moved, not rewritten.
  assert.equal(fs.readFileSync(layout.objectPath(root, HASH), 'utf8'), 'artifact content\n');
  assert.equal(fs.readFileSync(layout.summaryFile(root), 'utf8'), '# summary\n');
});

test('the-migrated-run-is-readable-through-the-runtime-api', () => {
  // Present on disk is not the same as usable. This is what a user notices.
  const { root } = v1Fixture();
  migrateLayout(root);
  assert.deepEqual(listRuns(root).sort(), [OTHER, RUN].sort(), 'listRuns does not see the migrated runs');
  const run = loadRun(root, RUN);
  assert.equal(run.objective, 'v1 run to migrate');
  assert.equal(run.revision, 3);
  const tasks = listTasks(root, RUN);
  assert.equal(tasks.length, 1, `expected one task, got ${tasks.length}`);
  assert.equal(tasks[0].task_id, 'TASK-001');
  check(loadTaskGraph(root, RUN) !== null, 'the task graph is unreadable');
  const artifacts = listArtifacts(root);
  assert.equal(artifacts.length, 1, `expected one artifact, got ${artifacts.length}`);
  assert.equal(getArtifact(root, `artifact://sha256/${HASH}`).content, 'artifact content\n');
});

test('the-pre-migration-tree-is-recoverable-from-the-backup', () => {
  const { root, d } = v1Fixture();
  const result = migrateLayout(root);
  const backup = path.join(root, result.backup);
  check(fs.existsSync(backup), `backup missing at ${result.backup}`);
  // The v1 shape is intact inside it...
  check(fs.existsSync(path.join(backup, `runs/${RUN}.json`)), 'the backup lost the v1 run document');
  check(fs.existsSync(path.join(backup, `artifacts/objects/${HASH}`)), 'the backup lost the v1 object store');
  assert.equal(fs.readFileSync(path.join(backup, 'SUMMARY.md'), 'utf8'), '# summary\n');
  // ...and the backup's own name is not a legacy marker, or it would keep the
  // tree looking unmigrated.
  check(path.basename(backup).startsWith(BACKUP_PREFIX), `unexpected backup name ${path.basename(backup)}`);
  assert.deepEqual(layout.detectLayoutVersion(root).markers, [],
    'the backup directory is itself being read as a v1 marker');
  check(fs.existsSync(path.join(d, 'LAYOUT.json')), 'no layout stamp was written');
});

test('migration-is-idempotent-and-leaves-a-v2-tree-alone', () => {
  const { root } = v1Fixture();
  const first = migrateLayout(root);
  check(first.status === 'MIGRATED', `first run reported ${first.status}`);

  const snapshot = (dir) => {
    const out = {};
    const walk = (p) => {
      for (const e of fs.readdirSync(p, { withFileTypes: true })) {
        const full = path.join(p, e.name);
        if (e.isDirectory()) walk(full);
        else out[path.relative(dir, full).split(path.sep).join('/')] = fs.readFileSync(full, 'utf8');
      }
    };
    walk(dir);
    return out;
  };
  const before = snapshot(layout.runsDir(root));

  const second = migrateLayout(root);
  check(second.status === 'ALREADY_CURRENT', `second run reported ${second.status}`);
  check(second.migrated === false, 'the second run claimed to migrate');
  check(second.move_count === 0, `the second run planned ${second.move_count} moves`);
  assert.deepEqual(snapshot(layout.runsDir(root)), before, 'the second run changed the tree');
  // And exactly one backup exists: a no-op must not accumulate copies.
  const backups = fs.readdirSync(layout.stateDir(root)).filter(n => n.startsWith(BACKUP_PREFIX));
  assert.equal(backups.length, 1, `expected one backup, found ${backups.length}`);
});

test('migrate-state-migrates-the-shape-before-reading-the-metadata', () => {
  // migrateState reads state.json on every path, and a v1 tree's state.json is
  // the one file at the same location in both layouts -- so the shape has to be
  // migrated first for the rest of that function to be looking at a real tree.
  const { root } = v1Fixture();
  const result = migrateState(ROOT, root);
  check(result.layout !== undefined, 'migrateState did not report the layout migration');
  check(result.layout.migrated === true, `layout migration reported ${result.layout.status}`);
  assert.deepEqual(layout.detectLayoutVersion(root).markers, [], 'markers survived migrateState');
  check(loadRun(root, RUN).objective === 'v1 run to migrate', 'the run is unreadable after migrateState');
  // Second call is a no-op on the shape.
  const again = migrateState(ROOT, root);
  check(again.layout.migrated === false, 'the second migrateState re-migrated the shape');
});

test('a-healthy-v2-project-is-left-alone-even-with-content-the-plan-does-not-recognise', () => {
  // The mirror image of every other fixture here, and the case that caught a
  // regression: the sweeps are deliberately greedy -- `docs/` takes every child
  // outside v2's own four -- so once "nothing left behind" started forcing a
  // migration, a single unrecognised file in a HEALTHY v2 project was relocated
  // and the result reported MIGRATED, with no v1 data anywhere. `migrateState`
  // calls this unconditionally, so a routine `migrate` did it every time.
  //
  // Built with initProject rather than by hand, because the bug only appears on
  // a tree the runtime itself considers normal.
  const root = makeTempDir('layout-v2-real-');
  initProject(root, { schema: 'agent-sdlc/project/v1', project: 'healthy', commands: {} });
  check(layout.detectLayoutVersion(root).status === 'CURRENT', 'the fixture is not a clean v2 tree');

  // A user's own file, in a place the migration plan has an opinion about.
  const stray = path.join(layout.docsDir(root), 'notes.md');
  fs.writeFileSync(stray, '# my notes\n');
  const strayInReports = path.join(layout.reportsDir(root), 'keep.txt');
  fs.writeFileSync(strayInReports, 'keep me\n');

  const result = migrateLayout(root);
  check(result.status === 'ALREADY_CURRENT', `a healthy v2 tree reported ${result.status}`);
  check(result.migrated === false, 'a healthy v2 tree was migrated');
  check(fs.existsSync(stray), 'a user file in docs/ was relocated by the migrator');
  check(fs.existsSync(strayInReports), 'a user file in docs/reports/ was relocated by the migrator');
  check(!fs.existsSync(path.join(layout.guidesDir(root), 'notes.md')), 'docs/notes.md was swept into guides/');
  const backups = fs.readdirSync(layout.stateDir(root)).filter(n => n.startsWith(BACKUP_PREFIX));
  assert.equal(backups.length, 0, 'a healthy v2 tree was backed up for no reason');

  // And migrateState, which invokes this unconditionally, is equally inert.
  migrateState(ROOT, root);
  check(fs.existsSync(stray), 'migrateState relocated a user file in a healthy v2 tree');
});

test('an-incomplete-migration-resumes-because-the-stamp-says-so', () => {
  // The other half of that gate: a tree whose markers are clean but whose stamp
  // records unfinished work must still be picked up, or the leftovers would be
  // indistinguishable from ordinary v2 content and never looked at again.
  const { root, d } = v1Fixture();
  fs.writeFileSync(path.join(d, 'docs', 'My Notes.md'), '# notes\n');
  const first = migrateLayout(root);
  check(first.status === 'INCOMPLETE', `expected INCOMPLETE, got ${first.status}`);

  const stampAfterFirst = JSON.parse(fs.readFileSync(layout.layoutFile(root), 'utf8'));
  check(stampAfterFirst.migration_incomplete === true, 'the stamp does not record unfinished work');
  check((stampAfterFirst.migration_leftovers?.unaddressable || []).includes('docs/My Notes.md'),
    `the stamp does not name the leftover: ${JSON.stringify(stampAfterFirst.migration_leftovers)}`);

  // Markers are clean by now, so only the stamp can bring it back.
  assert.deepEqual(layout.detectLayoutVersion(root).markers, [], 'markers are not clean; the test proves nothing');
  const second = migrateLayout(root);
  check(second.status === 'INCOMPLETE', `the resume reported ${second.status} instead of INCOMPLETE`);
  check((second.unaddressable || []).length === 1, 'the resume lost track of the leftover');

  // Rename the offending file and the resume finishes, clearing the stamp.
  fs.renameSync(path.join(d, 'docs', 'My Notes.md'), path.join(d, 'docs', 'My-Notes.md'));
  const third = migrateLayout(root);
  check(third.status === 'MIGRATED', `after renaming, the resume reported ${third.status}`);
  check(fs.existsSync(layout.guideFile(root, 'My-Notes.md')), 'the renamed file did not migrate');
  const stampAfterThird = JSON.parse(fs.readFileSync(layout.layoutFile(root), 'utf8'));
  check(!stampAfterThird.migration_incomplete, 'the stamp still claims unfinished work');
  // And now it is an ordinary v2 tree again.
  check(migrateLayout(root).status === 'ALREADY_CURRENT', 'the finished tree still resumes');
});

test('the-incomplete-error-names-every-cause', () => {
  // The message interpolated `retained_legacy_dirs` only, so the commonest
  // cause -- a name v2 cannot address -- threw `incomplete: []`, which reads as
  // a harness bug rather than as a file to rename.
  const { root, d } = v1Fixture();
  fs.writeFileSync(path.join(d, 'docs', 'My Notes.md'), '# notes\n');
  let message = '';
  try { migrateState(ROOT, root); } catch (e) { message = e.message; }
  check(message.includes('My Notes.md'), `the error does not name the offending file: ${message}`);
  check(!message.includes('incomplete: []'), `the error still reports an empty cause: ${message}`);
  check(message.includes('.backup-v1'), `the error does not name the backup: ${message}`);
});

test('a-fresh-v2-project-is-never-migrated', () => {
  const root = makeTempDir('layout-v2-');
  layout.ensureLayout(root);
  fs.writeFileSync(layout.layoutFile(root), JSON.stringify({
    schema: layout.LAYOUT_SCHEMA, layout_version: layout.LAYOUT_VERSION
  }, null, 2));
  fs.writeFileSync(layout.projectConfigFile(root), JSON.stringify({ schema: 'agent-sdlc/project/v1' }, null, 2));
  const result = migrateLayout(root);
  check(result.status === 'ALREADY_CURRENT', `a v2 tree reported ${result.status}`);
  check(result.migrated === false, 'a v2 tree was migrated');
  const backups = fs.readdirSync(layout.stateDir(root)).filter(n => n.startsWith(BACKUP_PREFIX));
  assert.equal(backups.length, 0, 'a v2 tree was backed up for no reason');
});

test('an-uninitialized-project-and-a-legacy-tree-are-both-refused', () => {
  const bare = makeTempDir('layout-bare-');
  const result = migrateLayout(bare);
  check(result.status === 'UNINITIALIZED', `a bare directory reported ${result.status}`);

  // The .ai-workflow legacy tree keeps its existing refusal: it is not a layout
  // migration, and converting it was never automatic.
  const legacy = makeTempDir('layout-legacy-');
  fs.mkdirSync(path.join(legacy, '.ai-workflow'), { recursive: true });
  const compat = compatCheck(ROOT, legacy);
  check(compat.status === 'LEGACY_V2_DETECTED', `a .ai-workflow tree reported ${compat.status}`);
  check(compat.compatible === false, 'a legacy tree was reported compatible');
  assert.throws(() => migrateState(ROOT, legacy), /automatic migration refused/,
    'migrateState did not refuse a .ai-workflow tree');
});

test('nothing-left-behind-is-ever-reported-as-MIGRATED', () => {
  // `status` used to be derived from the MARKER state alone, and the marker set
  // is smaller than the set of directories this module treats as legacy: 19
  // markers against 21 legacy names. `reports/` and `backups/` fall in the gap,
  // so a file left in `reports/` kept the directory alive while the migration
  // still called itself MIGRATED -- and `migrateState` waved it through,
  // because it only throws on INCOMPLETE.
  const { root, d } = v1Fixture();
  fs.writeFileSync(path.join(d, 'reports', 'notes.txt'), 'not a markdown report\n');
  const result = migrateLayout(root);
  check(result.status === 'MIGRATED',
    `a non-.md file in reports/ was not migrated: ${JSON.stringify(result.retained_legacy_dirs)}`);
  check(fs.existsSync(layout.reportFile(root, 'notes.txt')), 'the non-.md report was left behind');
  check(!fs.existsSync(path.join(d, 'reports')), 'the legacy reports/ directory survived');
});

test('a-docs-subdirectory-is-migrated-rather-than-silently-stranded', () => {
  // `docs` is neither a marker nor a legacy directory, so a subdirectory left
  // here was reported by NOTHING -- not the migration, not detectLayoutVersion,
  // not any later check. It simply stayed at its v1 path while the tree called
  // itself CURRENT, which is the worst shape a migration bug can take.
  const { root, d } = v1Fixture();
  fs.mkdirSync(path.join(d, 'docs', 'sub'), { recursive: true });
  fs.writeFileSync(path.join(d, 'docs', 'sub', 'deep.md'), '# deep\n');
  const result = migrateLayout(root);
  check(result.status === 'MIGRATED', `reported ${result.status}`);
  check(!fs.existsSync(path.join(d, 'docs', 'sub', 'deep.md')), 'the docs subdirectory stayed at its v1 path');
  check(fs.existsSync(path.join(layout.guidesDir(root), 'sub', 'deep.md')),
    'the docs subdirectory did not arrive under docs/guides/');
  // And v2's own children are never moved into themselves on a re-run.
  const again = migrateLayout(root);
  check(again.status === 'ALREADY_CURRENT', `second run reported ${again.status}`);
  check(!fs.existsSync(path.join(layout.guidesDir(root), 'guides')), 'guides/ was moved into itself');
});

test('an-unaddressable-filename-is-reported-not-fatal', () => {
  // `guideFile`/`reportFile` reject an unsafe segment by throwing, and a v1 tree
  // can legally hold `docs/My Notes.md`. One such file made planning throw
  // before it returned, so the tree stayed v1 FOREVER: every retry threw at the
  // same file. It failed safe -- planning precedes the backup -- but permanently.
  const { root, d } = v1Fixture();
  fs.writeFileSync(path.join(d, 'docs', 'My Notes.md'), '# notes\n');

  // Planning must return rather than throw; before the fix this line was the
  // end of the migration for this tree, permanently.
  const plan = planLayoutMigration(root);
  const flagged = (plan.unaddressable || []).some(u => u.what === 'docs/My Notes.md');
  check(flagged, `the unsafe name was not reported: ${JSON.stringify(plan.unaddressable)}`);

  const result = migrateLayout(root);
  // Everything else migrates; the one file stays where it is and the migration
  // says so rather than claiming success.
  check(result.status === 'INCOMPLETE', `an unaddressable entry was reported as ${result.status}`);
  check((result.unaddressable || []).length === 1, `unaddressable: ${JSON.stringify(result.unaddressable)}`);
  check(fs.existsSync(path.join(d, 'docs', 'My Notes.md')), 'the unaddressable file was lost');
  check(fs.existsSync(layout.guideFile(root, 'README.md')), 'the addressable guides did not migrate');
  // migrateState must refuse to pass an incomplete migration off as done.
  assert.throws(() => migrateState(ROOT, root), /layout migration incomplete/,
    'migrateState accepted an incomplete migration');
});

test('a-recovered-migration-keeps-the-pristine-backup', () => {
  // A re-run is the recovery path and is meant to work. Taking a fresh backup
  // then would capture the HALF-MIGRATED tree, while the pristine copy from the
  // first attempt sat unreferenced -- and since the re-run writes LAYOUT.json,
  // the recorded backup would be the useless one.
  const { root, d } = v1Fixture();
  const first = migrateLayout(root);
  check(first.status === 'MIGRATED', `first run reported ${first.status}`);
  const backups = fs.readdirSync(d).filter(n => n.startsWith(BACKUP_PREFIX));
  assert.equal(backups.length, 1, `expected one backup, found ${backups.length}`);
  // The recorded backup holds the v1 shape, not a migrated one.
  const recorded = JSON.parse(fs.readFileSync(layout.layoutFile(root), 'utf8')).backup;
  check(fs.existsSync(path.join(root, recorded, `runs/${RUN}.json`)),
    `the recorded backup (${recorded}) does not hold the pre-migration tree`);
});

test('migration-never-overwrites-an-existing-v2-path', () => {
  // A half-migrated tree is the realistic bad input: something moved, then the
  // process died. Replacing v2 data with v1 data is worse than stopping, so a
  // destination that already exists is skipped and reported.
  const { root } = v1Fixture();
  // Pre-create the v2 run document with different content.
  fs.mkdirSync(path.dirname(layout.runFile(root, RUN)), { recursive: true });
  fs.writeFileSync(layout.runFile(root, RUN), JSON.stringify({ run_id: RUN, objective: 'already v2' }, null, 2));
  const result = migrateLayout(root);
  const skippedRunDoc = (result.skipped || []).some(s => s.what === `runs/${RUN}.json` && s.reason === 'DESTINATION_EXISTS');
  check(skippedRunDoc, `the existing v2 run document was not reported as skipped: ${JSON.stringify(result.skipped)}`);
  assert.equal(loadRun(root, RUN).objective, 'already v2', 'v2 data was overwritten with v1 data');
});

finish();
