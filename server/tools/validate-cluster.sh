#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVER_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$SERVER_DIR"

API_BASE="${API_BASE:-http://127.0.0.1:5501}"
WS_BASE="${WS_BASE:-ws://127.0.0.1:5501/ws}"
CLIENTS="${CLIENTS:-50}"
LATENCY_THRESHOLD_MS="${LATENCY_THRESHOLD_MS:-50}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
REPORT_DIR="${REPORT_DIR:-$SERVER_DIR/reports}"
mkdir -p "$REPORT_DIR"

printf '=== Validación de clúster v2.8.0 ===\n'
printf 'API: %s\nWebSocket: %s\nClientes: %s\nUmbral P95: %s ms\n' "$API_BASE" "$WS_BASE" "$CLIENTS" "$LATENCY_THRESHOLD_MS"

printf '\n=== Readiness ===\n'
curl --fail --silent --show-error "$API_BASE/ready"
printf '\n'

printf '\n=== Coordinación multi-instancia ===\n'
API_BASE="$API_BASE" WS_BASE="$WS_BASE" node tools/cluster-smoke.js 2>&1 | tee "$REPORT_DIR/cluster-smoke-$STAMP.log"

printf '\n=== Carga y propagación geométrica ===\n'
API_BASE="$API_BASE" WS_BASE="$WS_BASE" node tools/benchmark.js \
  "--clients=$CLIENTS" \
  "--threshold-ms=$LATENCY_THRESHOLD_MS" \
  "--report=$REPORT_DIR/load-test-$STAMP.json" 2>&1 | tee "$REPORT_DIR/load-test-$STAMP.log"

printf '\nRESULTADO: pruebas de clúster y carga terminadas. Revisa los informes en %s\n' "$REPORT_DIR"
printf 'NOTA: este benchmark mide recepción WebSocket; el tiempo de renderizado debe documentarse por separado desde los navegadores.\n'
