# Repository Intelligence

Before alpha6, "find the relevant code" meant a model deciding what to grep for. That is the single largest source of both wasted context and missed impact. Alpha6 replaces the guess with a deterministic index.

The goal is explicitly **not** an always-running indexing platform. It is local-first, incremental and deterministic.

## Capability tiers

```
LSP_OR_COMPILER  >  LANGUAGE_PARSER  >  DETERMINISTIC_SYNTAX  >  LLM_INFERENCE
```

This harness implements `DETERMINISTIC_SYNTAX` and reports exactly that. `detectCapability` also reports the *signals* that a higher tier could be built on (a `tsconfig.json`, a `go.mod`) while stating `lsp_available: false` and `language_parser_available: false`. Every query result carries the tier that produced it, so a weak answer is visibly weak.

`findReferences` distinguishes `STRUCTURAL` confidence (resolved importers) from `TEXTUAL` (name matches only). Test links are ranked `STRONG` (imports the defining file), `MEDIUM` (file name matches) or `WEAK` (references the symbol).

## The index

`runtime/repo-index.mjs` walks git-tracked files, so `.gitignore` is honoured for free, and caches per-file extraction by content hash in `.agent-sdlc/index/repo-index.json`. Re-indexing a clean tree re-parses nothing (`counts.parsed: 0`, `counts.reused: n`). The index is revision-bound and `indexStale()` reports `REVISION_CHANGED` rather than silently answering from old data.

Per file it extracts: language, module boundary, symbols, exports, import specifiers, HTTP routes, data entities (SQL DDL plus common ORM table declarations), event/message contract names, and — for tests — the symbols they reference.

## The graph

`runtime/symbol-graph.mjs` resolves import specifiers structurally: relative specifiers by path, bare specifiers by module or basename. Everything else is reported, not guessed — `external_dependencies` for genuine packages, `unresolved_imports` for the rest. From that it derives dependents, dependencies, symbol locations, transitive dependent closures, test-to-symbol and test-to-file mappings, and module boundaries with their public surface.

## The query surface

`runtime/repo-intelligence.mjs`:

`findSymbol`, `findReferences`, `findTestsForSymbol`, `findTestsForFiles`, `findModuleBoundary`, `findDependents`, `findPublicInterfaces`, `findDataEntities`, `findEventContracts`, `findRecentChanges`, `getMinimalChangeSurface`.

### The minimal change surface

`getMinimalChangeSurface(intel, objective)` scores symbols by identifier-word overlap with the objective, then collects defining files, path-name matches, the dependent closure, covering tests, public interfaces, data entities and modules — bounded by explicit caps.

When nothing matches it returns no files and `empty_reason: NO_DETERMINISTIC_MATCH_BROADER_SEARCH_REQUIRED`. Saying "I could not narrow this" is useful; returning the repository is not.

## Context integration

`runtime/task-context.mjs` `scopeIntelligence()` is anchored to the task's **declared scope**, not to free-text mining. It expands declared path prefixes to indexed files, then reports the symbols, covering tests, public interfaces, data entities and — most usefully — the **dependents of the write scope**: whoever breaks if this task changes what it says it will change.

The rendered task prompt carries this as a `REPOSITORY FACTS (deterministic, in scope)` block. A failure here degrades the context and records `unavailable` with a reason; it never breaks the task.

## Evidence

`npm run test:alpha6` produces `evals/REPO-INTELLIGENCE-VALIDATION.json`. The suite asserts incrementality, staleness detection, structural dependency mapping, transitive dependents, strong test links, module surfaces, route/entity/event extraction, surface boundedness, honest empty results, and that an unrelated module never reaches a task context through intelligence.
