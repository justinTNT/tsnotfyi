# Server PostgreSQL Migration Plan

**Estimated Effort:** 1.5-2 hours
**Complexity:** Low
**Risk:** Low

---

## Executive Summary

Migrate Node.js server from SQLite to PostgreSQL for improved fuzzy text matching and better concurrent access. This migration only requires changes to connection handling and query execution - all SQL queries are compatible.

**Benefits:**
- Real fuzzy matching with `similarity()` function
- Better concurrent access (connection pooling)
- Industry-standard database
- Better JSON support (JSONB)

---

## Files to Modify

1. `server.js` - Main server (30 minutes)
2. `kd-tree.js` - Data loading (45 minutes)
3. `package.json` - Dependencies (1 minute)
4. `tsnotfyi-config.json` - Configuration (1 minute)

**Total:** 4 files, ~77 lines of code

---

## 1. Dependency Changes

### package.json

**Before:**
```json
{
  "dependencies": {
    "sqlite3": "^5.1.6"
  }
}
```

**After:**
```json
{
  "dependencies": {
    "pg": "^8.11.3"
  }
}
```

**Install:**
```bash
npm uninstall sqlite3
npm install pg
```

---

## 2. Configuration Changes

### tsnotfyi-config.json

**Before:**
```json
{
  "database": {
    "path": "~/project/dev/manual.db"
  }
}
```

**After:**
```json
{
  "database": {
    "url": "postgresql://localhost/tsnotfyi"
  }
}
```

**Or use environment variable:**
```json
{
  "database": {
    "url": "${DATABASE_URL}"
  }
}
```

---

## 3. server.js Changes

### A. Import Statement (Line 8)

**Before:**
```javascript
const sqlite3 = require('sqlite3').verbose();
```

**After:**
```javascript
const { Pool } = require('pg');
```

---

### B. Database Connection (Lines 161-168)

**Before:**
```javascript
const dbPath = config.database.path.replace('~', process.env.HOME);
const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (err) => {
  if (err) {
    console.error('Database connection failed:', err.message);
  } else {
    console.log('📊 Connected to music database');
  }
});
```

**After:**
```javascript
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || config.database.url,
  max: 20,  // Maximum pool size
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

pool.on('connect', () => {
  console.log('📊 Connected to music database');
});

pool.on('error', (err) => {
  console.error('Unexpected database error:', err);
  // Pool handles reconnection automatically
});
```

---

### C. Search Query Execution (Lines 940-1044)

**Before:**
```javascript
const searchQuery = `
  SELECT
    identifier,
    CAST(path_b64 AS TEXT) as path_b64,
    CAST(beets_json_b64 AS TEXT) as beets_json_b64
  FROM tracks
  WHERE
    LOWER(CAST(path_b64 AS TEXT)) LIKE LOWER(?)
    OR identifier LIKE ?
  ORDER BY
    CASE
      WHEN LOWER(CAST(beets_json_b64 AS TEXT)) LIKE LOWER(?) THEN 1
      WHEN LOWER(CAST(path_b64 AS TEXT)) LIKE LOWER(?) THEN 2
      WHEN identifier LIKE ? THEN 3
      ELSE 4
    END,
    LENGTH(CAST(path_b64 AS TEXT))
  LIMIT ?
`;

db.all(searchQuery, [searchPattern, searchPattern, metadataPattern, pathPattern, md5Pattern, limit], (err, rows) => {
  if (err) {
    console.error('Search error:', err);
    return res.status(500).json({ error: 'Search failed' });
  }

  const results = rows.map(row => {
    // Process results...
  });

  res.json({ results, query, total: results.length });
});
```

**After (Basic - Same SQL):**
```javascript
const searchQuery = `
  SELECT
    identifier,
    CAST(path_b64 AS TEXT) as path_b64,
    CAST(beets_json_b64 AS TEXT) as beets_json_b64
  FROM tracks
  WHERE
    LOWER(CAST(path_b64 AS TEXT)) LIKE LOWER($1)
    OR identifier LIKE $2
  ORDER BY
    CASE
      WHEN LOWER(CAST(beets_json_b64 AS TEXT)) LIKE LOWER($3) THEN 1
      WHEN LOWER(CAST(path_b64 AS TEXT)) LIKE LOWER($4) THEN 2
      WHEN identifier LIKE $5 THEN 3
      ELSE 4
    END,
    LENGTH(CAST(path_b64 AS TEXT))
  LIMIT $6
