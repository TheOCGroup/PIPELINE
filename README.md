# OCG PIPELINE

Standalone seller-opportunity pipeline application. Part of the OCG ecosystem —
**independent of OCG ONE**, with its own runtime, database, migrations, auth, and
release lifecycle.

> **Phase 3C — application shell.** This repository currently contains only the
> standalone application shell. Operational PIPELINE modules (seller
> opportunities, sources, provenance recovery, classification, offers) have
> **not** been migrated from OCG ONE and remain authoritative there during the
> transition. No production data lives here.

## Requirements
- Node.js >= 22.5 (uses the built-in `node:sqlite`). No third-party dependencies.

## Run
```bash
node server.js          # or: pnpm start
```
Defaults: `http://127.0.0.1:8090`. Configure via environment (see `.env.example`).

## Test
```bash
node --test tests/      # or: pnpm test
```
All tests use disposable temporary databases and never open the OCG ONE
canonical database.

## Endpoints (shell)
- `GET /` — standalone status page
- `GET /health` — `{status, service:"pipeline", version, database, integration}`
- `GET /version` — application + schema identity
- `POST /auth/handoff` — handoff verification **stub**; disabled unless
  integration is explicitly enabled and a handoff secret is configured (fails
  closed otherwise)

## Isolation guarantees
- Own database at `runtime/pipeline.db` (override with `PIPELINE_DB_PATH`).
- `src/database/canonicalDatabaseGuard.js` rejects the OCG ONE canonical
  database, its directory, protected basenames, and same-file paths **before**
  opening anything.
- No import from `../ocg-one`; no workspace dependency on OCG ONE.

## Documentation
- `docs/architecture-boundary.md` — ownership boundary and rules.
- `docs/integration-contract-draft.md` — planned OCG ONE ⇄ PIPELINE API contract.
