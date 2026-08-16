#!/usr/bin/env bash
set -euo pipefail

echo "=== Generating Production Secrets and Keypairs ==="

# 1. Create secure keys directory
sudo mkdir -p /etc/ocg
sudo chmod 700 /etc/ocg

# Generate secure random secrets
SESSION_SECRET=$(openssl rand -hex 32)
PIPELINE_SESSION_SECRET=$(openssl rand -hex 32)
WEBHOOK_SECRET=$(openssl rand -hex 32)
ENCRYPTION_KEY=$(openssl rand -hex 32)

# 2. Generate RS256 Keypairs
echo "Generating RS256 Keypairs..."

# Handoff Keypair (OCG ONE Signs, PIPELINE Verifies)
openssl genpkey -algorithm RSA -out /tmp/handoff_private.pem -pkeyopt rsa_keygen_bits:2048
openssl rsa -pubout -in /tmp/handoff_private.pem -out /tmp/handoff_public.pem

# Service Keypair (PIPELINE Signs, OCG ONE Verifies)
openssl genpkey -algorithm RSA -out /tmp/service_private.pem -pkeyopt rsa_keygen_bits:2048
openssl rsa -pubout -in /tmp/service_private.pem -out /tmp/service_public.pem

# Base64 encode private keys
HANDOFF_PRIVATE_B64=$(base64 -w 0 < /tmp/handoff_private.pem)
SERVICE_PRIVATE_B64=$(base64 -w 0 < /tmp/service_private.pem)

# Prepare public keys JSON maps
HANDOFF_PUBLIC_PEM=$(awk '{printf "%s\\n", $0}' /tmp/handoff_public.pem)
SERVICE_PUBLIC_PEM=$(awk '{printf "%s\\n", $0}' /tmp/service_public.pem)

HANDOFF_PUBLIC_JSON="{\"handoff-key-1\":\"${HANDOFF_PUBLIC_PEM}\"}"
SERVICE_PUBLIC_JSON="{\"service-key-1\":\"${SERVICE_PUBLIC_PEM}\"}"

# 3. Create pipeline.env
echo "Writing /etc/ocg/pipeline.env..."
sudo tee /etc/ocg/pipeline.env > /dev/null <<EOF
PIPELINE_ENV=production
PIPELINE_HOST=0.0.0.0
PIPELINE_PORT=8090
PIPELINE_DB_PATH=/data/pipeline.db
PIPELINE_ALLOW_OCG_ONE_INTEGRATION=true
PIPELINE_READ_ONLY=true

PIPELINE_SESSION_SECRET=${PIPELINE_SESSION_SECRET}
WEBHOOK_SECRET=${WEBHOOK_SECRET}
ENCRYPTION_KEY=${ENCRYPTION_KEY}

OCG_ONE_BASE_URL=https://os.ocg-one.com
OCG_ONE_HANDOFF_ISSUER=ocg-one
OCG_ONE_HANDOFF_AUDIENCE=pipeline
OCG_ONE_HANDOFF_PUBLIC_KEYS_JSON=${HANDOFF_PUBLIC_JSON}


# OCG ONE signs inbound PIPELINE S2S calls with its integration key. This
# initial package deliberately uses the handoff public key map until a separate
# inbound service key is provisioned and rotated on both services.
OCG_ONE_SERVICE_PUBLIC_KEYS_JSON=${HANDOFF_PUBLIC_JSON}
OCG_ONE_SERVICE_ISSUER=pipeline
OCG_ONE_SERVICE_AUDIENCE=ocg-one-pipeline-integration
OCG_ONE_SERVICE_PRIVATE_KEY_B64=${SERVICE_PRIVATE_B64}
OCG_ONE_SERVICE_KEY_ID=service-key-1
EOF

# 4. Create ocg-one.env
echo "Writing /etc/ocg/ocg-one.env..."
sudo tee /etc/ocg/ocg-one.env > /dev/null <<EOF
NODE_ENV=production
PORT=8080
DB_PATH=/srv/ocg/ocg-one/data/ocg_one.db

SESSION_SECRET=${SESSION_SECRET}
WEBHOOK_SECRET=${WEBHOOK_SECRET}
ENCRYPTION_KEY=${ENCRYPTION_KEY}

PIPELINE_BASE_URL=https://pipeline.ocg-one.com
PIPELINE_INTEGRATION_ENABLED=true

PIPELINE_HANDOFF_ISSUER=ocg-one
PIPELINE_HANDOFF_AUDIENCE=pipeline
PIPELINE_HANDOFF_PRIVATE_KEY_B64=${HANDOFF_PRIVATE_B64}
PIPELINE_HANDOFF_KEY_ID=handoff-key-1

PIPELINE_SERVICE_ISSUER=pipeline
PIPELINE_SERVICE_AUDIENCE=ocg-one-pipeline-integration
PIPELINE_SERVICE_PUBLIC_KEYS_JSON=${SERVICE_PUBLIC_JSON}

PIPELINE_STANDALONE_ENABLED=false
PIPELINE_EMBEDDED_WRITES_ENABLED=true
PIPELINE_CONVERSION_ENABLED=false
EOF

# 5. Clean up temporary keys and secure files
rm -f /tmp/handoff_private.pem /tmp/handoff_public.pem /tmp/service_private.pem /tmp/service_public.pem
sudo chmod 600 /etc/ocg/pipeline.env /etc/ocg/ocg-one.env
sudo chown root:root /etc/ocg/pipeline.env /etc/ocg/ocg-one.env

echo "=== Production Secrets and Keypairs Generated Successfully ==="
