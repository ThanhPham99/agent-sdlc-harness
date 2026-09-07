// The single authority for every path under `.agent-sdlc/`.
//
// Why this module exists at all: before it, 24 top-level namespaces were
// created ad hoc by 20+ runtime modules, each writing
// `path.join(stateDir(root),'<literal>')` at the point of use. Nothing could
// enumerate the layout, so nothing could migrate it, document it, or clean it
// up -- retention.mjs had to hand-maintain a list of per-run paths and silently
// missed six of them, orphaning a deleted run's evidence, ci-evidence,
// delivery, traceability, requirement-update and workspace bytes forever.
//
// So the layout is data here, not string literals scattered across callers:
// `TOP_LEVEL` and `RUN_SCOPED` describe the tree, every accessor is derived
// from them, and `runPaths()` is derived rather than written down. Adding a
// namespace means adding a row, which is what makes retention, migration and
// the generated documentation correct by construction instead of by diligence.
//
// This module has NO imports beyond node:fs and node:path, deliberately. It is
// the leaf that util.mjs itself depends on, so it cannot depend on util.mjs
// without a cycle.
//
// ---------------------------------------------------------------------------
// The v2 tree, and the three lifetimes it separates
// ---------------------------------------------------------------------------
//
//   .agent-sdlc/
//     LAYOUT.json                 what shape this tree is (layout_version)
//     project.json                CONFIG   -- commit this
//     state.json                  DURABLE  -- mutable pointers, migration ledger
//     workflows/                  CONFIG   -- user workflow overrides
//     runs/<run_id>/              DURABLE  -- everything run-scoped, one directory
//       run.json  events.jsonl  cost.jsonl  evidence.jsonl
//       ci-evidence.json  ci-evidence.jsonl
//       delivery.json  requirement-update.json
//       tasks/{graph.json, migration.json, <TASK-ID>.json}
//       task-events.jsonl
//       task-context/<TASK-ID>.json
//       task-evidence/
//       traceability/{graph.json, invalidations.jsonl}
//     store/<aa>/<rest>           DURABLE  -- content-addressed objects
//           <aa>/<rest>.meta.json          -- bindings, beside their object
//     shared/                     DURABLE  -- cross-run state
//       handoffs/ features/ memory/ webhooks/ intent/
//       backups/task-migration-<run_id>/   (run-scoped lifetime)
//       quarantine.json  activation.jsonl
//     cache/                      CACHE    -- 100% regenerable, safe to rm -rf
//       index/  dashboard.html
//       workspaces/<run_id>/               (run-scoped lifetime)
//     docs/                       DOCS     -- human-readable
//       SUMMARY.md  REVIEW.md  guides/
//       reports/<run_id>.md                (run-scoped lifetime)
//
// Three of those are run-scoped but do not live under `runs/<run_id>/`, because
// their lifetime and their natural location disagree: a worktree is disposable,
// a report is prose, a task-migration backup belongs with the other backups.
// `RUN_SCOPED` records them anyway, which is what keeps gc complete.
//
// The lifetime of a path is the property users actually need and could never
// previously read off the tree: CONFIG belongs in version control, DURABLE is
// the evidence the gates depend on and must be backed up, CACHE can be deleted
// at any moment without loss, DOCS is generated prose for humans.
import fs from 'node:fs';
import path from 'node:path';

/** On-disk shape of the tree. Bumped only by a migration in layout-migration.mjs. */
export const LAYOUT_VERSION=2;
export const LAYOUT_SCHEMA='agent-sdlc/layout/v1';
export const STATE_DIRNAME='.agent-sdlc';

export const CONFIG='config';
export const DURABLE='durable';
export const CACHE='cache';
export const DOCS='docs';
export const LIFETIMES=[CONFIG,DURABLE,CACHE,DOCS];

// ---------------------------------------------------------------------------
// The tree, as data
// ---------------------------------------------------------------------------

