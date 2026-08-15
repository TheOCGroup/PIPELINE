#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 2 ]; then
    echo "Usage: $0 <ocg_one_backup_path> <pipeline_backup_path_or_none>"
    exit 1
fi

OCG_BACKUP=$1
PIPELINE_BACKUP=$2

echo "=== Restoring Production Databases ==="

# Stop containers
docker compose -f /srv/ocg/compose/docker-compose.yml down

# Restore OCG ONE
if [ -f "${OCG_BACKUP}" ]; then
    echo "Restoring OCG ONE database..."
    sudo cp "${OCG_BACKUP}" /srv/ocg/ocg-one/data/ocg_one.db
    sudo chown 1000:1000 /srv/ocg/ocg-one/data/ocg_one.db
    sudo chmod 600 /srv/ocg/ocg-one/data/ocg_one.db
else
    echo "ERROR: Backup file ${OCG_BACKUP} not found."
    exit 1
fi

# Restore PIPELINE
if [ "${PIPELINE_BACKUP}" != "none" ]; then
    if [ -f "${PIPELINE_BACKUP}" ]; then
        echo "Restoring PIPELINE database..."
        sudo cp "${PIPELINE_BACKUP}" /srv/ocg/pipeline/data/pipeline.db
        sudo chown 1000:1000 /srv/ocg/pipeline/data/pipeline.db
        sudo chmod 600 /srv/ocg/pipeline/data/pipeline.db
    else
        echo "ERROR: Backup file ${PIPELINE_BACKUP} not found."
        exit 1
    fi
fi

# Restart containers
docker compose -f /srv/ocg/compose/docker-compose.yml up -d --wait

echo "=== Restore Completed ==="
