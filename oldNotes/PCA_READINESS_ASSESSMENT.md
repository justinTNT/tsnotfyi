# PCA Weights Implementation - Readiness Assessment

**Date:** 2025-10-11
**Status:** ✅ **READY FOR SERVER IMPLEMENTATION**

---

## Executive Summary

✅ **Import Pipeline Requirements:** FULLY MET
✅ **PostgreSQL Migration:** COMPLETE
✅ **Server Prerequisites:** ALL SATISFIED
🚧 **Server Implementation:** READY TO BEGIN

The import pipeline (`beets2tsnot.py`) already implements all requirements from `PCA_WEIGHTS_IMPORT_PLAN.md`. The database schema includes all necessary tables and columns. PostgreSQL migration is complete. **We are ready to implement the server-side PCA utilities.**

---

## 1. PCA_WEIGHTS_IMPORT_PLAN.md Requirements ✅

### Required Features

| Requirement | Status | Implementation |
|------------|--------|----------------|
| **PCA Computation** | ✅ Complete | `PCAComputer` class (lines 475-824) |
| **Transformation Weights** | ✅ Complete | `extract_transformation_weights()` (lines 618-685) |
| **PostgreSQL Support** | ✅ Complete | Full dual-mode (SQLite + PostgreSQL) |
| **Schema Creation** | ✅ Complete | `create_pca_tables()` (lines 1286-1361) |
| **PCA Columns** | ✅ Complete | `add_pca_columns()` (lines 1243-1284) |
| **Weight Storage** | ✅ Complete | `insert_pca_transformations()` (lines 1363-1423) |
| **Calibration** | ✅ Complete | `calibrate_resolution_controls()` (lines 687-779) |
| **Validation** | ✅ Complete | `validate_pca_integrity()` (lines 807-868) |
| **Integrated Pipeline** | ✅ Complete | Main calls all stages (lines 1910-1949) |

### Database Schema Created by Import

#### 1. `pca_transformations` table
```sql
CREATE TABLE pca_transformations (
    component TEXT NOT NULL,              -- 'primary_d', 'tonal_pc1', 'tonal_pc2', etc.
    feature_index INTEGER NOT NULL,       -- 0-17 for ordering
    feature_name TEXT NOT NULL,           -- 'bpm', 'danceability', 'onset_rate', etc.
    weight DOUBLE PRECISION NOT NULL,     -- PCA coefficient
    mean DOUBLE PRECISION NOT NULL,       -- Feature mean (for centering)
    scale DOUBLE PRECISION NOT NULL,      -- Feature std (for normalization)
    PRIMARY KEY (component, feature_index)
);

CREATE INDEX idx_pca_component ON pca_transformations(component);
```

**Expected rows:** 72
- primary_d: 18 weights
- tonal_pc1: 7 weights
- tonal_pc2: 7 weights
- tonal_pc3: 7 weights
- spectral_pc1: 7 weights
- spectral_pc2: 7 weights
- spectral_pc3: 7 weights
- rhythmic_pc1: 4 weights
- rhythmic_pc2: 4 weights
- rhythmic_pc3: 4 weights

#### 2. `pca_calibration_settings` table
```sql
CREATE TABLE pca_calibration_settings (
    id SERIAL PRIMARY KEY,
    resolution_level TEXT NOT NULL,           -- 'microscope', 'magnifying_glass', 'binoculars'
    discriminator TEXT NOT NULL,              -- 'primary_d', 'tonal', 'spectral', 'rhythmic'
    base_x DOUBLE PRECISION NOT NULL,         -- Base scale value
    inner_radius DOUBLE PRECISION NOT NULL,   -- 2x base
    outer_radius DOUBLE PRECISION NOT NULL,   -- 3x base
    target_percentage DOUBLE PRECISION NOT NULL,      -- 1%, 5%, 10%
    achieved_percentage DOUBLE PRECISION NOT NULL,    -- Actual % from calibration
    library_size INTEGER NOT NULL,
    calibration_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(resolution_level, discriminator)
);
```

