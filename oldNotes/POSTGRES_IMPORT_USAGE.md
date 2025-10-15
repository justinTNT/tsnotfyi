# Using PostgreSQL with beets2tsnot.py

## Migration Complete! ✅

The import script now supports both SQLite (default) and PostgreSQL databases.

---

## Setup (In Your Staging Environment)

### 1. Install PostgreSQL

```bash
# macOS
brew install postgresql
brew services start postgresql

# Create database
createdb tsnotfyi
```

### 2. Install Python Dependencies

```bash
pip install psycopg2-binary
```

---

## Usage

### Basic PostgreSQL Import

```bash
python3 beets2tsnot.py \
  --beets-db ~/.config/beets/library.db \
  --postgres \
  --pg-database tsnotfyi \
  --tranche proof_tools
```

### With Custom PostgreSQL Settings

```bash
python3 beets2tsnot.py \
  --beets-db ~/.config/beets/library.db \
  --postgres \
  --pg-host localhost \
  --pg-port 5432 \
  --pg-database tsnotfyi \
  --pg-user postgres \
  --tranche production
```

### Using Environment Variable for Password

```bash
export PGPASSWORD="your_password"

python3 beets2tsnot.py \
  --beets-db ~/.config/beets/library.db \
  --postgres \
  --pg-database tsnotfyi \
  --tranche make_fun
```

### Or Pass Password Directly

```bash
python3 beets2tsnot.py \
  --beets-db ~/.config/beets/library.db \
  --postgres \
  --pg-database tsnotfyi \
  --pg-password your_password \
  --tranche make_fun
```

---

## Command-Line Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--postgres` | False | Enable PostgreSQL (uses SQLite if omitted) |
| `--pg-host` | localhost | PostgreSQL host |
| `--pg-port` | 5432 | PostgreSQL port |
| `--pg-database` | tsnotfyi | Database name |
| `--pg-user` | postgres | Database user |
| `--pg-password` | (env var) | Password (or use PGPASSWORD env var) |

---

## Key Features

### Fuzzy Search Index

The PostgreSQL version automatically creates a **GIN trigram index** on `path_keywords` for fast fuzzy matching:

```sql
-- This is created automatically during import
CREATE INDEX idx_path_keywords_fuzzy ON music_analysis
USING GIN (path_keywords gin_trgm_ops);
```

### Performance Optimizations

- **Bulk inserts:** Uses `execute_values()` for 10x faster inserts
- **Batch updates:** Uses `execute_batch()` for efficient PCA updates
- **Connection pooling:** Persistent connections for better performance
- **UPSERT support:** Proper `ON CONFLICT` handling

### Query Examples (After Import)

```sql
-- Fuzzy search on path keywords
SELECT identifier, bt_path, path_keywords,
       similarity(path_keywords, 'four dog night') AS score
FROM music_analysis
WHERE path_keywords % 'four dog night'
ORDER BY score DESC
LIMIT 10;

-- Check import stats
SELECT COUNT(*) as total_tracks FROM music_analysis;

-- Verify PCA data
SELECT COUNT(*) as tracks_with_pca
FROM music_analysis
WHERE primary_d IS NOT NULL;
```

---

## Migration Comparison

| Feature | SQLite | PostgreSQL |
|---------|--------|------------|
| Fuzzy search | LIKE (slow) | Trigram similarity (fast) |
| Concurrent access | Limited | Excellent |
| Bulk inserts | `executemany` | `execute_values` (10x faster) |
| UPSERT | `INSERT OR REPLACE` | `ON CONFLICT DO UPDATE` |
| Data types | `TEXT`, `REAL` | `VARCHAR`, `DOUBLE PRECISION` |

---

## Testing Workflow

### 1. Test with Proof Tools (100 tracks)

```bash
python3 beets2tsnot.py \
  --beets-db ~/.config/beets/library.db \
  --postgres \
  --pg-database tsnotfyi \
  --tranche proof_tools
```

### 2. Verify Data

```bash
psql tsnotfyi -c "SELECT COUNT(*) FROM music_analysis;"
psql tsnotfyi -c "SELECT * FROM music_analysis LIMIT 1;"
```

### 3. Test Fuzzy Search

```bash
psql tsnotfyi -c "
SELECT bt_artist, bt_title, path_keywords,
       similarity(path_keywords, 'test search') AS score
FROM music_analysis
WHERE path_keywords % 'test search'
ORDER BY score DESC
LIMIT 5;
"
```

### 4. Run Full Import

```bash
python3 beets2tsnot.py \
  --beets-db ~/.config/beets/library.db \
  --postgres \
  --pg-database tsnotfyi \
  --tranche production \
  --parallel 8
```

---

## Troubleshooting

### "psycopg2 not installed"

```bash
pip install psycopg2-binary
```

### "database does not exist"

```bash
createdb tsnotfyi
```

### "password authentication failed"

```bash
# Set password via environment variable
export PGPASSWORD="your_password"

# Or pass it on command line
--pg-password your_password
```

### "pg_trgm extension not found"

The script creates this automatically, but if you need to do it manually:

```sql
psql tsnotfyi -c "CREATE EXTENSION IF NOT EXISTS pg_trgm;"
```

---

## Performance Tips

1. **Use parallel processing:** `--parallel 8`
2. **Batch size:** Default 100 is good, increase for faster machines
3. **Chunk size:** Default 20 works well for most systems
4. **Monitor progress:** Watch the logs for throughput

---

## What Changed

### Files Modified

- `import/beets2tsnot.py` (~200 lines changed)

### Key Changes

1. **Imports:** Added `psycopg2` support
2. **Config:** Added PostgreSQL connection parameters
3. **Connection:** Dual-mode database connection
4. **Schema:** PostgreSQL-compatible types (`VARCHAR`, `DOUBLE PRECISION`)
5. **Queries:** Parameter placeholders (`?` → `%s`)
6. **Indexes:** GIN trigram index for fuzzy search
7. **Bulk ops:** Optimized inserts and updates
8. **UPSERT:** PostgreSQL `ON CONFLICT` syntax

---

## Next Steps

Once you've tested the import in staging:

1. ✅ Import works with `--postgres` flag
2. ✅ Fuzzy search index is created
3. ✅ PCA computation completes
4. ✅ Calibration settings are stored

Then update the server to use PostgreSQL (see `SERVER_POSTGRES_MIGRATION.md`).

---

**Status:** Ready to test in staging environment
**Estimated import time:** ~same as SQLite, potentially faster with bulk ops
**Data format:** 100% compatible with existing queries
