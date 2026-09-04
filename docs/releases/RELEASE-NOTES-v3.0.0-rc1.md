# Release Notes — 3.0.0-rc1

Theme: **Release Candidate 1 — Production Readiness, Comprehensive Test Coverage & Cross-Platform Packaging**.

Agent SDLC Harness 3.0.0-rc1 consolidates all features across the v3 lifecycle into a production-ready, highly tested, zero-runtime-dependency distribution for Claude Code, OpenAI Codex, and Google Antigravity.

## Highlights

### 1. Extensive Test Coverage (>92.6% V8 Block Coverage)
- 38 test suites running 56 automated checks validating all 42 runtime modules.
- Added `scripts/test-commands-expansion.mjs` covering CLI dispatchers, rewind time-travel engines, webhook retry logic, PR generation, DAG task scheduling, and mutation/dead-code analysis.
- Ratcheted coverage floors enforced deterministically in CI.

### 2. Time-Travel Rollback & Rewind Engine (`runtime/rewind.mjs`)
- Rollback run states to any previous lifecycle stage or specific task ID.
- Selective evidence preservation or automatic downstream invalidation.
- Monotonic state transitions and cryptographic event chain integrity verification.

### 3. Automated PR & Semantic Release Synthesizer (`runtime/pr-generator.mjs`)
- Generate structured Markdown/JSON pull request descriptions with objective, task status, verification proofs, and security audit findings.
- Automatic Conventional Commits changelog grouping (`feat`, `fix`, `perf`, `refactor`, `chore`).
- Semantic release notes with versioned artifact digests and commit logs.

### 4. Resilient Webhook Notification System (`runtime/webhook.mjs`)
- Configurable event subscriptions with HMAC-SHA256 signature verification.
- Exponential backoff retry loop for transient failures.
- Dead-letter event storage and complete delivery history audit trails.

### 5. Multi-Host Packaging & Synchronization
- Unified GitHub-installable directory structure supporting Claude Code, OpenAI Codex, and Google Antigravity.
- Automated distribution builds with standalone host zip archives in `dist/`.
- 100% synchronized root adapter mirrors with zero manual drift.

## Qualification & Verification

All gates pass deterministically:
```bash
npm run check              # All offline test suites and integrity checks pass
npm run test:ci-coverage   # 100% CI workflow coverage gate verified
npm run build              # Builds Claude, Codex, and Antigravity release packages
npm run verify:dist        # Validates zero-dependency and distribution package integrity
npm run package:release    # Generates final distribution archives
```