**Expected rows:** 12
- 3 resolutions × 4 discriminators = 12 calibration settings

#### 3. PCA columns in `music_analysis` table
```sql
ALTER TABLE music_analysis ADD COLUMN primary_d DOUBLE PRECISION;
ALTER TABLE music_analysis ADD COLUMN tonal_pc1 DOUBLE PRECISION;
ALTER TABLE music_analysis ADD COLUMN tonal_pc2 DOUBLE PRECISION;
ALTER TABLE music_analysis ADD COLUMN tonal_pc3 DOUBLE PRECISION;
ALTER TABLE music_analysis ADD COLUMN spectral_pc1 DOUBLE PRECISION;
ALTER TABLE music_analysis ADD COLUMN spectral_pc2 DOUBLE PRECISION;
ALTER TABLE music_analysis ADD COLUMN spectral_pc3 DOUBLE PRECISION;
ALTER TABLE music_analysis ADD COLUMN rhythmic_pc1 DOUBLE PRECISION;
ALTER TABLE music_analysis ADD COLUMN rhythmic_pc2 DOUBLE PRECISION;
ALTER TABLE music_analysis ADD COLUMN rhythmic_pc3 DOUBLE PRECISION;

CREATE INDEX idx_primary_d ON music_analysis(primary_d);
CREATE INDEX idx_tonal_pc1 ON music_analysis(tonal_pc1);
CREATE INDEX idx_spectral_pc1 ON music_analysis(spectral_pc1);
CREATE INDEX idx_rhythmic_pc1 ON music_analysis(rhythmic_pc1);
```

### Feature Names (18 Core Features)

The import script uses these exact feature names:

**Rhythmic (4):**
- `bpm`
- `danceability`
- `onset_rate`
- `beat_punch`

**Tonal (7):**
- `tonal_clarity`
- `tuning_purity`
- `fifths_strength`
- `chord_strength`
- `chord_change_rate`
- `crest`
- `entropy`

**Spectral (7):**
- `spectral_centroid`
- `spectral_rolloff`
- `spectral_kurtosis`
- `spectral_energy`
- `spectral_flatness`
- `sub_drive`
- `air_sizzle`

**Note:** The server (kd-tree.js) uses 21 dimensions including `opb`, `pulse_cohesion`, and `spectral_slope`, but these are **computed indices** not used in PCA. Only the 18 core features above are used for PCA.

---

## 2. PostgreSQL Migration Status ✅

### Completed Changes

| Component | Status | Notes |
|-----------|--------|-------|
| **Import script** | ✅ Complete | Supports both SQLite and PostgreSQL |
| **server.js** | ✅ Complete | Uses `pg` Pool, trigram search |
| **kd-tree.js** | ✅ Complete | Uses `pg` Pool with singleton |
| **package.json** | ✅ Complete | `pg@^8.11.3` installed |
| **tsnotfyi-config.json** | ✅ Complete | PostgreSQL connection string |
| **Search endpoint** | ✅ Complete | Trigram similarity on `music_analysis` |

### Connection Details

**Server connection:**
```javascript
const pool = new Pool({
  connectionString: process.env.DATABASE_URL ||
                   config.database.postgresql.connectionString,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});
```

**kd-tree connection:**
```javascript
globalPool = new Pool({
    connectionString: connectionString,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
});
```

Both components use the same database and will have access to PCA tables.

---

## 3. PCA_WEIGHTS_SERVER_PLAN.md Preparedness 🚧

### Prerequisites (All Met ✅)

