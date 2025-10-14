# PCA Transformation Weights - Server Implementation Plan

## Context

Currently, the server has PCA values (primary_d, tonal_pc1-3, spectral_pc1-3, rhythmic_pc1-3) pre-computed and stored per-track, but lacks the transformation weights needed to recalculate PCA from raw features. This creates several limitations:

1. **Hybrid track construction is inconsistent** - 5 locations modify PCA values without updating corresponding raw features (or vice versa)
2. **Locality filtering is incomplete** - Can't properly validate that dimension changes don't cause jarring jumps in PCA space
3. **No cross-space reasoning** - Can't answer "if feature X changes, how does primary_d change?"

Once the import pipeline stores PCA transformation weights in the database, this plan implements proper PCA recalculation utilities throughout the server.

## Prerequisites (Provided by Import)

The import pipeline will create and populate:

```sql
CREATE TABLE pca_transformations (
    component TEXT NOT NULL,     -- 'primary_d', 'tonal_pc1', 'tonal_pc2', 'tonal_pc3',
                                 -- 'spectral_pc1', 'spectral_pc2', 'spectral_pc3',
                                 -- 'rhythmic_pc1', 'rhythmic_pc2', 'rhythmic_pc3'
    feature TEXT NOT NULL,       -- 'bpm', 'danceability', 'onset_rate', ... (21 total)
    weight REAL NOT NULL,        -- The PCA coefficient
    mean REAL,                   -- Feature mean (for centering)
    std REAL,                    -- Feature std (for normalization)
    PRIMARY KEY (component, feature)
);
```

Example rows:
```
component    | feature             | weight  | mean   | std
'primary_d'  | 'bpm'              | 0.234   | 120.5  | 25.3
'primary_d'  | 'spectral_centroid'| -0.156  | 1500.2 | 402.8
'tonal_pc1'  | 'chord_strength'   | 0.678   | 0.451  | 0.223
```

## Implementation Tasks

### 1. Add PCA Utilities to kd-tree.js

**Location:** `kd-tree.js` (MusicalKDTree class)

**Add new methods:**

```javascript
async loadPCATransformations() {
    // Load all transformation weights from database
    // Store in this.pcaWeights = { component: { feature: {weight, mean, std} } }
}

recalculatePCA(features, component) {
    // Given raw features and component name ('primary_d', 'tonal_pc1', etc.)
    // Return the calculated PCA value
    // Formula: Σ((feature - mean) / std * weight) for all features
}

recalculateAllPCA(features) {
    // Return object with all PCA values:
    // {
    //   primary_d: value,
    //   tonal: [pc1, pc2, pc3],
    //   spectral: [pc1, pc2, pc3],
    //   rhythmic: [pc1, pc2, pc3]
    // }
}

createCounterfactualTrack(baseTrack, featureModifications) {
    // Create hybrid track with modified features and recalculated PCA
    // baseTrack: original track object
    // featureModifications: { feature: newValue, ... }
    // Returns: new track object with updated features + recalculated PCA
}
```

**Update initialization:**

```javascript
async initialize() {
    // ... existing code ...
    await this.loadPCATransformations();
    console.log('PCA transformation weights loaded');
}
```

### 2. Fix Existing Hybrid Construction Sites

**Problem locations** (5 places):

#### A. Feature Hybrids (lines 716-720, 753-757)
```javascript
// Currently:
const hybrid = {
    features: this.cloneFeatureSet(currentTrack.features),
    pca: this.clonePcaSet(currentTrack.pca)  // ← PCA now stale
};
hybrid.features[dimension] = candidateValue;

// Fix:
const hybrid = this.createCounterfactualTrack(currentTrack, {
    [dimension]: candidateValue
});
// Now hybrid.pca is correctly recalculated!
```

#### B. PCA Hybrids (lines 803-807, 852-859, 894-901)

These are trickier - they modify PCA directly for contribution analysis. Two options:

**Option 1: Leave as-is with comment**
```javascript
// NOTE: This intentionally modifies PCA without updating features
// We're measuring PCA contribution in isolation (not creating valid track)
hybrid.pca.primary_d = candidateValue;
```

**Option 2: Make it explicit**
```javascript
// Create PCA-only pseudo-track for contribution measurement
const pcaOnlyHybrid = {
    pca: { ...currentTrack.pca, primary_d: candidateValue }
    // No features - this is not a real track!
};
const distance = this.calculatePCADistance(currentTrack, pcaOnlyHybrid, 'primary_d');
```

**Recommendation:** Option 1 - these are working correctly as-is, just add clarifying comments.

### 3. Implement Proper Locality Filter

**Location:** `kd-tree.js`, `getDirectionalCandidates()` method, after line 506

**Current temporary implementation:**
```javascript
// TODO: Uses raw feature distance (approximate)
const maxAllowedChange = searchRadius * 0.15;
if (dimDelta > maxAllowedChange) {
    return;
}
```

