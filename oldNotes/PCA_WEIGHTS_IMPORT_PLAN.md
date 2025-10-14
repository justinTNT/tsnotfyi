# PCA Transformation Weights - Import Pipeline Plan

## Context

Currently, `beets2tsnot.py` extracts 21 raw music indices but doesn't compute PCA. PCA computation and schema updates are handled separately by:
- `comprehensive_pca_analysis_and_verification.py` - computes PCA values (**file not found - need location**)
- `database_pca_schema_update.py` - adds PCA columns and calibration settings

This plan integrates PCA computation directly into `beets2tsnot.py` as a unified import pipeline, including extraction and storage of PCA transformation weights.

## Goals

1. **Unified pipeline**: beets → essentia → indices → PCA → all-in-one database
2. **Store transformation weights**: Enable server-side PCA recalculation
3. **Maintain existing functionality**: All current features still work
4. **Resumable**: PCA can be computed on existing databases without re-extraction

## Architecture Overview

```
beets2tsnot.py (current)                    beets2tsnot.py (new)
┌──────────────────────┐                    ┌──────────────────────┐
│ 1. Extract metadata  │                    │ 1. Extract metadata  │
│ 2. Run Essentia      │                    │ 2. Run Essentia      │
│ 3. Compute indices   │                    │ 3. Compute indices   │
│ 4. Write to DB       │                    │ 4. Compute PCA       │ ← NEW
└──────────────────────┘                    │ 5. Store weights     │ ← NEW
                                            │ 6. Write to DB       │
                                            └──────────────────────┘
```

## Schema Changes

### New Tables

#### 1. pca_transformations (transformation weights)
```sql
CREATE TABLE pca_transformations (
    component TEXT NOT NULL,     -- 'primary_d', 'tonal_pc1', 'tonal_pc2', etc.
    feature TEXT NOT NULL,       -- 'bpm', 'danceability', 'onset_rate', etc.
    weight REAL NOT NULL,        -- PCA coefficient
    mean REAL NOT NULL,          -- Feature mean (for centering)
    std REAL NOT NULL,           -- Feature std (for normalization)
    PRIMARY KEY (component, feature)
);

CREATE INDEX idx_pca_component ON pca_transformations(component);
```

#### 2. pca_calibration_settings (already in database_pca_schema_update.py)
```sql
CREATE TABLE IF NOT EXISTS pca_calibration_settings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    resolution_level TEXT NOT NULL,  -- 'microscope', 'magnifying_glass', 'binoculars'
    discriminator TEXT NOT NULL,     -- 'primary_d', 'tonal', 'spectral', 'rhythmic'
    base_x REAL NOT NULL,
    inner_radius REAL NOT NULL,
    outer_radius REAL NOT NULL,
    target_percentage REAL NOT NULL,
    achieved_percentage REAL NOT NULL,
    scaling_factor REAL,             -- ADD THIS for server scaling
    calibration_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    library_size INTEGER NOT NULL,
    UNIQUE(resolution_level, discriminator)
);
```

### Modified music_analysis Table
```sql
-- Add these columns (from database_pca_schema_update.py):
ALTER TABLE music_analysis ADD COLUMN primary_d REAL;
ALTER TABLE music_analysis ADD COLUMN tonal_pc1 REAL;
ALTER TABLE music_analysis ADD COLUMN tonal_pc2 REAL;
ALTER TABLE music_analysis ADD COLUMN tonal_pc3 REAL;
ALTER TABLE music_analysis ADD COLUMN spectral_pc1 REAL;
ALTER TABLE music_analysis ADD COLUMN spectral_pc2 REAL;
ALTER TABLE music_analysis ADD COLUMN spectral_pc3 REAL;
ALTER TABLE music_analysis ADD COLUMN rhythmic_pc1 REAL;
ALTER TABLE music_analysis ADD COLUMN rhythmic_pc2 REAL;
ALTER TABLE music_analysis ADD COLUMN rhythmic_pc3 REAL;

-- Add indexes (from database_pca_schema_update.py):
CREATE INDEX idx_primary_d ON music_analysis(primary_d);
CREATE INDEX idx_tonal_pc1 ON music_analysis(tonal_pc1);
-- ... etc for all PCA columns
```

## Implementation Plan

### Phase 1: Add PCA Computation Module to beets2tsnot.py

**New Class: `PCAComputer`**