/**
 * Top-level entries, relative to `.agent-sdlc/`.
 *
 * `create` marks a directory `ensureLayout` materializes at init. Files are
 * never pre-created here: an absent file and an empty file are different facts
 * to every reader in the runtime, and pre-creating them would erase that.
 */
export const TOP_LEVEL=[
  {key:'layout',        rel:'LAYOUT.json', type:'file',lifetime:DURABLE,purpose:'which layout version wrote this tree'},
  {key:'project',       rel:'project.json',type:'file',lifetime:CONFIG, purpose:'project configuration; commit this'},
  {key:'state',         rel:'state.json',  type:'file',lifetime:DURABLE,purpose:'active run pointer and harness migration ledger'},
  {key:'workflows',     rel:'workflows',   type:'dir', lifetime:CONFIG, purpose:'project-local workflow overrides',create:true},
  {key:'runs',          rel:'runs',        type:'dir', lifetime:DURABLE,purpose:'one directory per run, holding all of that run\'s state',create:true},
  {key:'store',         rel:'store',       type:'dir', lifetime:DURABLE,purpose:'content-addressed artifact objects and their bindings',create:true},
  {key:'shared',        rel:'shared',      type:'dir', lifetime:DURABLE,purpose:'durable state that outlives and spans runs',create:true},
  {key:'cache',         rel:'cache',       type:'dir', lifetime:CACHE,  purpose:'derived, regenerable state; safe to delete at any time',create:true},
  {key:'docs',          rel:'docs',        type:'dir', lifetime:DOCS,   purpose:'human-readable summaries and guides',create:true}
];

/**
 * Everything keyed by `run_id`, wherever it lives.
 *
 * `base` says which top-level subtree the entry hangs off, and is what makes
 * `runPaths()` derivable: a run's prune roots come from the distinct bases in
 * this table, so a namespace added here is reclaimed by gc without anyone
 * remembering to tell retention.mjs about it.
 *
 * `run`   -> runs/<run_id>/<rel>
 * `cache` -> cache/<rel>, with <run_id> substituted into rel
 */
export const RUN_SCOPED=[
  {key:'run',                 base:'run',  rel:'run.json',                type:'file',purpose:'the run document'},
  // Keep this table exhaustive over run-keyed paths. A run-keyed path missing
  // from it is a gc leak by construction, which is the bug this table exists to
  // make impossible -- see the `report` and `task_migration_backup` rows below,
  // which live outside runs/ and were exactly the kind of thing the old
  // hand-written list in retention.mjs forgot.
  {key:'events',              base:'run',  rel:'events.jsonl',            type:'file',purpose:'hash-chained run event stream'},
  {key:'cost',                base:'run',  rel:'cost.jsonl',              type:'file',purpose:'token and cost usage records'},
  {key:'evidence',            base:'run',  rel:'evidence.jsonl',          type:'file',purpose:'gate evidence log'},
  {key:'ci_evidence',         base:'run',  rel:'ci-evidence.json',        type:'file',purpose:'latest CI evidence record'},
  {key:'ci_evidence_log',     base:'run',  rel:'ci-evidence.jsonl',       type:'file',purpose:'CI evidence history'},
  {key:'delivery',            base:'run',  rel:'delivery.json',           type:'file',purpose:'git delivery state'},
  {key:'requirement_update',  base:'run',  rel:'requirement-update.json', type:'file',purpose:'requirement delta plan'},
  {key:'tasks',               base:'run',  rel:'tasks',                   type:'dir', purpose:'task records, graph and migration sidecars'},
  {key:'task_events',         base:'run',  rel:'task-events.jsonl',       type:'file',purpose:'task event stream'},
  {key:'task_context',        base:'run',  rel:'task-context',            type:'dir', purpose:'per-task context manifests'},
  {key:'task_evidence',       base:'run',  rel:'task-evidence',           type:'dir', purpose:'per-task verification evidence'},
  {key:'traceability',        base:'run',  rel:'traceability',            type:'dir', purpose:'traceability graph and invalidation history'},
  // Regenerable by definition -- a git worktree that `task start` recreates --
  // so it lives under cache/, but it is still this run's and gc must take it.
  {key:'run_workspaces',      base:'cache',rel:'workspaces/<run_id>',     type:'dir', purpose:'isolated task worktrees and their records'},
  // The generated human-readable report is keyed by run and cannot be
  // regenerated once the run document is gone, so it belongs to the run's
  // lifetime even though it is prose living under docs/.
  {key:'report',              base:'docs', rel:'reports/<run_id>.md',     type:'file',purpose:'human-readable run report'},
  // Written by the task-runtime migration before it rewrites a run's task
  // records. Durable, cross-cutting in location, run-scoped in lifetime.
  {key:'task_migration_backup',base:'shared',rel:'backups/task-migration-<run_id>',type:'dir',purpose:'pre-migration copy of this run\'s task records'}
];

