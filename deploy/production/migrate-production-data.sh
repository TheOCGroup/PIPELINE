#!/usr/bin/env bash
set -euo pipefail

echo "=== Starting OCG ONE to PIPELINE Production Data Migration ==="

# 1. Snapshot local OCG ONE DB securely via VACUUM INTO
echo "Creating OCG ONE database snapshot..."
docker compose -f /srv/ocg/compose/docker-compose.yml exec -T ocg-one node -e "
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync('/srv/ocg/ocg-one/data/ocg_one.db');
  db.exec('VACUUM INTO \"/srv/ocg/ocg-one/data/ocg_one_snapshot.db\"');
  console.log('Snapshot generated successfully.');
"

# 2. Run Export from OCG ONE snapshot
echo "Running data exporter against snapshot..."
# Use node inside container to execute export tool
docker compose -f /srv/ocg/compose/docker-compose.yml exec -T ocg-one node src/bin/pipeline-export.js --db "/srv/ocg/ocg-one/data/ocg_one_snapshot.db" --out "/srv/ocg/ocg-one/data/pipeline_export.json"

# Move export file to pipeline container volume path
sudo mv /srv/ocg/ocg-one/data/pipeline_export.json /srv/ocg/pipeline/data/pipeline_export.json
sudo chown 1000:1000 /srv/ocg/pipeline/data/pipeline_export.json

# 3. Preview Import in PIPELINE Standalone
echo "Previewing data import in PIPELINE Standalone..."
docker compose -f /srv/ocg/compose/docker-compose.yml exec -T pipeline node src/bin/pipeline-import.js --file "/data/pipeline_export.json" --preview

# 4. Apply Import
echo "Applying data import transactionally..."
docker compose -f /srv/ocg/compose/docker-compose.yml exec -T pipeline node src/bin/pipeline-import.js --file "/data/pipeline_export.json" --apply

# 5. Parity & Validation Verify
echo "Running post-migration parity check..."
docker compose -f /srv/ocg/compose/docker-compose.yml exec -T pipeline node src/bin/pipeline-import.js --file "/data/pipeline_export.json" --verify

# Clean up snapshot and JSON files
docker compose -f /srv/ocg/compose/docker-compose.yml exec -T ocg-one rm -f /srv/ocg/ocg-one/data/ocg_one_snapshot.db
docker compose -f /srv/ocg/compose/docker-compose.yml exec -T pipeline rm -f /data/pipeline_export.json

echo "=== Production Data Migration & Parity Verified Successfully ==="