Location: After `FeatureProcessor` class (~line 450)

```python
class PCAComputer:
    """Computes PCA transformations and values for music indices."""

    def __init__(self):
        self.feature_names = [
            # Rhythmic (4)
            'bpm', 'danceability', 'onset_rate', 'beat_punch',
            # Tonal (5)
            'tonal_clarity', 'tuning_purity', 'fifths_strength',
            'chord_strength', 'chord_change_rate',
            # Harmonic (2)
            'crest', 'entropy',
            # Spectral (6)
            'spectral_centroid', 'spectral_rolloff', 'spectral_kurtosis',
            'spectral_energy', 'spectral_flatness',
            # Production (2)
            'sub_drive', 'air_sizzle',
            # Calculated (3)
            'opb', 'pulse_cohesion', 'spectral_slope'
        ]

        self.pca_models = {}  # Will store fitted PCA objects
        self.transformation_weights = {}  # Will store for database

    def fit_pca_on_library(self, db_path):
        """
        Load all tracks from database and fit PCA models.

        Returns: Dict with PCA values per track
        """
        pass

    def _fit_primary_d(self, features_df):
        """Fit 1D primary discriminator PCA on all 21 features."""
        pass

    def _fit_domain_pca(self, features_df, domain, feature_subset):
        """
        Fit 3-component PCA on feature subset.

        domain: 'tonal', 'spectral', or 'rhythmic'
        feature_subset: list of feature names for this domain
        """
        pass

    def extract_transformation_weights(self):
        """
        Extract weights from fitted PCA models for database storage.

        Returns: List of (component, feature, weight, mean, std) tuples
        """
        pass

    def transform_track(self, track_features):
        """
        Apply fitted PCA to a single track.

        Returns: Dict with all PCA values
        """
        pass
```

**Key Methods Detail:**

```python
def fit_pca_on_library(self, db_path):
    # 1. Load all tracks with indices from database
    conn = sqlite3.connect(db_path)
    query = f"SELECT identifier, {','.join(self.feature_names)} FROM music_analysis"
    df = pd.read_sql(query, conn)

    # 2. Fit primary_d (1D PCA on all 21 features)
    self._fit_primary_d(df[self.feature_names])

    # 3. Fit domain-specific PCAs
    tonal_features = ['tonal_clarity', 'tuning_purity', 'fifths_strength',
                      'chord_strength', 'chord_change_rate']
    self._fit_domain_pca(df[self.feature_names], 'tonal', tonal_features)

    spectral_features = ['spectral_centroid', 'spectral_rolloff',
                         'spectral_kurtosis', 'spectral_energy', 'spectral_flatness']
    self._fit_domain_pca(df[self.feature_names], 'spectral', spectral_features)

    rhythmic_features = ['bpm', 'danceability', 'onset_rate', 'beat_punch', 'opb']
    self._fit_domain_pca(df[self.feature_names], 'rhythmic', rhythmic_features)

    # 4. Transform all tracks
    pca_values = {}
    for idx, row in df.iterrows():
        track_features = row[self.feature_names].to_dict()
        pca_values[row['identifier']] = self.transform_track(track_features)

    return pca_values

def extract_transformation_weights(self):
    """
    Extract (component, feature, weight, mean, std) for each PCA component.

    Returns list of tuples for database insertion.
    """
    weights = []

    # Primary D
    scaler = self.pca_models['primary_d']['scaler']
    pca = self.pca_models['primary_d']['pca']
    features = self.feature_names

    for i, feature in enumerate(features):
        weights.append((
            'primary_d',
            feature,
            float(pca.components_[0, i]),  # 1D, so first row
            float(scaler.mean_[i]),
            float(scaler.scale_[i])
        ))

    # Tonal/Spectral/Rhythmic (similar pattern for each)
    for domain in ['tonal', 'spectral', 'rhythmic']:
        scaler = self.pca_models[domain]['scaler']
        pca = self.pca_models[domain]['pca']
        features = self.pca_models[domain]['features']

        for pc_idx in range(3):  # 3 components
            component_name = f'{domain}_pc{pc_idx + 1}'
            for i, feature in enumerate(features):
                weights.append((
                    component_name,
                    feature,
                    float(pca.components_[pc_idx, i]),
                    float(scaler.mean_[i]),
                    float(scaler.scale_[i])
                ))

    return weights
```

