# Remaining Plugin Audit Findings — agent-sdlc-harness 3.0.0-rc1

Source: plugin-surface audit run 2026-09-06 against `6458ca8`, plus limitations
observed while driving the harness through its own workflow to land F1.

Baseline at time of audit: `npm run check` 46/46 PASS, runtime coverage 92%,
`npm run typecheck` PASS, no TODO/FIXME debt in `runtime/`.

F1 (auto-scaffolded write scope unbounded on ordinary repositories) was fixed in
`709ca04` and is **not** part of this spec.

**Status as of 2026-09-07:** F4, F6 and F7 are closed (see the markers below).
F2, F3, F5, F8-F11 and E1-E4 are open. Plans:
`docs/superpowers/plans/2026-09-07-remaining-audit-index.md`.

## Global constraints

These hold for every change made against this spec.

- Node `>=18`; `"type": "module"`; **zero runtime dependencies**
  (`agent-sdlc.manifest.json` → `runtime.dependency_mode`).
- Every new npm test script must be added to BOTH `scripts/lib/check-plan.mjs`
  and `.github/workflows/ci.yml`. `scripts/validate-ci-coverage.mjs` asserts
  membership and stage order, and fails if the two disagree.
- Tracked `evals/*.json` reports are written through
  `writeReport` from `scripts/lib/report-io.mjs` (atomic temp+rename), and carry
  a `version` field taken from `agent-sdlc.manifest.json`
  (`scripts/validate-versions.mjs` checks the stamp).
- Files mirrored between `adapters/` and the repository root are byte-for-byte
  copies checked by `scripts/validate-root-sync.mjs`; edit the `adapters/` copy
  and run `npm run sync:root`.
- Comments state WHY. The codebase rejects decorative or restating comments, and
  a comment that overclaims what the code does is treated as a defect.
- `npm run check` must be green before any commit.

## Findings

### F2 — A design decision made of placeholders passes the DESIGN gate
`validateDesignDecision` (`runtime/design-discovery.mjs`) is purely structural.
`scaffoldDesignDecision` emits FULL-mode options whose `summary`, `benefits` and
`tradeoffs` are the literal string `"TODO"`, and the result validates with
`valid: true` and emits gate evidence `full_design_approved_or_policy_auto`.

**Requirement.** Validation must reject a decision whose required free text is
still an unreplaced placeholder, with an error naming the field. Scaffolding
must keep emitting the placeholders — they are a starting point — so the
scaffold becomes *invalid until filled*, which is the intended contract.

### F3 — A scaffolded plan is indistinguishable from an authored one
`scaffoldTaskPlan` (`runtime/autonomous-runner.mjs`) produces a single task
covering the whole objective, with `targeted_tests` guessed by
`detectExistingTestFile` or the literal fallback `test/unit.test.js`. Nothing in
the artifact records that it was machine-generated.

**Requirement.** The plan artifact must record its provenance, and
`validateTaskPlan` must surface a scaffolded plan as a warning so a reader can
tell a guess from a decision. This must not become an error: `auto` depends on
scaffolded plans validating.

### F4 — Nine CLI commands ship undocumented, and nothing gates it

> **CLOSED** — `f75e8c5`. The gate refuses a command absent from the reference docs, and refuses any `docs/` path it cannot classify as reference or non-reference. `docs/USAGE.md` §12-17 added. The real undocumented set was twelve, not nine; the nine below were correct, and the gate initially credited them from this spec's own sibling plan file until its scope was fixed.
`auto`, `auto-task`, `ci-check`, `rewind`, `serve`, `dashboard`, `webhook`,
`completion` and `review` have zero mentions in `docs/`. `docs/USAGE.md` stops
at section 11 (alpha6). `scripts/validate-cli-surface.mjs` checks the registry
against the handlers and the generated help, but never against documentation.

**Requirement.** A gate that fails when a registered top-level command is
absent from the documentation, plus the missing documentation itself.

### F5 — MCP cannot record an agent-authored design decision or task plan
`runtime/mcp-server.mjs` exposes no `agent_sdlc_design` or `agent_sdlc_plan`
tool, and `agent_sdlc_task`'s `op` enum omits `materialize`. `runAutoPipeline`
accepts a `customPlan` option but no MCP surface passes one. `sdlc-orchestrator`
instructs the agent to fall back to "the corresponding MCP tools" when the CLI
is unavailable; for the two machine-checked gates those tools do not exist.

**Requirement.** MCP parity for the DESIGN and PLAN gates: record an authored
design decision, validate and record an authored task plan, and materialize it.

### F6 — `npm run typecheck` runs nowhere

> **CLOSED** — `a2dd3ff`. In the offline stage of `check-plan.mjs` and the matching CI step.
`scripts/validate-types.mjs` is wired to `package.json` but is absent from
`scripts/lib/check-plan.mjs` and from `.github/workflows/ci.yml`, so `types/`
can drift silently.

