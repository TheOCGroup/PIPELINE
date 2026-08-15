#!/usr/bin/env bash
set -euo pipefail

echo "=== Bootstrapping OCG Ubuntu 24.04 LTS Production Host ==="

# 1. Update and harden packages
sudo apt-get update
sudo apt-get upgrade -y
sudo apt-get install -y fail2ban ufw curl git

# 2. Hardening Firewall
echo "Configuring firewall..."
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp comment 'SSH'
sudo ufw allow 80/tcp comment 'HTTP'
sudo ufw allow 443/tcp comment 'HTTPS'
sudo ufw --force enable

# 3. Setup Docker & Docker Compose
if ! command -v docker &> /dev/null; then
    echo "Installing Docker..."
    curl -fsSL https://get.docker.com -o get-docker.sh
    sudo sh get-docker.sh
    sudo usermod -aG docker "${USER}"
    rm get-docker.sh
fi

# 4. Provision server directories
echo "Creating application directories..."
sudo mkdir -p \
  /srv/ocg/compose \
  /srv/ocg/pipeline/app \
  /srv/ocg/pipeline/data \
  /srv/ocg/pipeline/logs \
  /srv/ocg/ocg-one/app \
  /srv/ocg/ocg-one/data \
  /srv/ocg/ocg-one/logs \
  /srv/ocg/caddy/data \
  /srv/ocg/caddy/config \
  /srv/ocg/backups/pipeline \
  /srv/ocg/backups/ocg-one \
  /etc/ocg

# 5. Fix permissions for Node node user (default UID 1000 in containers)
echo "Configuring directory ownership and permissions..."
sudo chown -R 1000:1000 \
  /srv/ocg/pipeline \
  /srv/ocg/ocg-one \
  /srv/ocg/backups

# Caddy runs as root/caddy inside container
sudo chown -R 1000:1000 /srv/ocg/caddy

sudo chmod -R 700 /srv/ocg/
sudo chmod 700 /etc/ocg

echo "=== System Bootstrapped Successfully ==="
echo "Note: Log out and log back in to apply docker group membership."