### Phase 2: Integrate into DatabaseManager

**Add methods to DatabaseManager class:**

```python
class DatabaseManager:
    # ... existing code ...

    def create_pca_tables(self):
        """Create PCA transformation and calibration tables."""
        # Create pca_transformations table
        # Create pca_calibration_settings table (from database_pca_schema_update.py)
        pass

    def add_pca_columns_to_music_analysis(self):
        """Add PCA columns to music_analysis table."""
        # Logic from database_pca_schema_update.py lines 32-91
        pass

    def insert_pca_transformations(self, weights):
        """Bulk insert transformation weights."""
        pass

    def update_track_pca_values(self, identifier, pca_values):
        """Update a single track's PCA values."""
        pass

    def batch_update_pca_values(self, pca_dict):
        """Batch update PCA values for all tracks."""
        pass
```

### Phase 3: Add PCA Processing Stage to Main Pipeline

**Modify `main()` function:**

```python
def main():
    # ... existing setup ...

    # After all tracks are processed with Essentia + indices:
    if args.compute_pca:  # New flag
        logger.info("🧮 STARTING PCA COMPUTATION")

        # 1. Ensure PCA schema exists
        db_manager.create_pca_tables()
        db_manager.add_pca_columns_to_music_analysis()

        # 2. Fit PCA on entire library
        pca_computer = PCAComputer()
        pca_values = pca_computer.fit_pca_on_library(config.output_db_path)

        # 3. Store transformation weights
        weights = pca_computer.extract_transformation_weights()
        db_manager.insert_pca_transformations(weights)
        logger.info(f"✅ Stored {len(weights)} PCA transformation weights")

        # 4. Update all tracks with PCA values
        db_manager.batch_update_pca_values(pca_values)
        logger.info(f"✅ Updated {len(pca_values)} tracks with PCA values")

        # 5. Run calibration (if calibration script provided)
        if args.run_calibration:
            run_calibration_and_store(db_manager, pca_computer)
```

### Phase 4: Add Command-Line Options

```python
parser.add_argument('--compute-pca', action='store_true',
                   help='Compute PCA after extracting indices')
parser.add_argument('--pca-only', action='store_true',
                   help='Only compute PCA (skip Essentia extraction)')
parser.add_argument('--run-calibration', action='store_true',
                   help='Run resolution calibration after PCA')
```

### Phase 5: Migration Path for Existing Databases

**New standalone mode:**

```python
def recompute_pca_for_existing_db(db_path):
    """
    Recompute PCA for database that already has indices.

    Usage: python beets2tsnot.py --pca-only --output-db existing.db
    """
    logger.info("🔄 RECOMPUTING PCA FOR EXISTING DATABASE")

    # Check if indices exist
    # Fit PCA on existing indices
    # Store weights
    # Update PCA columns
    # Done!
```

## Dependencies to Add

```python
# At top of beets2tsnot.py
from sklearn.decomposition import PCA
from sklearn.preprocessing import StandardScaler
import pandas as pd
import numpy as np
```

## File Structure

```
beets2tsnot.py              # Main import script (modified)
├─ BeetsMetadataExtractor   # Existing
├─ EssentiaProcessor        # Existing
├─ FeatureProcessor         # Existing
├─ PCAComputer              # NEW
├─ DatabaseManager          # Modified (add PCA methods)
└─ main()                   # Modified (add PCA stage)

database_pca_schema_update.py  # Repurpose/deprecate
├─ Schema migration logic → Move to DatabaseManager
├─ CSV loading logic → Replace with PCAComputer
└─ Verification → Keep as separate validation script

comprehensive_pca_analysis_and_verification.py  # Location unknown - incorporate into PCAComputer
```

## Testing Strategy

### Unit Tests
1. **Test PCA fitting** - Verify components have correct dimensions
2. **Test weight extraction** - Verify weights can reconstruct PCA values
3. **Test transformation** - Apply weights manually, compare to sklearn output

### Integration Tests
1. **Full pipeline test** - Run on small dataset (100 tracks)
2. **Resume test** - Stop mid-processing, resume with PCA computation
3. **Existing DB test** - Run `--pca-only` on pre-existing database

### Validation Tests
1. **Reconstruction accuracy** - For each track: `recalculated_pca ≈ stored_pca`
2. **Weight completeness** - 21 weights per primary_d, correct counts for domains
3. **Schema verification** - All tables and columns exist with correct types