### F7 — The Windows CI leg omits four suites

> **CLOSED** — `4c5af7b`. All four added, each justified against the job's own platform-sensitivity criterion rather than parity with ubuntu, which contradicted that job's documented design.
`.github/workflows/ci.yml`'s `windows-validation` job stops at `test:simulator`.
It never runs `test:commands-expansion`, `test:web-dashboard`,
`test:simulate-e2e` or `test:autonomous-runner` — the last of which is where F1
lived.

### F8 — `init`/`start` dirties the tree the harness then polices
`runtime/store.mjs` copies `templates/REVIEW.md` into the project root on
`initProject`. It is not added to any ignore file, so the harness's own
initialization leaves an untracked file in a working tree whose cleanliness the
task scope audit depends on.

### F9 — The Antigravity hook is invoked by a CWD-relative path
`adapters/antigravity/hooks.json` runs `node ./hooks/antigravity-preinvocation.mjs`
while the Claude adapter uses `${CLAUDE_PLUGIN_ROOT}`.
`scripts/test-antigravity-bootstrap-hook.mjs` spawns the hook by absolute path,
so the relative command string in the manifest is never exercised.

### F10 — `security.sast` is unimplemented while a working linter ships unwired
`config/tools.json` declares `security.sast` and `security.sca` with
`"implementation": "external"`, so `tool-run` returns
`tool security.sast requires host/MCP/external implementation`.
`runtime/security-linter.mjs` exports a working `lintSecurityRisks(codeString,
{filename})` with its own suite and is referenced by no tool.

Consequently `no_new_high_security_findings` is absent from
`policies/stage-policy.json` → `evidence_authority`, so unlike
`targeted_verification_pass` it is caller-assertable: the VERIFY security gate
currently rests on the agent's word.

**Requirement.** Back `security.sast` with the shipped linter over the files
changed against the run's base revision, derive
`no_new_high_security_findings` from that run at `runtime/tools.mjs:268` the way
`targeted_verification_pass` is derived, and give the token `runtime` authority.

### F11 — `tool-run` returns raw logs, not structured summaries
`test.run_targeted` returns up to `max_return_bytes` (24000) of raw stdout as
`summary`, with `truncated: true` and a `full_log_artifact` ref. The harness's
own invariant is "tool output is bounded; store raw logs as artifacts and pass
structured summaries". Half of that holds.

**Requirement.** For runs whose output is a recognised report shape, return
counts and failure names rather than the head of the log. The artifact ref
already carries the full text.

## Engine limitations observed while dogfooding

### E1 — Orphan tasks block `implementation-complete` silently
A task present in an older plan revision but absent from the new one stays in
the graph. `task implementation-complete` then reports
`TASKS_NOT_DONE:TASK-002(BLOCKED)` and nothing supersedes it automatically.

Note: `materializeTaskGraph` **does** re-apply a changed definition to a task
with no bound work, and reports `DEFINITION_CHANGED_BUT_WORK_ALREADY_BOUND` in
its `conflicts` array when work is already bound. That behaviour is correct and
is not part of this spec.

### E2 — `task advance` ignores previously recorded reviews
`advanceTask` (`runtime/task-runner.mjs:135-150`) reads reviews only from its
own `specReview`/`qualityReview` arguments. A review recorded earlier through
`task review --kind spec --file ...` validates, is stored, and attaches to the
task — and then `task advance` still answers `awaiting: SPEC_COMPLIANCE_REVIEW`.

### E3 — The review verdict vocabulary is undiscoverable
`validateCodeQualityReview` requires `ACCEPTED` / `CHANGES_REQUIRED` /
`PENDING`; `validateSpecComplianceReview` requires `COMPLIANT` /
`NON_COMPLIANT` / `PENDING`. Neither vocabulary appears in
`agents/independent-reviewer/agent.md`, so a caller dispatching the shipped
reviewer gets `INVALID_VERDICT` and has to read the validator to find out why.

### E4 — Running a suite dirties tracked reports and staleness-invalidates evidence
Every suite rewrites its own tracked `evals/*.json`. `tool-run` therefore leaves
the tree dirty, and restoring those reports *after* gate evidence is recorded
changes the workspace and marks the evidence stale
(`gate blocked at VERIFY; stale evidence (workspace changed since it was
recorded)`). The working sequence is: restore reports, run the tool, transition
without touching the tree — which nothing states.

## Housekeeping

- `709ca04`'s commit message is harness-generated
  (`chore(sdlc): commit changes for TASK-010 [<entire goal sentence>]`) and does
  not follow the repository's Conventional Commits usage.
- Two stale git worktrees remain under `.agent-sdlc/workspaces/`: one from the
  superseded `TASK-001` of run `4d2c9237`, one from run `add72e05`.
