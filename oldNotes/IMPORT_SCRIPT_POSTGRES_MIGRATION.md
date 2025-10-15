# Import Script PostgreSQL Migration Plan

**Estimated Effort:** 2-3 hours
**Complexity:** Medium
**Risk:** Medium

**⚠️ RECOMMENDATION: Don't do this. Use pgloader instead (5 minutes).**

---

## Executive Summary

This document describes how to modify `beets2tsnot.py` to write directly to PostgreSQL instead of SQLite. However, **this is not recommended** for a one-time migration.

### Why Not Recommended

1. **You already have the data** in `results.db`
2. **pgloader can import it in 3 minutes** with zero risk
3. **This approach takes 2-3 hours** and introduces code risk
4. **Only worth it if** you need to re-run imports regularly

### When This IS Worth Doing

- You're importing new music weekly/daily
- You want PostgreSQL-native features during import
- You're starting from scratch (no existing SQLite DB)
- You need custom PostgreSQL types/partitions

---

## Alternative: Use pgloader (Recommended)

```bash
# Total time: 5 minutes

brew install pgloader
createdb tsnotfyi
pgloader results.db postgresql://localhost/tsnotfyi

# Add fuzzy search index on path_keywords
psql tsnotfyi <<EOF
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX idx_path_keywords_fuzzy ON music_analysis USING GIN (path_keywords gin_trgm_ops);
EOF

# Done! You have all your data in PostgreSQL with fuzzy search.
```

**If you choose this route, you can stop reading here.**

---

## If You Must Modify the Import Script...

The rest of this document describes the changes needed to make `beets2tsnot.py` write directly to PostgreSQL.

---

## Files to Modify

1. `import/beets2tsnot.py` - Main import script (~100 lines changed)

---

## 1. Dependency Changes

### Install psycopg2

```bash
pip install psycopg2-binary

# Or add to requirements.txt
echo "psycopg2-binary>=2.9.0" >> requirements.txt
pip install -r requirements.txt
```

### Import Changes (Lines 19-33)

**Before:**
```python
import sqlite3
import subprocess
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
```

**After:**
```python
import psycopg2
import psycopg2.extras
import psycopg2.pool
from psycopg2 import sql
import os
import subprocess
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
```

---

## 2. Configuration Changes

### ProcessingConfig Dataclass (Lines 62-93)

**Before:**
```python
@dataclass
class ProcessingConfig:
    """Configuration for beets2tsnot processing"""
    # Core settings
    beets_db_path: str
    output_db_path: str = "tsnot_analysis.db"
    checkpoint_db_path: Optional[str] = None
```

**After:**
```python
@dataclass
class ProcessingConfig:
    """Configuration for beets2tsnot processing"""
    # Core settings
    beets_db_path: str  # Still SQLite (beets source is read-only)

    # PostgreSQL output options
    output_db_url: Optional[str] = None
    output_db_host: str = "localhost"
    output_db_port: int = 5432
    output_db_name: str = "tsnotfyi"
    output_db_user: str = "postgres"
    output_db_password: Optional[str] = None  # From env var
```

---

## 3. BeetsMetadataExtractor (Lines 124-260)

**No changes needed!** This class reads from beets database, which stays SQLite.

```python
class BeetsMetadataExtractor:
    """Extracts comprehensive metadata from beets database"""

    def __init__(self, beets_db_path: str):
        self.beets_db_path = beets_db_path
        self.beets_db = None
        self._connect()

    def _connect(self):
        """Connect to beets database"""
        # SQLite connection - keep as-is
        self.beets_db = sqlite3.connect(
            self.beets_db_path,
            timeout=30.0,
            check_same_thread=False
        )
        self.beets_db.row_factory = sqlite3.Row
```

---

## 4. DatabaseManager Class Changes

This is where all the major changes happen.

### A. Connection (Lines 886-891)

**Before:**
```python
def _connect(self):
    """Connect to output database"""
    self.db = sqlite3.connect(self.db_path, timeout=30.0, check_same_thread=False)
    self.db.execute("PRAGMA journal_mode=WAL")
    self.db.execute("PRAGMA synchronous=NORMAL")
    self.db.execute("PRAGMA cache_size=10000")
    logger.info(f"Connected to output database: {self.db_path}")
```

