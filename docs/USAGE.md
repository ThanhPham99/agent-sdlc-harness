# Usage

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

Do not use `--force` in normal operation; it exists for operator recovery/testing and should be auditable.

## 7. Cost, telemetry, replay and compatibility

```bash
./bin/agent-sdlc usage-report --run-id <id>
./bin/agent-sdlc metrics
./bin/agent-sdlc replay-export --run-id <id> --output replay.json
./bin/agent-sdlc replay-validate --file replay.json
./bin/agent-sdlc compat-check
```

Use artifacts/handoffs at stage boundaries as external memory, then start the next bounded context instead of carrying transient conversation history forward.
