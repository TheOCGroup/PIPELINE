#!/usr/bin/env bash
set -euo pipefail

echo "=== Running Standalone PIPELINE Database Migrations ==="

# Execute migration command inside docker container
docker compose -f /srv/ocg/compose/docker-compose.yml exec -T pipeline node scripts/migrate.js

# Confirm migration applied status
docker compose -f /srv/ocg/compose/docker-compose.yml exec -T pipeline node -e "
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync('/data/pipeline.db');
  const count = db.prepare('SELECT count(1) as c FROM pipeline_migrations').get().c;
  console.log('Successfully applied migrations count:', count);
  if (count < 8) {
    console.error('Migration verification failed! Schema version is lower than expected.');
    process.exit(1);
  }
"
echo "=== Migrations Completed & Verified ==="