/** Fixed entries under `shared/`. */
export const SHARED=[
  {key:'handoffs',  rel:'handoffs',        type:'dir', purpose:'context handoffs, addressed by handoff id',create:true},
  {key:'features',  rel:'features',        type:'dir', purpose:'features and their phases',create:true},
  {key:'memory',    rel:'memory',          type:'dir', purpose:'failure memory index',create:true},
  {key:'webhooks',  rel:'webhooks',        type:'dir', purpose:'webhook delivery records',create:true},
  {key:'intent',    rel:'intent',          type:'dir', purpose:'intent proto-specs and their template',create:true},
  {key:'backups',   rel:'backups',         type:'dir', purpose:'pre-migration copies written by the runtime',create:true},
  {key:'quarantine',rel:'quarantine.json', type:'file',purpose:'quarantined flaky tests'},
  {key:'activation',rel:'activation.jsonl',type:'file',purpose:'auto-activation decision log'}
];

/** Fixed entries under `cache/`. Every one of these is reproducible from scratch. */
export const CACHE_ENTRIES=[
  {key:'index',      rel:'index',         type:'dir', purpose:'deterministic repository symbol index',create:true},
  {key:'workspaces', rel:'workspaces',    type:'dir', purpose:'isolated task worktrees, per run',create:true},
  {key:'dashboard',  rel:'dashboard.html',type:'file',purpose:'rendered status dashboard'}
];

/** Fixed entries under `docs/`. */
export const DOCS_ENTRIES=[
  {key:'summary', rel:'SUMMARY.md',type:'file',purpose:'status and documentation hub'},
  {key:'review',  rel:'REVIEW.md', type:'file',purpose:'human review notes'},
  {key:'guides',  rel:'guides',    type:'dir', purpose:'generated architecture, workflow and CLI guides',create:true},
  {key:'reports', rel:'reports',   type:'dir', purpose:'generated per-run reports',create:true}
];

// ---------------------------------------------------------------------------
// Segment safety
// ---------------------------------------------------------------------------

// Ids reach this module from authored input: a plan names its own task ids, and
// a run id can be passed on the command line. An id becomes a path segment, so
// one carrying a separator or a parent reference would address a file outside
// the tree it is supposed to describe. The safe set is deliberately narrower
// than the filesystem's -- the ids the engine produces are `run_<uuid>` and
// `TASK-001`.
const SAFE_SEGMENT=/^[A-Za-z0-9._-]+$/;
const MAX_SEGMENT=200;
// Windows resolves these names as devices no matter what extension follows, so
// `NUL.json` is the null device and not a file: a task with that id would have
// its record written to nowhere and read back as absent, losing the task
// silently. This harness runs on win32 in CI and on developer machines, so the
// check is not theoretical. Matched case-insensitively, since device names are.
const RESERVED_DEVICE=/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
export function assertSafeSegment(value,label='segment'){
  const bad=(why)=>new Error(`unsafe ${label} (${why}): ${JSON.stringify(value)}`);
  if(typeof value!=='string'||!SAFE_SEGMENT.test(value))throw bad('not [A-Za-z0-9._-]+');
  if(value==='.'||value==='..')throw bad('path traversal');
  if(value.length>MAX_SEGMENT)throw bad(`longer than ${MAX_SEGMENT} characters`);
  // Windows silently strips a trailing dot or space, so two distinct ids would
  // address one file.
  if(/[. ]$/.test(value))throw bad('trailing dot or space');
  if(RESERVED_DEVICE.test(value))throw bad('reserved Windows device name');
  return value;
}
const SHA256_HEX=/^[0-9a-f]{64}$/;
export function assertHash(hash){
  if(typeof hash!=='string'||!SHA256_HEX.test(hash))
    throw new Error(`not a sha256 hex digest: ${JSON.stringify(hash)}`);
  return hash;
}