`;

try {
  const result = await pool.query(searchQuery, [searchPattern, searchPattern, metadataPattern, pathPattern, md5Pattern, limit]);
  const rows = result.rows;

  const results = rows.map(row => {
    // Process results... (same logic)
  });

  res.json({ results, query, total: results.length });
} catch (err) {
  console.error('Search error:', err);
  return res.status(500).json({ error: 'Search failed' });
}
```

**After (Enhanced with Fuzzy Matching):**
```javascript
// First, enable pg_trgm extension (run once):
// psql tsnotfyi -c "CREATE EXTENSION IF NOT EXISTS pg_trgm;"

const searchQuery = `
  SELECT
    identifier,
    bt_title as title,
    bt_artist as artist,
    bt_path as path,
    similarity(
      COALESCE(bt_artist, '') || ' ' ||
      COALESCE(bt_title, '') || ' ' ||
      COALESCE(bt_album, ''),
      $1
    ) AS relevance_score
  FROM music_analysis
  WHERE
    (bt_artist || ' ' || bt_title || ' ' || bt_album) % $1
    OR identifier LIKE $2
  ORDER BY relevance_score DESC
  LIMIT $3
`;

try {
  const result = await pool.query(searchQuery, [query, `%${query}%`, limit]);
  const rows = result.rows;

  const results = rows.map(row => ({
    md5: row.identifier,
    title: row.title,
    artist: row.artist,
    path: row.path,
    relevance: row.relevance_score
  }));

  res.json({ results, query, total: results.length });
} catch (err) {
  console.error('Search error:', err);
  return res.status(500).json({ error: 'Search failed' });
}
```

**Key Changes:**
- `?` → `$1, $2, $3` (PostgreSQL positional parameters)
- `db.all()` → `await pool.query()`
- Callback pattern → async/await
- Access rows via `result.rows`
- Optional: Add fuzzy matching with `%` operator

---

## 4. kd-tree.js Changes

### A. Import Statement (Line 1)

**Before:**
```javascript
const sqlite3 = require('sqlite3').verbose();
```

**After:**
```javascript
const { Pool } = require('pg');
```

---

### B. Helper Functions (Lines 9-31)

**Before:**
```javascript
function openDatabase(dbPath) {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(dbPath, (err) => {
            if (err) {
                reject(new Error(`Database connection failed: ${err.message}`));
            } else {
                resolve(db);
            }
        });
    });
}

function runAll(db, query, params = []) {
    return new Promise((resolve, reject) => {
        db.all(query, params, (err, rows) => {
            if (err) {
                reject(err);
            } else {
                resolve(rows);
            }
        });
    });
}
```

**After:**
```javascript
// Module-level pool (shared across instances)
let globalPool = null;

function openDatabase(connectionConfig) {
    return new Promise((resolve, reject) => {
        try {
            if (globalPool) {
                resolve(globalPool);
                return;
            }

            globalPool = new Pool(
                typeof connectionConfig === 'string'
                    ? { connectionString: connectionConfig }
                    : connectionConfig
            );

            globalPool.on('error', (err) => {
                console.error('Unexpected database error:', err);
            });

            resolve(globalPool);
        } catch (err) {
            reject(new Error(`Database connection failed: ${err.message}`));
        }
    });
}

async function runAll(pool, query, params = []) {
    const result = await pool.query(query, params);
    return result.rows;
}
```

**Key Changes:**
- Pool singleton pattern (reuse connections)
- Callback → async/await
- Auto-reconnection handled by pool

---

### C. Constructor (Line 43)

**Before:**
```javascript
constructor(dbPath = config.database.path.replace('~', process.env.HOME)) {
    this.dbPath = dbPath;
    this.db = null;
    // ... rest
}
```

**After:**
```javascript
constructor(dbConfig = null) {
    this.dbConfig = dbConfig || {
        connectionString: process.env.DATABASE_URL ||
                         config.database.url ||
                         'postgresql://localhost/tsnotfyi'
    };
    this.db = null;
    // ... rest
}
```

