# Hybrid Track Construction - Implementation Analysis

**Date:** 2025-10-11
**Purpose:** Rigorous analysis of all hybrid construction sites before implementation

---

## Overview

The kd-tree.js file creates "hybrid" tracks in 5 locations for contribution analysis. These hybrids combine aspects of two tracks to measure the isolated effect of changing specific features or PCA components.

**Critical distinction:**
- **Feature hybrids:** Modify raw features → PCA becomes stale → MUST recalculate
- **PCA hybrids:** Modify PCA directly for measurement → Intentionally invalid tracks → NO recalculation

---

## Hybrid Construction Sites

### Site 1: Feature Contribution - Reference Dimension (Lines 757-761)

**Location:** `calculateFeatureContributionFractions()` method

**Purpose:** Measure the contribution of the reference dimension to total distance

**Current Code:**
```javascript
const hybrid = {
    features: this.cloneFeatureSet(currentTrack.features),
    pca: this.clonePcaSet(currentTrack.pca)
};
hybrid.features[referenceDimension] = candidateValue;
```

**Analysis:**
- Creates hybrid with ONE feature changed (referenceDimension)
- Keeps currentTrack's PCA values (now STALE)
- Uses hybrid to calculate `calculateDimensionSimilarity(currentTrack, hybrid, [referenceDimension], weights)`
- **Problem:** PCA values don't match the modified features
- **Impact:** If distance calculation uses PCA (which it might for weighted similarity), results are incorrect

**Fix Required:** ✅ YES
```javascript
const hybrid = this.createCounterfactualTrack(currentTrack, {
    [referenceDimension]: candidateValue
});
```

**Why safe:**
- `createCounterfactualTrack` will clone features, apply modification, recalculate ALL PCA values
- Now hybrid.features and hybrid.pca are consistent
- Distance calculation uses correct PCA values

---

### Site 2: Feature Contribution - All Dimensions (Lines 794-798)

**Location:** `calculateFeatureContributionFractions()` method (loop over dimensions)

**Purpose:** Measure the contribution of each dimension to total distance

**Current Code:**
```javascript
const hybrid = {
    features: this.cloneFeatureSet(currentTrack.features),
    pca: this.clonePcaSet(currentTrack.pca)
};
hybrid.features[dimension] = candidateValue;
```

**Analysis:**
- Same pattern as Site 1
- Creates hybrid with ONE feature changed (current dimension in loop)
- Keeps currentTrack's PCA values (now STALE)
- Uses hybrid to calculate `calculateDimensionSimilarity(currentTrack, hybrid, [dimension], weights)`
- **Problem:** Same as Site 1 - PCA doesn't match features

**Fix Required:** ✅ YES
```javascript
const hybrid = this.createCounterfactualTrack(currentTrack, {
    [dimension]: candidateValue
});
```

**Why safe:**
- Same reasoning as Site 1
- Each iteration creates a hybrid with exactly one feature modified
- PCA values correctly reflect that modification

---

### Site 3: PCA Contribution - Primary D (Lines 844-848)

**Location:** `calculatePcaContributionFractions()` method (primary_d case)

**Purpose:** Measure how much of total PCA distance comes from primary_d

**Current Code:**
```javascript
const hybrid = {
    features: this.cloneFeatureSet(currentTrack.features),
    pca: this.clonePcaSet(currentTrack.pca)
};
hybrid.pca.primary_d = candidateValue;
```

**Analysis:**
- Creates hybrid with primary_d PCA component changed
- Features remain unchanged (now INCONSISTENT with PCA)
- Uses hybrid to calculate `calculatePCADistance(currentTrack, hybrid, 'primary_d')`
- **This is intentional:** Measuring PCA distance by directly manipulating PCA
- **Purpose:** Isolate primary_d contribution without affecting other PCA components
- **Features are irrelevant:** calculatePCADistance only looks at pca.primary_d

**Fix Required:** ❌ NO - Add clarifying comment

```javascript
const hybrid = {
    features: this.cloneFeatureSet(currentTrack.features),
    pca: this.clonePcaSet(currentTrack.pca)
};
// NOTE: Intentionally modifying PCA without updating features
// This is a pseudo-track for measuring PCA contribution in isolation
hybrid.pca.primary_d = candidateValue;
```

**Why no fix needed:**
- `calculatePCADistance(track1, track2, 'primary_d')` only looks at `track1.pca.primary_d` and `track2.pca.primary_d`
- It doesn't touch features at all
- We're measuring: "How much does primary_d contribute to the distance?"
- Answer: The distance between currentTrack.pca.primary_d and candidateTrack.pca.primary_d

**This is contribution analysis, not track construction**

---

### Site 4: PCA Contribution - Reference Component (Lines 893-900)

