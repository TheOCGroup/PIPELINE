# PIPELINE migrations

Migrations for the **PIPELINE-owned** database only (default `runtime/pipeline.db`).

- Applied in filename order by `src/database/migrationRunner.js`.
- Each is recorded in `pipeline_migrations`; completed migrations are never reapplied.
- Each runs in a transaction and rolls back on failure.
- The runner only ever touches the configured PIPELINE database; the canonical
  guard (`src/database/canonicalDatabaseGuard.js`) rejects the OCG ONE database.

**Phase 3C scope:** only `001_pipeline_application_metadata.sql` (shell metadata).
Production PIPELINE schema (seller opportunities, sources, provenance,
classification, offers, …) is **not** created here — that is Phase 3F, and the
OCG ONE migrations `044–047` and `053` are **not** copied into this app during
Phase 3C.
