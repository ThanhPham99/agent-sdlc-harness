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
npm run build                 # Build provider distributions
npm run verify:dist           # Verify packaged distributions
```

### Coding Standards & Invariants
- **Deterministic state:** State transitions and routing decisions must be deterministic and explainable via reason codes.
- **Token efficiency:** Keep context payloads bounded; use on-demand lazy loading for internal skill instructions.
- **Provider neutrality:** Core runtime logic must remain agnostic to host providers.
- **Root surface sync:** All files in root matching `adapters/` must be synchronized byte-for-byte.

## Pull Request Guidelines
1. Ensure all integrity gates pass locally (`npm run check`).
2. Provide concise commit messages describing what and why.
3. Keep changes minimal, scoped, and well-covered by tests.
