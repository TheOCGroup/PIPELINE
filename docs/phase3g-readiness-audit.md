# Phase 3G read-only migration readiness audit

Run `python3 scripts/phase3g_readiness.py --source /path/to/ocg_one.db --target /path/to/pipeline.db` on a machine with read-only access to both databases. No records are copied, mutated, or printed. Output contains aggregate counts only. Exit 0 means no automatic blocker was detected; exit 2 means **cutover blocked**. Exit 0 is not approval to migrate.

Verified against the existing GCP VM on 2026-11-12: both SQLite databases pass integrity check, but source has 616 opportunities and only 13 linked source records; destination has zero opportunities. The audit intentionally reports `ready_for_cutover: false` and requires authoritative lineage verification and approved cutover. The source's creator counts are 583 `user-genaro`, 31 `user-test`, and 2 `legacy_migration`; these are not proof of genuine records. Do not infer that all 616 should migrate. OCG ONE remains authoritative for properties, people, and canonical tasks.

The script is an inventory and gate, **not a migration implementation**. Before migration, identify genuine vs seeded/legacy records, map source IDs and provenance, reconcile audit history and offers, test deterministic idempotent import on an isolated database, compare counts and hashes, verify rollback, then approve production cutover.
