#!/bin/bash
# Seed local wrangler persistence with blob data
# Run once after build-blobs, before first wrangler dev
# Usage: ./scripts/seed-local.sh

set -e
cd "$(dirname "$0")/.."

BLOB_DIR="./blobs"

if [ ! -d "$BLOB_DIR" ]; then
  echo "❌ No blobs directory. Run: npm run build:blobs"
  exit 1
fi

echo "📦 Seeding local R2..."
for blob in features.json tracks.json search.json; do
  if [ -f "$BLOB_DIR/$blob" ]; then
    echo "  ↑ $blob"
    npx wrangler r2 object put "tsnotfyi-library/$blob" --file "$BLOB_DIR/$blob" --content-type "application/json" --local 2>&1 | grep -E "Upload|Error" || true
  fi
done

echo "📦 Seeding local KV metadata..."
node -e "
const fs = require('fs');
const data = JSON.parse(fs.readFileSync('$BLOB_DIR/metadata.json', 'utf8'));
const header = data[0];
const bulk = [];
for (let i = 1; i < data.length; i++) {
  const row = data[i];
  const obj = {};
  for (let j = 1; j < header.length; j++) {
    obj[header[j]] = row[j];
  }
  bulk.push({ key: row[0], value: JSON.stringify(obj) });
}
const batchSize = 10000;
let batchNum = 0;
for (let b = 0; b < bulk.length; b += batchSize) {
  const batch = bulk.slice(b, b + batchSize);
  const batchFile = '/tmp/kv-local-batch-' + b + '.json';
  fs.writeFileSync(batchFile, JSON.stringify(batch));
  batchNum++;
}
console.log(batchNum + ' batches prepared (' + bulk.length + ' entries)');
"

for i in 0 10000 20000 30000 40000 50000 60000 70000 80000 90000 100000; do
  if [ -f "/tmp/kv-local-batch-${i}.json" ]; then
    echo -n "  batch $((i / 10000 + 1))... "
    npx wrangler kv bulk put --namespace-id "74b769eee0c8486db6b534acf5bc7770" "/tmp/kv-local-batch-${i}.json" --local 2>&1 | grep -E "Success|Error" | head -1 || echo "done"
  fi
done

echo "📦 Seeding local D1..."
npx wrangler d1 execute tsnotfyi --file d1-schema.sql --local 2>&1 | tail -1
if [ -f "$BLOB_DIR/user-data.sql" ]; then
  npx wrangler d1 execute tsnotfyi --file "$BLOB_DIR/user-data.sql" --local 2>&1 | tail -1
fi

echo "📦 Done! Run: ./start-dev.sh"
