# Workflow Module: repository-intelligence

> Internal orchestrator module. This is not a public Agent Skill and must not be independently discovered or invoked by the host. Load it only when the canonical workflow state selects this module. Return control to `sdlc-orchestrator`; never mark the global workflow COMPLETE yourself.

# Repository Intelligence

Ask the index before you scan the repository. A broad `repo.search` is the fallback, not the opening move.

```
bin/agent-sdlc repo index                      # build or refresh (incremental)
bin/agent-sdlc repo status                     # indexed? stale? which capability tier?
bin/agent-sdlc repo surface --objective "..."   # the minimal change surface
bin/agent-sdlc repo symbol     --name PaymentService
bin/agent-sdlc repo references --name RefundRepository
bin/agent-sdlc repo dependents --path src/payments/refund-repository.js
bin/agent-sdlc repo tests      --name PaymentService | --paths a.js,b.js
bin/agent-sdlc repo module     --path src/payments/payment-service.js
bin/agent-sdlc repo interfaces --paths src/api/
bin/agent-sdlc repo entities   --paths migrations/
bin/agent-sdlc repo events     --paths src/payments/
bin/agent-sdlc repo recent     --since 30
```

## Read the capability tier

Every answer reports the tier that produced it:

```
LSP_OR_COMPILER  >  LANGUAGE_PARSER  >  DETERMINISTIC_SYNTAX  >  LLM_INFERENCE
```

This harness implements `DETERMINISTIC_SYNTAX` and says so. Treat its answers as **strong evidence about structure** (imports, exports, routes, table names, test-to-file links) and as **candidates about semantics**. `findReferences` marks its confidence `STRUCTURAL` when importers were resolved and `TEXTUAL` when only names matched — do not present a textual hit as a proven reference.

## Use the change surface to scope, not to decide

`repo surface --objective "..."` returns a bounded set: matched symbols with the words that matched, defining files, the dependent closure, covering tests, public interfaces, data entities and modules.

When nothing matches it returns `empty_reason: NO_DETERMINISTIC_MATCH_BROADER_SEARCH_REQUIRED` and no files. That is the signal to search more broadly — not a reason to read the whole tree.

## In planning

Use the surface to fill a task's `read_scope`, `write_scope`, `likely_symbols`, `modules` and `verification.targeted_tests` with exact values rather than directory guesses. Use `repo dependents` on each intended write path: whoever depends on it is who breaks, and that belongs in the plan's verification obligations.

## In implementation

A task's context already carries deterministic facts for its declared scope, including the dependents of its write scope. Read those first. Widen only when the facts are insufficient, and say what you were looking for.

## Honesty rules

- The index is revision-bound. If `repo status` reports `stale`, refresh it before relying on it; a stale answer is worse than no answer.
- Never claim a higher capability tier than the one reported.
- Extraction is deterministic, not exhaustive. A symbol the extractor missed is a gap to report, not a symbol that does not exist.
