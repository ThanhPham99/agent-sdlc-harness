# Workflow Maintenance

Use this internal module only for plugin/project lifecycle work: install validation, project bootstrap compatibility, workflow upgrade, schema migration, rollback compatibility, or uninstall validation.

## Required order
1. Read `workflow-meta.yaml` when present and every active feature `state.yaml` that may be migrated.
2. Load `../rules/plugin-lifecycle-policy.yaml`.
3. Never mutate project state just because the plugin version changed. Run compatibility check first.
4. For migration, dry-run first; if writes are needed, create a byte-for-byte backup before changing recognized workflow state/meta files.
5. Preserve feature lifecycle state, current gate, resume point, artifacts, invalidations, questions, exceptions, recovery, coordination, delivery, production, knowledge, and unknown extension fields.
6. Refuse a state schema newer than this plugin understands. Do not guess a downgrade.
7. Validate the migrated project before host package replacement is considered successful.
8. Installation/uninstallation must not delete `.ai-workflow` project history. Project-state deletion requires a separate explicit user request.
9. Record durable migration outcomes in `migration-journal.md`; do not record transient model reasoning.

## Tooling
When available, use `scripts/migrate_project.py` and `scripts/validate_installation.py` for deterministic lifecycle checks instead of reproducing migration logic in prompts.