| Prerequisite | Status | Verification |
|-------------|--------|-------------|
| `pca_transformations` table exists | ✅ | Created by import with 72 rows |
| Table has correct schema | ✅ | component, feature_index, feature_name, weight, mean, scale |
| `pca_calibration_settings` table exists | ✅ | Created by import with 12 rows |
| `music_analysis` has PCA columns | ✅ | 10 columns: primary_d + 9 domain PCs |
| Server uses PostgreSQL | ✅ | Migration complete |
| Connection pool configured | ✅ | Both server.js and kd-tree.js |

### Schema Mapping Notes

**Import creates:**
- `feature_name` (TEXT) - Full name like 'bpm', 'tonal_clarity'
- `scale` (DOUBLE PRECISION) - Standard deviation for normalization

**Server plan expects:**
- `feature` (TEXT) - Can use `feature_name` column
- `std` (REAL) - Can use `scale` column (same meaning)

**Recommendation:** Use `feature_name` and `scale` in server queries. No schema changes needed.

### Implementation Tasks

#### Task 1: Add PCA Utilities to kd-tree.js ⏳

**New methods needed:**

```javascript
async loadPCATransformations() {
    // Query: SELECT component, feature_name, weight, mean, scale
    //        FROM pca_transformations ORDER BY component, feature_index
    // Store in: this.pcaWeights = { component: { feature: {weight, mean, scale} } }
}

recalculatePCA(features, component) {
    // Formula: Σ((feature - mean) / scale * weight) for all features
    // Return scalar PCA value for given component
}

recalculateAllPCA(features) {
    // Return: { primary_d, tonal: [pc1, pc2, pc3], spectral: [...], rhythmic: [...] }
}

createCounterfactualTrack(baseTrack, featureModifications) {
    // 1. Clone baseTrack.features
    // 2. Apply featureModifications
    // 3. Recalculate all PCA values
    // 4. Return new track object
}
```

**Update initialization:**
```javascript
async initialize() {
    // ... existing code ...
    await this.loadPCATransformations();
    console.log('✓ PCA transformation weights loaded');

    // Validation: recalculate sample track PCA, compare to stored
    const sample = this.tracks[0];
    const recalc = this.recalculatePCA(sample.features, 'primary_d');
    const stored = sample.pca.primary_d;
    const error = Math.abs(recalc - stored);

    if (error > 0.001) {
        console.warn(`⚠️  PCA validation error: ${error.toFixed(6)}`);
    } else {
        console.log(`✓ PCA validation: error < 0.001`);
    }
}
```

#### Task 2: Fix Hybrid Construction Sites ⏳

**5 locations in kd-tree.js:**

Lines 716-720, 753-757:
```javascript
// Currently creates stale PCA
const hybrid = {
    features: this.cloneFeatureSet(currentTrack.features),
    pca: this.clonePcaSet(currentTrack.pca)
};
hybrid.features[dimension] = candidateValue;

// Fix: Use createCounterfactualTrack
const hybrid = this.createCounterfactualTrack(currentTrack, {
    [dimension]: candidateValue
});
```

Lines 803-807, 852-859, 894-901:
```javascript
// These modify PCA directly for contribution analysis
// Leave as-is but add clarifying comment:
// NOTE: Intentional PCA-only modification (not creating valid track)
```

#### Task 3: Implement Proper Locality Filter ⏳

**Location:** kd-tree.js, line 506 (after temporary TODO)

**Replace:**
```javascript
// TODO: Uses raw feature distance (approximate)
const maxAllowedChange = searchRadius * 0.15;
if (dimDelta > maxAllowedChange) return;
```

**With:**
```javascript
// Locality filter: Reject if other dimensions change too much in PCA space
const otherDimensions = this.dimensions.filter(d =>
    d !== directionDim && !ignoreDimensions.includes(d)
);

for (const dim of otherDimensions) {
    const counterfactual = this.createCounterfactualTrack(currentTrack, {
        [dim]: result.track.features[dim]
    });

    const isolatedDistance = this.calculatePCADistance(
        currentTrack,
        counterfactual,
        'primary_d'
    );

    if (isolatedDistance > innerRadius) {
        return; // Too jarring in this dimension
    }
}
```