**Replace with:**
```javascript
// Locality filter: Reject if any other dimension changes too much
const otherDimensions = this.dimensions.filter(d =>
    d !== directionDim && !ignoreDimensions.includes(d)
);

for (const dim of otherDimensions) {
    // Create counterfactual: current track but with ONLY this dimension changed
    const counterfactual = this.createCounterfactualTrack(currentTrack, {
        [dim]: result.track.features[dim]
    });

    // Measure PCA distance caused by changing just this dimension
    const isolatedDistance = this.calculatePCADistance(
        currentTrack,
        counterfactual,
        'primary_d'
    );

    // Reject if isolated change exceeds inner radius
    if (isolatedDistance > innerRadius) {
        return; // Too jarring in this dimension
    }
}
```

### 4. Add Diagnostics

**Location:** Multiple places for debugging

Add logging to understand PCA space coverage:

```javascript
// In getDirectionalCandidates, before returning:
if (directionalCandidates.length > 0) {
    const pcaDistances = directionalCandidates.map(c =>
        this.calculatePCADistance(currentTrack, c.track, 'primary_d')
    );
    const minPCA = Math.min(...pcaDistances);
    const maxPCA = Math.max(...pcaDistances);

    console.log(`📊 Candidates span PCA: ${minPCA.toFixed(2)} → ${maxPCA.toFixed(2)} (expected: ${innerRadius} → ${outerRadius})`);
}
```

### 5. Optional: Add Interpolation Utilities

**Location:** New methods in `kd-tree.js`

Enable smooth transitions between tracks:

```javascript
interpolateTracksInFeatureSpace(trackA, trackB, alpha) {
    // alpha = 0 → trackA, alpha = 1 → trackB
    // Interpolate raw features, recalculate PCA
    const interpolatedFeatures = {};

    for (const dim of this.dimensions) {
        const valueA = trackA.features[dim] || 0;
        const valueB = trackB.features[dim] || 0;
        interpolatedFeatures[dim] = valueA * (1 - alpha) + valueB * alpha;
    }

    return this.createCounterfactualTrack(trackA, interpolatedFeatures);
}
```

## Testing Plan

### 1. Unit Tests

Create test file `kd-tree.test.js`:

```javascript
describe('PCA Recalculation', () => {
    test('recalculatePCA matches stored values', () => {
        // For existing tracks, recalculated PCA should match stored PCA
        // Within epsilon tolerance
    });

    test('createCounterfactualTrack has consistent PCA', () => {
        // Modified features should produce corresponding PCA values
    });

    test('locality filter rejects extreme changes', () => {
        // Track with one dimension changed drastically should be rejected
    });
});
```

### 2. Integration Validation

Add to startup logging:

```javascript
// After loadPCATransformations():
const sampleTrack = this.tracks[0];
const recalc = this.recalculatePCA(sampleTrack.features, 'primary_d');
const stored = sampleTrack.pca.primary_d;
const error = Math.abs(recalc - stored);

console.log(`✓ PCA validation: recalc=${recalc.toFixed(3)}, stored=${stored.toFixed(3)}, error=${error.toFixed(6)}`);

if (error > 0.001) {
    console.warn('⚠️  PCA recalculation error exceeds tolerance - check transformation weights');
}
```

### 3. User-Facing Validation

Monitor these metrics:
- Locality filter rejection rate (should be 5-15% of candidates)
- PCA distance span in directional searches (should cover annulus)
- Track transitions feel smoother (subjective but important!)

## Files to Modify

1. **kd-tree.js** - Primary changes
   - Add `loadPCATransformations()`
   - Add `recalculatePCA()`, `recalculateAllPCA()`
   - Add `createCounterfactualTrack()`
   - Update hybrid construction sites (5 locations)
   - Fix locality filter
   - Add diagnostics

2. **radial-search.js** - Minimal/none
   - Uses kd-tree methods, should work automatically

3. **directional-drift-player.js** - Minimal/none
   - Uses kd-tree methods, should work automatically

4. **drift-audio-mixer.js** - Optional improvements
   - Could use `interpolateTracksInFeatureSpace()` for smoother crossfades
   - Not required for core functionality

## Migration Path

1. **Before re-import:** Current code continues working (using pre-computed PCA)
2. **After re-import, before server changes:** Code still works (just doesn't use weights yet)
3. **After server changes:** Full functionality enabled, existing TODOs resolved

This is **non-breaking** - the changes enhance functionality without requiring coordinated deployment.

## Success Criteria

- [ ] All 5 hybrid construction sites properly recalculate PCA
- [ ] Locality filter uses PCA distance (not raw feature approximation)
- [ ] PCA validation shows <0.001 error on sample tracks
- [ ] Diagnostics show candidates span expected PCA ranges
- [ ] No regression in existing track selection behavior
- [ ] TODOs in staging code resolved

## Open Questions for Import Agent

1. What are the 21 feature names used in the import? (Need exact spelling for weight lookups)
2. Are PCA components normalized (unit variance)? Or do we need to store explained_variance?
3. Should we store PCA fit metrics (explained variance ratio) for diagnostics?
4. Confirm mean/std are per-feature (not global normalization)

## Notes

- PCA transformation is **linear** - we can recalculate efficiently
- The 4 PCA spaces (primary_d, tonal, spectral, rhythmic) are **independent** - no cross-transformation possible
- Raw features → PCA is **many-to-one** - can't reverse transform (PCA → features) without additional info
- This enables **counterfactual reasoning** - key capability for intelligent navigation
