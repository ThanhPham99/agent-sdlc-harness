// v1 -> v2 layout migration.
//
// The v1 tree kept 24 namespaces side by side at the top level, most of them
// keyed by run id: `runs/<id>.json`, `events/<id>.jsonl`, `tasks/<id>/`, and so
// on. v2 gathers everything one run owns into `runs/<run_id>/`, shards the
// content store, and separates the three lifetimes (config / durable / cache /
// docs). runtime/layout.mjs describes the result; this module gets an existing
// project there.
//
// Three properties this has to have, and each one is a way it could quietly go
// wrong:
//
//   * It MOVES. `detectLayoutVersion` reports `migration_required` while any
//     legacy top-level name still exists, so a migration that copied out of the
//     old directories would leave a correctly migrated project reporting
//     `compatible: false` forever. The markers are the acceptance test.
//   * It backs up FIRST, to a name that is not itself a legacy marker --
//     otherwise the backup would keep the tree looking unmigrated.
//   * It only touches trees that are ITS BUSINESS: one whose shape is still v1,
//     or one whose stamp records a migration that left work behind. A v2 project
//     is left alone even when it holds files this module does not recognise --
//     the sweeps here are deliberately greedy, so run against a healthy tree
//     they relocate a user's own content and call it a migration.
//   * It is IDEMPOTENT. A second run over a finished tree finds nothing to do
//     and says so, rather than half-applying to a tree that is already v2.
//
// It does not rewrite content. Every operation is a rename of a file or a
// directory, so an interrupted migration leaves files in one place or the
// other, never truncated -- and the backup holds the original tree either way.
import fs from 'node:fs';
import path from 'node:path';
import * as layout from './layout.mjs';
import {now, readJson, writeJson} from './util.mjs';

export const MIGRATION_SCHEMA = 'agent-sdlc/layout-migration/v1';
export const BACKUP_PREFIX = '.backup-v1';

/** A run id, as v1 spelled it in a filename. */
const RUN_ID = /^(run_[A-Za-z0-9._-]+)$/;
const isRunId = (name) => RUN_ID.test(name);

/** Entries of `dir`, or [] when it does not exist. Never throws on a missing tree. */
function entries(dir) {
  if (!fs.existsSync(dir)) return [];
  try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}

const stripExt = (name, ext) => (name.endsWith(ext) ? name.slice(0, -ext.length) : null);

/**
 * Every move this migration would make, as `{from, to, what}` with absolute
 * paths -- computed without touching disk beyond reading directory listings.
 *
 * Pure, so `status` can show the plan and `apply` can execute exactly it, the
 * same split `planGc`/`applyGc` uses. A path is only planned when its source
 * exists, so the list doubles as the answer to "is there anything to do".
 */
