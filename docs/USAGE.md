# Usage

## 0. Just ask

With the plugin installed, repository/system work routes itself — no skill needs to be named:

```text
Add password reset to this backend.
Fix the login bug in this repository.
Investigate this production outage.
```

`sdlc-router` runs before planning, editing or tool use, then hands control to
`sdlc-orchestrator`. Generic programming Q&A does not start a run. Automatic entry never
substitutes for approval on production, destructive, credential or security-exception actions.

```bash
./bin/agent-sdlc activation doctor      # how this host delivers the bootstrap
./bin/agent-sdlc activation status --host claude
```

On Windows use `bin\agent-sdlc.cmd` (cmd.exe) or `bin\agent-sdlc.ps1`
(PowerShell); `bin/agent-sdlc` is a POSIX `sh` script and neither shell will run
it. `node runtime/cli.mjs <command>` works everywhere and is what all three
shims exec.

Codex installed natively is soft activation only; see `docs/AUTO-ACTIVATION.md`. The commands
below remain the deterministic surface the orchestrator drives, and are equally usable by hand.

## 1. Initialize and inspect configuration

```bash
./bin/agent-sdlc init
./bin/agent-sdlc config-show
./bin/agent-sdlc doctor
```

Review detected build/test commands and project invariants in `.agent-sdlc/project.json` before allowing write-capable execution.

A `new-feature` run started before any project knowledge exists (no `system-context`, `architecture`,
`standards` or `feature-index` artifact yet) automatically loads the `project-bootstrap` skill at
INTAKE/REQUIREMENTS instead of guessing at architecture it was never shown; it drops out again once
all four exist. Check the current status directly with `./bin/agent-sdlc knowledge status`.

## 2. Normalize source material before model reasoning

```bash
./bin/agent-sdlc normalize --file ./requirements.docx --output /tmp/requirements.normalized.md
```

With `--run-id`, a successful normalization is persisted as a content-addressed `normalized-requirement` artifact. Images or image-only PDFs return `NEEDS_MULTIMODAL` rather than being guessed or silently OCR'd.

## 3. Route and start

```bash
./bin/agent-sdlc route --objective "Add idempotent refunds"
./bin/agent-sdlc start --objective "Add idempotent refunds"
```

Save the returned `run_id`. Routing chooses workflow/risk profile deterministically when possible.

## 4. Compile only the current context

```bash
./bin/agent-sdlc context --run-id <id>
./bin/agent-sdlc context --run-id <id> --prompt
```

The manifest loads current stage skills, workflow-specific specialties, compact project invariants, relevant artifact summaries and exact requested symbols—never the entire chat/repository by default. It also carries `active_roles`: the roles `policies/stage-policy.json` authorizes for the current stage, each resolved against `config/roles.json` for its responsibilities and default constraint, so the model knows whose concerns it is standing in for (e.g. `architect`, `security`, `sre`, `dba` at DESIGN) rather than the registry sitting unused.

`config/skills.json` registers 20 broad, always-compact capability groups; `config/procedures.json` registers the deeper, single-purpose methodology files under `harness/internal-skills/` that the group files intentionally stay too short to include (e.g. `tdd`, `systematic-debugging`, `git-delivery`, `design-discovery`). `runtime/procedures.mjs` resolves each one from canonical run state — current stage, workflow, profile, the same design-mode decision the DESIGN gate itself uses, materialized task-graph size — never from keywords in the objective text, and never all at once. A procedure whose ideal trigger has no first-class field yet (e.g. a declared build strategy for `tdd`) uses the closest real proxy available today rather than defaulting to always-on; `harness/internal-skills/workflow-maintenance.md` is registered but deliberately never auto-selected, since harness self-maintenance is operator-invoked, not run-driven. The resolved set appears in the context manifest as `procedures`/`procedure_instructions`, and every file under `harness/internal-skills/` is accounted for by either the skill maps or this registry — enforced by a regression test, not just a claim.

## 5. Tool and model routing

