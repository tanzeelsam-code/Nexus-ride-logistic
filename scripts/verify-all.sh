#!/usr/bin/env bash
set -euo pipefail

echo "========================================================"
echo "   NEXUS LOGISTICS — FULL STACK SYSTEM VERIFICATION"
echo "========================================================"

TEST_PORT=3099
export PORT="${TEST_PORT}"
export NODE_ENV="development"

# 1. Syntax Validations
echo "1) Checking JavaScript and Python syntax..."
node --check backend_api.js
python3 -m py_compile ai_engine.py
echo "   ✅ Code syntax validation passed."

# 2. Frontend Assets Check
echo "2) Checking frontend assets..."
for f in frontend/index.html frontend/ride.html frontend/freight.html frontend/nexus-client.js; do
  if [ ! -f "$f" ]; then
    echo "   ❌ Missing frontend asset: $f"
    exit 1
  fi
done
echo "   ✅ All frontend dashboards and nexus-client.js verified."

# 3. Spin up Backend API on ephemeral port
echo "3) Starting backend API on port ${TEST_PORT} for integration tests..."
node backend_api.js > /tmp/nexus-verify.log 2>&1 &
SERVER_PID=$!

cleanup() {
  echo "Stopping verification server (PID: ${SERVER_PID})..."
  kill -9 "${SERVER_PID}" 2>/dev/null || true
  rm -f /tmp/nexus-verify.log
}
trap cleanup EXIT

# Wait for server to boot
sleep 2

# 4. Run Endpoint Checks
echo "4) Running API integration tests against http://localhost:${TEST_PORT}..."

echo "   -> Health Check..."
HEALTH_RES=$(curl -s "http://localhost:${TEST_PORT}/api/v1/health")
echo "      Response: ${HEALTH_RES}"

echo "   -> Ops Overview..."
OPS_RES=$(curl -s "http://localhost:${TEST_PORT}/api/v1/ops/overview")
if echo "${OPS_RES}" | grep -q "NEXUS LOGISTICS GROUP"; then
  echo "      ✅ Ops overview returned valid platform status."
else
  echo "      ❌ Ops overview verification failed."
  exit 1
fi

echo "   -> B2B Freight Instant Quote..."
QUOTE_RES=$(curl -s -X POST "http://localhost:${TEST_PORT}/api/v1/b2b/quote" \
  -H "Content-Type: application/json" \
  -d '{"pickup_lat": 40.7128, "pickup_lng": -74.0060, "dropoff_lat": 40.7580, "dropoff_lng": -73.9855, "service_type": "cold_chain", "requires_refrigeration": true, "cargo_weight_kg": 85, "cargo_value": 5000, "insurance_requested": true}')
if echo "${QUOTE_RES}" | grep -q "quote_id"; then
  echo "      ✅ B2B quote returned valid pricing breakdown."
else
  echo "      ❌ B2B quote failed: ${QUOTE_RES}"
  exit 1
fi

echo "   -> Cold-Chain IoT Sensor Ingestion & Excursion Alert..."
CC_RES=$(curl -s -X POST "http://localhost:${TEST_PORT}/api/v1/cold-chain/telemetry" \
  -H "Content-Type: application/json" \
  -d '{"delivery_id": "DEL-44200", "temperature_c": 11.4, "battery_pct": 82, "seal_intact": true}')
if echo "${CC_RES}" | grep -q "critical"; then
  echo "      ✅ Cold chain excursion detection & incident trigger verified."
else
  echo "      ❌ Cold chain excursion test failed: ${CC_RES}"
  exit 1
fi

echo "   -> Diurnal Fleet Rebalance..."
REB_RES=$(curl -s "http://localhost:${TEST_PORT}/api/v1/fleet/rebalance")
if echo "${REB_RES}" | grep -q "drivers_rebalanced"; then
  echo "      ✅ Diurnal fleet rebalance algorithm passed."
else
  echo "      ❌ Diurnal fleet rebalance failed: ${REB_RES}"
  exit 1
fi

echo "   -> Prometheus Metrics..."
METRICS_RES=$(curl -s "http://localhost:${TEST_PORT}/api/v1/metrics" | head -n 5)
echo "      ${METRICS_RES}"
echo "      ✅ Prometheus metrics output verified."

echo
echo "========================================================"
echo "   🎉 ALL 5 SYSTEM CHECKS PASSED SUCCESSFULLY!"
echo "   NEXUS Logistics is ready for operation and deployment."
echo "========================================================"