**Location:** `calculatePcaContributionFractions()` method (domain PCA, reference component)

**Purpose:** Measure the contribution of the reference component (e.g., tonal_pc2) to total domain distance

**Current Code:**
```javascript
const hybrid = {
    features: this.cloneFeatureSet(currentTrack.features),
    pca: this.clonePcaSet(currentTrack.pca)
};
if (!Array.isArray(hybrid.pca[domain])) {
    hybrid.pca[domain] = currentComponents.slice();
}
hybrid.pca[domain][referenceIndex] = candidateValue;
```

**Analysis:**
- Creates hybrid with ONE PCA component changed (e.g., tonal_pc2)
- Features remain unchanged (INCONSISTENT)
- Uses hybrid to calculate `calculatePCADistance(currentTrack, hybrid, domain)`
- **Same pattern as Site 3:** Intentional PCA-only modification
- **Purpose:** Isolate that component's contribution to domain distance
- **Features are irrelevant:** calculatePCADistance for domain only looks at pca[domain] array

**Fix Required:** ❌ NO - Add clarifying comment

```javascript
const hybrid = {
    features: this.cloneFeatureSet(currentTrack.features),
    pca: this.clonePcaSet(currentTrack.pca)
};
if (!Array.isArray(hybrid.pca[domain])) {
    hybrid.pca[domain] = currentComponents.slice();
}
// NOTE: Intentionally modifying PCA component without updating features
// This is a pseudo-track for measuring component contribution in isolation
hybrid.pca[domain][referenceIndex] = candidateValue;
```

**Why no fix needed:**
- Same reasoning as Site 3
- `calculatePCADistance(track1, track2, 'tonal')` computes Euclidean distance between track1.pca.tonal and track2.pca.tonal
- Doesn't look at features
- We're measuring: "How much does tonal_pc2 contribute to the tonal distance?"

---

### Site 5: PCA Contribution - All Components (Lines 935-942)

**Location:** `calculatePcaContributionFractions()` method (domain PCA, loop over all components)

**Purpose:** Measure the contribution of each component to total domain distance

**Current Code:**
```javascript
const hybrid = {
    features: this.cloneFeatureSet(currentTrack.features),
    pca: this.clonePcaSet(currentTrack.pca)
};
if (!Array.isArray(hybrid.pca[domain])) {
    hybrid.pca[domain] = currentComponents.slice();
}
hybrid.pca[domain][index] = candidateValue;
```

**Analysis:**
- Same pattern as Site 4
- Creates hybrid with ONE PCA component changed (current index in loop)
- Features remain unchanged (INCONSISTENT)
- **Same reasoning applies:** Intentional for contribution measurement

**Fix Required:** ❌ NO - Add clarifying comment

```javascript
const hybrid = {
    features: this.cloneFeatureSet(currentTrack.features),
    pca: this.clonePcaSet(currentTrack.pca)
};
if (!Array.isArray(hybrid.pca[domain])) {
    hybrid.pca[domain] = currentComponents.slice();
}
// NOTE: Intentionally modifying PCA component without updating features
// This is a pseudo-track for measuring component contribution in isolation
hybrid.pca[domain][index] = candidateValue;
```

---

## Summary of Required Changes

| Site | Lines | Method | Type | Fix |
|------|-------|--------|------|-----|
| 1 | 757-761 | calculateFeatureContributionFractions | Feature hybrid | ✅ Use createCounterfactualTrack |
| 2 | 794-798 | calculateFeatureContributionFractions | Feature hybrid | ✅ Use createCounterfactualTrack |
| 3 | 844-848 | calculatePcaContributionFractions | PCA hybrid | ❌ Add comment only |
| 4 | 893-900 | calculatePcaContributionFractions | PCA hybrid | ❌ Add comment only |
| 5 | 935-942 | calculatePcaContributionFractions | PCA hybrid | ❌ Add comment only |

---

## Locality Filter Analysis (Lines 525-539)

**Current Implementation:**
```javascript
// TODO: Locality filter - currently uses raw feature distance
// Once PCA weights are stored, recalculate PCA for proper distance check
const otherDimensions = this.dimensions.filter(d =>
    d !== directionDim && !ignoreDimensions.includes(d)
);

let violatesLocality = false;
for (const dim of otherDimensions) {
    const dimDelta = Math.abs(result.track.features[dim] - currentTrack.features[dim]);

    // TODO: This should use PCA distance after recalculating hybrid.pca
    // For now: raw feature delta check (approximate)
    const maxAllowedChange = searchRadius * 0.15; // Conservative threshold

    if (dimDelta > maxAllowedChange) {
        violatesLocality = true;
        break;
    }
}
```

### Problem Analysis

