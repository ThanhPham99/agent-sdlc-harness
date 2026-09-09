# Skill-First Agent Navigation — Design

- Date: 2026-09-09
- Status: Approved for planning
- Scope: plugin public surface, agent navigation mechanics, skill packaging
- Supersedes: the flat `public_skills` surface model and the Claude-only `commands/` surface

## Problem

The same lifecycle knowledge lives on three disconnected surfaces.

1. `commands/` — six Markdown files (`sdlc-approve`, `sdlc-doctor`, `sdlc-resume`,
   `sdlc-route`, `sdlc-status`, `sdlc-task`). Each is a thin wrapper that duplicates a
   skill of the same name. Only the Claude manifests declare a `commands` root; Codex,
   Cursor, Kimi and Antigravity are skills-only. The surface is therefore both redundant
   and host-asymmetric.
2. `skills/` — eight public skills. `sdlc-orchestrator` is a 99-line mega-skill carrying
   every stage of the lifecycle inline, so an agent in `DESIGN` still pays for the
   `RELEASE` text. `sdlc-route` duplicates `sdlc-router`; the only difference is that one
   is reached by the bootstrap hook and the other by a user typing a slash command.
3. `harness/internal-skills/` — 41 files (1246 lines) that are not skills. They are
   injected as raw text by `runtime/context.mjs` and `runtime/task-context.mjs`. Only 21
   have a real route through `config/procedures.json`; the remaining 20 are reached by
   `legacyReachableSkillIds`. The TDD rules are additionally hardcoded a fourth time
   inside `runtime/task-worker.mjs`.

Underneath the third surface sits the actual cause. `runtime/context.mjs:10-21` hardcodes
three navigation maps in code — `CORE_SKILL_BY_STAGE` (11 lifecycle stages to one skill
each), `WORKFLOW_SKILLS` (15 workflows to skills) and `OVERLAY_SKILLS` (5 overlays to
skills). Navigation policy therefore lives in a module, not in a policy file, and the 20
non-registry files exist mostly to fill those slots. Twelve of them contain exactly one
substantive line: their own description, followed by a `## Contract` block that is
byte-identical across all of them.

Consequences: agents navigate by issuing CLI commands rather than by activating the skill
that matches their state; context cost is paid up-front instead of progressively; and one
rule can drift across four copies.

## Goals

- Exactly one public surface — skills — identical on every host.
- Navigation is skill-first but deterministic: the engine names the next skill, the agent
  activates it. No model guessing.
- Progressive disclosure by stage: an agent loads the stage it is in, not the whole
  lifecycle.
- One source of truth per rule.
- No legacy navigation path: every file under `harness/internal-skills/` is routed by the
  registry, or it does not exist.
- Navigation policy lives in a policy file, not hardcoded in a runtime module.
- Provider neutrality preserved: hosts without a Skill tool keep working unchanged.

## Non-Goals

- Changing the state machine, workflow registry, gate semantics, or the five Human
  Confirmation Gates.
- Changing what the deterministic router decides.
- Writing new lifecycle guidance. Consolidation moves and merges existing text; it does not
  author replacement content for the stub files it removes.

## Design

### 1. Four-tier skill taxonomy

`agent-sdlc.manifest.json` replaces the flat `public_skills` array with four tiers that
differ in activation semantics:

| Tier | Manifest key | Members | Auto-activates | Location |
|---|---|---|---|---|
| Entry | `entry_skills` | `sdlc-router`, `sdlc-orchestrator` | Yes — `sdlc-router` via the bootstrap hook | `skills/` |
| Ops | `ops_skills` | `sdlc-status`, `sdlc-resume`, `sdlc-approve`, `sdlc-task`, `sdlc-doctor` | No — user slash invocation or orchestrator dispatch | `skills/` |
| Stage | `stage_skills` | `sdlc-requirements`, `sdlc-design`, `sdlc-plan`, `sdlc-implement`, `sdlc-verify`, `sdlc-review`, `sdlc-release` | No — dispatched by run state | `skills/` |
| Procedure | `procedure_skills` | the 24 ids in `config/procedures.json` after consolidation | No | `skills/procedures/<id>/` |

Structural changes:

- `skills/sdlc-route/` is deleted and merged into `skills/sdlc-router/`. `sdlc-router` is
  retained because it is the name the bootstrap hook injects.
