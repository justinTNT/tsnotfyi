#!/bin/bash
# Start local dev stack with Worker replacing web server
# Usage: ./start-dev.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

cleanup() {
  echo ""
  echo "Shutting down..."
  kill $API_PID $AUDIO_PID $COVERS_PID $WORKER_PID 2>/dev/null
  wait $API_PID $AUDIO_PID $COVERS_PID $WORKER_PID 2>/dev/null
  echo "All servers stopped."
}
trap cleanup EXIT INT TERM

echo "🧮 Starting API server (port 3003)..."
node api-server.js &
API_PID=$!

for i in $(seq 1 60); do
  if curl -s http://localhost:3003/health | grep -q '"ok"' 2>/dev/null; then
    echo "✅ API server ready"
    break
  fi
  sleep 1
done

echo "🎵 Starting Audio server (port 3002)..."
node audio-server.js &
AUDIO_PID=$!

for i in $(seq 1 30); do
  if curl -s http://localhost:3002/health | grep -q '"ok"' 2>/dev/null; then
    echo "✅ Audio server ready"
    break
  fi
  sleep 1
done

echo "🖼️  Starting Covers server (port 3004)..."
node covers-server.js &
COVERS_PID=$!
sleep 1
echo "✅ Covers server ready"

echo "🌐 Starting Worker (port 8787)..."
npx wrangler dev --port 8787 --ip 0.0.0.0 &
WORKER_PID=$!

# Wait for Worker to be ready
for i in $(seq 1 15); do
  if curl -s http://localhost:8787/health 2>/dev/null | grep -q '"ok"'; then
    echo "✅ Worker ready"
    break
  fi
  sleep 1
done

echo ""
echo "═══════════════════════════════════════"
echo "  App:    http://localhost:8787"
echo "  API:    http://localhost:3003"
echo "  Audio:  http://localhost:3002"
echo "  Covers: http://localhost:3004"
echo "═══════════════════════════════════════"
echo "  Press Ctrl+C to stop all servers"
echo ""

wait
