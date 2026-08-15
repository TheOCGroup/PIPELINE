# OCG PIPELINE

Standalone seller-opportunity pipeline application. Part of the OCG ecosystem—
**independent of OCG ONE**, with its own runtime, database, migrations, auth,
release lifecycle, and PIPER acquisition-intelligence layer.

PIPELINE owns seller opportunities, source lineage, provenance recovery,
classification, underwriting records, offers, outcomes, audit history, and
approved-source property discovery. PIPER can ingest or discover properties,
normalize and deduplicate addresses, score findings, create explainable
recommendations, and answer questions grounded in the active opportunity.

## Requirements
- Node.js >= 22.5 (uses the built-in `node:sqlite`)
- Install locked dependencies with `npm ci` or `pnpm install --frozen-lockfile`

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

## Key endpoints
- `GET /` — PIPELINE workspace
- `GET /health` — `{status, service:"pipeline", version, database, integration}`
- `GET /version` — application + schema identity
- `GET /api/v1/opportunities` — filtered and paginated opportunity records
- `GET /api/v1/piper/status` — grounded PIPER discovery status
- `GET /api/v1/piper/recommendations` — prioritized explainable actions
- `POST /api/v1/piper/chat` — contextual PIPER conversation
- `POST /api/v1/piper/run` — manual approved-source discovery run
- `POST /api/integrations/piper/intake` — secured property intake
- `POST /auth/handoff` — signed OCG ONE user handoff

PIPER discovery is disabled by default. Configure only sources you are
authorized to access; supported formats are JSON, JSON-LD, and RSS. Robots rules
are honored by default. See `.env.example` for the intake and discovery flags.

## Isolation guarantees
- Own database at `runtime/pipeline.db` (override with `PIPELINE_DB_PATH`).
- `src/database/canonicalDatabaseGuard.js` rejects the OCG ONE canonical
  database, its directory, protected basenames, and same-file paths **before**
  opening anything.
- No import from `../ocg-one`; no workspace dependency on OCG ONE.

## Documentation
- `docs/architecture-boundary.md` — ownership boundary and rules.
- `docs/integration-contract-draft.md` — planned OCG ONE ⇄ PIPELINE API contract.