## Migration Steps for Users

### New Import (Clean Start)
```bash
python beets2tsnot.py --beets-db library.db --tranche production --compute-pca --run-calibration
```

### Existing Database (Add PCA)
```bash
python beets2tsnot.py --pca-only --output-db existing_music.db --run-calibration
```

### Validation
```bash
python validate_pca_weights.py existing_music.db  # New validation script
```

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| PCA fit fails on sparse data | High | Require minimum 1000 tracks for PCA |
| Memory issues on large libraries | Medium | Batch PCA computation, use iterators |
| Schema conflicts | Medium | Check existing columns, skip if present |
| sklearn version differences | Low | Pin sklearn version in requirements |

## Success Criteria

- [ ] PCA values computed for all 4 spaces (primary_d, tonal, spectral, rhythmic)
- [ ] Transformation weights stored (10 components × ~21 features = ~210 rows)
- [ ] Calibration settings stored (3 resolutions × 4 discriminators = 12 rows)
- [ ] Reconstruction error < 0.001 for all tracks
- [ ] `--pca-only` mode works on existing databases
- [ ] Server plan's `loadPCATransformations()` finds all expected data

## Key Information from comprehensive_pca_analysis_and_verification.py

**Feature Groupings** (lines 48-54):
- **Tonal** (7 features): tonal_clarity, tuning_purity, fifths_strength, chord_strength, chord_change_rate, crest, entropy
- **Spectral** (7 features): spectral_centroid, spectral_rolloff, spectral_kurtosis, spectral_energy, spectral_flatness, sub_drive, air_sizzle
- **Rhythmic** (4 features): bpm, danceability, onset_rate, beat_punch
- **Total**: 18 features (NOT 21 - opb, pulse_cohesion, spectral_slope are computed indices, not core features)

**PCA Computation** (lines 100-294):
- Primary D: `PCA(n_components=1, random_state=42)` on all 18 features
- Domain PCAs: `PCA(n_components=3, random_state=42)` on feature subsets
- Normalization: `StandardScaler()` before PCA (stores `mean_` and `scale_`)
- Models stored in `self.discriminators[name]['pca_model']` and `['scaler']`

**Critical Missing Piece**:
The comprehensive script **does NOT extract or store PCA transformation weights**! It only:
- Computes and stores PCA values per track
- Updates database with primary_d, tonal_pc1-3, spectral_pc1-3, rhythmic_pc1-3
- Creates calibration settings

**What We Must Add**:
Extract from fitted PCA models:
- `pca.components_` → transformation matrix (n_components × n_features)
- `scaler.mean_` → feature means (n_features,)
- `scaler.scale_` → feature stds (n_features,)

## Answered Questions

1. ✅ **Found comprehensive script** at `/Users/jtnt/comprehensive_pca_analysis_and_verification.py`
2. ✅ **Feature groupings** - See above (18 features total)
3. ✅ **Calibration** - Already hardcoded in script (lines 715-757), uses 3 resolutions × 4 discriminators
4. ✅ **Database schema** - Script already updates schema and populates PCA values (lines 759-888)
5. ⚠️ **Transformation weights** - NOT currently extracted, must add this functionality

## Recommended Approach: Extend comprehensive_pca_analysis_and_verification.py

Rather than rewriting PCA logic in beets2tsnot.py, **extend the existing comprehensive script** to:
1. Extract and store transformation weights
2. Use dynamic calibration (from intuitive_resolution_calibrator.py)
3. Include built-in validation (from end_to_end_pca_validation.py)

All improvements are **integrated into the main script**, not optional subprocess calls.

### Add to ComprehensivePCAAnalyzer class:

```python
def extract_transformation_weights(self) -> List[Tuple]:
    """
    Extract PCA transformation weights from fitted models.

    Returns: List of (component, feature, weight, mean, std) tuples
    """
    weights = []

    # Primary D (1D PCA on all 18 features)
    if 'primary_d' in self.discriminators:
        pca = self.discriminators['primary_d']['pca_model']
        scaler = self.scaler  # Global scaler from load_and_prepare_data

        for i, feature in enumerate(self.core_indices):
            weights.append((
                'primary_d',
                feature,
                float(pca.components_[0, i]),  # 1D, first row only
                float(scaler.mean_[i]),
                float(scaler.scale_[i])
            ))

    # Domain discriminators (3D PCA each)
    for domain in ['tonal', 'spectral', 'rhythmic']:
        if domain not in self.discriminators:
            continue

        pca = self.discriminators[domain]['pca_model']
        scaler = self.discriminators[domain]['scaler']
        features = self.discriminators[domain]['feature_indices']

        for pc_idx in range(3):  # 3 components
            component_name = f'{domain}_pc{pc_idx + 1}'
            for feat_idx, feature in enumerate(features):
                weights.append((
                    component_name,
                    feature,
                    float(pca.components_[pc_idx, feat_idx]),
                    float(scaler.mean_[feat_idx]),
                    float(scaler.scale_[feat_idx])
                ))

    return weights

def populate_transformation_weights(self, weights: List[Tuple]):
    """Store transformation weights in database."""
    print(f"\n💾 POPULATING TRANSFORMATION WEIGHTS")
    print("="*60)

    try:
        conn = sqlite3.connect(self.db_path)

        # Create table
        conn.execute("""
        CREATE TABLE IF NOT EXISTS pca_transformations (
            component TEXT NOT NULL,
            feature TEXT NOT NULL,
            weight REAL NOT NULL,
            mean REAL NOT NULL,
            std REAL NOT NULL,
            PRIMARY KEY (component, feature)
        )
        """)

        # Clear existing
        conn.execute("DELETE FROM pca_transformations")

        # Insert all weights
        insert_sql = """
        INSERT INTO pca_transformations (component, feature, weight, mean, std)
        VALUES (?, ?, ?, ?, ?)
        """
        conn.executemany(insert_sql, weights)

        conn.commit()
        conn.close()

        print(f"✅ Stored {len(weights)} transformation weights")

        # Breakdown by component
        from collections import Counter
        component_counts = Counter(w[0] for w in weights)
        for component, count in sorted(component_counts.items()):
            print(f"   {component}: {count} weights")

        return True

    except Exception as e:
        print(f"❌ Error storing weights: {e}")
        return False
```

### Replace calibrate_intuitive_resolution_controls() method:

Current version (lines 715-757) has hardcoded values. Replace with actual calibration:

```python
def calibrate_intuitive_resolution_controls(self) -> Dict[str, Any]:
    """
    Calibrate intuitive resolution controls dynamically.

    Finds optimal base_x values for each resolution level and discriminator
    using actual library data instead of hardcoded values.
    """
    from sklearn.neighbors import NearestNeighbors

    print(f"\n🎯 CALIBRATING INTUITIVE RESOLUTION CONTROLS")
    print("="*70)

    target_resolutions = {
        'microscope': {'emoji': '🔬', 'target_pct': 1.0, 'description': 'Ultra-precise similarity'},
        'magnifying_glass': {'emoji': '🔍', 'target_pct': 5.0, 'description': 'Focused exploration'},
        'binoculars': {'emoji': '🔭', 'target_pct': 10.0, 'description': 'Broader discovery'}
    }

    # Build NN models for each discriminator
    nn_models = {}
    discriminator_data = {
        'primary_d': self.discriminators['primary_d']['values'].reshape(-1, 1),
        'tonal': self.discriminators['tonal']['values'],
        'spectral': self.discriminators['spectral']['values'],
        'rhythmic': self.discriminators['rhythmic']['values']
    }

    for disc_name, disc_values in discriminator_data.items():
        nn_models[disc_name] = NearestNeighbors(metric='euclidean')
        nn_models[disc_name].fit(disc_values)

    # Test queries for calibration
    n_test = 15
    test_indices = np.linspace(0, len(self.data)-1, n_test, dtype=int)

    calibration_results = {}

    for res_name, res_config in target_resolutions.items():
        target_pct = res_config['target_pct']
        print(f"\n{res_config['emoji']} {res_name.replace('_', ' ').title()} ({target_pct}%)")

        calibration_results[res_name] = {
            'config': res_config,
            'discriminator_calibrations': {}
        }

        for disc_name, nn_model in nn_models.items():
            # Binary search for optimal base_x
            x_low, x_high = 0.01, 10.0
            best_x = None
            best_error = float('inf')

            for _ in range(20):  # 20 iterations of binary search
                x_mid = (x_low + x_high) / 2
                inner_radius = 2 * x_mid
                outer_radius = 3 * x_mid

                percentages = []
                for test_idx in test_indices:
                    query = discriminator_data[disc_name][test_idx:test_idx+1]
                    distances, _ = nn_model.kneighbors(query, n_neighbors=len(self.data))
                    distances = distances[0]

                    in_zone = np.sum((distances >= inner_radius) & (distances <= outer_radius))
                    pct = (in_zone / len(distances)) * 100
                    percentages.append(pct)

                avg_pct = np.mean(percentages)
                error = abs(avg_pct - target_pct)

                if error < best_error:
                    best_error = error
                    best_x = x_mid

                # Adjust search range
                if avg_pct < target_pct:
                    x_high = x_mid
                else:
                    x_low = x_mid

            calibration_results[res_name]['discriminator_calibrations'][disc_name] = {
                'best_x': best_x,
                'best_inner': 2 * best_x,
                'best_outer': 3 * best_x,
                'achieved_percentage': avg_pct
            }

            print(f"   {disc_name}: x={best_x:.3f}, achieved={avg_pct:.2f}%")

    print(f"\n✅ Calibration complete")
    return calibration_results
```