```bash
./bin/agent-sdlc tool-check --run-id <id> --tool test.run_targeted
./bin/agent-sdlc tool-run --run-id <id> --tool test.run_targeted --args '{"selector":"refund"}'
./bin/agent-sdlc model-route --run-id <id>
./bin/agent-sdlc parallel-plan --tasks '[{"id":"a","write_set":["a.ts"]},{"id":"b","write_set":["b.ts"]}]'
```

`tool-run` also accepts `--selector <value>` and `--timeout-ms <n>` as shorthand for the
`selector`/`timeout_ms` keys inside `--args`; if `--args` already sets one of those keys, the
`--args` value wins.

External tools (LSP, SAST/SCA, deploy, observability) are mapped through MCP/host integrations while retaining the canonical policy decision.

## 6. Evidence gates and durable handoff

```bash
./bin/agent-sdlc artifact-put --run-id <id> --kind spec --file ./SPEC.md
./bin/agent-sdlc transition --run-id <id> --to DESIGN --evidence requirements_confirmed
./bin/agent-sdlc handoff-put --run-id <id> --summary "Design approved" --verified "requirements confirmed" --next "implement plan"
```

`transition` has no `--force` or `--approval` flag; both are rejected outright with a named error.
Recovery goes through a declared reentry edge in `config/state-machine.json` (blocked at VERIFY
after new evidence surfaces a code defect, transition back to IMPLEMENT — the edge already exists).
A privileged capability is authorized only by a human running
`agent-sdlc approval grant --run-id <id> --capability <name>` interactively; it requires a TTY, an
explicit typed confirmation, and — for a privileged capability — an expiry. Read the current
approvals on a run with `agent-sdlc approval status --run-id <id>`.

`targeted_verification_pass` (the VERIFY gate) cannot be asserted with `--evidence` either: it is
written only by a real `tool-run --tool test.run_targeted` PASS, bound to the exact git SHA and
working-tree diff it ran against, so an edit after the test run makes it stale rather than still
satisfying the gate. Other evidence tokens remain caller-asserted for now — there is no deterministic
tool behind SAST/SCA yet, so typing them would either fabricate a tool that isn't there or leave the
gate permanently unsatisfiable. `agent-sdlc gate status --run-id <id>` / `gate explain --run-id <id>
--stage <stage>` show exactly what's satisfied, missing, or stale for any stage.

## 7. Cost, telemetry, replay and compatibility

```bash
./bin/agent-sdlc usage-report --run-id <id>
./bin/agent-sdlc metrics
./bin/agent-sdlc replay-export --run-id <id> --output replay.json
./bin/agent-sdlc replay-validate --file replay.json
./bin/agent-sdlc compat-check
```

Use artifacts/handoffs at stage boundaries as external memory, then start the next bounded context instead of carrying transient conversation history forward.

## 8. Design gate and plan gate (v3.0.0-alpha4)

Two gates are machine-checked. Their evidence cannot be supplied through `transition --evidence`.

### DESIGN

```bash
./bin/agent-sdlc design mode     --run-id <id>
./bin/agent-sdlc design policy
./bin/agent-sdlc design scaffold --run-id <id>
./bin/agent-sdlc design validate --file design-decision.json
./bin/agent-sdlc design record   --run-id <id> --file design-decision.json
```

`design mode` returns `SKIP` / `COMPACT` / `FULL` with reason codes, the escalation and de-escalation signals that fired, and whether human approval is required. Declare a signal the objective text does not express with `--signals ARCHITECTURE_BOUNDARY,...` rather than overriding the answer by hand.

`design mode`'s output (`agent-sdlc/design-discovery-decision/v1`) is a mode *selection*, not the decision content `design validate`/`design record` require (`agent-sdlc/design-decision/v1`) — the two do not compose directly. `design scaffold` runs the same selection and prints a correctly-shaped draft for that mode alongside it: a `SKIP` or `COMPACT` draft is immediately valid (the selection's own reason codes are the real answer to "why skip"); a `FULL` draft has the right number of `options` with `TODO` placeholders and needs real judgment (and, if `human_approval_required`, real approval) before it validates. Save `.draft` to a file, edit it, then pass it to `design validate`/`design record`. A starting shape also lives at `templates/design-decision.json`.

