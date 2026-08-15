# OCG ONE & PIPELINE Standalone Production Deployment Package

This package contains the Docker Compose configurations, Caddyfile routing parameters, environment variables templates, hardening guides, backup scripts, and cutover transition procedures to deploy standalone PIPELINE and the OCG ONE integration to an Ubuntu 24.04 LTS production server.

## Directory Layout (on VPS)

```text
/srv/ocg/
├── compose/          # docker-compose.yml, Caddyfile, Dockerfiles, and shell scripts
├── apps/
│   ├── pipeline/     # PIPELINE application source
│   └── ocg-one/      # OCG ONE application source
├── pipeline/
│   ├── data/         # SQLite persistent database storage path
│   └── logs/         # Server logs directory
├── ocg-one/
│   ├── app/          # OCG ONE Hub application source (apps/ocg-one)
│   ├── data/         # SQLite database path (ocg_one.db)
│   └── logs/         # Server logs directory
└── backups/          # Secured pre-import and post-import DB copies
    ├── pipeline/
    └── ocg-one/
```

## Files in this Package

* `docker-compose.yml`: Multi-container bridge setup isolating application runtimes and mounting caddy, pipeline, and ocg-one.
* `Caddyfile`: Reverse proxy and TLS manager directing HTTP traffic, enforcing HTTPS redirect, and providing strict security headers.
* `pipeline.Dockerfile` & `ocg-one.Dockerfile`: Multi-stage Docker builds setting production dependencies, copying source files, and running Node services under non-root (`node`) users.
* `pipeline.env.example` & `ocg-one.env.example`: Environment variables templates containing integration, Handshake, and S2S settings.
* `bootstrap-server.sh`: Initial Ubuntu 24.04 hardening script setting UFW firewall rules, installing fail2ban, Docker engine, and configuring permission ownership.
* `deploy.sh`: Docker compose compilation and execution wrapper.
* `deploy.ps1`: Local PowerShell orchestration utility to tarball clean app sources and SCP files to the VPS via SSH.
* `generate-secrets.sh`: Secure random secret generator and RS256 keypair generator producing base64-encoded strings and JWK mappings.
* `migrate-pipeline.sh`: Database schema migrator applying all migrations, including PIPER discovery schema `009`.
* `migrate-production-data.sh`: Controlled exporter/importer script executing clean VACUUM OCG ONE snapshots, exporting Pipeline-owned data objects, performing parity verification, and importing records transactionally.
* `verify-production.sh`: Local curl smoke check for `/health` and SSL certificate headers.
* `backup.sh` & `restore.sh`: SQLite snapshot copy procedures for disaster recovery.
* `cutover.sh`: Feature-flag sequential cutover utility.
* `rollback.sh`: Read-only lock, data exporter/reconciler, and rollback utility.

## Deployment Step-by-Step Instructions

1. **Local Package Prep**: Run `deploy.ps1` from local machine providing target VPS IP and SSH credentials:
   ```powershell
   .\deploy.ps1 -VpsIp "1.2.3.4" -SshUser "ubuntu"
   ```
2. **Server Hardening**: SSH into the server and run the bootstrap script:
   ```bash
   cd /srv/ocg/compose
   chmod +x *.sh
   ./bootstrap-server.sh
   ```
3. **Secrets Configuration**: Generate cryptographic configurations:
   ```bash
   ./generate-secrets.sh
   ```
4. **App Deployment**: Start Caddy and the application containers:
   ```bash
   ./deploy.sh
   ```
5. **PIPELINE Migrations**: Run and verify all PIPELINE migrations:
   ```bash
   ./migrate-pipeline.sh
   ```
6. **Data Migration**: Run export, preview, import, and parity check sequence:
   ```bash
   ./migrate-production-data.sh
   ```
7. **Production Smoke Check**: Confirm health endpoints and certificates:
   ```bash
   ./verify-production.sh
   ```
8. **Cutover**: Trigger the transition sequence to disable embedded writes and enable S2S conversion:
   ```bash
   ./cutover.sh
   ```
