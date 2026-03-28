#!/bin/bash
# Deploy blobs to Cloudflare: R2 bucket, KV metadata, D1 user data
# Prerequisites: npx wrangler login, blobs/ directory populated
# Usage: ./scripts/deploy-blobs.sh [--create-resources]

set -e
cd "$(dirname "$0")/.."

BLOB_DIR="./blobs"
BUCKET="tsnotfyi-library"
KV_NS="tsnotfyi-metadata"
D1_DB="tsnotfyi"

if [ ! -d "$BLOB_DIR" ]; then
  echo "❌ No blobs directory. Run: node scripts/build-blobs.js"
  exit 1
fi

# ─── Create resources (first time only) ───
if [ "$1" = "--create-resources" ]; then
  echo "📦 Creating Cloudflare resources..."
  npx wrangler r2 bucket create "$BUCKET" 2>/dev/null || echo "  (bucket may already exist)"
  npx wrangler kv namespace create "$KV_NS" 2>/dev/null || echo "  (KV namespace may already exist)"
  npx wrangler d1 create "$D1_DB" 2>/dev/null || echo "  (D1 database may already exist)"
  echo ""
  echo "⚠️  Update wrangler.toml with the IDs printed above, then re-run without --create-resources"
  exit 0
fi

# ─── Upload blobs to R2 ───
echo "📦 Uploading blobs to R2..."
for blob in features.json tracks.json search.json; do
  if [ -f "$BLOB_DIR/$blob" ]; then
    echo "  ↑ $blob ($(du -h "$BLOB_DIR/$blob" | cut -f1))"
    npx wrangler r2 object put "$BUCKET/$blob" --file "$BLOB_DIR/$blob" --content-type "application/json"
  fi
done

# ─── Populate KV with metadata (one key per track) ───
echo "📦 Populating KV with metadata..."
if [ -f "$BLOB_DIR/metadata.json" ]; then
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
    // Write in batches of 10,000 (KV bulk limit)
    const batchSize = 10000;
    for (let b = 0; b < bulk.length; b += batchSize) {
      const batch = bulk.slice(b, b + batchSize);
      const batchFile = '/tmp/kv-batch-' + b + '.json';
      fs.writeFileSync(batchFile, JSON.stringify(batch));
      console.log('  batch ' + (b / batchSize + 1) + ': ' + batch.length + ' entries');
    }
    console.log('BATCH_COUNT=' + Math.ceil(bulk.length / batchSize));
    console.log('TOTAL=' + bulk.length);
  " > /tmp/kv-info.txt

  TOTAL=$(grep TOTAL /tmp/kv-info.txt | cut -d= -f2)
  BATCHES=$(grep BATCH_COUNT /tmp/kv-info.txt | cut -d= -f2)
  echo "  $TOTAL entries in $BATCHES batches"

  for i in $(seq 0 $((BATCHES - 1))); do
    OFFSET=$((i * 10000))
    echo "  ↑ batch $((i + 1))/$BATCHES"
    npx wrangler kv bulk put --namespace-id "$(grep 'binding = \"METADATA\"' -A1 wrangler.toml | grep id | cut -d'"' -f2)" /tmp/kv-batch-${OFFSET}.json
  done
fi

# ─── Initialize D1 schema + migrate user data ───
echo "📦 Initializing D1 schema..."
npx wrangler d1 execute "$D1_DB" --file d1-schema.sql

if [ -f "$BLOB_DIR/user-data.sql" ]; then
  echo "📦 Importing user data to D1..."
  npx wrangler d1 execute "$D1_DB" --file "$BLOB_DIR/user-data.sql"
fi

echo "📦 Done!"