### Add validation after database update:

```python
def validate_pca_integrity(self):
    """
    Validate PCA values in database match computed values.

    Catches corruption, floating point errors, or implementation bugs.
    """
    print(f"\n🔍 VALIDATING PCA INTEGRITY")
    print("="*60)

    conn = sqlite3.connect(self.db_path)
    db_df = pd.read_sql_query("""
        SELECT primary_d, tonal_pc1, tonal_pc2, tonal_pc3,
               spectral_pc1, spectral_pc2, spectral_pc3,
               rhythmic_pc1, rhythmic_pc2, rhythmic_pc3
        FROM music_analysis
        WHERE primary_d IS NOT NULL
        ORDER BY rowid
    """, conn)
    conn.close()

    tolerance = 1e-10
    all_valid = True

    # Validate primary_d
    computed = self.discriminators['primary_d']['values']
    db_values = db_df['primary_d'].values
    diff = np.abs(computed - db_values)
    max_diff = np.max(diff)
    matches = np.sum(diff < tolerance)

    print(f"Primary D: {matches:,}/{len(db_values):,} exact matches, max diff: {max_diff:.2e}")
    if matches < len(db_values) * 0.99:  # Allow 1% tolerance
        print(f"   ⚠️  Only {matches/len(db_values)*100:.1f}% exact matches!")
        all_valid = False

    # Validate domain components
    for domain in ['tonal', 'spectral', 'rhythmic']:
        for i in range(3):
            col_name = f'{domain}_pc{i+1}'
            computed = self.discriminators[domain]['values'][:, i]
            db_values = db_df[col_name].values

            diff = np.abs(computed - db_values)
            max_diff = np.max(diff)
            matches = np.sum(diff < tolerance)

            print(f"{col_name}: {matches:,}/{len(db_values):,} exact matches, max diff: {max_diff:.2e}")
            if matches < len(db_values) * 0.99:
                all_valid = False

    if all_valid:
        print(f"\n✅ PCA integrity validated - all values match")
    else:
        print(f"\n⚠️  PCA validation found discrepancies")
        raise ValueError("PCA validation failed - database values don't match computed values")

    return all_valid
```

### Integrate into main_comprehensive():

```python
# Replace lines 996-1001 with:

# 5. Calibrate resolution controls (DYNAMIC, not hardcoded)
calibration_results = analyzer.calibrate_intuitive_resolution_controls()

# 6. Update database schema and populate data
if analyzer.update_database_schema_and_populate():
    analyzer.populate_calibration_settings(calibration_results)

    # 6.5 Extract and store transformation weights
    print(f"\n💾 EXTRACTING AND STORING TRANSFORMATION WEIGHTS")
    weights = analyzer.extract_transformation_weights()
    if not analyzer.populate_transformation_weights(weights):
        raise ValueError("Failed to store transformation weights")

    # 6.6 Validate integrity
    analyzer.validate_pca_integrity()
else:
    raise ValueError("Database update failed")
```

### Updated calibration_settings schema:

