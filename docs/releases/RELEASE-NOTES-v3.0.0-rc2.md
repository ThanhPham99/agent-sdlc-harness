# Release Notes — 3.0.0-rc2

Theme: **Release Candidate 2 — AI-Native SDLC Playbook Enhancements, Statistical Quality Controls & Extended Model Routing**.

Agent SDLC Harness 3.0.0-rc2 introduces key enhancements from the AI-Native SDLC Playbook including intent intake proto-specs, design policy escalation, test-file protections, tri-pass reviews with nit capping, statistical control bands, coexistence sync models, and expanded multi-provider model routing.

## Highlights

### 1. Proto-Spec & Intent Intake Pipeline
- Added `templates/intent.md` proto-spec template and automated directory scaffolding under `.agent-sdlc/intent/`.
- Multi-format document normalization recognizing `# Intent:` headers with automated `is_intent` metadata flagging.

### 2. Policy Escalation & Safety Gates
- Added `flagged_policy_concerns` in design discovery artifacts with automatic escalation to human confirmation on blocking policy concerns.
- Test-file protection guard in PreToolUse hooks preventing deletion/modification of test suites during bugfix and hotfix workflows.
- Plan-scope drift detection preventing tasks from writing outside approved boundaries without re-planning.

### 3. Tri-Pass Code Review Protocol
- Added `templates/REVIEW.md` formalizing Pass 1 (Bugs & Defects), Pass 2 (Security & Threat Boundary), and Pass 3 (Compliance & Coding Standards).
- Deterministic nit capping limiting reported nits to 5 while tracking remainder in `nit_count_omitted`.

### 4. Statistical Process Control Bands
- Added `templates/bands.yaml`, `policies/control-bands.json`, and `runtime/control-bands.mjs`.
- Anomaly classification across 1-sigma (normal variation), 2-sigma (diagnose), and 3-sigma (breach) with automatic anomaly proto-spec generation.

### 5. Coexistence Architecture
- Flexible repository governance modes (`local_primary`, `external_primary`, `bi_directional_sync`) documented in `docs/architecture/ARTIFACT-MODEL.md`.
- External issue/tracker metadata binding in feature protocols.

### 6. Updated Model Routing & Tier Registry
- Added support for latest Claude, Codex, and Antigravity model families in `policies/model-routing.json`.

## Qualification & Verification

All gates pass deterministically:
```bash
npm run check              # All offline test suites and integrity checks pass
npm run test:ci-coverage   # 100% CI workflow coverage gate verified
npm run build              # Builds Claude, Codex, and Antigravity release packages
npm run verify:dist        # Validates zero-dependency and distribution package integrity
npm run package:release    # Generates final distribution archives
```