---

### D. Initialize Method (Lines 144-161)

**Before:**
```javascript
async initialize() {
    if (this.db) {
        return;
    }

    this.db = await openDatabase(this.dbPath);
    console.log('Connected to musical database');

    await Promise.all([
        this.loadTracks(),
        this.loadCalibrationSettings()
    ]);

    console.log(`Loaded ${this.tracks.length} tracks`);
    console.log(`Loaded calibration settings for ${Object.keys(this.calibrationSettings).length} resolutions`);
    this.buildTree();
    console.log('KD-tree constructed');
}
```

**After:**
```javascript
// No changes needed! Just works with new openDatabase()
async initialize() {
    if (this.db) {
        return;
    }

    this.db = await openDatabase(this.dbConfig);
    console.log('Connected to musical database');

    await Promise.all([
        this.loadTracks(),
        this.loadCalibrationSettings()
    ]);

    console.log(`Loaded ${this.tracks.length} tracks`);
    console.log(`Loaded calibration settings for ${Object.keys(this.calibrationSettings).length} resolutions`);
    this.buildTree();
    console.log('KD-tree constructed');
}
```

---

### E. Load Tracks Query (Lines 163-222)

**SQL is 100% compatible - no changes needed!**

```javascript
async loadTracks() {
    const query = `
        SELECT
            identifier,
            bt_title as title,
            bt_artist as artist,
            bt_path as path,
            bt_length as length,
            ${this.dimensions.join(', ')},
            primary_d,
            tonal_pc1, tonal_pc2, tonal_pc3,
            spectral_pc1, spectral_pc2, spectral_pc3,
            rhythmic_pc1, rhythmic_pc2, rhythmic_pc3,
            love,hate,beets_meta
        FROM music_analysis
        WHERE bpm IS NOT NULL and hate IS 0
        AND spectral_centroid IS NOT NULL
        AND primary_d IS NOT NULL
        ORDER BY identifier
    `;

    const rows = await runAll(this.db, query);
    // ... rest unchanged
}
```

---

### F. Load Calibration Settings (Lines 224-251)

**SQL is 100% compatible - no changes needed!**

```javascript
async loadCalibrationSettings() {
    const query = `
        SELECT resolution_level as resolution, discriminator, base_x, inner_radius, outer_radius, achieved_percentage, scaling_factor
        FROM pca_calibration_settings
        ORDER BY resolution_level, discriminator
    `;

    try {
        const rows = await runAll(this.db, query);
        // ... rest unchanged
    } catch (err) {
        console.warn('Could not load calibration settings:', err);
        this.calibrationSettings = {};
    }
}
```

---

### G. Close Method (Lines 954-958)

**Before:**
```javascript
close() {
    if (this.db) {
        this.db.close();
    }
}
```

**After:**
```javascript
async close() {
    if (this.db) {
        await this.db.end();  // Gracefully close pool
    }
}
```

---

## 5. Data Migration

**Don't rebuild - just import existing database!**

```bash
# Install tools
brew install postgresql pgloader

# Start PostgreSQL
brew services start postgresql

# Create database
createdb tsnotfyi

# Import existing SQLite database
pgloader ~/project/dev/manual.db postgresql://localhost/tsnotfyi

# Add fuzzy search index
psql tsnotfyi <<EOF
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX idx_fuzzy_search ON music_analysis
USING GIN ((bt_artist || ' ' || COALESCE(bt_title, '') || ' ' || COALESCE(bt_album, '')) gin_trgm_ops);
EOF
```

---

## 6. Testing Checklist

```bash
# 1. Install dependencies
npm install pg
npm uninstall sqlite3

# 2. Update configuration
# Edit tsnotfyi-config.json

# 3. Test database connection
node -e "const {Pool} = require('pg'); const p = new Pool({connectionString: 'postgresql://localhost/tsnotfyi'}); p.query('SELECT 1').then(() => console.log('✅ Connected')).catch(console.error)"

# 4. Start server
node server.js
# Should see: "📊 Connected to music database"

# 5. Test basic search
curl "http://localhost:3001/search?q=test&limit=10"

# 6. Test fuzzy search
curl "http://localhost:3001/search?q=four+dog+night&limit=10"

# 7. Test KD-tree loading
# Check logs for: "Loaded X tracks"
# Check logs for: "Loaded calibration settings for Y resolutions"

# 8. Test session creation
curl -X POST http://localhost:3001/create-session

# 9. Monitor connection pool
psql tsnotfyi -c "SELECT count(*) FROM pg_stat_activity WHERE datname='tsnotfyi';"
```