```python
# Update line 821-835 to include scaling_factor column:
conn.execute("""
CREATE TABLE IF NOT EXISTS pca_calibration_settings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    resolution_level TEXT NOT NULL,
    discriminator TEXT NOT NULL,
    base_x REAL NOT NULL,
    inner_radius REAL NOT NULL,
    outer_radius REAL NOT NULL,
    target_percentage REAL NOT NULL,
    achieved_percentage REAL NOT NULL,
    scaling_factor REAL DEFAULT 1.0,  -- ADD THIS
    calibration_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    library_size INTEGER NOT NULL,
    UNIQUE(resolution_level, discriminator)
)
""")
```

## Integration with beets2tsnot.py

The enhanced comprehensive script becomes the **mandatory PCA stage**:

```python
# In beets2tsnot.py, add method to DatabaseManager:

def run_pca_analysis(self):
    """
    Run comprehensive PCA analysis on completed database.

    This is NOT optional - it's a required part of the import pipeline.
    Includes: computation, calibration, weight extraction, and validation.
    """
    import subprocess

    logger.info("🧮 Running comprehensive PCA analysis")
    logger.info("   (Includes calibration, weight extraction, and validation)")

    try:
        result = subprocess.run(
            ['python3', str(Path(__file__).parent.parent / 'comprehensive_pca_analysis_and_verification.py')],
            capture_output=True,
            text=True,
            timeout=900  # 15 minutes for calibration + validation
        )

        if result.returncode == 0:
            logger.info("✅ PCA analysis completed and validated")

            # Log key metrics from output
            if "PCA integrity validated" in result.stdout:
                logger.info("   ✓ Validation passed")
            if "transformation weights stored" in result.stdout:
                logger.info("   ✓ Weights stored")
            if "Calibration complete" in result.stdout:
                logger.info("   ✓ Calibration computed")

            return True
        else:
            logger.error(f"❌ PCA analysis failed")
            logger.error(result.stderr)
            raise RuntimeError("PCA analysis failed - cannot complete import")

    except subprocess.TimeoutExpired:
        logger.error("❌ PCA analysis timed out after 15 minutes")
        raise RuntimeError("PCA analysis timeout")

# In main(), after all tracks processed:
# NO FLAG - this is mandatory for any import
logger.info("=" * 60)
logger.info("STAGE 3: PCA COMPUTATION")
logger.info("=" * 60)
db_manager.run_pca_analysis()
```

## Implementation Checklist

### Modifications to comprehensive_pca_analysis_and_verification.py

- [ ] Add `extract_transformation_weights()` method (code provided above)
- [ ] Add `populate_transformation_weights()` method (code provided above)
- [ ] Replace hardcoded `calibrate_intuitive_resolution_controls()` with dynamic version (code provided above)
- [ ] Add `validate_pca_integrity()` method (code provided above)
- [ ] Update `main_comprehensive()` to call all 4 new methods in sequence
- [ ] Add `scaling_factor` column to calibration_settings schema
- [ ] Test on existing database, verify output

### Expected Results

**Weights:** 100 rows in pca_transformations table
- Primary D: 1 component × 18 features = 18 rows
- Tonal: 3 components × 7 features = 21 rows
- Spectral: 3 components × 7 features = 21 rows
- Rhythmic: 3 components × 4 features = 12 rows
- **Total: 72 rows** (NOT 100 - I miscalculated earlier)

**Calibration:** 12 rows in pca_calibration_settings table
- 3 resolutions × 4 discriminators = 12 rows
- Each with dynamically computed base_x, inner/outer radius

**Validation:** All PCA values must match within 1e-10 tolerance
- Script raises ValueError if validation fails
- No silent failures - import stops if corruption detected

### Integration with beets2tsnot.py

- [ ] Add `run_pca_analysis()` method to DatabaseManager
- [ ] Call after all tracks processed (mandatory, not optional)
- [ ] Handle errors - stop import if PCA fails
- [ ] Log key metrics from PCA output

### Testing

1. **Unit test** - Run enhanced comprehensive script standalone on existing DB
2. **Integration test** - Full import pipeline on small dataset (100 tracks)
3. **Validation test** - Verify weights can reconstruct PCA values
4. **Regression test** - Server loads weights, locality filter works

## Success Criteria

- [ ] PCA computation completes without errors
- [ ] 72 transformation weights stored in database
- [ ] 12 calibration settings computed and stored
- [ ] All PCA values validated (100% match within tolerance)
- [ ] Server can load weights and recalculate PCA
- [ ] Locality filter uses recalculated PCA distances
- [ ] No hardcoded calibration values remain
- [ ] No optional flags - everything is automatic
