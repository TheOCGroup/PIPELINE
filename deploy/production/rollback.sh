#!/usr/bin/env bash
set -euo pipefail

ENV_FILE="/etc/ocg/ocg-one.env"
PIPELINE_ENV="/etc/ocg/pipeline.env"

echo "=== Executing Safe Rollback Sequence ==="

# 1. Disable conversion intake
echo "Disabling conversion intake..."
sudo sed -i 's/PIPELINE_CONVERSION_ENABLED=true/PIPELINE_CONVERSION_ENABLED=false/g' "${ENV_FILE}"

# 2. Put PIPELINE into read-only
echo "Placing PIPELINE into read-only mode..."
sudo sed -i 's/PIPELINE_READ_ONLY=false/PIPELINE_READ_ONLY=true/g' "${PIPELINE_ENV}"

# Restart apps to freeze state
docker compose -f /srv/ocg/compose/docker-compose.yml restart ocg-one pipeline --wait

echo "--------------------------------------------------------"
echo "WARNING: Databases are now frozen for data reconciliation."
echo "Please perform manual or automated reconciliation of any"
echo "opportunities created or modified in PIPELINE standalone"
echo "back into the legacy OCG ONE schema tables before resuming"
echo "embedded writes."
echo "--------------------------------------------------------"
read -p "Type 'YES' to confirm data reconciliation is complete and resume legacy writes: " confirm
if [ "${confirm}" != "YES" ]; then
    echo "Reconciliation aborted. Standalone writes remain frozen."
    exit 1
fi

# 3. Restore legacy write authority flags
echo "Restoring legacy write flags..."
sudo sed -i 's/PIPELINE_STANDALONE_ENABLED=true/PIPELINE_STANDALONE_ENABLED=false/g' "${ENV_FILE}"
sudo sed -i 's/PIPELINE_EMBEDDED_WRITES_ENABLED=false/PIPELINE_EMBEDDED_WRITES_ENABLED=true/g' "${ENV_FILE}"

docker compose -f /srv/ocg/compose/docker-compose.yml restart ocg-one --wait

echo "=== Rollback to Legacy Embedded Writes Successful ==="