export function planLayoutMigration(projectRoot) {
  const d = layout.stateDir(projectRoot);
  const at = (...p) => path.join(d, ...p);
  const moves = [];
  const add = (from, to, what) => { if (fs.existsSync(from)) moves.push({ from, to, what }); };

  // Destinations that go through a VALIDATING accessor need the accessor call
  // itself guarded, not just the move.
  //
  // `guideFile`, `reportFile`, `handoffFile` and the feature accessors reject an
  // unsafe path segment by throwing -- which is right, but a v1 tree can legally
  // contain `docs/My Notes.md`, and one such file made `planLayoutMigration`
  // throw before it returned. The tree then stayed v1 forever: every retry threw
  // at the same file, and no amount of re-running could get past it. It failed
  // safe (planning precedes the backup, so nothing was mutated) but it was
  // permanent, which is worse than a file left behind and reported.
  //
  // The artifact loops below already had this shape. This gives it to the rest:
  // an entry whose destination cannot be addressed in v2 is recorded and left
  // exactly where it is, which also keeps its legacy directory non-empty and so
  // forces the migration to report itself INCOMPLETE.
  const unaddressable = [];
  const addSafe = (from, toFn, what) => {
    if (!fs.existsSync(from)) return;
    let to;
    try { to = toFn(); }
    catch (e) { unaddressable.push({ what, reason: 'UNSAFE_NAME_FOR_V2', detail: String(e.message).slice(0, 160) }); return; }
    moves.push({ from, to, what });
  };

  // --- per-run files, keyed by `<run_id>.<ext>` -----------------------------
  const runScopedFiles = [
    { dir: 'events', ext: '.jsonl', to: (id) => layout.runEventsFile(projectRoot, id) },
    { dir: 'cost', ext: '.jsonl', to: (id) => layout.runCostFile(projectRoot, id) },
    { dir: 'evidence', ext: '.jsonl', to: (id) => layout.runEvidenceFile(projectRoot, id) },
    { dir: 'ci-evidence', ext: '.json', to: (id) => layout.runCiEvidenceFile(projectRoot, id) },
    { dir: 'ci-evidence', ext: '.jsonl', to: (id) => layout.runCiEvidenceLogFile(projectRoot, id) },
    { dir: 'delivery', ext: '.json', to: (id) => layout.runDeliveryFile(projectRoot, id) },
    { dir: 'requirement-update', ext: '.json', to: (id) => layout.runRequirementUpdateFile(projectRoot, id) },
    { dir: 'task-events', ext: '.jsonl', to: (id) => layout.runTaskEventsFile(projectRoot, id) }
  ];
  for (const spec of runScopedFiles) {
    for (const e of entries(at(spec.dir))) {
      if (!e.isFile()) continue;
      const id = stripExt(e.name, spec.ext);
      // `.json` and `.jsonl` share a directory in ci-evidence, and stripping
      // `.json` off `<id>.jsonl` yields `<id>.jsonl` minus nothing -- so the id
      // is validated rather than assumed.
      if (!id || !isRunId(id)) continue;
      addSafe(at(spec.dir, e.name), () => spec.to(id), `${spec.dir}/${e.name}`);
    }
  }

  // The run document itself: `runs/<id>.json` -> `runs/<id>/run.json`. Planned
  // last among run files but executed in order; the target directory is created
  // at apply time.
  for (const e of entries(at('runs'))) {
    if (!e.isFile()) continue;
    const id = stripExt(e.name, '.json');
    if (!id || !isRunId(id)) continue;
    addSafe(at('runs', e.name), () => layout.runFile(projectRoot, id), `runs/${e.name}`);
  }

  // --- per-run directories --------------------------------------------------
  const runScopedDirs = [
    { dir: 'tasks', to: (id) => layout.runTasksDir(projectRoot, id) },
    { dir: 'task-context', to: (id) => layout.runTaskContextDir(projectRoot, id) },
    { dir: 'task-evidence', to: (id) => layout.runTaskEvidenceDir(projectRoot, id) },
    { dir: 'workspaces', to: (id) => layout.runWorkspacesDir(projectRoot, id) }
  ];
  for (const spec of runScopedDirs) {
    for (const e of entries(at(spec.dir))) {
      if (!e.isDirectory() || !isRunId(e.name)) continue;
      addSafe(at(spec.dir, e.name), () => spec.to(e.name), `${spec.dir}/${e.name}/`);
    }
  }

  // Traceability split a run across two differently-named files; v2 gives the
  // run a directory and names them by role.
  for (const e of entries(at('traceability'))) {
    if (!e.isFile()) continue;
    const invalidations = stripExt(e.name, '-invalidations.jsonl');
    if (invalidations && isRunId(invalidations)) {
      addSafe(at('traceability', e.name), () => layout.traceabilityInvalidationsFile(projectRoot, invalidations),
        `traceability/${e.name}`);
      continue;
    }
    const id = stripExt(e.name, '.json');
    if (id && isRunId(id)) addSafe(at('traceability', e.name), () => layout.traceabilityGraphFile(projectRoot, id),
      `traceability/${e.name}`);
  }

  // The generated run report is run-scoped and lives under docs/ in v2.
  // EVERY entry, not just `*.md` files. A `.md` filter left anything else in
  // `reports/` behind, and `reports` is a legacy directory to this module but
  // not a marker to `detectLayoutVersion` -- so the directory survived while the
  // migration still reported MIGRATED.
  for (const e of entries(at('reports'))) {
    const id = e.isFile() && e.name.endsWith('.md') ? stripExt(e.name, '.md') : null;
    addSafe(at('reports', e.name),
      () => (id && isRunId(id) ? layout.runReportFile(projectRoot, id) : layout.reportFile(projectRoot, e.name)),
      `reports/${e.name}`);
  }

  // --- the content-addressed store -----------------------------------------
  // `artifacts/objects/<hash>` + `artifacts/meta/<hash>.json` become one
  // sharded pair. A hash that fails validation is left alone rather than
  // guessed at: it is not addressable in v2 and moving it would hide it.
  for (const e of entries(at('artifacts', 'objects'))) {
    if (!e.isFile()) continue;
    try { add(at('artifacts', 'objects', e.name), layout.objectPath(projectRoot, e.name), `artifacts/objects/${e.name}`); }
    catch { /* not a sha256 address; left for the backup to preserve */ }
  }
  for (const e of entries(at('artifacts', 'meta'))) {
    if (!e.isFile()) continue;
    const hash = stripExt(e.name, '.json');
    if (!hash) continue;
    try { add(at('artifacts', 'meta', e.name), layout.objectMetaPath(projectRoot, hash), `artifacts/meta/${e.name}`); }
    catch { /* not a sha256 address */ }
  }

  // --- cross-run state, into shared/ ---------------------------------------
  const sharedMoves = [
    ['handoffs', layout.handoffsDir(projectRoot)],
    ['features', layout.featuresDir(projectRoot)],
    ['memory', layout.memoryDir(projectRoot)],
    ['webhooks', layout.webhooksDir(projectRoot)],
    ['intent', layout.intentDir(projectRoot)],
    ['backups', layout.backupsDir(projectRoot)],
    ['quarantine.json', layout.quarantineFile(projectRoot)],
    ['activation.jsonl', layout.activationLogFile(projectRoot)]
  ];
  for (const [name, to] of sharedMoves) add(at(name), to, name);

  // --- regenerable state, into cache/ --------------------------------------
  add(at('index'), layout.repoIndexDir(projectRoot), 'index');
  add(at('dashboard.html'), layout.dashboardFile(projectRoot), 'dashboard.html');

  // --- human-readable, into docs/ ------------------------------------------
  add(at('SUMMARY.md'), layout.summaryFile(projectRoot), 'SUMMARY.md');
  add(at('REVIEW.md'), layout.reviewFile(projectRoot), 'REVIEW.md');
  // v1's `docs/` holds what v2 calls guides, and v2's `docs/` is the parent of
  // that -- the one rename whose source and destination overlap. Each file is
  // moved individually into `docs/guides/`, which needs no temporary directory
  // and leaves `docs/` in place as the v2 parent.
  // Every entry again, and for a worse reason than `reports/`: `docs` is
  // neither a marker nor a legacy directory, so a subdirectory left here is
  // reported by NOTHING -- not by the migration, not by `detectLayoutVersion`,
  // not by any later check. `.agent-sdlc/docs/sub/deep.md` simply stayed at its
  // v1 path while the tree called itself CURRENT.
  //
  // `guides` and `reports` are skipped because they are v2's own children. A
  // pure v1 tree has neither (this plan is computed before `ensureLayout`
  // runs), but a re-run after a partial migration does, and moving `guides`
  // into `guides/guides` would be its own quiet corruption.
  const V2_DOCS_CHILDREN = new Set(['guides', 'reports', 'SUMMARY.md', 'REVIEW.md']);
  for (const e of entries(at('docs'))) {
    if (V2_DOCS_CHILDREN.has(e.name)) continue;
    addSafe(at('docs', e.name), () => layout.guideFile(projectRoot, e.name), `docs/${e.name}`);
  }

  return {
    schema: MIGRATION_SCHEMA,
    from_layout_version: 1,
    to_layout_version: layout.LAYOUT_VERSION,
    detected: layout.detectLayoutVersion(projectRoot),
    move_count: moves.length,
    unaddressable,
    moves: moves.map(m => ({
      what: m.what,
      to: path.relative(projectRoot, m.to).split(path.sep).join('/')
    })),
    _moves: moves
  };
}

