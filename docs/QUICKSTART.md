# Agent SDLC Harness — Quickstart Guide

Get up and running with **Agent SDLC Harness** in 5 minutes.

---

## 1. What is Agent SDLC Harness?

Agent SDLC Harness is a local-first, zero-runtime-dependency lifecycle controller for autonomous AI coding agents (Claude Code, OpenAI Codex, Google Antigravity). It enforces deterministic stage gates, progressive context management, token/cost governance, cryptographically verifiable task DAG execution, and time-travel rollbacks.

---

## 2. Fast 5-Minute Setup

### Prerequisites
- Node.js >= 18.0.0 (uses only standard library: `node:fs`, `node:http`, `node:crypto`, etc.)
- Git

### Initialization

```bash
# Clone repository
git clone https://github.com/ThanhPham99/agent-sdlc-harness.git
cd agent-sdlc-harness

# Initialize harness in your project repository
node runtime/cli.mjs init
```

---

## 3. Basic Workflow & Key Commands

### Step 1: Start a New SDLC Run
```bash
node runtime/cli.mjs start --objective "Build a user authentication API with JWT verification"
```

### Step 2: Check Status & Next Recommended Step
```bash
node runtime/cli.mjs status --pretty
node runtime/cli.mjs next
```

### Step 3: Transition Across Lifecycle Gates
```bash
# Transition to requirements after drafting specs
node runtime/cli.mjs transition --to REQUIREMENTS

# Transition with verification evidence tokens
node runtime/cli.mjs transition --to VERIFY --evidence artifact://sha256/abc12345...
```

### Step 4: Time-Travel Rollback (Rewind)
If you need to revisit a previous stage or task:
```bash
node runtime/cli.mjs rewind --stage DESIGN
```

### Step 5: Real-Time Live Visual Dashboard
```bash
# Start live web dashboard on port 4100
node runtime/cli.mjs dashboard --web --port 4100

# Or render terminal TUI directly
node runtime/cli.mjs dashboard --tui
```

---

## 4. Multi-Host Auto-Activation

- **Claude Code**: Put `.claude-plugin/plugin.json` in your Claude plugins directory or load as external tool.
- **OpenAI Codex**: Configured via `.codex-plugin/plugin.json`.
- **Google Antigravity**: Seamlessly loaded via `skills/sdlc-router` and `skills/sdlc-orchestrator`.

---

## 5. Next Steps
- Read [Step-by-Step Tutorial](TUTORIAL-STEP-BY-STEP.md) for a complete walkthrough.
- Check [Multi-Language Integration Guide](guides/MULTI-LANGUAGE-INTEGRATION.md) for configuring test runners in Python, Go, Rust, or Java.

## 6. Codex Integration

```bash
node scripts/codex-bootstrap.mjs status
node scripts/codex-bootstrap.mjs install [--dry-run] [--codex-home DIR]
node scripts/codex-bootstrap.mjs uninstall [--dry-run]
# or through the CLI
agent-sdlc activation codex-bootstrap install
```

Installer control:

```bash
./install.sh --host codex                      # managed block installed (default)
./install.sh --host codex --no-auto-activate    # soft discovery only, no file written
./install.sh --host all --dry-run              # print planned actions, change nothing
./install.ps1 -HostName codex -NoAutoActivate  # Windows parity
```

## 9. Uninstall

`./uninstall.sh` removes the plugin through each native host command and then removes only the
Agent SDLC managed block from the global Codex `AGENTS.md`. Unrelated content is preserved
byte-for-byte. The instruction file itself is deleted only when Agent SDLC created it and nothing
else remains in it. `--keep-bootstrap` leaves the block in place; `--dry-run` prints the plan.

## 10. Diagnosing activation

```bash
agent-sdlc activation status --host claude
agent-sdlc activation doctor                 # all hosts, with Codex bootstrap detail
agent-sdlc activation doctor --host codex
agent-sdlc activation classify --prompt "Add password reset to this backend." --repository-target
agent-sdlc activation events
agent-sdlc doctor
```

`activation status` answers: is it enabled, which layer decided that, how this host delivers it,
whether the class is strong or soft, whether a Codex override masks it, and how many rough
tokens it costs.

`activation classify` is a deterministic diagnostic/eval helper only. The authoritative semantic
decision at runtime belongs to `sdlc-router`.

Activation events (`activation.bootstrap_delivered`, `route_expected`, `route_started`,
`route_skipped`, `route_missed`, `disabled`) carry host, delivery mode, bootstrap version/hash
and rough tokens. They never carry prompt text, file content or secrets.

## 11. Tests and evidence

```bash
node scripts/test-auto-bootstrap.mjs
node scripts/test-claude-bootstrap-hook.mjs
node scripts/test-antigravity-bootstrap-hook.mjs
node scripts/test-codex-bootstrap.mjs
```

Corpora: `evals/activation/deterministic-cases.json` (positive, negative, borderline),
`multi-turn-cases.json`, `adversarial-cases.json`, `provider-expectations.json`.
Live activation evidence, when a host CLI and credentials exist, is produced by
`scripts/qualify-host.mjs` and reported with one of `AUTO_ACTIVATED`,
`SOFT_DISCOVERY_ACTIVATED`, `NOT_ACTIVATED`, `UNSUPPORTED`, `PENDING`.
