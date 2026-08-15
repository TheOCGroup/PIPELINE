#!/usr/bin/env bash
set -euo pipefail

echo "=== Deploying Services with Docker Compose ==="

# 1. Sync configuration files
if [ ! -f /etc/ocg/pipeline.env ] || [ ! -f /etc/ocg/ocg-one.env ]; then
    echo "ERROR: Environment files must exist at /etc/ocg/ before deploying."
    exit 1
fi

# 2. Build and start containers
cd /srv/ocg/compose
docker compose down --remove-orphans || true
docker compose build --no-cache
docker compose up -d --wait

# 3. Output statuses
docker compose ps
echo "=== Deployment Completed ==="