- `commands/` is deleted and the `"commands"` key is removed from
  `.claude-plugin/plugin.json` and `adapters/claude/plugin.json`. No UX is lost: a skill
  is slash-invocable, so `/sdlc-status` continues to work.
- Procedure skills live under `skills/procedures/`, not the discovery root, so they never
  sit beside the entry skills.
- `config/skills.json` drops its `public` array (today a duplicate of
  `manifest.public_skills`). The manifest becomes the single source of truth for tiers;
  `config/skills.json` keeps only `internal`.

The invariant comment at `scripts/build-dist.mjs:17` ("Never place internal skills under a
host-native `skills/` discovery root") is rewritten, not violated: entry, ops and stage
skills occupy the discovery root; procedure skills occupy a separate branch and never
auto-activate.

### 2. Deterministic skill navigation

A new `policies/skill-navigation.json` becomes the single source of truth for navigation and
**replaces the three maps hardcoded at `runtime/context.mjs:10-21`**. It carries three
sections: `stages`, `workflow_skills` and `overlay_skills`. `legacyReachableSkillIds` is
deleted; every id is reachable through the policy.

The `stages` section maps lifecycle stage to stage skill to procedure skills:

| Stage(s) | Stage skill | Procedure skills |
|---|---|---|
| `INTAKE`, `REQUIREMENTS` | `sdlc-requirements` | `requirements-intake`, `requirements-normalize`, `requirements-clarify`, `project-bootstrap` (when), `impact-analysis` (when) |
| `DESIGN` | `sdlc-design` | `design-discovery`, `solution-design` (when), `technical-spike` (when) |
| `PLAN` | `sdlc-plan` | `implementation-plan`, `coordination-analysis` (when) |
| `IMPLEMENT` | `sdlc-implement` | `task-execution`, `repository-intelligence`, `systematic-debugging` (when), `tdd` (when) |
| `VERIFY` | `sdlc-verify` | `testing-verification` |
| `REVIEW` | `sdlc-review` | `code-review`, `traceability`, `docs-update`, `knowledge-maintenance` (when) |
| `RELEASE`, `DEPLOY`, `OBSERVE`, `CLOSE` | `sdlc-release` | `release-deployment`, `git-delivery`, `operability-engineering` |

`workflow-maintenance` keeps its `manual` trigger and is reachable through `sdlc-task`
rather than through a stage.

The `workflow_skills` and `overlay_skills` sections carry what `runtime/context.mjs`
hardcodes today, with one change in shape: an entry that previously pointed at a stub file
now carries the stub's single guidance sentence inline as a `guidance` field, plus the
procedure skills that actually cover the work. So `security-remediation` keeps its
"threat-model and review bounded change for security/privacy regressions" line without a
`security.md` file existing to hold it. `client-impact` continues to route to
`frontend-integration`, which survives consolidation as a real procedure skill.

An entry with `guidance` but no procedure skills is the declared extension point: when real
content is written for it later, it graduates into `config/procedures.json` and becomes a
procedure skill, without any change to the navigation shape.

Gating conditions reuse the existing `WHEN_HANDLERS` in `runtime/procedures.mjs`. No
second gating implementation is written.

Three code touchpoints:

1. `bin/agent-sdlc status` and `bin/agent-sdlc context` gain a `navigation` block:
   `{ stage, stage_skill, procedure_skills[], fallback_instructions_inlined }`. A host with
   a Skill tool activates by name. A host without one receives
   `fallback_instructions_inlined: true` and the procedure text continues to be injected
   by `runtime/context.mjs` exactly as today.
2. `skills/sdlc-orchestrator/SKILL.md` drops from 99 lines to 93, not to roughly 45 as
   first estimated: the Iron Laws, the anti-rationalization table, the non-negotiable
   invariants, and the five Human Confirmation Gates all stay, because none of them is
   per-stage detail -- they are the safety rails that apply across every stage, so moving
   them into a stage skill would only make them conditionally loaded instead of always
   present. What actually moves out is the per-stage detail (REQUIREMENTS, DESIGN, PLAN,
   IMPLEMENT) that used to be inlined; the file keeps a loop of "read state, activate
   `navigation.stage_skill`, transition with evidence" in its place.
3. `runtime/task-worker.mjs` stops hardcoding the TDD rules and resolves them from the
   registry (`config/procedures.json` to `harness/internal-skills/tdd.md`). The worker runs
   in a separate process that may have no Skill tool, so the text is inlined — but from the
   one canonical file.

### 3. Activation safety

Stage and procedure skill descriptions follow a fixed shape:

> Dispatched by `sdlc-orchestrator` when the active SDLC run state is `<STAGE>`. Not an
> entry point; do not activate from a user prompt.

Only `sdlc-router` keeps a broad activation description, because the bootstrap hook depends
on it. This is enforced by an eval, not by convention.

### 4. Generation and packaging

`scripts/gen-skill-surface.mjs` (new) generates `skills/procedures/<id>/SKILL.md` from
`config/procedures.json` and `config/skills.json`, with a `--check` mode for CI drift
detection. Generated files carry a "GENERATED — do not edit by hand" header, matching the
convention already used by `adapters/hooks/claude-session-start.mjs`. The body references
`harness/internal-skills/<id>.md` rather than copying it, so the original stays canonical.
The generator stamps `metadata.version` from `VERSION`.

The validation chain must be updated in step with the taxonomy:

| File | Change |
|---|---|
| `scripts/build-dist.mjs:17` | Rewrite the invariant comment; copy four tiers instead of `public_skills` |
| `scripts/validate-github-install.mjs:28` | `expected` becomes entry + ops + stage; procedure skills validated separately |
| `scripts/verify-dist.mjs:54` | Same tier-aware expectation |
| `scripts/validate-registry.mjs:65` | Walk all four tiers |
| `scripts/validate-versions.mjs:90` | Accept generated procedure skills; generator stamps the version |
| `scripts/bump-version.mjs:83` | Walk all four tiers |
| `evals/run-deterministic.mjs:644` | Replace `manifest-public-skill-count-8` with per-tier assertions |

### 5. New evals

- `skill-navigation-covers-every-stage` — every stage in `lifecycle_order` maps to exactly
  one stage skill, and every procedure in the registry is reachable through at least one of
  `stages`, `workflow_skills`, `overlay_skills`, or an explicit `manual` trigger. No
  procedure is unreachable, and no navigation entry names a procedure that does not exist.
- `single-auto-activating-skill` — exactly one skill (`sdlc-router`) carries a broad
  activation description; every other tier member contains "Not an entry point".
- `skill-description-token-budget` — total description bytes across all tiers stay at or
  below a threshold recorded when the design lands. The measured baseline and the new
  figure are both written into the eval so regressions are visible.

### 6. Legacy consolidation

The twenty non-registry files are promoted — meaning the legacy path is removed entirely,
not that twenty skills are added. They were measured before being classified: `SUBSTAN`
below is the count of substantive lines, excluding blanks, headings, and the `## Contract`
block that is byte-identical across the stub files.

**Group A — routing slots, not content (12 files, SUBSTAN = 1).** `ci-cd`, `compliance`,
`database`, `deployment`, `documentation`, `incident`, `maintenance`, `modernization`,
`monitoring`, `performance`, `security`, `upgrade`. The entire body of each is its own
one-line description — already present verbatim as the `description` field in
`config/skills.json` — followed by the shared boilerplate. They exist to fill slots in
`CORE_SKILL_BY_STAGE`, `WORKFLOW_SKILLS` and `OVERLAY_SKILLS`. Their promoted form is the
stage skill tier plus a `guidance` entry in `policies/skill-navigation.json`; the files are
deleted. Turning them into procedure skills would produce twelve skills whose body is a
sentence the registry already holds.

**Group B — fold into the counterpart, then delete (5 files).**

| File | SUBSTAN | Folds into | Content that must survive |
|---|---|---|---|
| `testing` | 35 | `tdd`, `testing-verification` | Testing anti-pattern table (partially overlaps `tdd.md`) |
| `implementation` | 10 | `task-execution` | The `policies/coding-standards.json` enforcement detail |
| `planning` | 10 | `implementation-plan` | "Minimums that never relax, including FAST micro-plans: goal, scope, done condition, verification" |
| `architecture` | 6 | `design-discovery`, `solution-design` | The `design mode` selector preflight |
| `requirements` | 2 | `requirements-normalize` | The `NEEDS_MULTIMODAL` rule: never silently OCR or invent missing content |

**Group C — real content, promoted with a route (3 files).** `code-review` (SUBSTAN 21: the
two hardened rubrics and the severity calibration) routes to `REVIEW`. `project-bootstrap`
(SUBSTAN 10: the artifact kinds and the knowledge baseline) routes to `INTAKE`, keeping its
G0 trigger. `frontend-integration` (SUBSTAN 4) routes through the `client-impact` overlay.

Result: `harness/internal-skills/` goes from 41 files to 24; `config/procedures.json` goes
from 21 entries to 24; `legacyReachableSkillIds` and the three hardcoded maps are deleted
from `runtime/context.mjs`. The D5 orphan check in
`runtime/procedures.mjs:auditProcedureCoverage` becomes total: it no longer needs a legacy
set to consult, because every remaining file is registered.

Every deletion in Groups A and B is content-preserving by construction: the fold lands in
its own commit and the delete follows only after it.

## Migration and Compatibility

- `/sdlc-route` disappears; `/sdlc-router` replaces it. Recorded in `docs/MIGRATION.md`. No
  alias skill is created — an alias would reintroduce the duplication this design removes.
- The other five slash commands keep working under the same names because the same-named
  skills are slash-invocable.
- Hosts without a Skill tool see no behavioral change: the `navigation` block is additive
  and the existing text-injection path is untouched.
- The bootstrap hook, its hash, and `policies/auto-activation.json` are unchanged.

## Rollout

Six phases, each independently verifiable.

1. **Deduplicate.** Delete `commands/`, merge `sdlc-route` into `sdlc-router`, update both
   Claude manifests. Verify: full eval suite green, `/sdlc-status` still resolves.
2. **Tier model.** Introduce the four manifest keys; update build, dist and validation
   scripts. Verify: `build-dist`, `verify-dist`, `validate-github-install`,
   `validate-registry`, `validate-versions` all pass.
3. **Navigation policy.** Add `policies/skill-navigation.json` carrying `stages`,
   `workflow_skills` and `overlay_skills`; delete `CORE_SKILL_BY_STAGE`, `WORKFLOW_SKILLS`,
   `OVERLAY_SKILLS` and `legacyReachableSkillIds` from `runtime/context.mjs`; add the
   `navigation` block to `status` and `context`. Verify: the coverage eval passes, and the
   set of skill ids resolved per stage/workflow/overlay is identical to what the deleted
   maps produced — asserted by a differential test, not by inspection.
4. **Legacy consolidation.** Fold Group B content into its counterparts and commit that
   alone; then delete Groups A and B and add Group C routes to `config/procedures.json`.
   Verify: the D5 orphan audit reports zero orphans with no legacy set; every surviving
   sentence from the fold table is greppable in its new home.
5. **Stage skills.** Split the seven stage skills out; shrink `sdlc-orchestrator`. Verify:
   activation evals plus a run driven end to end through the stage skills.
6. **Procedure generation.** Add `scripts/gen-skill-surface.mjs`, move the `task-worker` TDD
   text to the registry, add the three new evals, update `docs/QUICKSTART.md`,
   `docs/USAGE.md`, `docs/AUTO-ACTIVATION.md`, `docs/MIGRATION.md`,
   `docs/CORPUS-DECISIONS.md` and `README.md`. Verify: `--check` drift mode green in CI.

## Risks

| Risk | Mitigation |
|---|---|
| Stage skills auto-activate on unrelated prompts | Fixed description shape plus the `single-auto-activating-skill` eval |
| Description bloat (~+500 tokens estimated for the stage tier; +3 procedures net) | Token budget eval with a recorded baseline; procedure tier excluded from auto-activation; consolidation avoids 12 content-free skills |
| Deleting a Group A stub silently drops workflow guidance | The stub's one sentence moves to a `guidance` field in the navigation policy; a differential test compares resolved skill ids before and after |
| A future contributor needs a per-workflow module that no longer has a file | `guidance`-only navigation entries are the declared extension point; adding content graduates the entry into `procedures.json` |
| Generated skill files drift from the registry | `gen-skill-surface.mjs --check` runs in CI |
| Host-specific Skill tool semantics differ | `navigation` is advisory; the deterministic text-injection path remains the floor |
| Splitting the orchestrator loses an invariant | Iron Laws and invariants stay in `sdlc-orchestrator`; only per-stage procedure moves |
