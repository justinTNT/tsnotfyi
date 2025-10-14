# PCA Suite Integration Assessment

## Overview
The `~/pca_suite/` directory contains 20 Python scripts. Most are **research/analysis scripts** used during development. Only 2-3 are valuable for the import pipeline.

## Scripts by Category

### ✅ **Essential for Import** (2 scripts)

#### 1. `comprehensive_pca_analysis_and_verification.py` (1041 lines)
**Status:** Already in plan - this is the main script
**What it does:**
- Computes all PCA values (primary_d, tonal, spectral, rhythmic)
- Updates database schema
- Populates PCA columns
- **Missing:** Transformation weights extraction (we're adding this)

#### 2. `end_to_end_pca_validation.py` (567 lines)
**Status:** Should add as post-import validation
**What it does:**
- Cross-references database PCA values against freshly computed values
- Calculates checksums for all PCA fields
- Validates exact matches (tolerance 1e-10)
- Tests similarity search functionality
- Validates calibration settings exist

**Value:** Ensures import didn't corrupt data, catches bugs early

**Integration:**
```python
# Add to beets2tsnot.py after PCA computation:
if args.validate_pca:
    subprocess.run(['python3', 'end_to_end_pca_validation.py'])
```

### 🔄 **Potentially Better** (1 script)

#### 3. `intuitive_resolution_calibrator.py` (426 lines)
**Status:** Competes with hardcoded calibration in comprehensive script
**What it does:**
- Dynamically computes optimal base_x values for 3 resolutions
- Uses binary search to find values achieving target percentages (1%, 5%, 10%)
- Tests across multiple query points for robustness
- Generates calibration JSON output

**Current approach:** comprehensive script has hardcoded calibration values (lines 715-757)

**Comparison:**
| Aspect | Hardcoded (comprehensive) | Dynamic (calibrator) |
|--------|---------------------------|---------------------|
| Speed | Instant | ~2-5 minutes |
| Accuracy | Fixed to one library size | Adapts to actual library |
| Robustness | May drift as library grows | Recalibrated each import |
| Maintenance | Requires manual updates | Self-adjusting |

**Recommendation:** Use calibrator for initial import, then cache results. Only recalibrate if:
- Library size changes >10%
- User requests recalibration
- Validation shows poor calibration fit

**Integration:**
```python
# Option 1: Always run (slower but accurate)
calibration_results = run_calibrator_script()

# Option 2: Smart recalibration (faster)
if should_recalibrate(db_path):
    calibration_results = run_calibrator_script()
else:
    calibration_results = load_cached_calibration()
```

### ❌ **Research/Analysis Only** (17 scripts)

These were used during development to understand PCA behavior but aren't needed in production:

**Variance/Optimality Analysis:**
- `verify_d_optimality.py` - Proves D is mathematically optimal (one-time verification)
- `directional_variance_analysis.py` - Studies variance in directional searches
- `individual_index_variance_analysis.py` - Analyzes per-index variance
- `primary_discriminator_analysis.py` - Deep dive into primary D properties
- `primary_discriminator_utility_analysis.py` - Cost/benefit of using D

**Distance/Search Analysis:**
- `distance_normalization_test.py` - Tests distance normalization approaches
- `false_negative_distance_analysis.py` - Studies false negative rates
- `high_d_threshold_and_pca_complement_analysis.py` - Threshold tuning
- `minimize_false_negatives_analysis.py` - Optimization studies
- `radial_search_false_negative_analysis.py` - Radial search analysis
- `radial_search_performance_analysis.py` - Performance benchmarks

**Calibration Analysis:**
- `clarify_percentage_vs_distance_targeting.py` - Compares targeting approaches
- `discriminator_error_threshold_analysis.py` - Error threshold studies
- `inner_outer_radius_analysis.py` - Annulus sizing
- `resolution_scaling_analysis.py` - Scaling factor analysis

**System Design:**
- `hierarchical_sieve_system.py` - Alternative search system design

**Schema Management:**
- `database_pca_schema_update.py` - Superseded by comprehensive script (schema update already in there)

## Recommendations

### Minimal Integration (Fast, Good Enough)
```
beets2tsnot.py
    └─> comprehensive_pca_analysis_and_verification.py (enhanced with weights)
        └─> Uses hardcoded calibration
        └─> Populates database

Optional validation:
    └─> end_to_end_pca_validation.py
```

**Pros:** Simple, proven, fast
**Cons:** Calibration may drift as library grows

### Optimal Integration (Robust, Slower)
```
beets2tsnot.py
    └─> comprehensive_pca_analysis_and_verification.py (enhanced with weights)
        ├─> intuitive_resolution_calibrator.py (dynamic calibration)
        │   └─> Saves calibration to database
        └─> Populates database with computed calibration

Validation:
    └─> end_to_end_pca_validation.py
```

**Pros:** Self-adjusting, robust to library changes
**Cons:** +2-5 minutes per import

### Recommended Hybrid
```
beets2tsnot.py --compute-pca
    └─> Check if calibration exists and library size similar
        ├─> YES: Use cached calibration (fast path)
        └─> NO: Run calibrator.py (slow path, first import only)
    └─> comprehensive_pca_analysis_and_verification.py
        └─> Use calibration from above
        └─> Extract and store weights
        └─> Populate database

Validation (--validate-pca flag):
    └─> end_to_end_pca_validation.py
```

**Implementation:**
```python
def should_recalibrate(db_path):
    """Check if calibration needs refresh."""
    conn = sqlite3.connect(db_path)

    # Check if calibration exists
    cursor = conn.execute("SELECT COUNT(*) FROM pca_calibration_settings")
    if cursor.fetchone()[0] == 0:
        return True  # No calibration, must run

    # Check library size change
    cursor = conn.execute("SELECT library_size FROM pca_calibration_settings LIMIT 1")
    old_size = cursor.fetchone()[0]

    cursor = conn.execute("SELECT COUNT(*) FROM music_analysis")
    new_size = cursor.fetchone()[0]

    size_change_pct = abs(new_size - old_size) / old_size * 100

    conn.close()

    return size_change_pct > 10  # Recalibrate if >10% change
```

## Summary

**Must integrate:**
1. ✅ `comprehensive_pca_analysis_and_verification.py` - Already in plan, add weight extraction
2. ✅ `end_to_end_pca_validation.py` - Add as validation step (optional flag)

**Consider integrating:**
3. 🔄 `intuitive_resolution_calibrator.py` - Replace hardcoded calibration, or use smart caching

**Don't integrate:**
4. ❌ 17 other scripts - Research/analysis only, not production code

## Updated Import Plan Addition

Add to end of `PCA_WEIGHTS_IMPORT_PLAN.md`:

### Phase 6: Validation (Optional but Recommended)

**Add to beets2tsnot.py:**
```python
parser.add_argument('--validate-pca', action='store_true',
                   help='Run comprehensive validation after PCA computation')

# After PCA computation:
if args.validate_pca:
    logger.info("🔍 Running PCA validation")
    result = subprocess.run(
        ['python3', 'end_to_end_pca_validation.py'],
        capture_output=True,
        text=True
    )
    if result.returncode == 0:
        logger.info("✅ PCA validation passed")
    else:
        logger.warning("⚠️  PCA validation found issues")
        logger.warning(result.stdout)
```

### Phase 7: Smart Calibration (Optional Enhancement)

**Add calibrator integration:**
```python
def get_or_compute_calibration(db_path):
    """Get cached calibration or compute fresh if needed."""
    if should_recalibrate(db_path):
        logger.info("🎯 Computing fresh calibration")
        result = subprocess.run(
            ['python3', 'intuitive_resolution_calibrator.py'],
            capture_output=True,
            text=True
        )
        # Load calibration from generated JSON
        with open('comprehensive_analysis_output/intuitive_resolution_calibration.json') as f:
            return json.load(f)
    else:
        logger.info("📋 Using cached calibration")
        # Load from database
        return load_calibration_from_db(db_path)
```
