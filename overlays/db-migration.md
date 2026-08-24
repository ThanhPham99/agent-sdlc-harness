# DB / Data Migration Overlay v1.3

Apply to schema migration, data migration/backfill, destructive data change, or compatibility-sensitive persistence evolution.

Mandatory evidence:
- schema/data compatibility impact;
- migration ordering and mixed-version compatibility window;
- rollback/backout or forward-fix strategy;
- data validation/reconciliation;
- migration verification plus application regression.

## Profile rule
- `STANDARD` only when explicitly proven additive, backward-compatible, online-safe, and free of material lock/backfill risk.
- `STRICT` when destructive/difficult to reverse, backfill/transform is material, lock risk is material, compatibility breaks, or operational risk is unknown.
- G3 `HUMAN` for destructive/difficult-to-reverse decisions unless a project policy explicitly delegates them.