// ---------------------------------------------------------------------------
// Roots
// ---------------------------------------------------------------------------

export function stateDir(projectRoot){return path.join(projectRoot,STATE_DIRNAME);}

const top=(key)=>{
  const entry=TOP_LEVEL.find(e=>e.key===key);
  if(!entry)throw new Error(`unknown top-level layout key: ${key}`);
  return entry;
};
const topPath=(projectRoot,key)=>path.join(stateDir(projectRoot),top(key).rel);

export const layoutFile=(projectRoot)=>topPath(projectRoot,'layout');
export const projectConfigFile=(projectRoot)=>topPath(projectRoot,'project');
export const stateFile=(projectRoot)=>topPath(projectRoot,'state');
export const customWorkflowsDir=(projectRoot)=>topPath(projectRoot,'workflows');
export const runsDir=(projectRoot)=>topPath(projectRoot,'runs');
export const storeDir=(projectRoot)=>topPath(projectRoot,'store');
export const sharedDir=(projectRoot)=>topPath(projectRoot,'shared');
export const cacheDir=(projectRoot)=>topPath(projectRoot,'cache');
export const docsDir=(projectRoot)=>topPath(projectRoot,'docs');

// ---------------------------------------------------------------------------
// Per-run paths
// ---------------------------------------------------------------------------

export function runDir(projectRoot,runId){
  return path.join(runsDir(projectRoot),assertSafeSegment(runId,'run_id'));
}

const runScoped=(key)=>{
  const entry=RUN_SCOPED.find(e=>e.key===key);
  if(!entry)throw new Error(`unknown run-scoped layout key: ${key}`);
  return entry;
};

/** Where each `base` hangs off. The only place `base` is interpreted. */
const BASE_ROOT={
  run:(projectRoot,runId)=>runDir(projectRoot,runId),
  cache:(projectRoot)=>cacheDir(projectRoot),
  shared:(projectRoot)=>sharedDir(projectRoot),
  docs:(projectRoot)=>docsDir(projectRoot)
};

/**
 * Resolve one row of `RUN_SCOPED` for a run.
 *
 * A row on the `run` base is inside `runs/<run_id>/` and so is already scoped
 * by position. A row on any other base is NOT: it sits in a directory shared
 * with every other run, so its `rel` must name the run itself or the path it
 * resolves to would belong to all runs at once -- and `runPaths` would then
 * hand retention a shared directory to delete. That is a table authoring
 * mistake with data loss at the end of it, so it throws here rather than
 * resolving to something plausible.
 */
function resolveRunScoped(projectRoot,runId,entry){
  const id=assertSafeSegment(runId,'run_id');
  const root=BASE_ROOT[entry.base];
  // A new base with no rule here would resolve somewhere arbitrary and, worse,
  // would be invisible to runPaths -- the exact failure this table replaced.
  if(!root)throw new Error(`layout row ${entry.key} declares unknown base ${JSON.stringify(entry.base)}`);
  if(entry.base!=='run'&&!entry.rel.includes('<run_id>'))
    throw new Error(`layout row ${entry.key} is on the ${entry.base} base but its rel does not name <run_id>; it would address every run at once`);
  const rel=entry.rel.split('/').map(seg=>seg.replace('<run_id>',id));
  return path.join(root(projectRoot,id),...rel);
}

export const runPath=(projectRoot,runId,key)=>resolveRunScoped(projectRoot,runId,runScoped(key));