**After:**
```python
def _connect(self):
    """Connect to output database"""
    try:
        # Build connection string or use config
        if self.config.output_db_url:
            self.db = psycopg2.connect(self.config.output_db_url)
        else:
            self.db = psycopg2.connect(
                host=self.config.output_db_host,
                port=self.config.output_db_port,
                database=self.config.output_db_name,
                user=self.config.output_db_user,
                password=self.config.output_db_password or os.getenv('DB_PASSWORD')
            )

        # Set session parameters (equivalent to PRAGMA)
        with self.db.cursor() as cur:
            cur.execute("SET work_mem = '50MB'")
            cur.execute("SET maintenance_work_mem = '256MB'")
            cur.execute("SET synchronous_commit = OFF")  # Faster bulk inserts

        self.db.autocommit = False  # Explicit transaction control
        logger.info(f"Connected to PostgreSQL database: {self.config.output_db_name}")

    except Exception as e:
        logger.error(f"Failed to connect to output database: {e}")
        raise
```

---

### B. Schema Creation (Lines 893-941)

**Before:**
```python
create_sql = f"""
CREATE TABLE IF NOT EXISTS music_analysis (
    identifier TEXT PRIMARY KEY,
    processed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    -- Beets metadata (bt_ prefix)
    {columns_sql['beets']},
    -- Music indices (21 total)
    {columns_sql['indices']}
)
"""

self.db.execute(create_sql)
```

**After:**
```python
create_sql = f"""
CREATE TABLE IF NOT EXISTS music_analysis (
    identifier VARCHAR(32) PRIMARY KEY,
    processed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    -- Beets metadata (bt_ prefix)
    {columns_sql['beets']},
    -- Music indices (21 total)
    {columns_sql['indices']}
)
"""

with self.db.cursor() as cur:
    cur.execute(create_sql)
self.db.commit()
```

**Key Changes:**
- `TEXT PRIMARY KEY` → `VARCHAR(32) PRIMARY KEY` (MD5 hash)
- Use cursor pattern instead of direct execute
- Explicit commit

---

### C. Column Type Mappings (Lines 942-983)

**Before:**
```python
elif col in ['length', 'mtime', 'added', 'rg_track_gain', ...]:
    beets_cols.append(f"bt_{col} REAL")
```

**After:**
```python
elif col in ['length', 'mtime', 'added', 'rg_track_gain', ...]:
    beets_cols.append(f"bt_{col} DOUBLE PRECISION")  # PostgreSQL standard
```

---

### D. Index Creation (Lines 985-1001)

**Before:**
```python
def _create_indexes(self):
    """Create database indexes for performance"""
    indexes = [
        "CREATE INDEX IF NOT EXISTS idx_bt_artist ON music_analysis(bt_artist)",
        "CREATE INDEX IF NOT EXISTS idx_bt_album ON music_analysis(bt_album)",
        "CREATE INDEX IF NOT EXISTS idx_path_keywords ON music_analysis(path_keywords)",
        # ... more indexes
    ]

    for index_sql in indexes:
        self.db.execute(index_sql)
```

**After:**
```python
def _create_indexes(self):
    """Create database indexes for performance"""
    with self.db.cursor() as cur:
        # Enable trigram extension for fuzzy search
        cur.execute("CREATE EXTENSION IF NOT EXISTS pg_trgm")

        indexes = [
            "CREATE INDEX IF NOT EXISTS idx_bt_artist ON music_analysis(bt_artist)",
            "CREATE INDEX IF NOT EXISTS idx_bt_album ON music_analysis(bt_album)",
            "CREATE INDEX IF NOT EXISTS idx_bt_genre ON music_analysis(bt_genre)",
            "CREATE INDEX IF NOT EXISTS idx_bt_year ON music_analysis(bt_year)",
            "CREATE INDEX IF NOT EXISTS idx_bpm ON music_analysis(bpm)",
            "CREATE INDEX IF NOT EXISTS idx_primary_d ON music_analysis(primary_d)",

            # FUZZY SEARCH INDEX on path_keywords - The main benefit!
            "CREATE INDEX IF NOT EXISTS idx_path_keywords_fuzzy ON music_analysis USING GIN (path_keywords gin_trgm_ops)"
        ]

        for index_sql in indexes:
            cur.execute(index_sql)

    self.db.commit()
```