// Directories v1 owned that must not survive, or the markers never clear.
//
// `runs` and `docs` are deliberately absent: both are v1 names AND v2 parents.
// `runs/` holds `runs/<run_id>/` in v2, and `docs/` holds `docs/guides/`, so
// removing them would delete what the migration just built. The marker for a v1
// `runs` is a flat `runs/<id>.json` FILE, which the moves take, and `docs` is
// not a marker at all -- see detectLayoutVersion.
const LEGACY_DIRS = ['events', 'cost', 'evidence', 'ci-evidence', 'delivery',
  'requirement-update', 'tasks', 'task-events', 'task-context', 'task-evidence',
  'traceability', 'workspaces', 'artifacts', 'handoffs', 'features', 'memory',
  'webhooks', 'intent', 'backups', 'index', 'reports'];

/** Remove `dir` if it exists and is empty. Returns whether it was removed. */
function removeIfEmpty(dir) {
  if (!fs.existsSync(dir)) return false;
  try {
    if (fs.readdirSync(dir).length) return false;
    fs.rmdirSync(dir);
    return true;
  } catch { return false; }
}

/** Rename, falling back to copy+remove across filesystems. */
function rename(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try {
    fs.renameSync(from, to);
    return;
  } catch (err) {
    // EXDEV (different filesystems) is the documented reason rename fails on a
    // path that exists; anything else is a real error worth surfacing.
    if (err.code !== 'EXDEV') throw err;
  }
  fs.cpSync(from, to, { recursive: true });
  fs.rmSync(from, { recursive: true, force: true });
}