`design record` validates the `agent-sdlc/design-decision/v1` artifact, stores it, and writes the DESIGN gate evidence only on success.

### PLAN

```bash
./bin/agent-sdlc plan validate --file task-plan.json
./bin/agent-sdlc plan graph    --file task-plan.json
./bin/agent-sdlc plan record   --run-id <id> --file task-plan.json
```

`plan graph` prints the derived dependency graph, cycles, ready-set waves, acceptance-criterion coverage and parallel scope conflicts. `plan record` is the only source of PLAN gate evidence.

See `docs/architecture/DESIGN-DISCOVERY.md` and `docs/architecture/PLAN-QUALITY.md`.

## 9. Task execution (v3.0.0-alpha5)

`IMPLEMENT` executes a persistent task graph rather than "writing the code".

```bash
./bin/agent-sdlc task materialize --run-id <id> --file task-plan.json
./bin/agent-sdlc task refresh     --run-id <id>
./bin/agent-sdlc task schedule    --run-id <id>
./bin/agent-sdlc task start       --run-id <id> --task-id TASK-001 --writer dev-1
./bin/agent-sdlc task advance     --run-id <id> --task-id TASK-001 \
    --spec-review spec.json --quality-review quality.json
./bin/agent-sdlc task implementation-complete --run-id <id>
```

Inspection and diagnostics:

```bash
./bin/agent-sdlc task list|graph|progress|events --run-id <id>
./bin/agent-sdlc task ready      --run-id <id> --stage IMPLEMENT
./bin/agent-sdlc task context    --run-id <id> --task-id TASK-001 [--prompt]
./bin/agent-sdlc task verify     --run-id <id> --task-id TASK-001
./bin/agent-sdlc task classify   --run-id <id> --task-id TASK-001 --verification v.json
./bin/agent-sdlc task workspaces --run-id <id>
./bin/agent-sdlc task usage|metrics --run-id <id>
./bin/agent-sdlc task migrate    --run-id <id> [--dry-run]
```

`task schedule` reports every ready task it did not dispatch, with a reason. `task metrics`
reports cost per verified DONE task, `success@1` and retry rate.

See `docs/architecture/TASK-ENGINE.md` and `docs/architecture/TASK-SCHEDULER.md`.

## 10. Feature / phase identity (v3.0.0-alpha6)

A feature is durable project state that can span multiple runs and multiple phases; a run alone
used to be the only unit that existed, so "continue this feature" or "this requirement changed"
had no actual feature to point at.

```bash
./bin/agent-sdlc feature create --title "Coupon support"
./bin/agent-sdlc feature show|update --feature-id <id>
./bin/agent-sdlc feature list
./bin/agent-sdlc feature active [--feature-id <id>]
./bin/agent-sdlc feature phase-create --feature-id <id> [--name ...] [--objective ...]
./bin/agent-sdlc feature phase-show|phase-complete --feature-id <id> --phase-id <id>
./bin/agent-sdlc feature phase-list --feature-id <id>
```

`agent-sdlc start` stays unbound by default — nothing changes for a plain `start --objective ...`.
Pass `--feature-id <id>` to attach to an existing feature, or `--track-feature` to have a plain
`new-feature` start create one automatically (titled from the objective unless `--feature-title` is
given). `--workflow continue-feature` and `--workflow requirement-update` always require
`--feature-id` — they refuse to run unbound rather than silently starting a disconnected run.
Completing a phase (`feature phase-complete`) never marks the feature itself complete: a feature can
carry deferred phases long after one run's phase closes, and `run.state === 'CLOSE'` is never treated
as `feature.status === 'COMPLETE'`. A superseded phase is never deleted, only marked `SUPERSEDED` —
starting phase 2 does not erase phase 1's history. A bound run's context manifest carries a `feature`
summary (title, status, current phase, deferred items, open questions) so the model knows it is
picking up prior work rather than starting cold.

