#!/bin/bash

# Postgres connection (uses DATABASE_URL or default)
DB="${DATABASE_URL:-postgresql://localhost/tsnotfyi}"
PSQL="${PSQL:-/opt/homebrew/Cellar/libpq/18.0/bin/psql}"

echo "Querying distinct directories missing artpath..." >&2

QUERY="
  SELECT DISTINCT regexp_replace(convert_from(bt_path::bytea, 'UTF8'), '/[^/]+\$', '') as dir
  FROM music_analysis
  WHERE bt_path IS NOT NULL
  AND (beets_meta IS NULL
       OR beets_meta::jsonb->'album'->>'artpath' IS NULL
       OR beets_meta::jsonb->'album'->>'artpath' = '')
"

found=0
missing=0
"$PSQL" "$DB" -t -A -c "$QUERY" | while read -r dir; do
  # Walk up the tree looking for any jpg/png
  searchdir="$dir"
  cover_found=""
  while [ -n "$searchdir" ] && [ "$searchdir" != "/" ]; do
    # Stop at volume root
    case "$searchdir" in /Volumes/?*) ;; *) if [ "$(dirname "$searchdir")" = "/Volumes" ]; then break; fi ;; esac

    if find "$searchdir" -maxdepth 1 -type f \( -iname '*.jpg' -o -iname '*.png' \) 2>/dev/null | head -1 | grep -q .; then
      cover_found="$searchdir"
      break
    fi
    searchdir=$(dirname "$searchdir")
  done

  if [ -n "$cover_found" ]; then
    echo "$cover_found"
  fi
done | sort | uniq -c | sort -rn | head -50

echo "---"
echo "Distinct dirs missing artpath:"
"$PSQL" "$DB" -t -A -c "
  SELECT COUNT(DISTINCT regexp_replace(convert_from(bt_path::bytea, 'UTF8'), '/[^/]+\$', ''))
  FROM music_analysis
  WHERE bt_path IS NOT NULL
  AND (beets_meta IS NULL
       OR beets_meta::jsonb->'album'->>'artpath' IS NULL
       OR beets_meta::jsonb->'album'->>'artpath' = '')
"
echo "Tracks missing artpath:"
"$PSQL" "$DB" -t -A -c "
  SELECT COUNT(*) FROM music_analysis
  WHERE bt_path IS NOT NULL
  AND (beets_meta IS NULL
       OR beets_meta::jsonb->'album'->>'artpath' IS NULL
       OR beets_meta::jsonb->'album'->>'artpath' = '')
"
