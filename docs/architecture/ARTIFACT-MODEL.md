# Artifact and Handoff Model

Artifacts are content-addressed under `.agent-sdlc/artifacts`. Requirements, specs, designs, ADRs, plans, test evidence, security reports, release evidence, deployment receipts, production verification and handoffs are source of truth.

A stage handoff should contain: objective, decisions, affected files/symbols, contracts, tests/evidence, risks/unknowns and exactly one next action. This externalizes memory so the next context does not need conversation history.