There is deliberately no automatic "resume mid-stage" here: Feature.schema.json's `resume` field and
Phase.schema.json's `resume_from` field exist for a future increment, but nothing reads them yet — a
bound run still walks its own state machine from that workflow's first stage and earns every gate's
evidence itself. Skipping stages based on "this was already proven valid on a prior run" would need a
provenance chain this codebase does not have yet; building that without it would reopen exactly the
kind of evidence-bypass this project spent several rounds closing.

## 11. Repository intelligence, traceability and delivery (v3.0.0-alpha6)

```bash
./bin/agent-sdlc repo index
./bin/agent-sdlc repo status
./bin/agent-sdlc repo surface     --objective "add refund idempotency"
./bin/agent-sdlc repo symbol      --name PaymentService
./bin/agent-sdlc repo references  --name RefundRepository
./bin/agent-sdlc repo dependents  --path src/payments/refund-repository.js
./bin/agent-sdlc repo tests       --name PaymentService
./bin/agent-sdlc repo module|interfaces|entities|events|recent ...
```

```bash
./bin/agent-sdlc trace build      --run-id <id>
./bin/agent-sdlc trace coverage   --run-id <id>
./bin/agent-sdlc trace closure    --run-id <id> --node ACCEPTANCE_CRITERION:AC-001 --delta BEHAVIOR_CHANGE
./bin/agent-sdlc trace invalidate --run-id <id> --node INTERFACE:"POST /v1/refunds" --delta INTERFACE_CHANGE [--dry-run]
./bin/agent-sdlc trace history    --run-id <id>
```

```bash
./bin/agent-sdlc requirement-update plan --run-id <new-id> --continues <prior-run-id> \
    --node ACCEPTANCE_CRITERION:AC-001 --delta BEHAVIOR_CHANGE [--reason "..."] [--dry-run]
./bin/agent-sdlc requirement-update show --run-id <new-id>
```

```bash
./bin/agent-sdlc ci record        --run-id <id> --file ci.json --revision <sha>
./bin/agent-sdlc ci status        --run-id <id>
./bin/agent-sdlc delivery record  --run-id <id> --target PR_READY --base main --base-revision <sha>
./bin/agent-sdlc delivery drift|push-check|group --run-id <id>
```

```bash
./bin/agent-sdlc govern task      --run-id <id> --task-id TASK-001 --remaining-model-calls 20
./bin/agent-sdlc govern report    --run-id <id>
./bin/agent-sdlc fallback         --run-id <id> --task-id TASK-001 --from claude --to codex
./bin/agent-sdlc learn candidate  --source VERIFICATION_FAILURE --title "..." --observed "..." --expected "..."
npm run learn:promote -- --source VERIFICATION_FAILURE --title "..." --observed "..." --expected "..."
```

`repo surface` returns a bounded surface or says it could not narrow the objective. `trace coverage`
derives coverage from graph edges, not from claims. `ci status` exits non-zero when the recorded
evidence is not about the current revision. `delivery record` never reports a target its evidence
cannot justify. `govern task` explains every decision and never trades a security or review
requirement for cost.

`requirement-update plan` links a new run to the prior run its update targets, computes the same
deterministic invalidation closure `trace invalidate` uses but against the *prior* run's graph, and
carries forward exactly the artifact refs the closure proves are still valid onto the new run — a
wording-only change preserves everything; a behavior or interface change invalidates the affected
closure in the prior run's history (never deleted, only marked invalid) and reports the earliest
stage the delta actually reaches. This does not skip the new run's own gates: there is no
Feature/Phase identity yet to let one run's evidence stand in for another's, so the new run still
earns its own evidence at every stage — this is honest signal about what changed and what's settled,
surfaced in its context manifest as `requirement_update`, not an automatic replay shortcut.

See `docs/architecture/REPOSITORY-INTELLIGENCE.md` and `docs/architecture/TRACEABILITY-GRAPH.md`.