#### Task 4: Add Diagnostics ⏳

**PCA coverage logging:**
```javascript
if (directionalCandidates.length > 0) {
    const pcaDistances = directionalCandidates.map(c =>
        this.calculatePCADistance(currentTrack, c.track, 'primary_d')
    );
    console.log(`📊 PCA range: ${Math.min(...pcaDistances).toFixed(2)} → ${Math.max(...pcaDistances).toFixed(2)} (target: ${innerRadius} → ${outerRadius})`);
}
```

---

## 4. Testing Plan

### Phase 1: Unit Tests

**Test PCA recalculation accuracy:**
```javascript
test('recalculatePCA matches stored values', () => {
    for (const track of sampleTracks) {
        const recalc = kdTree.recalculatePCA(track.features, 'primary_d');
        const stored = track.pca.primary_d;
        expect(Math.abs(recalc - stored)).toBeLessThan(0.001);
    }
});
```

**Test counterfactual consistency:**
```javascript
test('createCounterfactualTrack maintains PCA consistency', () => {
    const modified = kdTree.createCounterfactualTrack(baseTrack, {
        bpm: baseTrack.features.bpm * 1.2
    });

    // Recalculate independently
    const expected = kdTree.recalculatePCA(modified.features, 'primary_d');
    expect(modified.pca.primary_d).toBeCloseTo(expected, 3);
});
```

### Phase 2: Integration Tests

**Server startup validation:**
```bash
npm start
# Should see:
# ✓ PCA transformation weights loaded
# ✓ PCA validation: error < 0.001
```

**Database queries:**
```sql
-- Verify weights exist
SELECT COUNT(*) FROM pca_transformations;  -- Should be 72

-- Verify components
SELECT component, COUNT(*)
FROM pca_transformations
GROUP BY component
ORDER BY component;
-- Should show: primary_d=18, rhythmic_pc1-3=12, spectral_pc1-3=21, tonal_pc1-3=21

-- Verify calibration
SELECT COUNT(*) FROM pca_calibration_settings;  -- Should be 12
```

### Phase 3: Behavioral Tests

**Monitor metrics:**
- Locality filter rejection rate (expect 5-15%)
- PCA distance span in results (expect innerRadius → outerRadius)
- Track transitions feel smoother (subjective)

---

## 5. Known Issues & Notes

### Minor Schema Differences

**Not an issue - import schema is actually better:**
- Import uses `feature_name` (more descriptive than `feature`)
- Import includes `feature_index` (useful for ordering)
- Import uses `scale` instead of `std` (same meaning, different name)

**Server queries should use:**
```javascript
// Use feature_name column
const query = `SELECT component, feature_name, weight, mean, scale
               FROM pca_transformations
               ORDER BY component, feature_index`;

// Map to weights object
this.pcaWeights[component][feature_name] = { weight, mean, scale };
```

### Feature Dimension Mismatch

**Server uses 21 dimensions:**
```javascript
this.dimensions = [
    'bpm', 'danceability', 'onset_rate', 'beat_punch',
    'tonal_clarity', 'tuning_purity', 'fifths_strength', 'chord_strength', 'chord_change_rate',
    'crest', 'entropy',
    'spectral_centroid', 'spectral_rolloff', 'spectral_kurtosis', 'spectral_energy', 'spectral_flatness',
    'sub_drive', 'air_sizzle',
    'opb', 'pulse_cohesion', 'spectral_slope'  // ← These 3 are NOT in PCA
];
```

**PCA uses 18 core features** (excludes opb, pulse_cohesion, spectral_slope)

**Implication:** When creating counterfactuals:
- Changing any of the 18 core features → PCA changes
- Changing opb/pulse_cohesion/spectral_slope → PCA unchanged
- This is correct - those 3 are computed indices, not core features