**What it's trying to do:**
- Get candidates moving in direction (e.g., "more danceability")
- Filter out candidates that change TOO MUCH in other dimensions
- Goal: Smooth transitions that don't jar the listener

**Current approach (approximate):**
- Measures raw feature delta for each non-direction dimension
- Rejects if delta > searchRadius * 0.15
- **Problem:** Raw feature scales vary wildly (bpm: 60-180, spectral_centroid: 0-8000)
- **Problem:** Doesn't measure actual perceptual distance (PCA space)

**Example scenario:**
```
Current track: { bpm: 120, spectral_centroid: 1500, danceability: 0.6 }
Candidate: { bpm: 121, spectral_centroid: 2000, danceability: 0.8 }
Direction: more_danceability

Raw deltas:
- bpm: |121 - 120| = 1 (small)
- spectral_centroid: |2000 - 1500| = 500 (large!)

Current code: REJECTS (spectral_centroid delta too large)
But: What if that 500 change in spectral_centroid only moves 0.1 in PCA space?
```

**The correct approach:**
- For each other dimension, create a counterfactual track
- Counterfactual: "What if ONLY this dimension changed?"
- Measure PCA distance of that isolated change
- Reject if isolated change exceeds threshold (e.g., innerRadius)

### Proposed Implementation

```javascript
// Locality filter: Reject if other dimensions change too much in PCA space
const otherDimensions = this.dimensions.filter(d =>
    d !== directionDim && !ignoreDimensions.includes(d)
);

let violatesLocality = false;
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
        violatesLocality = true;
        break;
    }
}

if (violatesLocality) {
    return; // Skip this candidate
}
```

### Why This Works

**Counterfactual reasoning:**
- Start with currentTrack
- Change ONLY dim (e.g., only spectral_centroid)
- Recalculate PCA to see actual perceptual impact
- If that isolated change is jarring (> innerRadius), reject

**Example:**
```
Current: { bpm: 120, spectral_centroid: 1500 }
  → PCA: { primary_d: 0.5, tonal: [0.2, 0.1, -0.3] }

Counterfactual (change only spectral_centroid to 2000):
  { bpm: 120, spectral_centroid: 2000 }
  → Recalculate PCA: { primary_d: 0.52, tonal: [0.21, 0.15, -0.29] }

Isolated distance in primary_d: |0.52 - 0.5| = 0.02

If innerRadius = 0.1:
  0.02 < 0.1 → ACCEPT (change is subtle in PCA space)

If a different candidate had isolatedDistance = 0.15:
  0.15 > 0.1 → REJECT (change is too jarring)
```

**This correctly measures perceptual distance, not raw feature distance.**

### Performance Consideration

**Concern:** Creating counterfactuals for every dimension × every candidate?

**Analysis:**
```
Typical scenario:
- 500 candidates in neighborhood
- 21 dimensions - 1 direction - 2 ignored = ~18 dimensions to check
- 500 × 18 = 9,000 counterfactual creations per search

Each counterfactual:
- Clone features: O(21) - trivial
- Modify one feature: O(1)
- Recalculate PCA: O(18) scalar multiplications - trivial

Total: ~9,000 × 18 = 162,000 scalar ops
This is negligible (< 1ms on modern CPU)
```

**Optimization opportunity:**
If profiling shows this is slow, we can:
1. Cache PCA weights per dimension (precompute isolation impact)
2. Early-exit on first violation (already implemented with `break`)
3. Reduce neighborhood size (already limited to 500)

**Verdict:** Implement as-is, optimize only if needed

---

## createCounterfactualTrack Implementation

**Signature:**
```javascript
createCounterfactualTrack(baseTrack, featureModifications)
```

**Parameters:**
- `baseTrack`: The original track object
- `featureModifications`: Object mapping feature names to new values
  - Example: `{ bpm: 130, danceability: 0.8 }`

**Returns:**
- New track object with:
  - All original metadata (identifier, title, artist, etc.)
  - Modified features
  - Recalculated PCA values (all 10: primary_d + 9 domain components)

**Implementation:**
```javascript
createCounterfactualTrack(baseTrack, featureModifications) {
    if (!baseTrack?.features || !this.pcaWeights) {
        console.error('❌ Cannot create counterfactual: missing base track or PCA weights');
        return null;
    }

    // 1. Clone base track structure
    const counterfactual = {
        identifier: baseTrack.identifier,
        title: baseTrack.title,
        artist: baseTrack.artist,
        path: baseTrack.path,
        length: baseTrack.length,
        albumCover: baseTrack.albumCover,
        love: baseTrack.love,
        beetsMeta: baseTrack.beetsMeta,
        features: this.cloneFeatureSet(baseTrack.features),
        pca: {} // Will be recalculated
    };

    // 2. Apply feature modifications
    for (const [feature, newValue] of Object.entries(featureModifications)) {
        if (this.dimensions.includes(feature)) {
            counterfactual.features[feature] = newValue;
        } else {
            console.warn(`⚠️ Ignoring unknown feature: ${feature}`);
        }
    }

    // 3. Recalculate all PCA values
    counterfactual.pca = this.recalculateAllPCA(counterfactual.features);

    return counterfactual;
}
```

