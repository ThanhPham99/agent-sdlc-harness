# Remaining Plugin Audit Work — Plan Index

**Spec:** `docs/superpowers/specs/2026-09-07-remaining-plugin-audit-findings.md`

Five plans cover every open item from the 2026-09-06 plugin audit plus the
engine limitations found while landing F1. They are independent: each produces
working, testable software on its own, and none blocks another except where
noted below.

| Plan | Covers | Size | Risk | Status |
|---|---|---|---|---|
| [Gate honesty](2026-09-07-gate-honesty.md) | F2, F3, F10 | 5 tasks | **High** — Task 5 changes an evidence token's authority and breaks every current caller that asserts it | **Complete** — all 5 tasks landed (commits `26e2a46`..`1c65763`) |
| [Surface coverage](2026-09-07-surface-coverage.md) | F4, F6, F7 | 4 tasks | Low — one new gate, wiring, and prose | **Complete** — merged to `master` at `f75e8c5`, 2026-09-07 |
| [MCP authored artifacts](2026-09-07-mcp-authored-artifacts.md) | F5 | 3 tasks | Medium — new public tool surface | **Complete** — all 3 tasks landed (commits `e5c12ab`..`e48a45c`) |
| [Harness hygiene](2026-09-07-harness-hygiene.md) | F8, F9, F11, E4, housekeeping | 5 tasks | Medium — Task 3 changes what every `tool-run` caller sees | **Complete** — all 5 tasks landed (commits `36436ff`..`f233cc1`) |
| [Task engine ergonomics](2026-09-07-task-engine-ergonomics.md) | E1, E2, E3 | 3 tasks | **High** — Task 1 changes task status automatically | **Complete** — all 3 tasks landed (commits `4d6376d`..`8dea631`) |

## Suggested order

**1. Surface coverage.** ✅ **Done** — merged at `f75e8c5`. Lowest risk, and it is
the plan that stops the class of defect from recurring: a command can no longer
ship undocumented, an unclassifiable `docs/` path now fails the gate, and
`typecheck` cannot silently stop running. See that plan's Execution record for
the six places execution departed from what was written.

**2. Harness hygiene, Tasks 1, 2, 4 and 5.** ← **next** Small, independent, and Task 5
clears the two housekeeping items off the board. Leave Task 3 (tool-output
summaries) for later — it is the one with reach.

**3. Task engine ergonomics.** E1 and E2 are the two limitations that cost real
time during F1's delivery. Task 1's `hasBoundWork` guard is the safety argument
for the whole plan; review it carefully.

**4. Gate honesty.** Largest and most invasive, and the one whose value is
highest: it is the difference between gates that check content and gates that
check shape. Do it when there is room to run the full suite repeatedly.

**5. MCP authored artifacts.** Genuinely optional until an MCP-only host needs
it. Note the interaction: if gate honesty's Task 1 has landed, a FULL-mode
scaffold no longer records, which that plan's Task 1 Step 6 accounts for.

**6. Harness hygiene, Task 3.** Last, because it changes the summary every
caller of `tool-run` reads, and it is easier to judge that change when nothing
else is moving.

## Cross-plan interactions

- **Gate honesty Task 1 ↔ MCP Task 1.** The placeholder guard makes a FULL-mode
  scaffold invalid. The MCP design tool's test picks a STANDARD-profile fixture
  so it passes either way.
- **Gate honesty Task 5 ↔ everything that asserts the security token.** Two
  callers are known and handled. Run
  `grep -rn "no_new_high_security_findings" --include=*.mjs .` before starting
  and handle anything the grep finds that the plan does not name.
- **Surface coverage Task 3 changed the suite count** from 46 to 47 (done). The
  other four plans still say "46/46" in their verification steps; read that as
  "all suites", and expect 47 until another plan adds one.
- **Surface coverage's gate now classifies every `docs/` path** as reference or
  non-reference and fails on anything it cannot classify. A later plan that adds
  a directory under `docs/` must classify it in
  `scripts/validate-cli-surface.mjs` or the gate will refuse it — that refusal is
  the intended behaviour, not a breakage.

## What is deliberately not planned

- `security.sca`. Gate honesty implements `security.sast` with the linter that
  already ships; there is no dependency scanner to wire, and marking `sca`
  builtin without one would be the same defect in a new place.
- `task start` / `advance` over MCP. They dispatch work and bind evidence to a
  workspace; that is a larger design question than the gate parity F5 asks for.
- Re-scoping a task that already holds bound work. `materializeTaskGraph`
  already refuses this and reports `DEFINITION_CHANGED_BUT_WORK_ALREADY_BOUND`
  in `conflicts`. That behaviour is correct.