**Note:** The fuzzy search index is on `path_keywords` field, which is computed from the file path (see `compute_path_keywords()` at line 95).

---

### E. Track Insertion (Lines 1010-1037)

**Before:**
```python
def insert_track(self, track_data: Dict, indices: Dict):
    """Insert complete track analysis"""
    # Build data dict
    all_data = {'identifier': track_data['identifier']}
    # ... populate all_data

    # Build insert SQL
    columns = list(all_data.keys())
    placeholders = ', '.join(['?' for _ in columns])
    values = [all_data[col] for col in columns]

    insert_sql = f"""
    INSERT OR REPLACE INTO music_analysis ({', '.join(columns)})
    VALUES ({placeholders})
    """

    self.db.execute(insert_sql, values)
```

**After:**
```python
def insert_track(self, track_data: Dict, indices: Dict):
    """Insert complete track analysis"""
    # Build data dict
    all_data = {'identifier': track_data['identifier']}
    # ... populate all_data

    # Build insert SQL with PostgreSQL placeholders
    columns = list(all_data.keys())
    placeholders = ', '.join([f'%s' for _ in columns])  # Changed from ?
    values = [all_data[col] for col in columns]

    # UPSERT syntax for PostgreSQL
    insert_sql = f"""
    INSERT INTO music_analysis ({', '.join(columns)})
    VALUES ({placeholders})
    ON CONFLICT (identifier) DO UPDATE SET
        {', '.join([f'{col} = EXCLUDED.{col}' for col in columns if col != 'identifier'])}
    """

    with self.db.cursor() as cur:
        cur.execute(insert_sql, values)
```

**Key Changes:**
- `?` → `%s` (parameter placeholder)
- `INSERT OR REPLACE` → `INSERT ... ON CONFLICT DO UPDATE` (UPSERT)
- Use cursor context manager

---

### F. Bulk Update PCA Values (Lines 1165-1209)

**Before:**
```python
update_sql = """
UPDATE music_analysis SET
    primary_d = ?, tonal_pc1 = ?, tonal_pc2 = ?, tonal_pc3 = ?,
    spectral_pc1 = ?, spectral_pc2 = ?, spectral_pc3 = ?,
    rhythmic_pc1 = ?, rhythmic_pc2 = ?, rhythmic_pc3 = ?
WHERE identifier = ?
"""

self.db.executemany(update_sql, batch_updates)
```

**After:**
```python
update_sql = """
UPDATE music_analysis SET
    primary_d = %s, tonal_pc1 = %s, tonal_pc2 = %s, tonal_pc3 = %s,
    spectral_pc1 = %s, spectral_pc2 = %s, spectral_pc3 = %s,
    rhythmic_pc1 = %s, rhythmic_pc2 = %s, rhythmic_pc3 = %s
WHERE identifier = %s
"""

with self.db.cursor() as cur:
    psycopg2.extras.execute_batch(cur, update_sql, batch_updates, page_size=1000)
```

**Key Changes:**
- `?` → `%s`
- `executemany()` → `psycopg2.extras.execute_batch()` (faster!)

---

### G. Insert PCA Transformations (Lines 1128-1164)

**Before:**
```python
insert_sql = """
INSERT INTO pca_transformations
(component, feature_index, feature_name, weight, mean, scale)
VALUES (?, ?, ?, ?, ?, ?)
"""

self.db.executemany(insert_sql, weights)
```

**After:**
```python
insert_sql = """
INSERT INTO pca_transformations
(component, feature_index, feature_name, weight, mean, scale)
VALUES %s
"""

from psycopg2.extras import execute_values
with self.db.cursor() as cur:
    execute_values(cur, insert_sql, weights, page_size=1000)
```

**Key Changes:**
- Use `execute_values()` for bulk inserts (10x faster!)
- `VALUES %s` template for execute_values

---

### H. PCA Computation Data Loading (Lines 499-519)