export const runFile=(projectRoot,runId)=>runPath(projectRoot,runId,'run');
export const runEventsFile=(projectRoot,runId)=>runPath(projectRoot,runId,'events');
export const runCostFile=(projectRoot,runId)=>runPath(projectRoot,runId,'cost');
export const runEvidenceFile=(projectRoot,runId)=>runPath(projectRoot,runId,'evidence');
export const runCiEvidenceFile=(projectRoot,runId)=>runPath(projectRoot,runId,'ci_evidence');
export const runCiEvidenceLogFile=(projectRoot,runId)=>runPath(projectRoot,runId,'ci_evidence_log');
export const runDeliveryFile=(projectRoot,runId)=>runPath(projectRoot,runId,'delivery');
export const runRequirementUpdateFile=(projectRoot,runId)=>runPath(projectRoot,runId,'requirement_update');
export const runTasksDir=(projectRoot,runId)=>runPath(projectRoot,runId,'tasks');
export const runTaskEventsFile=(projectRoot,runId)=>runPath(projectRoot,runId,'task_events');
export const runTaskContextDir=(projectRoot,runId)=>runPath(projectRoot,runId,'task_context');
export const runTaskEvidenceDir=(projectRoot,runId)=>runPath(projectRoot,runId,'task_evidence');
export const runTraceabilityDir=(projectRoot,runId)=>runPath(projectRoot,runId,'traceability');
export const runWorkspacesDir=(projectRoot,runId)=>runPath(projectRoot,runId,'run_workspaces');

// `graph.json` and `migration.json` are sidecars in the task directory, not
// task records; store.mjs excludes them when listing, and naming them here is
// what lets it do that from the layout rather than from a private constant.
export const TASK_SIDECARS=['graph.json','migration.json'];
export const taskFile=(projectRoot,runId,taskId)=>
  path.join(runTasksDir(projectRoot,runId),`${assertSafeSegment(taskId,'task_id')}.json`);
export const taskGraphFile=(projectRoot,runId)=>path.join(runTasksDir(projectRoot,runId),'graph.json');
export const taskMigrationFile=(projectRoot,runId)=>path.join(runTasksDir(projectRoot,runId),'migration.json');
export const taskContextFile=(projectRoot,runId,taskId)=>
  path.join(runTaskContextDir(projectRoot,runId),`${assertSafeSegment(taskId,'task_id')}.json`);
export const taskEvidenceDir=(projectRoot,runId,taskId)=>
  path.join(runTaskEvidenceDir(projectRoot,runId),assertSafeSegment(taskId,'task_id'));
export const taskWorkspaceRecordFile=(projectRoot,runId,taskId)=>
  path.join(runWorkspacesDir(projectRoot,runId),`${assertSafeSegment(taskId,'task_id')}.json`);
export const taskWorkspaceTreeDir=(projectRoot,runId,taskId)=>
  path.join(runWorkspacesDir(projectRoot,runId),`${assertSafeSegment(taskId,'task_id')}-tree`);
export const traceabilityGraphFile=(projectRoot,runId)=>
  path.join(runTraceabilityDir(projectRoot,runId),'graph.json');
export const traceabilityInvalidationsFile=(projectRoot,runId)=>
  path.join(runTraceabilityDir(projectRoot,runId),'invalidations.jsonl');

/**
 * Every per-run namespace, as `{key, path, type, purpose}` -- the inspectable
 * view. Includes paths that do not exist yet; callers filter.
 */
export function runNamespaces(projectRoot,runId){
  return RUN_SCOPED.map(entry=>({
    key:entry.key,
    path:resolveRunScoped(projectRoot,runId,entry),
    type:entry.type,
    purpose:entry.purpose
  }));
}

