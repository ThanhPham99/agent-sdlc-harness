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
   have a real route through `config/procedures.json`; the remaining 20 are reachable only
   via `legacyReachableSkillIds`. The TDD rules are additionally hardcoded a fourth time
   inside `runtime/task-worker.mjs`.

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
- Provider neutrality preserved: hosts without a Skill tool keep working unchanged.

## Non-Goals

- Promoting all 41 internal-skill files to discoverable skills (see Deliberate Debt).
- Changing the state machine, workflow registry, gate semantics, or the five Human
  Confirmation Gates.
- Changing what the deterministic router decides.

## Design

### 1. Four-tier skill taxonomy

`agent-sdlc.manifest.json` replaces the flat `public_skills` array with four tiers that
differ in activation semantics:

| Tier | Manifest key | Members | Auto-activates | Location |
|---|---|---|---|---|
| Entry | `entry_skills` | `sdlc-router`, `sdlc-orchestrator` | Yes — `sdlc-router` via the bootstrap hook | `skills/` |
| Ops | `ops_skills` | `sdlc-status`, `sdlc-resume`, `sdlc-approve`, `sdlc-task`, `sdlc-doctor` | No — user slash invocation or orchestrator dispatch | `skills/` |
| Stage | `stage_skills` | `sdlc-requirements`, `sdlc-design`, `sdlc-plan`, `sdlc-implement`, `sdlc-verify`, `sdlc-review`, `sdlc-release` | No — dispatched by run state | `skills/` |
| Procedure | `procedure_skills` | the 21 ids in `config/procedures.json` | No | `skills/procedures/<id>/` |

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

A new `policies/skill-navigation.json` is the single source of truth mapping lifecycle
stage to stage skill to procedure skills:

| Stage(s) | Stage skill | Procedure skills |
|---|---|---|
| `INTAKE`, `REQUIREMENTS` | `sdlc-requirements` | `requirements-intake`, `requirements-normalize`, `requirements-clarify`, `impact-analysis` (when) |
| `DESIGN` | `sdlc-design` | `design-discovery`, `solution-design` (when), `technical-spike` (when) |
| `PLAN` | `sdlc-plan` | `implementation-plan`, `coordination-analysis` (when) |
| `IMPLEMENT` | `sdlc-implement` | `task-execution`, `repository-intelligence`, `systematic-debugging` (when), `tdd` (when) |
| `VERIFY` | `sdlc-verify` | `testing-verification` |
| `REVIEW` | `sdlc-review` | `traceability`, `docs-update`, `knowledge-maintenance` (when) |
| `RELEASE`, `DEPLOY`, `OBSERVE`, `CLOSE` | `sdlc-release` | `release-deployment`, `git-delivery`, `operability-engineering` |

`workflow-maintenance` keeps its `manual` trigger and is reachable through `sdlc-task`
rather than through a stage.

Gating conditions reuse the existing `WHEN_HANDLERS` in `runtime/procedures.mjs`. No
second gating implementation is written.

Three code touchpoints:

1. `bin/agent-sdlc status` and `bin/agent-sdlc context` gain a `navigation` block:
   `{ stage, stage_skill, procedure_skills[], fallback_instructions_inlined }`. A host with
   a Skill tool activates by name. A host without one receives
   `fallback_instructions_inlined: true` and the procedure text continues to be injected
   by `runtime/context.mjs` exactly as today.
2. `skills/sdlc-orchestrator/SKILL.md` shrinks from 99 lines to roughly 45: it retains the
   Iron Laws, the non-negotiable invariants, the five Human Confirmation Gates, and a loop
   of "read state, activate `navigation.stage_skill`, transition with evidence". The
   per-stage detail currently inline (REQUIREMENTS, DESIGN, PLAN, IMPLEMENT) moves into the
   corresponding stage skill.
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
  one stage skill, and every procedure in the registry belongs to exactly one stage.
- `single-auto-activating-skill` — exactly one skill (`sdlc-router`) carries a broad
  activation description; every other tier member contains "Not an entry point".
- `skill-description-token-budget` — total description bytes across all tiers stay at or
  below a threshold recorded when the design lands. The measured baseline and the new
  figure are both written into the eval so regressions are visible.

## Deliberate Debt

Twenty files under `harness/internal-skills/` sit outside `config/procedures.json` and are
reachable only through `legacyReachableSkillIds` in `runtime/context.mjs`: `architecture`,
`planning`, `implementation`, `testing`, `code-review`, `security`, `incident`,
`maintenance`, `upgrade`, `database`, `performance`, `compliance`, `documentation`,
`modernization`, `frontend-integration`, `project-bootstrap`, `requirements`, `ci-cd`,
`monitoring`, `deployment`.

They are **not** promoted in this design. Promoting all of them would breach the
description token budget established in section 5. The legacy path is left intact and this
is recorded as intentional debt with a follow-up decision: each file either earns a route in
`procedures.json` or is deleted. The D5 orphan check in
`runtime/procedures.mjs:auditProcedureCoverage` continues to guarantee none becomes silently
unreachable.

## Migration and Compatibility

- `/sdlc-route` disappears; `/sdlc-router` replaces it. Recorded in `docs/MIGRATION.md`. No
  alias skill is created — an alias would reintroduce the duplication this design removes.
- The other five slash commands keep working under the same names because the same-named
  skills are slash-invocable.
- Hosts without a Skill tool see no behavioral change: the `navigation` block is additive
  and the existing text-injection path is untouched.
- The bootstrap hook, its hash, and `policies/auto-activation.json` are unchanged.

## Rollout

Five phases, each independently verifiable.

1. **Deduplicate.** Delete `commands/`, merge `sdlc-route` into `sdlc-router`, update both
   Claude manifests. Verify: full eval suite green, `/sdlc-status` still resolves.
2. **Tier model.** Introduce the four manifest keys; update build, dist and validation
   scripts. Verify: `build-dist`, `verify-dist`, `validate-github-install`,
   `validate-registry`, `validate-versions` all pass.
3. **Navigation policy.** Add `policies/skill-navigation.json` and the `navigation` block on
   `status` and `context`. Verify: new coverage eval passes; existing CLI contract tests
   unchanged.
4. **Stage skills.** Split the seven stage skills out; shrink `sdlc-orchestrator`. Verify:
   activation evals plus a run driven end to end through the stage skills.
5. **Procedure generation.** Add `scripts/gen-skill-surface.mjs`, move the `task-worker` TDD
   text to the registry, add the three new evals, update `docs/QUICKSTART.md`,
   `docs/USAGE.md`, `docs/AUTO-ACTIVATION.md`, `docs/MIGRATION.md`,
   `docs/CORPUS-DECISIONS.md` and `README.md`. Verify: `--check` drift mode green in CI.

## Risks

| Risk | Mitigation |
|---|---|
| Stage skills auto-activate on unrelated prompts | Fixed description shape plus the `single-auto-activating-skill` eval |
| Description bloat (~+500 tokens estimated) | Token budget eval with a recorded baseline; procedure tier excluded from auto-activation |
| Generated skill files drift from the registry | `gen-skill-surface.mjs --check` runs in CI |
| Host-specific Skill tool semantics differ | `navigation` is advisory; the deterministic text-injection path remains the floor |
| Splitting the orchestrator loses an invariant | Iron Laws and invariants stay in `sdlc-orchestrator`; only per-stage procedure moves |
