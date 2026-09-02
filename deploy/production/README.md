# OCG PIPELINE Standalone Production Deployment Package

This package deploys the existing standalone PIPELINE application to an Ubuntu 24.04 LTS host using Docker Compose and Caddy. It is a deployment path for the canonical PIPELINE repository; it does not create a second application or database.

## Production layout

```text
/srv/ocg/
├── compose/          # docker-compose.yml, Caddyfile, Dockerfiles, deployment scripts
├── apps/
│   └── pipeline/     # canonical PIPELINE application source
├── pipeline/
│   ├── data/         # persistent SQLite storage
│   └── logs/         # runtime logs
└── backups/
    └── pipeline/     # secured database snapshots
```

## Key files

- `docker-compose.yml` — container and network definition.
- `Caddyfile` — TLS/reverse proxy and security headers.
- `pipeline.Dockerfile` — production image running as the non-root `node` user.
- `pipeline.env.example` — required PIPELINE runtime and integration settings.
- `bootstrap-server.sh` — host hardening and Docker bootstrap.
- `deploy.sh` / `deploy.ps1` — deployment orchestration.
- `generate-secrets.sh` — cryptographic secret generation.
- `migrate-pipeline.sh` — runs the repository's canonical migration runner and verifies **every `.sql` migration shipped in the running image** is recorded in `pipeline_migrations`.
- `migrate-production-data.sh` — controlled import/parity sequence for legacy production data where required.
- `verify-production.sh` — health/TLS smoke checks.
- `backup.sh` / `restore.sh` — SQLite recovery procedures.
- `cutover.sh` / `rollback.sh` — controlled transition and rollback utilities.

## Deployment sequence

1. Prepare the existing host/package with `deploy.ps1` or the equivalent established deployment process.
2. Run `bootstrap-server.sh` on a new host only when host hardening has not already been completed.
3. Configure secrets and environment variables. Reuse the existing production values; do not generate replacements during a normal application update.
4. Run `deploy.sh` to build/start the canonical PIPELINE container.
5. Run `migrate-pipeline.sh`. The script must report that all migrations present under `/usr/src/app/migrations` are applied. It intentionally does **not** use a hard-coded migration count.
6. If legacy data migration is actually required, run `migrate-production-data.sh` and confirm its parity checks. Do not rerun a historical migration blindly on an established production database.
7. Run `verify-production.sh` and confirm the health endpoint and TLS/security headers.
8. Run `cutover.sh` only for a genuine cutover event. Normal application releases should not repeatedly perform cutover operations.

## Release rule

Do not call PIPELINE production-ready because a container starts. A release is verified only when the running revision uses the intended source, all shipped migrations are applied, the persistent SQLite path is intact, health checks pass, and the authorized Piper intake boundary behaves correctly.