/**
 * The prune roots for a run: the smallest set of paths whose removal deletes
 * everything belonging to that run and nothing belonging to another.
 *
 * Derived, not enumerated. Entries under `runs/<run_id>/` collapse to that one
 * directory -- listing them individually would double-count bytes against the
 * parent -- and each distinct non-`run` base contributes its own resolved path.
 * This is what retention.mjs consumes, so a namespace added to `RUN_SCOPED` is
 * garbage-collected without touching retention at all.
 *
 * Only existing paths are returned, so the result is directly usable both for
 * sizing a gc plan and for performing it.
 */
export function runPaths(projectRoot,runId){
  const candidates=new Set();
  for(const entry of RUN_SCOPED){
    candidates.add(entry.base==='run'
      ?runDir(projectRoot,runId)
      :resolveRunScoped(projectRoot,runId,entry));
  }
  // Collapse anything nested inside another candidate. Two rows on the same
  // non-`run` base can legitimately nest (`cache/x/<run_id>` and
  // `cache/x/<run_id>/y`), and keeping both would make a gc plan count those
  // bytes twice and then delete an already-deleted path.
  const all=[...candidates].sort();
  const roots=all.filter(p=>!all.some(other=>other!==p&&p.startsWith(other+path.sep)));
  return roots.filter(p=>fs.existsSync(p));
}

/** Run ids present on disk. Sorted, because readdir order is the filesystem's business. */
export function listRunIds(projectRoot){
  const d=runsDir(projectRoot);
  if(!fs.existsSync(d))return [];
  return fs.readdirSync(d,{withFileTypes:true})
    .filter(e=>e.isDirectory()&&SAFE_SEGMENT.test(e.name))
    .map(e=>e.name).sort();
}

// ---------------------------------------------------------------------------
// Content-addressed store
// ---------------------------------------------------------------------------
//
// Sharded the way git shards its loose objects: the first two hex characters of
// the digest name a directory, the remaining 62 name the file. A flat directory
// is fine at a few hundred objects and stops being fine well before a
// long-lived project's evidence trail is done growing -- every readdir, every
// stat sweep and every backup walks the whole set. Two characters give 256
// buckets, which is the right order for the tens-of-thousands range this store
// realistically reaches.
//
// Metadata lives beside its object as `<rest>.meta.json` rather than in a
// parallel `meta/` tree: the two are written together, read together and
// deleted together, and keeping them adjacent means one shard directory is the
// complete story for its objects.

export const SHARD_LENGTH=2;
export const META_SUFFIX='.meta.json';

export function objectShardDir(projectRoot,hash){
  return path.join(storeDir(projectRoot),assertHash(hash).slice(0,SHARD_LENGTH));
}
export function objectPath(projectRoot,hash){
  return path.join(objectShardDir(projectRoot,hash),assertHash(hash).slice(SHARD_LENGTH));
}
export function objectMetaPath(projectRoot,hash){
  return path.join(objectShardDir(projectRoot,hash),`${assertHash(hash).slice(SHARD_LENGTH)}${META_SUFFIX}`);
}

/**
 * Every object hash in the store, sorted.
 *
 * Sorted for the same reason listRunIds is: shard order is a B-tree detail on
 * NTFS and a hash-order detail on ext4, and callers reach content hashes
 * through the traceability graph, where a stable order is the only order that
 * reproduces.
 */
export function listObjectHashes(projectRoot){
  const root=storeDir(projectRoot);
  if(!fs.existsSync(root))return [];
  const out=[];
  for(const shard of fs.readdirSync(root,{withFileTypes:true})){
    if(!shard.isDirectory()||shard.name.length!==SHARD_LENGTH)continue;
    for(const entry of fs.readdirSync(path.join(root,shard.name),{withFileTypes:true})){
      if(!entry.isFile()||entry.name.endsWith(META_SUFFIX))continue;
      const hash=`${shard.name}${entry.name}`;
      if(SHA256_HEX.test(hash))out.push(hash);
    }
  }
  return out.sort();
}

// ---------------------------------------------------------------------------
// Shared, cache and docs paths
// ---------------------------------------------------------------------------

const fixed=(list,key,label)=>{
  const entry=list.find(e=>e.key===key);
  if(!entry)throw new Error(`unknown ${label} layout key: ${key}`);
  return entry;
};