/**
 * Move `from` to `to`, MERGING when `to` already exists as a directory.
 *
 * A plain rename is not enough, because `ensureLayout` runs first and creates
 * exactly the directories these moves target -- `shared/handoffs`,
 * `shared/features`, `cache/index` and the rest. Treating an existing
 * destination as a conflict skipped every one of them, and the run then
 * reported INCOMPLETE with the legacy directories still in place: the
 * copy-instead-of-move failure, arrived at from the other direction.
 *
 * Merging descends instead. A file whose destination already exists is still
 * never overwritten -- that is the case where v2 data would be replaced by v1
 * data -- and is reported so the operator sees it.
 *
 * Returns `{moved, skipped}` describing what happened beneath this path.
 */
function moveInto(from, to, label, out = { moved: [], skipped: [] }) {
  // Existence is re-checked on the way down. The caller checks its own source,
  // but recursion reaches children from a listing taken a moment earlier, and a
  // child that vanished in between would throw ENOENT out of a loop whose whole
  // job is to keep going and report.
  if (!fs.existsSync(from)) { out.skipped.push({ what: label, reason: 'SOURCE_GONE' }); return out; }
  const fromIsDir = fs.statSync(from).isDirectory();
  if (!fromIsDir) {
    if (fs.existsSync(to)) { out.skipped.push({ what: label, reason: 'DESTINATION_EXISTS' }); return out; }
    rename(from, to);
    out.moved.push(label);
    return out;
  }
  if (!fs.existsSync(to)) {
    rename(from, to);
    out.moved.push(label);
    return out;
  }
  if (!fs.statSync(to).isDirectory()) {
    out.skipped.push({ what: label, reason: 'DESTINATION_IS_A_FILE' });
    return out;
  }
  for (const child of fs.readdirSync(from)) {
    moveInto(path.join(from, child), path.join(to, child), `${label}/${child}`, out);
  }
  removeIfEmpty(from);
  return out;
}

