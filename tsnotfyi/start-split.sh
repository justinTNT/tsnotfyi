#!/bin/bash
# Start the 3-tier split: API → Audio → Web
# Usage: ./start-split.sh
# Stop: Ctrl+C (kills all three)

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

cleanup() {
  echo ""
  echo "Shutting down..."
  kill $API_PID $AUDIO_PID $WEB_PID 2>/dev/null
  wait $API_PID $AUDIO_PID $WEB_PID 2>/dev/null
  echo "All servers stopped."
}
trap cleanup EXIT INT TERM

echo "🧮 Starting API server (port 3003)..."
node api-server.js &
API_PID=$!

# Wait for API to be ready
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

# Wait for Audio to be ready
for i in $(seq 1 30); do
  if curl -s http://localhost:3002/health | grep -q '"ok"' 2>/dev/null; then
    echo "✅ Audio server ready"
    break
  fi
  sleep 1
done

echo "🌐 Starting Web server (port 3001)..."
node server.js &
WEB_PID=$!

echo ""
echo "═══════════════════════════════════════"
echo "  API:   http://localhost:3003/health"
echo "  Audio: http://localhost:3002/health"
echo "  Web:   http://localhost:3001"
echo "═══════════════════════════════════════"
echo "  Press Ctrl+C to stop all servers"
echo ""

wait