/**
 * Resolve a namespace, plus an optional tail of caller-supplied segments.
 *
 * The tail exists because most of these namespaces are addressed by an id --
 * a feature id, a phase id, a filename -- and without it callers would have to
 * `path.join` onto the result themselves. That is the pattern this module
 * replaced, and it is worse here than elsewhere: feature and phase ids come
 * from authored input, so a hand-join is a hand-join that skips
 * `assertSafeSegment`. Every tail segment is validated.
 */
const nested=(rootFn,list,label)=>(projectRoot,key,...tail)=>
  path.join(rootFn(projectRoot),fixed(list,key,label).rel,
    ...tail.map(seg=>assertSafeSegment(seg,`${label} path segment`)));

export const sharedPath=nested(sharedDir,SHARED,'shared');
export const cachePath=nested(cacheDir,CACHE_ENTRIES,'cache');
export const docsPath=nested(docsDir,DOCS_ENTRIES,'docs');

export const handoffsDir=(projectRoot)=>sharedPath(projectRoot,'handoffs');
export const handoffFile=(projectRoot,handoffId)=>
  path.join(handoffsDir(projectRoot),`${assertSafeSegment(handoffId,'handoff_id')}.json`);
export const featuresDir=(projectRoot)=>sharedPath(projectRoot,'features');
// A feature is a document and, once it has phases, a directory of the same
// name beside it. Both are addressed by an authored feature id.
export const featureFile=(projectRoot,featureId)=>sharedPath(projectRoot,'features',`${assertSafeSegment(featureId,'feature_id')}.json`);
export const featureDir=(projectRoot,featureId)=>sharedPath(projectRoot,'features',featureId);
export const featurePhasesDir=(projectRoot,featureId)=>path.join(featureDir(projectRoot,featureId),'phases');
export const featurePhaseFile=(projectRoot,featureId,phaseId)=>
  path.join(featurePhasesDir(projectRoot,featureId),`${assertSafeSegment(phaseId,'phase_id')}.json`);
export const memoryDir=(projectRoot)=>sharedPath(projectRoot,'memory');
export const failureIndexFile=(projectRoot)=>sharedPath(projectRoot,'memory','failure-index.json');
export const webhooksDir=(projectRoot)=>sharedPath(projectRoot,'webhooks');
export const webhookDeliveriesFile=(projectRoot)=>sharedPath(projectRoot,'webhooks','deliveries.json');
export const intentDir=(projectRoot)=>sharedPath(projectRoot,'intent');
export const intentTemplateFile=(projectRoot)=>sharedPath(projectRoot,'intent','template.md');
export const intentFile=(projectRoot,name)=>sharedPath(projectRoot,'intent',name);
export const backupsDir=(projectRoot)=>sharedPath(projectRoot,'backups');
export const backupDir=(projectRoot,name)=>sharedPath(projectRoot,'backups',name);
export const taskMigrationBackupDir=(projectRoot,runId)=>runPath(projectRoot,runId,'task_migration_backup');
export const quarantineFile=(projectRoot)=>sharedPath(projectRoot,'quarantine');
export const activationLogFile=(projectRoot)=>sharedPath(projectRoot,'activation');

export const repoIndexDir=(projectRoot)=>cachePath(projectRoot,'index');
export const repoIndexFile=(projectRoot)=>cachePath(projectRoot,'index','repo-index.json');
export const workspacesDir=(projectRoot)=>cachePath(projectRoot,'workspaces');
export const dashboardFile=(projectRoot)=>cachePath(projectRoot,'dashboard');

export const summaryFile=(projectRoot)=>docsPath(projectRoot,'summary');
export const reviewFile=(projectRoot)=>docsPath(projectRoot,'review');
export const guidesDir=(projectRoot)=>docsPath(projectRoot,'guides');
export const guideFile=(projectRoot,name)=>docsPath(projectRoot,'guides',name);
export const reportsDir=(projectRoot)=>docsPath(projectRoot,'reports');
export const reportFile=(projectRoot,name)=>docsPath(projectRoot,'reports',name);
export const runReportFile=(projectRoot,runId)=>runPath(projectRoot,runId,'report');