---

## 7. Rollback Strategy

### Option A: Feature Flag

```javascript
const DB_TYPE = process.env.DB_TYPE || 'postgres';

if (DB_TYPE === 'sqlite') {
    const sqlite3 = require('sqlite3');
    db = new sqlite3.Database(dbPath);
} else {
    const { Pool } = require('pg');
    db = new Pool({ connectionString: dbUrl });
}
```

### Option B: Git Branch

```bash
git checkout -b postgres-migration
# Make changes
# Test thoroughly
git checkout main  # Rollback if needed
```

---

## 8. Performance Optimizations

### Connection Pooling

```javascript
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,                    // Maximum connections
  min: 5,                     // Minimum idle connections
  idleTimeoutMillis: 30000,   // Close idle connections after 30s
  connectionTimeoutMillis: 2000,
});
```

### Query Performance

```sql
-- After migration, analyze tables for better query planning
ANALYZE music_analysis;
ANALYZE pca_calibration_settings;

-- Check slow queries
SELECT query, calls, mean_exec_time
FROM pg_stat_statements
ORDER BY mean_exec_time DESC
LIMIT 10;
```

---

## 9. Common Issues & Solutions

### Issue: "relation does not exist"

```bash
# Make sure pgloader completed successfully
psql tsnotfyi -c "\dt"
# Should show: music_analysis, pca_calibration_settings, etc.
```

### Issue: "password authentication failed"

```bash
# Set password in environment
export DATABASE_URL="postgresql://user:password@localhost/tsnotfyi"

# Or use .pgpass file
echo "localhost:5432:tsnotfyi:user:password" >> ~/.pgpass
chmod 600 ~/.pgpass
```

### Issue: Connection pool exhausted

```javascript
// Increase pool size
const pool = new Pool({
  max: 50,  // Increase from default 20
});
```

### Issue: Slow queries

```sql
-- Check if indexes exist
SELECT indexname FROM pg_indexes WHERE tablename = 'music_analysis';

-- Recreate indexes if needed
CREATE INDEX idx_bt_artist ON music_analysis(bt_artist);
CREATE INDEX idx_primary_d ON music_analysis(primary_d);
```

---

## 10. Summary of Changes

| File | Lines Changed | Complexity | Time |
|------|---------------|------------|------|
| `server.js` | ~30 | Low | 30 min |
| `kd-tree.js` | ~45 | Low | 45 min |
| `package.json` | 1 | Trivial | 1 min |
| `tsnotfyi-config.json` | 2 | Trivial | 1 min |
| **TOTAL** | **~78** | **Low** | **1.25 hours** |

**Plus testing/verification: 15-30 minutes**

**Total effort: 1.5-2 hours**

---

## 11. Quick Reference: SQLite vs PostgreSQL

| Feature | SQLite | PostgreSQL |
|---------|--------|------------|
| Import | `require('sqlite3')` | `require('pg')` |
| Connection | `new Database(path)` | `new Pool(config)` |
| Query | `db.all(sql, params, callback)` | `await pool.query(sql, params)` |
| Placeholder | `?` | `$1, $2, $3` |
| Result | `rows` in callback | `result.rows` |
| Close | `db.close()` | `await pool.end()` |
| Fuzzy search | Not built-in | `similarity()`, `%` operator |

---

## 12. Post-Migration Benefits

✅ **Real fuzzy matching** - "Four dog night" matches "Fourth night"
✅ **Better concurrency** - 20 simultaneous connections
✅ **Connection pooling** - Automatic connection reuse
✅ **Better JSON support** - JSONB indexing
✅ **Industry standard** - Easier to find help/documentation
✅ **Better monitoring** - pg_stat_statements, pg_stat_activity

---

**Migration Status:** Ready to execute
**Recommended Approach:** Import data with pgloader, update server code
**Estimated Downtime:** None (can test in parallel)
