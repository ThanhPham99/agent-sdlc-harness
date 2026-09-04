# End-to-End SDLC Tutorial: Building a Feature with Agent SDLC Harness

This tutorial walks through building, verifying, and releasing a new feature using the canonical Agent SDLC Harness lifecycle.

---

## 1. Overview of the Canonical Lifecycle

Agent SDLC Harness enforces a monotonic 10-stage lifecycle:
`INTAKE` ➔ `REQUIREMENTS` ➔ `ARCHITECTURE` ➔ `DESIGN` ➔ `PLAN` ➔ `EXECUTE` ➔ `VERIFY` ➔ `REVIEW` ➔ `DELIVERY` ➔ `CLOSE`

Every stage transition is protected by a deterministic Quality Gate that requires cryptographic evidence tokens.

---

## 2. Step-by-Step Walkthrough

### Step 1: Initialize the Project
In your project root directory:
```bash
node runtime/cli.mjs init
```
This creates `.agent-sdlc/project.json` declaring test commands, build scripts, and policies.

### Step 2: Kick off the Feature (Intake & Route)
```bash
node runtime/cli.mjs start --objective "Implement rate limiting middleware for API endpoints"
```
The router analyzes the prompt and classifies the workflow into `new-feature` with profile `STANDARD`.

### Step 3: Requirements & Spec Drafting
Advance the run state to `REQUIREMENTS`:
```bash
node runtime/cli.mjs transition --to REQUIREMENTS
```
Write specification artifacts and attach them:
```bash
node runtime/cli.mjs artifact-put --kind spec --content "Rate limiter limits to 100 req/min per IP using token bucket algorithm."
```

### Step 4: Architecture & Design Decisions
```bash
node runtime/cli.mjs transition --to ARCHITECTURE
node runtime/cli.mjs transition --to DESIGN
```

### Step 5: Task DAG Planning (`PLAN`)
```bash
node runtime/cli.mjs transition --to PLAN
```
The planner outputs a validated `TaskPlan` artifact. The harness automatically materializes the Task DAG and checks for scope conflicts.

### Step 6: Task Execution (`EXECUTE`)
In the execute stage, parallel workers claim ready tasks from the DAG:
```bash
node runtime/cli.mjs transition --to EXECUTE
node runtime/cli.mjs task ready
node runtime/cli.mjs task schedule
```

### Step 7: Verification & Gate Validation (`VERIFY`)
Run test suites and obtain verification evidence:
```bash
node runtime/cli.mjs transition --to VERIFY
```

### Step 8: Code Review & Quality Audit (`REVIEW`)
Conduct multi-axis review across correctness, security, architecture, and performance:
```bash
node runtime/cli.mjs transition --to REVIEW
```

### Step 9: PR Synthesis & Delivery (`DELIVERY`)
Generate the structured PR description and changelog:
```bash
node runtime/cli.mjs transition --to DELIVERY
```

### Step 10: Run Completion (`CLOSE`)
```bash
node runtime/cli.mjs transition --to CLOSE
```

---

## 3. Real-Time Observability

At any point during the run, you can inspect progress:
- **Terminal TUI**: `node runtime/cli.mjs dashboard --tui`
- **Live Web GUI**: `node runtime/cli.mjs dashboard --web --port 4100`
- **Traceability Graph**: `node runtime/cli.mjs trace show --mermaid`

