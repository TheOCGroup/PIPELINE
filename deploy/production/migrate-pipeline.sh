#!/usr/bin/env bash
set -euo pipefail

echo "=== Running Standalone PIPELINE Database Migrations ==="

COMPOSE_FILE="/srv/ocg/compose/docker-compose.yml"

# The application migration runner is authoritative. It applies every *.sql file
# in filename order and records each applied filename in pipeline_migrations.
docker compose -f "$COMPOSE_FILE" exec -T pipeline node scripts/migrate.js

# Verify production has applied every migration shipped in the running image.
# Do not hard-code a historical migration count; the repository evolves.
docker compose -f "$COMPOSE_FILE" exec -T pipeline node --input-type=module -e "
  import { DatabaseSync } from 'node:sqlite';
  import { readdirSync } from 'node:fs';

  const migrationFiles = readdirSync('/usr/src/app/migrations')
    .filter((name) => name.endsWith('.sql'))
    .sort();
  const db = new DatabaseSync('/data/pipeline.db');
  const applied = db.prepare('SELECT filename FROM pipeline_migrations ORDER BY filename').all().map((row) => row.filename);
  db.close();

  const missing = migrationFiles.filter((name) => !applied.includes(name));
  console.log('Migration files shipped:', migrationFiles.length);
  console.log('Migrations recorded applied:', applied.length);
  if (missing.length) {
    console.error('Migration verification failed. Missing:', missing.join(', '));
    process.exit(1);
  }
  console.log('All shipped PIPELINE migrations are applied.');
"

echo "=== Migrations Completed & Verified ==="
