# Failure Recovery

Classify before retry. 429: honor retry-after/jitter then fallback. 5xx: bounded retry then circuit breaker. Timeout: resume if supported, otherwise restart from artifact checkpoint. Context overflow: compact artifacts before switching providers. Schema violation: one constrained repair. Deterministic tool failure with identical args: no blind retry. Test failure: re-enter implementation/debug. Permission denial: approval or safe alternative.

## "Stale evidence (workspace changed since it was recorded)"

Gate evidence is bound to the workspace state at the moment the tool ran. Any
change to the tree afterwards — including restoring a file — invalidates it.

This bites most often with the tracked reports under `evals/`. Every suite
rewrites its own report, so `agent-sdlc tool-run --tool test.run_targeted`
leaves the tree dirty; restoring those reports before transitioning is what
makes the evidence stale.

The order that works:

1. Restore any tracked reports a previous run dirtied (`npm run check` does this
   in its `hygiene` stage; `git checkout -- evals/` does it directly).
2. Run the tool that produces the evidence.
3. Transition immediately, without touching the tree in between.

Restoring the reports afterwards is fine — the transition has already happened.

