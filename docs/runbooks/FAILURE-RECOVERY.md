# Failure Recovery

Classify before retry. 429: honor retry-after/jitter then fallback. 5xx: bounded retry then circuit breaker. Timeout: resume if supported, otherwise restart from artifact checkpoint. Context overflow: compact artifacts before switching providers. Schema violation: one constrained repair. Deterministic tool failure with identical args: no blind retry. Test failure: re-enter implementation/debug. Permission denial: approval or safe alternative.
