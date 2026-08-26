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

Codex installed natively is soft activation only; see `docs/AUTO-ACTIVATION.md`. The commands
below remain the deterministic surface the orchestrator drives, and are equally usable by hand.

## 1. Initialize and inspect configuration

```bash
./bin/agent-sdlc init
./bin/agent-sdlc config-show
./bin/agent-sdlc doctor
```

Review detected build/test commands and project invariants in `.agent-sdlc/project.json` before allowing write-capable execution.

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

The manifest loads current stage skills, workflow-specific specialties, compact project invariants, relevant artifact summaries and exact requested symbols—never the entire chat/repository by default.

## 5. Tool and model routing

```bash
./bin/agent-sdlc tool-check --run-id <id> --tool test.run_targeted
./bin/agent-sdlc tool-run --run-id <id> --tool test.run_targeted --args '{"selector":"refund"}'
./bin/agent-sdlc model-route --run-id <id>
./bin/agent-sdlc parallel-plan --tasks '[{"id":"a","write_set":["a.ts"]},{"id":"b","write_set":["b.ts"]}]'
```

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
./bin/agent-sdlc design validate --file design-decision.json
./bin/agent-sdlc design record   --run-id <id> --file design-decision.json
```

`design mode` returns `SKIP` / `COMPACT` / `FULL` with reason codes, the escalation and de-escalation signals that fired, and whether human approval is required. Declare a signal the objective text does not express with `--signals ARCHITECTURE_BOUNDARY,...` rather than overriding the answer by hand.

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

## 10. Repository intelligence, traceability and delivery (v3.0.0-alpha6)

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

See `docs/architecture/REPOSITORY-INTELLIGENCE.md` and `docs/architecture/TRACEABILITY-GRAPH.md`.