/**
 * Migrate a v1 tree in place, after copying it to a backup.
 *
 * Refuses rather than guesses: a tree that is already v2, or that is not
 * initialized at all, is reported and left alone.
 */
export function migrateLayout(projectRoot, { dryRun = false } = {}) {
  const d = layout.stateDir(projectRoot);
  const detected = layout.detectLayoutVersion(projectRoot);

  if (detected.status === 'UNINITIALIZED') {
    return { schema: MIGRATION_SCHEMA, status: 'UNINITIALIZED', migrated: false,
      reason: 'no .agent-sdlc directory to migrate', detected };
  }
  // Two different questions, and conflating them made this module overreach.
  //
  //   "Is this tree v1?"                      -> detected.migration_required
  //   "Did a previous migration leave work?"  -> the stamp says so
  //
  // Only those two are this migration's business. Everything else in the tree
  // is a v2 project's own content, and the sweeps below are deliberately greedy
  // -- `docs/` takes every child that is not one of v2's four -- so running them
  // on a v2 tree relocates files nobody asked about. A single `docs/notes.md` in
  // a healthy project was moved to `docs/guides/notes.md` and reported MIGRATED,
  // with no v1 data anywhere in sight, on every routine `migrate`.
  //
  // That was mine: making `status` honest about leftovers, and then making the
  // early return agree with it, together turned "unrecognised content" into
  // "work to do". The stamp is what separates them -- a migration that left
  // something behind records that, and only such a tree resumes.
  // Read explicitly, never `readJson(p, null)`: a null fallback RETHROWS (see
  // util.mjs), and a v1 tree has no LAYOUT.json at all -- so the fallback that
  // looks like "default to nothing" is exactly the input that throws. This is
  // the third time that trap has been hit in this change; it is worth the two
  // extra lines everywhere it appears.
  let stamp = null;
  try { stamp = JSON.parse(fs.readFileSync(layout.layoutFile(projectRoot), 'utf8')); }
  catch { /* absent or unreadable: this tree has never recorded a migration */ }
  const resuming = stamp?.migration_incomplete === true;
  if (!detected.migration_required && !resuming) {
    return { schema: MIGRATION_SCHEMA, status: 'ALREADY_CURRENT', migrated: false,
      reason: `the tree is already layout v${detected.layout_version}`, detected, move_count: 0 };
  }

  const plan = planLayoutMigration(projectRoot);
  if (dryRun) {
    return { schema: MIGRATION_SCHEMA, status: 'DRY_RUN', migrated: false, detected,
      move_count: plan.move_count, moves: plan.moves, backup: null };
  }

  // The backup goes in first and takes a name that is NOT a legacy marker, or
  // it would keep the tree looking unmigrated forever. It sits beside the tree
  // rather than inside a subtree the migration is about to restructure.
  //
  // An EXISTING backup is reused rather than joined by a second one. This runs
  // again after a crash -- that is the recovery path, and it is meant to work --
  // and a fresh copy taken then would capture the HALF-MIGRATED tree, while the
  // pristine one from the first attempt sat unreferenced beside it. Since the
  // last writer wins in `LAYOUT.json`, the recorded backup would have been the
  // useless one. The oldest backup is the pre-migration tree, so it is the one
  // that is kept and named.
  //
  // It also stops each retry doubling the disk cost of a tree that may be large,
  // for a path no layout row covers and gc therefore never reclaims.
  const existingBackups = fs.readdirSync(d, { withFileTypes: true })
    .filter(e => e.isDirectory() && e.name.startsWith(BACKUP_PREFIX))
    .map(e => e.name).sort();
  const backupDir = existingBackups.length
    ? path.join(d, existingBackups[0])
    : path.join(d, `${BACKUP_PREFIX}-${Date.now()}`);
  if (!existingBackups.length) {
    fs.mkdirSync(backupDir, { recursive: true });
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith(BACKUP_PREFIX)) continue;
      fs.cpSync(path.join(d, e.name), path.join(backupDir, e.name), { recursive: true });
    }
  }

  layout.ensureLayout(projectRoot);

  // Per-move error handling, because a filesystem error here is ordinary rather
  // than exceptional: on win32 an open `dashboard.html` gives EPERM/EBUSY, and
  // an antivirus scanner produces the same. Letting that escape threw out of
  // `migrateLayout` AND `migrateState` after the backup and after N moves, so
  // the operator got a bare fs error with no result document, no list of what
  // had moved, and no mention of the backup that made it recoverable.
  //
  // The recovery path is sound -- a re-run finishes a half-migrated tree -- so
  // losing the report was the whole loss.
  const outcome = { moved: [], skipped: [] };
  const errors = [];
  for (const m of plan._moves) {
    if (!fs.existsSync(m.from)) { outcome.skipped.push({ what: m.what, reason: 'SOURCE_GONE' }); continue; }
    try { moveInto(m.from, m.to, m.what, outcome); }
    catch (e) { errors.push({ what: m.what, code: e.code ?? null, error: String(e.message).slice(0, 200) }); }
  }
  const moved = outcome.moved;
  const skipped = outcome.skipped;

  // Now the markers. Every legacy directory must be gone, not merely empty:
  // `detectLayoutVersion` tests existence, so an empty `events/` left behind
  // reports `migration_required` for the rest of the project's life.
  const removed = [];
  const retained = [];
  for (const name of LEGACY_DIRS) {
    const dir = path.join(d, name);
    if (!fs.existsSync(dir)) continue;
    // `artifacts/` has two children of its own to clear first.
    for (const child of ['objects', 'meta']) removeIfEmpty(path.join(dir, child));
    if (removeIfEmpty(dir)) removed.push(name);
    else retained.push({ name, reason: 'NOT_EMPTY', entries: entries(dir).map(e => e.name).slice(0, 8) });
  }

  const after = layout.detectLayoutVersion(projectRoot);
  const leftoverCount = retained.length + (plan.unaddressable?.length ?? 0) + errors.length;
  const finished = !after.migration_required && leftoverCount === 0;

  // The stamp carries whether work remains, because that is the ONLY thing that
  // makes a later run resume. Without it, an incomplete migration on a tree
  // whose markers happen to be clean is indistinguishable from an ordinary v2
  // project, and the leftovers would never be looked at again.
  writeJson(layout.layoutFile(projectRoot), {
    schema: layout.LAYOUT_SCHEMA,
    layout_version: layout.LAYOUT_VERSION,
    migrated_from: 1,
    migrated_at: now(),
    backup: path.relative(projectRoot, backupDir).split(path.sep).join('/'),
    migration_incomplete: !finished || undefined,
    migration_leftovers: finished ? undefined : {
      retained_legacy_dirs: retained.map(r => r.name),
      unaddressable: (plan.unaddressable ?? []).map(u => u.what),
      errors: errors.map(e => e.what)
    }
  });
  // MIGRATED means "everything moved", not "no marker remains".
  //
  // Those are different sets, and the difference is reachable: this module
  // treats 21 directories as legacy while `detectLayoutVersion` recognises 19
  // markers, so `reports/` and `backups/` can survive with the marker check
  // still clean. Deriving the verdict from markers alone reported MIGRATED over
  // a `reports/` directory that was still sitting there, and `migrateState`
  // passed it through because it only throws on INCOMPLETE.
  //
  // So anything left behind -- a retained legacy directory, an entry whose name
  // v2 cannot address, or a move that errored -- makes the whole migration
  // INCOMPLETE, whatever the markers say.
  return {
    schema: MIGRATION_SCHEMA,
    status: finished ? 'MIGRATED' : 'INCOMPLETE',
    migrated: finished,
    move_count: moved.length,
    moved,
    skipped,
    errors,
    unaddressable: plan.unaddressable ?? [],
    removed_legacy_dirs: removed,
    retained_legacy_dirs: retained,
    backup: path.relative(projectRoot, backupDir).split(path.sep).join('/'),
    detected_before: detected,
    detected_after: after
  };
}
