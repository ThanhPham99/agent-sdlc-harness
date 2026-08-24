# Conditional Design Discovery

Design discovery answers one question before any code is written: **how much design work does this objective actually deserve?**

Two failure modes are equally bad. Brainstorming a README typo wastes the user's time and tokens. Coding straight through a breaking API change or a data migration produces work that has to be thrown away. The harness resolves this deterministically instead of leaving it to the model's mood.

## Not a third public skill

There are exactly two public, host-discoverable skills: `sdlc-router` and `sdlc-orchestrator`. Design discovery is an **internal orchestrator module** at `harness/internal-skills/design-discovery.md`, registered in `config/skills.json` and loaded only when the `DESIGN` stage selects it.

## Three modes

| Mode | What happens | Gate evidence |
|---|---|---|
| `SKIP` | Record why design is unnecessary and move on | `design_skipped_with_reason` |
| `COMPACT` | One bounded design statement: intended change, affected components/contracts, chosen approach, verification obligations | `compact_design_accepted` |
| `FULL` | Unknowns, 2–3 materially distinct approaches with trade-offs, a recommendation, and approval where policy demands it | `full_design_approved_or_policy_auto` |

## Deterministic mode selection

`runtime/design-discovery.mjs` selects the mode from `policies/design-discovery.json`. No model inference, no repository reads — the same input always yields the same mode and the same reason codes.

```
bin/agent-sdlc design mode --profile STANDARD --objective "<objective>" [--signals ID,ID]
```

Precedence, applied in this order:

1. **Profile default** — `FAST -> SKIP`, `STANDARD -> COMPACT`, `STRICT -> FULL`.
2. **Soft escalation** — signals such as `ARCHITECTURE_BOUNDARY`, `MULTIPLE_APPROACHES` or `REQUIREMENT_AMBIGUITY` raise the mode.
3. **De-escalation ceiling** — `DOCS_ONLY`, `TEST_ONLY`, `MECHANICAL_REFACTOR`, `TRIVIAL_LOCAL_FIX`, `DEPENDENCY_BUMP_NO_DECISION`, `RESTORE_CONFIRMED_BEHAVIOR` cap the soft result.
4. **Hard escalation** — `USER_REQUESTED_OPTIONS`, `PUBLIC_CONTRACT_CHANGE`, `SECURITY_POLICY_DESIGN`, `DATA_MIGRATION_STRATEGY` are marked `deescalatable: false`. They override the ceiling. A contract or migration decision cannot be talked down by wrapping it in docs-flavoured language.
5. **Profile bounds** — `STRICT` has a floor of `COMPACT`, so strict work never reaches `SKIP`.

Signals are matched from the objective text *or* declared explicitly by the orchestrator/router via `--signals`. Declared signals are authoritative; inference only adds. Unknown signal IDs are ignored and reported as `UNKNOWN_SIGNAL_IGNORED:<id>` rather than silently dropped.

Selecting `FULL` never grants tool authority: every decision carries `approval_implied: false`.

## Human approval

`human_approval_required` is true when the mode is `FULL` **and** either a signal in `human_approval_required_signals` matched (contract change, security policy design, data migration) or the profile is in `human_approval_required_profiles` (`STRICT`).

When it is true, the orchestrator suspends to `NEEDS_CONFIRMATION`. The agent cannot write its own approval: `design_human_approved` has `human` authority in `policies/stage-policy.json`, so it is only accepted alongside a recorded approval.

## The artifact and the gate

The module emits `agent-sdlc/design-decision/v1` (`protocol/schemas/DesignDecision.schema.json`). `bin/agent-sdlc design record` validates it and, only on success, writes the gate evidence.

`validateDesignDecision` rejects:

- `FULL` mode with no options;
- fewer options than policy minimum without `rejected_alternatives` carrying concrete rejection evidence;
- a `recommended_option` that is not one of the options;
- an option missing summary, benefits or trade-offs;
- `SKIP` with no reason;
- `approval.required: true` with any status other than `APPROVED`;
- `affected_interfaces` or `affected_data` with no `verification_obligations`.

Every accepted mode also derives the canonical `design_or_skip_decision` token, so existing stage policy stays compatible.

## Evidence cannot be asserted

All design gate tokens have `runtime` authority. Passing them to `bin/agent-sdlc transition --evidence` fails with *"must be produced by the deterministic validator"*. The only way through the gate is a validated decision — or `--force`, which is the operator's audited escape hatch, not the agent's.

## Evidence artifacts

`npm run test:gates` produces `evals/DESIGN-DISCOVERY-VALIDATION.json`: the mode decision for every eval case with its reason codes, the decision-contract adversarial results, the gate wiring, and `live_qualification: PENDING_LIVE_QUALIFICATION` — offline validation never claims a live semantic result.