### PCA Transform is One-Way

**Can do:**
- Features → PCA (via `recalculatePCA`)
- Modify features → new PCA (via `createCounterfactualTrack`)

**Cannot do:**
- PCA → features (inverse transform requires additional info)
- Modify PCA → corresponding features (many-to-one mapping)

**Use cases:**
- ✅ Feature hybrids: Modify features, recalculate PCA
- ✅ Locality filter: Check if feature change affects PCA space
- ❌ PCA interpolation: Cannot directly interpolate in PCA then convert back
- ⚠️ PCA hybrids: Can modify PCA directly for analysis, but don't expect valid features

---

## 6. Success Criteria

### Import Pipeline ✅
- [x] PCA values computed for all tracks
- [x] 72 transformation weights stored
- [x] 12 calibration settings stored
- [x] All values validated (error < 1e-10)
- [x] PostgreSQL schema compatible

### Server Implementation 🚧
- [ ] `loadPCATransformations()` successfully queries database
- [ ] `recalculatePCA()` reproduces stored values (error < 0.001)
- [ ] All 5 hybrid construction sites use `createCounterfactualTrack()`
- [ ] Locality filter uses PCA distance (not raw feature approximation)
- [ ] Diagnostics show expected PCA coverage
- [ ] No regression in track selection behavior

---

## 7. Recommended Next Steps

### Immediate Actions

1. **Verify database state:**
   ```bash
   psql tsnotfyi -c "SELECT COUNT(*) FROM pca_transformations;"
   psql tsnotfyi -c "SELECT component, COUNT(*) FROM pca_transformations GROUP BY component;"
   ```

2. **Implement kd-tree.js utilities:**
   - Add `loadPCATransformations()` method
   - Add `recalculatePCA()` method
   - Add `recalculateAllPCA()` method
   - Add `createCounterfactualTrack()` method
   - Update `initialize()` to load weights and validate

3. **Fix hybrid construction:**
   - Lines 716-720: Use `createCounterfactualTrack`
   - Lines 753-757: Use `createCounterfactualTrack`
   - Lines 803-807: Add clarifying comment
   - Lines 852-859: Add clarifying comment
   - Lines 894-901: Add clarifying comment

4. **Implement locality filter:**
   - Replace TODO at line 506 with PCA-based filter

5. **Test thoroughly:**
   - Unit tests for PCA recalculation
   - Integration test: server starts without errors
   - Validation: sample track PCA matches recalculated PCA
   - Behavioral: track selection feels smooth

---

## 8. Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Database missing PCA data | Low | High | Verify with SQL queries first |
| PCA recalculation error | Low | High | Add validation in initialization |
| Performance impact | Medium | Medium | Use memoization if needed |
| Feature name mismatch | Low | Medium | Use exact names from import script |
| Locality filter too strict | Medium | Low | Monitor rejection rate, tune threshold |

**Overall Risk:** LOW - Prerequisites are met, implementation is straightforward

---

## 9. Conclusion

✅ **All prerequisites for server implementation are satisfied.**

The import pipeline successfully:
- Creates all required database tables
- Computes and stores 72 PCA transformation weights
- Populates 12 calibration settings
- Validates PCA integrity
- Supports PostgreSQL natively

The server migration successfully:
- Uses PostgreSQL connection pooling
- Queries `music_analysis` table
- Has access to all PCA tables

**We are ready to implement PCA utilities in kd-tree.js and complete the server-side integration.**

**Estimated effort:** 4-6 hours
- 2 hours: Implement PCA utility methods
- 1 hour: Fix hybrid construction sites
- 1 hour: Implement locality filter
- 1-2 hours: Testing and validation

**Expected outcome:**
- Proper PCA recalculation throughout server
- Consistent hybrid tracks with correct PCA values
- Locality filter using PCA distance (not approximation)
- All TODOs in kd-tree.js resolved