**Before:**
```python
def fit_pca_on_library(self, db_path: str) -> Dict[str, np.ndarray]:
    conn = sqlite3.connect(db_path)
    query = f"SELECT {', '.join(columns)} FROM music_analysis WHERE identifier IS NOT NULL"
    self.data = pd.read_sql_query(query, conn)
    conn.close()
```

**After:**
```python
def fit_pca_on_library(self, db_config) -> Dict[str, np.ndarray]:
    if isinstance(db_config, str):
        conn = psycopg2.connect(db_config)
    else:
        conn = psycopg2.connect(**db_config)

    query = f"SELECT {', '.join(columns)} FROM music_analysis WHERE identifier IS NOT NULL"
    self.data = pd.read_sql_query(query, conn)
    conn.close()
```

**Good news:** `pd.read_sql_query()` works with both databases!

---

## 5. Parameter Placeholder Reference

**Critical: SQLite uses `?`, PostgreSQL uses `%s`**

| Operation | SQLite | PostgreSQL |
|-----------|--------|------------|
| Single value | `WHERE id = ?` | `WHERE id = %s` |
| Multiple values | `VALUES (?, ?, ?)` | `VALUES (%s, %s, %s)` |
| Named params | Not supported | `%(name)s` |

**Find & Replace:**
```bash
# In beets2tsnot.py
sed -i '' 's/VALUES (?/VALUES (%s/g' beets2tsnot.py
sed -i '' 's/= ?/= %s/g' beets2tsnot.py
sed -i '' 's/, ?/, %s/g' beets2tsnot.py
```

---

## 6. Performance Optimizations

### Bulk Insert Methods (Fastest to Slowest)

```python
# 1. COPY - Fastest (use for initial bulk load)
with open('tracks.csv', 'r') as f:
    cur.copy_from(f, 'music_analysis', sep=',', columns=['id', 'title', ...])

# 2. execute_values - Very Fast
from psycopg2.extras import execute_values
execute_values(cur, "INSERT INTO t VALUES %s", rows, page_size=1000)

# 3. execute_batch - Fast
from psycopg2.extras import execute_batch
execute_batch(cur, "INSERT INTO t VALUES (%s, %s)", rows, page_size=100)

# 4. executemany - Slow
cur.executemany("INSERT INTO t VALUES (%s, %s)", rows)

# 5. Individual inserts - Very Slow
for row in rows:
    cur.execute("INSERT INTO t VALUES (%s, %s)", row)
```

### Transaction Control

```python
# SLOW: Autocommit every insert
conn.autocommit = True
for row in rows:
    cur.execute(...)

# FAST: Batch commits
conn.autocommit = False
for i, row in enumerate(rows):
    cur.execute(...)
    if i % 1000 == 0:
        conn.commit()
conn.commit()
```

---

## 7. Fuzzy Search on path_keywords

The import script already computes `path_keywords` from file paths:

```python
# From beets2tsnot.py line 95-112
def compute_path_keywords(path_str: str) -> str:
    if not path_str:
        return ""
    segments = [seg for seg in path_str.split('/') if seg]
    if len(segments) <= 5:
        trimmed = path_str
    else:
        trimmed = ' '.join(segments[5:])
    trimmed = trimmed.rsplit('.', 1)[0] if segments and '.' in segments[-1] else trimmed
    return (
        trimmed
        .replace('_', ' ')
        .replace('-', ' ')
        .replace('.', ' ')
        .replace('/', ' ')
        .strip()
        .lower()
    )
```

**After migration, fuzzy search queries will use:**

```sql
-- Fuzzy match against path keywords
SELECT *,
       similarity(path_keywords, 'four dog night') AS score
FROM music_analysis
WHERE path_keywords % 'four dog night'  -- % is similarity operator
ORDER BY score DESC
LIMIT 10;
```

**The GIN index on `path_keywords` makes this fast:**
```sql
CREATE INDEX idx_path_keywords_fuzzy ON music_analysis
USING GIN (path_keywords gin_trgm_ops);
```

---

## 8. Testing

