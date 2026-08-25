# Contributing to Agent SDLC Harness

Thank you for contributing to the Agent SDLC Harness project.

## Development Workflow

### Prerequisites
- Node.js >= 18.0.0
- Git

### Getting Started
```bash
git clone https://github.com/ThanhPham99/agent-sdlc-harness.git
cd agent-sdlc-harness
npm install # if dependencies exist
```

### Running Tests & Quality Gates
Before submitting a PR, make sure all test suites and integrity gates pass:

```bash
# Run all offline verification gates and tests
npm run check

# Or run specific test suites
npm test                      # Deterministic regression suite
npm run test:integrity        # Version consistency, registry, root-sync, guard validation
npm run test:activation       # Auto-activation tests for Claude, Codex, Antigravity
npm run test:coverage         # Runtime coverage floor (V8 block coverage, no dependencies)
npm run build                 # Build provider distributions
npm run verify:dist           # Verify packaged distributions
```

CI runs everything reachable from `npm run check`; `scripts/validate-ci-coverage.mjs`
fails if a suite in that chain is missing from `.github/workflows/ci.yml`, so add
new suites to both.

Coverage is measured with `NODE_V8_COVERAGE` over the deterministic suite and
ratcheted in `evals/COVERAGE-FLOOR.json`. A drop fails CI; when coverage
improves, raise the floor with `npm run coverage:update` in the same commit.

### Editing against a live host
The host loads the plugin from its own cache directory, not from your checkout,
so edits here do not reach a running session until the cache is pointed at this
tree:

```bash
npm run dev:status   # what the host currently loads, and how far it has drifted
npm run dev:link     # link the host's cache entry to this working tree
npm run dev:unlink   # restore the cached copy
```

`dev:link` renames the cached directory aside rather than deleting it, and
`dev:unlink` puts it back. Restart the host (or reload plugins) after either.

### Coding Standards & Invariants
- **Deterministic state:** State transitions and routing decisions must be deterministic and explainable via reason codes.
- **Token efficiency:** Keep context payloads bounded; use on-demand lazy loading for internal skill instructions.
- **Provider neutrality:** Core runtime logic must remain agnostic to host providers.
- **Root surface sync:** All files in root matching `adapters/` must be synchronized byte-for-byte.

## Pull Request Guidelines
1. Ensure all integrity gates pass locally (`npm run check`).
2. Provide concise commit messages describing what and why.
3. Keep changes minimal, scoped, and well-covered by tests.
