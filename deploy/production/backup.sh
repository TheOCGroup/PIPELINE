#!/usr/bin/env bash
set -euo pipefail

echo "=== Creating Encrypted/Secure Backups ==="

BACKUP_TIME=$(date +%Y%m%d_%H%M%S)
BACKUP_DIR="/srv/ocg/backups"

# OCG ONE backup
echo "Backing up OCG ONE database..."
sudo cp /srv/ocg/ocg-one/data/ocg_one.db "${BACKUP_DIR}/ocg-one/ocg_one_backup_${BACKUP_TIME}.db"
sudo chmod 600 "${BACKUP_DIR}/ocg-one/ocg_one_backup_${BACKUP_TIME}.db"

# PIPELINE backup
if [ -f /srv/ocg/pipeline/data/pipeline.db ]; then
    echo "Backing up PIPELINE database..."
    sudo cp /srv/ocg/pipeline/data/pipeline.db "${BACKUP_DIR}/pipeline/pipeline_backup_${BACKUP_TIME}.db"
    sudo chmod 600 "${BACKUP_DIR}/pipeline/pipeline_backup_${BACKUP_TIME}.db"
fi

echo "Backups stored under ${BACKUP_DIR}."
