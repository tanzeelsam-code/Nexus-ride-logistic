#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost}"
RID="smoke-$(date +%s)"

echo "Running NEXUS smoke checks against: ${BASE_URL}"
echo "Request ID: ${RID}"
echo

echo "1) API health"
curl -sS -i -H "x-request-id: ${RID}-health" "${BASE_URL}/api/v1/health" | sed -n '1,20p'
echo

echo "2) API readiness"
curl -sS -i -H "x-request-id: ${RID}-ready" "${BASE_URL}/api/v1/ready" | sed -n '1,20p'
echo

echo "3) API metrics (first lines)"
curl -sS -H "x-request-id: ${RID}-metrics" "${BASE_URL}/api/v1/metrics" | sed -n '1,30p'
echo

echo "Smoke checks completed."