// Config-lifetime paths that are addressed by name rather than fixed.
export const customWorkflowFile=(projectRoot,name)=>
  path.join(customWorkflowsDir(projectRoot),assertSafeSegment(name,'workflow file name'));
// compat.mjs copies state.json beside itself before rewriting it. The stamp is
// generated, not authored, but it still becomes a filename.
export const stateBackupFile=(projectRoot,stamp)=>
  path.join(stateDir(projectRoot),`state.backup-${assertSafeSegment(String(stamp),'state backup stamp')}.json`);

// ---------------------------------------------------------------------------
// Materialization and description
// ---------------------------------------------------------------------------

/**
 * Create the directories the v2 tree declares. Idempotent.
 *
 * Only rows marked `create` are materialized: a run directory is created by the
 * run that needs it, and an absent file stays absent so readers can still tell
 * "never written" from "written empty".
 */
export function ensureLayout(projectRoot){
  const created=[];
  // Only paths this call actually brought into existence are reported. Pushing
  // unconditionally would make a re-init indistinguishable from a first init,
  // and `created.length` is exactly what a caller reads to decide whether it
  // repaired anything.
  const mk=(p)=>{const existed=fs.existsSync(p);fs.mkdirSync(p,{recursive:true});if(!existed)created.push(p);};
  for(const entry of TOP_LEVEL)if(entry.create)mk(path.join(stateDir(projectRoot),entry.rel));
  for(const entry of SHARED)if(entry.create)mk(path.join(sharedDir(projectRoot),entry.rel));
  for(const entry of CACHE_ENTRIES)if(entry.create)mk(path.join(cacheDir(projectRoot),entry.rel));
  for(const entry of DOCS_ENTRIES)if(entry.create)mk(path.join(docsDir(projectRoot),entry.rel));
  return created;
}

/**
 * The layout as a serializable description: what the tree contains, and what
 * each part's lifetime is.
 *
 * This is what the documentation generator renders and what `doctor` can print.
 * Generating the explanation from the same table the runtime resolves paths
 * through is the only way the two cannot drift.
 */
export function describeLayout(){
  return {
    schema:LAYOUT_SCHEMA,
    layout_version:LAYOUT_VERSION,
    state_dirname:STATE_DIRNAME,
    lifetimes:{
      [CONFIG]:'Project configuration. Commit it.',
      [DURABLE]:'Evidence and run history the gates depend on. Back it up; never edit by hand.',
      [CACHE]:'Derived and regenerable. Safe to delete at any time; gitignore it.',
      [DOCS]:'Generated prose for humans. Regenerated on demand.'
    },
    top_level:TOP_LEVEL.map(e=>({key:e.key,path:e.rel,type:e.type,lifetime:e.lifetime,purpose:e.purpose})),
    run_scoped:RUN_SCOPED.map(e=>({
      key:e.key,
      path:e.base==='run'?`runs/<run_id>/${e.rel}`:`${e.base}/${e.rel}`,
      base:e.base,
      type:e.type,purpose:e.purpose
    })),
    shared:SHARED.map(e=>({key:e.key,path:`shared/${e.rel}`,type:e.type,purpose:e.purpose})),
    cache:CACHE_ENTRIES.map(e=>({key:e.key,path:`cache/${e.rel}`,type:e.type,purpose:e.purpose})),
    docs:DOCS_ENTRIES.map(e=>({key:e.key,path:`docs/${e.rel}`,type:e.type,purpose:e.purpose})),
    store:{
      path:'store/<first 2 hex chars>/<remaining 62>',
      meta_path:'store/<first 2 hex chars>/<remaining 62>.meta.json',
      shard_length:SHARD_LENGTH,
      meta_suffix:META_SUFFIX,
      purpose:'sha256 content-addressed objects, git-style two-character fan-out, metadata beside its object'
    }
  };
}