**Key properties:**
- **Immutable:** Doesn't modify baseTrack
- **Complete:** Returns fully-formed track object
- **Validated:** Checks for required data
- **Flexible:** Can modify any number of features

---

## Validation Strategy

### 1. Initialization Validation

After loading PCA weights, validate on a sample track:

```javascript
async initialize() {
    // ... existing initialization ...

    await this.loadPCATransformations();
    console.log('✓ PCA transformation weights loaded');

    // Validate PCA recalculation
    if (this.tracks.length > 0) {
        const sample = this.tracks[0];
        const recalc = this.recalculatePCA(sample.features, 'primary_d');
        const stored = sample.pca.primary_d;
        const error = Math.abs(recalc - stored);

        if (error > 0.001) {
            console.warn(`⚠️ PCA validation error: ${error.toFixed(6)} (threshold: 0.001)`);
            console.warn(`   Sample track: ${sample.identifier}`);
            console.warn(`   Recalculated: ${recalc.toFixed(6)}, Stored: ${stored.toFixed(6)}`);
        } else {
            console.log(`✓ PCA validation passed: error = ${error.toFixed(6)}`);
        }
    }
}
```

### 2. Counterfactual Validation

Add optional validation in `createCounterfactualTrack`:

```javascript
// After recalculating PCA
if (Object.keys(featureModifications).length === 0) {
    // No modifications - PCA should match original
    const error = Math.abs(counterfactual.pca.primary_d - baseTrack.pca.primary_d);
    if (error > 1e-6) {
        console.warn(`⚠️ Counterfactual validation failed: ${error}`);
    }
}
```

### 3. Locality Filter Monitoring

Add logging to track rejection rates:

```javascript
// In getDirectionalCandidates, after the loop
const rejectedCount = neighborhood.length - directionalCandidates.length;
const rejectionRate = (rejectedCount / neighborhood.length) * 100;

if (rejectionRate > 20) {
    console.warn(`⚠️ High locality rejection rate: ${rejectionRate.toFixed(1)}% (${rejectedCount}/${neighborhood.length})`);
} else {
    console.log(`✓ Locality filter: ${rejectionRate.toFixed(1)}% rejected (${rejectedCount}/${neighborhood.length})`);
}
```

---

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| PCA recalculation error | Low | High | Validate on initialization, add tolerance checks |
| Performance regression | Low | Medium | Profile first, optimize if needed |
| Locality filter too strict | Medium | Low | Monitor rejection rates, tune threshold |
| Feature/PCA mismatch | Low | High | Always use createCounterfactualTrack for feature changes |
| Missing PCA weights | Low | High | Check pcaWeights existence before using |

---

## Implementation Order

1. **Add PCA utility methods** (foundational)
   - `loadPCATransformations()` - Load from database
   - `recalculatePCA()` - Single component
   - `recalculateAllPCA()` - All components
   - `createCounterfactualTrack()` - Create hybrid

2. **Fix feature hybrid sites** (safety-critical)
   - Lines 757-761: Replace with createCounterfactualTrack
   - Lines 794-798: Replace with createCounterfactualTrack

3. **Document PCA hybrid sites** (clarity)
   - Lines 844-848: Add clarifying comment
   - Lines 893-900: Add clarifying comment
   - Lines 935-942: Add clarifying comment

4. **Implement locality filter** (correctness)
   - Lines 525-539: Replace with PCA-based filtering

5. **Add validation** (confidence)
   - Initialization check
   - Monitoring logs
   - Error reporting

---

## Success Criteria

- [ ] All feature hybrids use createCounterfactualTrack
- [ ] PCA validation error < 0.001 on sample tracks
- [ ] Locality filter rejection rate between 5-20%
- [ ] No performance regression (< 10ms added latency)
- [ ] All PCA hybrid sites have clarifying comments
- [ ] createCounterfactualTrack returns complete track objects
- [ ] recalculatePCA matches stored values (< 0.001 error)

---

## Conclusion

**Feature hybrids need fixing:** Sites 1 and 2 create tracks with stale PCA

**PCA hybrids are correct:** Sites 3, 4, and 5 intentionally modify PCA for analysis

**Locality filter needs proper implementation:** Current approximation doesn't measure perceptual distance

**Implementation is low-risk:** Clear separation of concerns, validation at each step

**Ready to implement with confidence.**
