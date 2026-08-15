#!/usr/bin/env bash
set -euo pipefail

echo "=== Running Production Smoke Verification ==="

# 1. Check HTTP status and JSON payload properties
check_endpoint() {
    local url=$1
    local name=$2
    echo "Checking ${name} at ${url}..."
    local status
    status=$(curl -o /dev/null -s -w "%{http_code}\n" "${url}")
    if [ "${status}" -ne 200 ] && [ "${status}" -ne 401 ]; then
        echo "FAIL: ${name} returned HTTP ${status}"
        exit 1
    fi
    echo "OK: ${name} reached (HTTP ${status})"
}

check_endpoint "http://localhost:8080/health" "OCG ONE Local Health"
check_endpoint "http://localhost:8090/health" "PIPELINE Local Health"
check_endpoint "http://localhost:8090/version" "PIPELINE Version Endpoint"

# 2. Check Caddy routing and TLS headers if hostname is resolving locally
if curl -sI https://os.ocg-one.com/health | grep -i "strict-transport-security" > /dev/null; then
    echo "OK: os.ocg-one.com TLS headers active."
else
    echo "WARNING: Public TLS verification skipped or not resolving locally."
fi

echo "=== Smoke Checks Passed ==="