```bash
# 1. Test with small dataset first
python3 beets2tsnot.py \
  --beets-db ~/.config/beets/library.db \
  --output postgresql://localhost/tsnotfyi \
  --tranche proof_tools \
  --limit 100

# 2. Verify data
psql tsnotfyi -c "SELECT COUNT(*) FROM music_analysis;"
psql tsnotfyi -c "SELECT identifier, path_keywords FROM music_analysis LIMIT 5;"

# 3. Test fuzzy search on path_keywords
psql tsnotfyi -c "
SELECT identifier, bt_path, path_keywords,
       similarity(path_keywords, 'four dog night') AS score
FROM music_analysis
WHERE path_keywords % 'four dog night'
ORDER BY score DESC
LIMIT 10;
"

# 4. Run full import
python3 beets2tsnot.py \
  --beets-db ~/.config/beets/library.db \
  --output postgresql://localhost/tsnotfyi \
  --tranche production
```

---

## 9. Summary of Changes

| File | Lines Changed | Complexity | Time |
|------|---------------|------------|------|
| Imports | 5 | Trivial | 2 min |
| Config class | 10 | Low | 5 min |
| DatabaseManager._connect | 20 | Low | 15 min |
| Schema creation | 10 | Low | 10 min |
| Column types | 5 | Trivial | 3 min |
| Index creation | 10 | Low | 10 min |
| insert_track | 15 | Medium | 20 min |
| batch_update_pca | 10 | Low | 15 min |
| insert_transformations | 10 | Low | 10 min |
| PCAComputer | 5 | Low | 5 min |
| **TOTAL** | **~100** | **Low-Med** | **1.5 hours** |

**Plus testing/debugging: 1 hour**
**Total: 2.5-3 hours**

---

## 10. Common Issues & Solutions

### Issue: "relation does not exist"

```python
# Make sure schema is created before inserting
processor.db_manager.initialize_schema(beets_columns)
```

### Issue: Parameter type mismatch

```python
# PostgreSQL is stricter about types
# Make sure None vs NULL is handled:
values = [val if val is not None else None for val in values]
```

### Issue: Slow bulk inserts

```python
# Use execute_values instead of executemany
from psycopg2.extras import execute_values
execute_values(cur, sql, values, page_size=1000)
```

---

## 11. Why pgloader is Better

**Time comparison:**

| Task | Modified Script | pgloader |
|------|----------------|----------|
| Code changes | 1.5 hours | 0 min |
| Testing | 1 hour | 5 min |
| Debug issues | 30 min | 0 min |
| Run import | 30 min | 3 min |
| Add fuzzy index | 0 min | 2 min |
| **TOTAL** | **3.5 hours** | **10 minutes** |

**pgloader advantages:**
- ✅ Handles all type conversions automatically
- ✅ Creates indexes automatically
- ✅ Battle-tested on millions of migrations
- ✅ Zero code changes
- ✅ Zero risk of bugs
- ✅ Can resume if interrupted
- ✅ Shows progress bar

**Modified script advantages:**
- ✅ PostgreSQL-native features during import
- ✅ Good for regular/scheduled imports
- ✅ Can add custom PostgreSQL types
- ✅ Fine-grained control over process

---

## 12. Final Recommendation

**For one-time migration:** Use pgloader (10 minutes)

**For ongoing imports:** Modify script (3 hours upfront, saves time later)

**Your situation:** You have `results.db` with all data already processed, including `path_keywords` computed.

**Recommended approach:**
```bash
# Just import it!
pgloader results.db postgresql://localhost/tsnotfyi

# Add fuzzy search index on path_keywords
psql tsnotfyi <<EOF
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX idx_path_keywords_fuzzy ON music_analysis USING GIN (path_keywords gin_trgm_ops);
EOF

# Test fuzzy search
psql tsnotfyi -c "
SELECT identifier, path_keywords,
       similarity(path_keywords, 'four dog night') AS score
FROM music_analysis
WHERE path_keywords % 'four dog night'
ORDER BY score DESC
LIMIT 10;
"

# Done in 10 minutes.
```

Only modify the import script if you plan to:
- Import new music weekly/daily
- Need PostgreSQL-specific features
- Want to maintain a PostgreSQL-native pipeline

Otherwise, pgloader is the obvious choice.

---

**Status:** Documentation complete
**Recommendation:** Use pgloader instead
**If you must modify:** Follow this guide
**Fuzzy search field:** `path_keywords` (already computed by import script)
