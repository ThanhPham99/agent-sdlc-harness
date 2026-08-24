# Release / Production Impact Overlay

Apply when operational coordination, environment promotion, configuration, migration ordering, feature flags, rollout strategy, rollback/roll-forward, or post-deployment verification matters.

Require release/deployment notes proportional to risk: exact release revision, prerequisites, release-train ordering, rollout strategy/stages, relevant health/business signals, feature-flag state, migration phase, recovery path, and production verification.

If completion ends at `PR_READY`, `MERGED`, or `RELEASE_READY`, do not load production execution context unnecessarily. Load the production lifecycle only when deployment/production evidence is actually in scope.
