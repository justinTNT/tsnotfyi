# ML Primitives & Embedding Space Analysis Plan

## Overview
Build a reusable ML primitives library and comprehensive analysis toolkit to understand and optimize the embedding space. Focus on measuring distribution, reachability, and system health to inform discovery mechanisms.

**Priority:** After TypeScript upgrade
**Philosophy:** Agents generate ML components easily → use them more liberally

### Dimension Toolkit Approach
The system treats all available dimensions as a **36-dimensional toolkit**:
- **Core features (18D):** Raw Essentia audio analysis (bpm, spectral_centroid, etc.)
- **PCA dimensions (10D):** Linear domain-decomposed features (primary_d, tonal_pc1-3, spectral_pc1-3, rhythmic_pc1-3)
- **VAE dimensions (8D):** Learned non-linear manifold features (vae_0 through vae_7)

**Key insight:** There is no "best" embedding. At each step of a musical journey, we **select the most useful dimensions from all 36** based on local neighborhood characteristics. Different dimensions excel in different contexts - some are workhorses (appear everywhere), others are specialists (appear in specific neighborhoods).

**Different cardinalities (18, 10, 8) intentionally avoid over-duplication** - each embedding space may discover unique structure.

Tools measure **dimension-level utility** (not embedding-level performance) to guide adaptive navigation.

---

## Phase 1: Instrumentation

### Goal
Track user interactions separately from server logs to enable analysis of actual usage patterns.

### Implementation

**Storage:** SQLite database (separate from main postgres)
- Location: `tsnotfyi/analytics.db`
- Rationale: Easy for early dev, can migrate to postgres later if needed

**Schema:**
```sql
CREATE TABLE track_plays (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    track_id TEXT NOT NULL,
    played_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE track_ratings (
    track_id TEXT PRIMARY KEY,
    love_count INTEGER DEFAULT 0,
    hate_count INTEGER DEFAULT 0,
    rating INTEGER -- -1=hate, 0=neutral, 1=love (for latest rating)
);

CREATE INDEX idx_plays_track ON track_plays(track_id);
CREATE INDEX idx_plays_time ON track_plays(played_at);
```

**Server Integration:**
- Add endpoints:
  - `POST /api/track/:id/play` - log play
  - `POST /api/track/:id/rate` - body: `{rating: -1|0|1}`
  - `GET /api/track/:id/stats` - return plays + rating
- Keep minimal: just record events
- No complex aggregation at write time

**Client Integration:**
- Hook into existing playback logic
- Send play event on track start (or after N seconds)
- Add UI for love/hate if not already present

---

## Phase 2: Dimension Inspection APIs

### Goal
Expose all 36 dimensions for analysis and adaptive selection without duplicating code.

**Note:** Endpoints return data for all available embedding spaces (core, PCA, VAE). Client can select which dimensions to use.

### New Server Endpoints

**GET /api/dimensions/stats**
```json
{
  "total_tracks": 5234,
  "available_dimensions": {
    "core": 18,
    "pca": 10,
    "vae": 8,
    "total": 36
  },
  "dimension_names": {
    "core": ["bpm", "spectral_centroid", "danceability", ...],
    "pca": ["primary_d", "tonal_pc1", "tonal_pc2", ...],
    "vae": ["vae_0", "vae_1", "vae_2", ...]
  }
}
```

**GET /api/kd-tree/neighbors/:id?radius=0.1&limit=100**
```json
{
  "track_id": "abc123",
  "neighbors": [
    {"id": "def456", "distance": 0.03},
    {"id": "ghi789", "distance": 0.07}
  ]
}
```

**GET /api/dimensions/track/:id/position**
```json
{
  "track_id": "abc123",
  "dimensions": {
    "core": {"bpm": 128, "spectral_centroid": 2341.5, ...},
    "pca": {"primary_d": 0.23, "tonal_pc1": -0.45, ...},
    "vae": {"vae_0": 1.2, "vae_1": -0.3, ...}
  },
  "local_density": {
    "core": 15,      // neighbors using core features
    "pca": 23,       // neighbors using PCA
    "vae": 28        // neighbors using VAE
  },
  "nearest_distance": {
    "core": 0.05,
    "pca": 0.02,
    "vae": 0.01
  }
}
```

**POST /api/kd-tree/batch-neighbors**
Body: `{track_ids: ["id1", "id2", ...], radius: 0.1}`
Returns neighbors for multiple tracks (efficient for analysis)

**GET /api/kd-tree/random-tracks?count=100**
Returns random sample of track IDs (for reachability analysis)

**GET /api/dimensions/all-tracks**
Returns all track IDs + all dimensions (paginated if needed)
- For offline analysis
- Format: newline-delimited JSON
- Each line: `{"id": "abc", "core": {...}, "pca": {...}, "vae": {...}}`

**GET /api/dimensions/utility/:id?radius=0.3**
Analyze dimension utility in local neighborhood
```json
{
  "track_id": "abc123",
  "neighborhood_size": 142,
  "dimension_rankings": [
    {
      "name": "vae_3",
      "space": "vae",
      "variance": 0.89,
      "coverage": 0.92,
      "clustering": 0.76,
      "hubness": 0.23,
      "spread": 0.88,
      "utility_score": 0.87
    },
    {
      "name": "bpm",
      "space": "core",
      "variance": 0.85,
      "utility_score": 0.82
    },
    ...
  ],
  "top_5": ["vae_3", "bpm", "spectral_pc1", "vae_0", "tonal_pc2"]
}
```

---

## Phase 3: Analysis Toolkit

### Language & Libraries
**Python** - optimized for rapid development and rich ML ecosystem

**Dependencies:**
```
numpy
scipy
scikit-learn
pandas
requests  # for API calls
```

### Location
`tsnotfyi/analysis/` directory with:
```
analysis/
  requirements.txt
  README.md
  lib/
    api_client.py           # wrapper for server APIs
    embeddings.py           # load/cache embedding data
    metrics.py              # common metric calculations
    distance_metrics.py     # euclidean, cosine, etc.
  tools/
    # Dimension utility analysis (primary focus)
    analyze_dimension_utility.py      # Which dimensions are useful where?
    analyze_dimension_patterns.py     # Usage patterns across journeys

    # Topology analysis (all dimensions)
    analyze_density.py                # Distribution across all dimensions
    analyze_reachability.py           # Coverage using adaptive dimension selection
    analyze_connectivity.py           # Graph structure per dimension
    simulate_search.py                # Adaptive vs fixed dimension sets

    # Specialized analysis
    analyze_distance_metrics.py       # Euclidean vs Cosine per dimension
    analyze_interpolation_quality.py  # VAE decoder validation

    # Export
    export_data.py
```

### Tool Specifications

#### 0. `analyze_dimension_utility.py` **(Primary Tool)**

**Purpose:** Measure utility of all 36 dimensions across neighborhoods to identify workhorses, specialists, and redundant dimensions

**Usage:**
```bash
python analysis/tools/analyze_dimension_utility.py \
  --sample-tracks 1000 \
  --radius 0.3 \
  --output dimension_utility_report.json
```

**Algorithm:**
1. Sample N random tracks as neighborhood centers
2. For each track, for each of 36 dimensions:
   - Measure variance in neighborhood
   - Measure coverage (reachability using only this dimension)
   - Measure clustering quality (silhouette score)
   - Measure hubness (access inequality)
   - Measure spread (range coverage)
   - Calculate composite utility score
3. Aggregate across all samples:
   - Which dimensions have high utility everywhere (workhorses)?
   - Which dimensions have high utility in specific contexts (specialists)?
   - Which dimensions are never useful (redundant)?

**Output (JSON):**
```json
{
  "params": {
    "sample_tracks": 1000,
    "radius": 0.3,
    "total_dimensions": 36
  },
  "global_rankings": [
    {
      "name": "vae_3",
      "space": "vae",
      "avg_utility": 0.87,
      "appears_in_top5": 0.78,  // 78% of neighborhoods
      "category": "workhorse"
    },
    {
      "name": "spectral_centroid",
      "space": "core",
      "avg_utility": 0.65,
      "appears_in_top5": 0.42,
      "category": "specialist"
    },
    {
      "name": "air_sizzle",
      "space": "core",
      "avg_utility": 0.12,
      "appears_in_top5": 0.02,
      "category": "redundant"
    },
    ...
  ],
  "by_space": {
    "core": {"workhorses": ["bpm"], "specialists": [...], "redundant": [...]},
    "pca": {"workhorses": ["primary_d"], "specialists": [...], "redundant": [...]},
    "vae": {"workhorses": ["vae_3", "vae_0"], "specialists": [...], "redundant": [...]}
  },
  "dimension_correlations": {
    "high_correlation_pairs": [
      {"dim1": "spectral_centroid", "dim2": "spectral_pc1", "corr": 0.92},
      ...
    ]
  }
}
```

**Also export CSV:** dimension_name, space, avg_utility, appears_in_top5, category

---

#### 1. `analyze_density.py`

**Purpose:** Understand local density distribution per dimension and across composite spaces

**Usage:**
```bash
python analysis/tools/analyze_density.py \
  --radius 0.1 \
  --top-dims 5 \
  --output density_report.json
```

**Algorithm:**
1. Fetch all tracks + all dimensions from server
2. For each dimension individually:
   - Compute local density using only that dimension
   - Calculate isolation score
3. For adaptive mode (top-N dimensions per neighborhood):
   - Select top N dimensions by local utility
   - Compute density using composite distance
4. Calculate statistics per mode:
   - Mean, median, std dev of densities
   - Percentiles (10th, 25th, 50th, 75th, 90th)
   - Isolation score: % tracks with density < threshold (e.g., < 3)
   - Cluster identification: connected components via neighbor links
   - **Distance meaningfulness:** k-th nearest ratio (10th/100th distance)
     - Ratio > 3.0: distances are meaningful
     - Ratio < 1.5: curse of dimensionality detected

**Output (JSON):**
```json
{
  "params": {
    "radius": 0.1,
    "top_dims": 5,
    "total_tracks": 5234,
    "total_dimensions": 36
  },
  "adaptive_mode": {
    "density_stats": {
      "mean": 28.4,
      "median": 25,
      "std": 12.1,
      "percentiles": {"10": 8, "25": 15, "50": 25, "75": 35, "90": 42}
    },
    "isolated_tracks": 89,
    "isolated_fraction": 0.017,
    "distance_meaningfulness": {
      "avg_10th_to_100th_ratio": 3.4,
      "interpretation": "distances_meaningful"
    }
  },
  "per_dimension": {
    "vae_3": {
      "density_stats": {"mean": 18.2, "median": 15, ...},
      "isolated_tracks": 124,
      "distance_meaningfulness": {"ratio": 3.1, "interpretation": "meaningful"}
    },
    "primary_d": {
      "density_stats": {"mean": 15.3, "median": 12, ...},
      "isolated_tracks": 234,
      "distance_meaningfulness": {"ratio": 2.8, "interpretation": "meaningful"}
    },
    "air_sizzle": {
      "density_stats": {"mean": 3.2, "median": 2, ...},
      "isolated_tracks": 1823,
      "distance_meaningfulness": {"ratio": 1.2, "interpretation": "curse_of_dimensionality"}
    },
    ...
  },
  "summary": {
    "best_single_dimension": "vae_3",
    "worst_single_dimension": "air_sizzle",
    "adaptive_improvement_vs_best_single": "56%"  // adaptive is 56% better than best single dim
  }
}
```

**Also export CSV:** mode, dimension_name, mean_density, isolated_fraction, distance_ratio

---

#### 2. `analyze_reachability.py`

**Purpose:** Measure what's reachable using adaptive dimension selection vs fixed dimension sets

**Usage:**
```bash
python analysis/tools/analyze_reachability.py \
  --samples 1000 \
  --max-distance 0.5 \
  --hop-limit 5 \
  --top-dims 5 \
  --output reachability_report.json
```

**Algorithm:**
1. Sample N random tracks as starting points
2. For each starting point:
   - BFS/DFS with distance threshold: expand neighbors within max-distance
   - Track all reachable tracks (within hop-limit hops)
   - Record path lengths
3. Aggregate across all samples:
   - Which tracks are reachable from most starting points?
   - Which tracks are rarely/never reached?
   - Average path length to reach any track
   - Dead zones: tracks unreachable from >X% of samples

**Output (JSON):**
```json
{
  "params": {
    "samples": 1000,
    "max_distance": 0.5,
    "hop_limit": 5,
    "top_dims": 5
  },
  "adaptive_mode": {
    "coverage": {
      "total_tracks": 5234,
      "reachable_from_any": 5021,
      "unreachable_from_any": 213,
      "coverage_pct": 95.9
    },
    "path_stats": {
      "avg_hops": 2.1,
      "max_hops_observed": 4,
      "unreachable_within_limit": 213
    },
    "dimensions_used_histogram": {
      "vae_3": 0.82,  // used in 82% of steps
      "bpm": 0.67,
      "spectral_pc1": 0.51,
      ...
    }
  },
  "comparison_modes": {
    "best_single_dim_vae_3": {"coverage_pct": 82.1, "avg_hops": 2.8},
    "pca_only": {"coverage_pct": 74.4, "avg_hops": 3.1},
    "vae_only": {"coverage_pct": 79.8, "avg_hops": 2.6},
    "core_only": {"coverage_pct": 68.2, "avg_hops": 3.4}
  },
  "dead_zones": [
    {"track_id": "abc", "reached_from": 0.04, "why": "isolated_in_all_spaces"},
    ...
  ]
}
```

**Also export CSV:** track_id, times_reached, avg_hops_to_reach

---

#### 3. `analyze_connectivity.py`

**Purpose:** Understand graph structure: bridges, components, overall connectivity

**Usage:**
```bash
python analysis/tools/analyze_connectivity.py \
  --embedding-mode pca \
  --threshold 0.1 \
  --output connectivity_report.json
```

**Algorithm:**
1. Build graph: nodes=tracks, edges=neighbors within threshold distance
2. Find connected components
3. Identify bridges: tracks whose removal disconnects components
4. Calculate graph metrics:
   - Clustering coefficient
   - Average degree
   - Diameter (longest shortest path)
   - Bridge score for each track

**Output (JSON):**
```json
{
  "params": {
    "embedding_mode": "pca",
    "threshold": 0.1
  },
  "components": {
    "count": 3,
    "largest_size": 5100,
    "largest_fraction": 0.974,
    "disconnected_tracks": 134
  },
  "graph_stats": {
    "avg_degree": 15.3,
    "clustering_coefficient": 0.42,
    "diameter": 12,
    "avg_shortest_path": 4.2
  },
  "bridges": {
    "count": 89,
    "top_bridges": [
      {"track_id": "abc", "bridge_score": 234, "connects": ["cluster_1", "cluster_5"]},
      ...
    ]
  }
}
```

**Bridge score:** Number of shortest paths passing through this node

**Also export CSV:** track_id, degree, bridge_score, component_id

---

#### 4. `simulate_search.py`

**Purpose:** Simulate user search behavior to measure system coverage and diversity

**Usage:**
```bash
python analysis/tools/simulate_search.py \
  --embedding-mode pca \
  --queries 10000 \
  --results-per-query 20 \
  --strategy nearest \
  --output search_simulation.json
```

**Algorithm:**
1. Generate N random query points:
   - Option A: Use random existing tracks as queries
   - Option B: Use random points in embedding space (between min/max bounds)
2. For each query, fetch K nearest neighbors (via server API)
3. Track:
   - Which tracks appear in results (access frequency)
   - Diversity of result sets (entropy, unique tracks)
   - Coverage: % of library appearing in at least one result set
   - Concentration: Gini coefficient of access distribution

**Output (JSON):**
```json
{
  "params": {
    "embedding_mode": "pca",
    "queries": 10000,
    "results_per_query": 20,
    "strategy": "nearest"
  },
  "coverage": {
    "total_tracks": 5234,
    "appeared_in_results": 3892,
    "coverage_pct": 74.4,
    "never_returned": 1342
  },
  "access_distribution": {
    "gini_coefficient": 0.65,  // 0=perfectly equal, 1=one track dominates
    "top_10pct_tracks_get": 0.42,  // 42% of all accesses
    "entropy": 8.2
  },
  "result_diversity": {
    "avg_unique_per_query": 19.8,
    "duplicate_rate": 0.01
  },
  "unreachable_tracks": [
    {"track_id": "abc", "reason": "too_far_from_all_queries"},
    ...
  ]
}
```

**Also export CSV:** track_id, times_returned, avg_rank

---

#### 5. `export_data.py`

**Purpose:** Bulk export for external analysis (R, spreadsheets, etc.)

**Usage:**
```bash
python analysis/tools/export_data.py --format csv --output tracks_export.csv
```

**Exports:**
- All tracks with embeddings
- Playcount + ratings (from analytics.db)
- Pre-computed metrics (density, connectivity)

**CSV columns:**
```
track_id, dimension_1, dimension_2, ..., dimension_N, play_count, rating, local_density, degree, bridge_score
```

---

#### 6. `compare_embeddings.py`

**Purpose:** Direct comparison of PCA vs VAE embedding quality

**Usage:**
```bash
python analysis/tools/compare_embeddings.py \
  --modes pca,vae \
  --output comparison_report.json
```

**Algorithm:**
1. Run core analysis (density, reachability, connectivity, search simulation) for both modes
2. Compare metrics side-by-side
3. Statistical significance testing
4. Generate recommendation

**Output (JSON):**
```json
{
  "modes_compared": ["pca", "vae"],
  "metrics": {
    "coverage": {"pca": 74.4, "vae": 82.1, "winner": "vae"},
    "gini_coefficient": {"pca": 0.65, "vae": 0.48, "winner": "vae"},
    "isolated_tracks": {"pca": 234, "vae": 89, "winner": "vae"},
    "avg_hops": {"pca": 2.3, "vae": 2.1, "winner": "vae"},
    "distance_meaningfulness": {"pca": 2.8, "vae": 3.4, "winner": "vae"}
  },
  "recommendation": "vae",
  "confidence": 0.95,
  "notes": "VAE shows significant improvement in coverage and equality"
}
```

---

#### 7. `analyze_distance_metrics.py`

**Purpose:** Compare distance metrics (Euclidean vs Cosine) for a given embedding

**Usage:**
```bash
python analysis/tools/analyze_distance_metrics.py \
  --embedding-mode pca \
  --metrics euclidean,cosine \
  --output metrics_comparison.json
```

**Algorithm:**
1. For same embedding, compute neighbors using different distance metrics
2. Measure coverage, hubness, diversity for each
3. Compare result quality

**Output (JSON):**
```json
{
  "embedding_mode": "pca",
  "metrics_compared": ["euclidean", "cosine"],
  "results": {
    "coverage": {"euclidean": 74.4, "cosine": 78.2},
    "hubness_gini": {"euclidean": 0.65, "cosine": 0.58},
    "avg_distance": {"euclidean": 0.42, "cosine": 0.31},
    "isolated_tracks": {"euclidean": 234, "cosine": 187}
  },
  "recommendation": "cosine",
  "reason": "Better coverage and less hubness"
}
```

---

#### 8. `analyze_interpolation_quality.py` (VAE-specific)

**Purpose:** Measure quality of interpolations between tracks (VAE decoder validation)

**Usage:**
```bash
python analysis/tools/analyze_interpolation_quality.py \
  --track-pairs 100 \
  --steps 10 \
  --output interpolation_quality.json
```

**Algorithm:**
1. Sample N pairs of distant tracks
2. Generate interpolation path (VAE decoder for intermediate latent points)
3. For each step, check if generated features are "musical":
   - Reconstruction error
   - Distance to nearest real track
   - Feature validity (e.g., BPM in valid range)
4. Compare VAE interpolation to linear PCA interpolation

**Output (JSON):**
```json
{
  "params": {"track_pairs": 100, "steps": 10},
  "vae_interpolation": {
    "avg_reconstruction_error": 0.12,
    "pct_valid_features": 98.5,
    "avg_distance_to_real": 0.08,
    "stays_on_manifold": true
  },
  "pca_interpolation": {
    "avg_reconstruction_error": 0.34,
    "pct_valid_features": 87.2,
    "avg_distance_to_real": 0.21,
    "stays_on_manifold": false
  },
  "winner": "vae",
  "quality_score": 0.92
}
```

---

#### 9. `analyze_disentanglement.py` (VAE-specific)

**Purpose:** Measure if VAE latent dimensions are disentangled (β-VAE validation)

**Usage:**
```bash
python analysis/tools/analyze_disentanglement.py \
  --output disentanglement_report.json
```

**Algorithm:**
1. For each latent dimension, vary it while holding others fixed
2. Measure which original features change most
3. Calculate independence score (mutual information)
4. Identify if dimensions map to musical concepts

**Output (JSON):**
```json
{
  "latent_dims": 8,
  "beta": 4.0,
  "disentanglement_score": 0.78,
  "dimension_interpretations": [
    {"latent_dim": 0, "primary_feature": "bpm", "correlation": 0.89},
    {"latent_dim": 1, "primary_feature": "spectral_centroid", "correlation": 0.76},
    ...
  ],
  "interpretation": "well_disentangled",
  "musical_concepts_learned": true
}
```

---

## Phase 4: ML Primitives Library

### Goal
Extract reusable ML components that can be applied to various problems.

### Structure

**Location:** `tsnotfyi/ml-primitives/` (or separate npm package later)

```
ml-primitives/
  src/
    embeddings/
      create-embedder.ts
      similarity.ts
      distance-metrics.ts
    reduction/
      pca.ts              # extract current PCA code
      feature-selection.ts
    clustering/
      kmeans.ts
      dbscan.ts
      hierarchical.ts
    classification/
      knn-classifier.ts
      decision-boundary.ts
    ranking/
      learned-rank.ts
      pair-preference.ts
    utils/
      normalize.ts
      validation.ts
  tests/
  README.md
```

### Primitives to Implement

#### 1. **Clustering**
```typescript
interface ClusteringResult {
  labels: number[];          // cluster assignment for each item
  centroids: number[][];     // cluster centers
  metrics: {
    silhouette_score: number;
    inertia: number;
  };
}

function cluster(
  embeddings: number[][],
  options: {
    method: 'kmeans' | 'dbscan' | 'hierarchical',
    n_clusters?: number,      // for kmeans
    eps?: number,             // for dbscan
    min_samples?: number      // for dbscan
  }
): ClusteringResult;
```

**Applications:**
- Auto-playlist generation (cluster similar tracks)
- Mood/genre discovery (find natural groupings)
- Library organization (tag clusters)

#### 2. **Similarity Search** (refactor existing)
```typescript
interface SimilarityOptions {
  metric: 'euclidean' | 'cosine' | 'manhattan';
  radius?: number;
  limit?: number;
}

function findSimilar(
  query: number[],
  corpus: number[][],
  options: SimilarityOptions
): Array<{index: number, distance: number}>;
```

#### 3. **Dimensionality Reduction** (refactor existing PCA)
```typescript
interface PCAModel {
  components: number[][];
  explained_variance: number[];
  mean: number[];
  transform(data: number[][]): number[][];
  inverse_transform(data: number[][]): number[][];
}

function fitPCA(
  data: number[][],
  n_components: number
): PCAModel;
```

**New applications:**
- Visualization (reduce to 2D/3D)
- Index size optimization
- Feature importance analysis

#### 4. **Classification** (new)
```typescript
interface Classifier {
  train(X: number[][], y: number[]): void;
  predict(X: number[][]): number[];
  predict_proba(X: number[][]): number[][];
}

function createKNNClassifier(k: number): Classifier;
```

**Applications:**
- Learn user skip patterns → predict skips
- Learn love/hate from features
- Content moderation (if needed)

#### 5. **Ranking** (new)
```typescript
interface RankingModel {
  train(items: number[][], preferences: Array<[number, number]>): void;
  rank(items: number[][]): number[];  // returns sorted indices
}

function createRankingModel(): RankingModel;
```

**Applications:**
- Learn good transitions (pair preferences)
- Personalized search result ranking
- Playlist ordering

### Integration Strategy

**Phase 4A: Extract existing code**
1. Move PCA implementation to ml-primitives
2. Extract similarity search logic
3. Add tests
4. Update server to import from ml-primitives

**Phase 4B: Add new primitives**
1. Implement clustering (start with k-means)
2. Implement classification (k-NN)
3. Add ranking model
4. Document usage patterns

**Phase 4C: Apply to new features**
Use analysis tools to identify opportunities:
- If analysis shows poor coverage → use clustering to expose diverse content
- If many isolated tracks → use classification to predict which will be loved
- If transitions are random → use ranking to learn good pairs

---

## Phase 5: VAE Integration & Adaptive Dimension Selection

### Goal
Add VAE as 8 additional dimensions to the toolkit and implement adaptive dimension selection for optimal journey crafting.

### Implementation Steps

**5A: VAE Implementation** (See `tsnotfyi-vae.md` for details)
1. Copy VAE module from agent-vomit
2. Train VAE on 18D core features:
   - `input_dim=18` (Essentia features)
   - `latent_dim=8` (different from PCA's 10 to avoid duplication)
   - `beta=4.0` (encourage disentanglement)
3. Save model to `tsnotfyi/models/music_vae.pt`
4. Create VAE service wrapper (Python subprocess)
5. Pre-compute VAE embeddings for all tracks
6. Store in database: add 8 columns `vae_0` through `vae_7` to `music_analysis` table

**5B: Dimension Labeling via PCA Mapping**
```python
# label_vae_dimensions.py
# Correlate VAE dims with PCA dims to bootstrap semantic labels

def map_vae_to_pca(pca_embeddings, vae_embeddings):
    for vae_dim in range(8):
        correlations = {}
        for pca_dim in pca_dimension_names:
            corr = np.corrcoef(vae_embeddings[:, vae_dim], pca_embeddings[pca_dim])[0,1]
            correlations[pca_dim] = corr

        best_match = max(correlations.items(), key=lambda x: abs(x[1]))

        if abs(best_match[1]) > 0.5:
            # Strong correlation - inherit PCA label
            vae_labels[vae_dim] = f"{best_match[0]}_learned (ρ={best_match[1]:.2f})"
        else:
            # Weak correlation - unique dimension
            vae_labels[vae_dim] = f"vae_{vae_dim}_unique"

    return vae_labels
```

Store labels in database for API consumption.

**5C: Adaptive Dimension Selection Implementation**
```javascript
// In kd-tree.js or new adaptive-search.js

function selectDimensionsForStep(currentTrack, neighbors, context) {
  const allDimensions = [
    ...coreFeatures,    // 18
    ...pcaDimensions,   // 10
    ...vaeDimensions    // 8
  ];

  // Score each dimension for this neighborhood
  const scores = allDimensions.map(dim => ({
    name: dim,
    space: getSpace(dim),
    variance: calculateVariance(neighbors, dim),
    coverage: calculateCoverage(currentTrack, neighbors, dim),
    clustering: calculateSilhouette(neighbors, dim),
    utility: compositeScore(...)
  }));

  // Return top N dimensions
  return scores
    .sort((a, b) => b.utility - a.utility)
    .slice(0, 5);
}

function dedupAndPrioritise(candidates, currentTrack, neighbors, context) {
  // 1. Select best dimensions for this step
  const topDims = selectDimensionsForStep(currentTrack, neighbors, context);

  // 2. Compute weighted distance using selected dimensions
  candidates = candidates.map(c => {
    let distance = 0;
    topDims.forEach((dim, idx) => {
      const weight = 1.0 / (idx + 1);  // decreasing weight
      distance += weight * Math.abs(currentTrack[dim.name] - c.track[dim.name]);
    });
    return { ...c, distance, dims_used: topDims.map(d => d.name) };
  });

  // 3. Sort and return
  return candidates.sort((a, b) => a.distance - b.distance);
}
```

**5D: Journey Tracking**
```javascript
// Track dimension usage across navigation steps

CREATE TABLE journey_steps (
  id SERIAL PRIMARY KEY,
  session_id TEXT,
  step_number INTEGER,
  from_track TEXT,
  to_track TEXT,
  dimensions_used TEXT[],  // e.g., ['vae_3', 'bpm', 'spectral_pc1']
  dimension_utilities REAL[],  // corresponding utility scores
  user_feedback INTEGER,  // 1=continued, 0=stopped, -1=backtracked
  timestamp TIMESTAMP
);
```

**5E: Usage Pattern Analysis**
```bash
# After collecting journey data
python analysis/tools/analyze_dimension_patterns.py --min-journeys 100

# Output:
# - Which dimensions appear most frequently?
# - Which dimensions are workhorse vs specialists?
# - Which dimension combinations work well together?
# - Which dimensions rarely contribute (candidates for removal)?
```

### Success Metrics

**Not: "Does VAE beat PCA?"**

**Instead: "How do all 36 dimensions contribute to navigation?"**

- ✓ Adaptive selection improves coverage vs any single embedding (target: >10% improvement)
- ✓ Dimension usage patterns emerge (workhorses vs specialists identified)
- ✓ Some dimensions from each space are useful (validates 36-dim toolkit approach)
- ✓ Journey quality improves (measured by user continuation rate)
- ✓ System can explain its choices ("used vae_3 + bpm because high variance here")

**If successful:** Keep all 36 dimensions, use adaptive selection by default

---

## Implementation Priorities

### Immediate (After TypeScript Upgrade)
1. **Instrumentation** - start collecting data ASAP
   - Add analytics.db
   - Add play/rate endpoints
   - Hook up client

### Near-term
2. **KD-Tree APIs** - enable analysis without code duplication
   - Implement inspection endpoints
   - Document API

3. **Core Analysis Tools** - understand current state
   - `analyze_density.py`
   - `analyze_reachability.py`
   - Run initial analysis, document findings

### Medium-term
4. **Additional Analysis** - deeper understanding
   - `analyze_connectivity.py`
   - `simulate_search.py`
   - `analyze_distance_metrics.py` - test cosine vs euclidean
   - Use findings to inform next steps

5. **ML Primitives Library** - refactor + extend
   - Extract existing PCA/similarity
   - Add clustering
   - Apply to discovered problems

### Long-term (Post-Analysis)
6. **VAE Implementation** - add 8 more dimensions to toolkit
   - Implement VAE training (tsnotfyi-vae.md)
   - Pre-compute VAE embeddings for all tracks
   - Label VAE dimensions via PCA mapping
   - Add to dimension pool (now 36 total)

7. **Adaptive Dimension Selection** - the core innovation
   - Implement dimension utility scoring
   - Build adaptive selection in dedupAndPrioritise
   - Add journey tracking infrastructure
   - Deploy and collect usage data

8. **Dimension Pattern Analysis** - understand what works
   - `analyze_dimension_utility.py` (identify workhorses/specialists)
   - `analyze_dimension_patterns.py` (usage patterns from journeys)
   - Validate: Does adaptive selection outperform fixed embeddings?
   - Iterate: Remove redundant dimensions, tune selection logic

9. **New Discovery Mechanisms** - leverage dimension insights
   - Design informed by dimension utility metrics
   - Target under-covered areas using specialist dimensions
   - Surface bridge tracks (high utility in sparse regions)
   - Validate with analysis tools

---

## Success Metrics

**Instrumentation:**
- ✓ Data collecting without errors
- ✓ Can query play counts and ratings

**Analysis Tools:**
- ✓ Can measure density distribution
- ✓ Can identify isolated/unreachable tracks
- ✓ Can measure search coverage
- ✓ Outputs are actionable (point to specific improvements)

**ML Primitives:**
- ✓ Existing code extracted and tested
- ✓ At least one new primitive (clustering) working
- ✓ Applied to at least one new feature
- ✓ Measurably improves coverage/diversity metrics

**Dimension Toolkit (with VAE integrated):**
- ✓ All 36 dimensions available (18 core + 10 PCA + 8 VAE)
- ✓ VAE dimensions labeled via PCA mapping
- ✓ Dimension utility analysis reveals workhorses, specialists, redundant dims
- ✓ Usage patterns emerge from journey tracking

**Adaptive Selection:**
- ✓ Adaptive dimension selection implemented
- ✓ Outperforms any single embedding by >10% (coverage/diversity)
- ✓ System can explain dimension choices per step
- ✓ Dimension usage varies meaningfully across journey (validates adaptive approach)

---

## Anticipated Findings & Dimension Patterns

Based on the 36-dimensional toolkit approach (18 core + 10 PCA + 8 VAE), we anticipate discovering:

### Expected Dimension Patterns (High Probability)

**1. Workhorse Dimensions (appear in 60-80% of steps)**
- **Likely candidates:**
  - `bpm` (core) - universal discriminator across genres
  - `primary_d` (PCA) - designed as primary discriminator
  - 1-2 VAE dimensions (e.g., vae_3, vae_0) - learned cross-domain patterns
- **Detection:** `analyze_dimension_utility.py` shows high avg_utility + high appears_in_top5
- **Implication:** These become the default navigation axes

**2. Specialist Dimensions (appear in 20-40% of steps, context-specific)**
- **Likely candidates:**
  - `spectral_centroid` (core) - useful when timbre varies, genre constant
  - `tonal_pc1, tonal_pc2` (PCA) - useful in harmonic music clusters
  - Some VAE dimensions - useful in specific manifold regions
- **Detection:** `analyze_dimension_patterns.py` shows correlation with neighborhood type
- **Implication:** System learns when to deploy specialists

**3. Redundant Dimensions (appear in <5% of steps)**
- **Likely candidates:**
  - `air_sizzle` (core) - probably correlates highly with spectral features
  - Some PCA dimensions - might be replaced by VAE equivalents
  - Some VAE dimensions - might not discover unique structure
- **Detection:** Low utility scores, high correlation with other dims
- **Implication:** Candidates for removal (reduce from 36 to ~25-30 useful dims)

**4. Embedding Space Contributions**
- **Core features (18):** Expect 3-5 workhorses (bpm, spectral_centroid, etc.)
- **PCA (10):** Expect primary_d + 2-3 domain specialists
- **VAE (8):** Expect 2-3 workhorses (cross-domain patterns) + 1-2 specialists
- **Total useful:** ~20-25 dimensions (30-40% reduction from 36)

### Expected Usage Patterns (Journey-Level)

**Scenario 1: Dense techno cluster**
```
Step 1→2: [bpm, rhythmic_pc1, vae_5] (tempo-focused)
Step 2→3: [bpm, spectral_pc1, vae_5] (add timbre variation)
Step 3→4: [bpm, vae_5, danceability] (maintain energy)
```
Pattern: `bpm` and `vae_5` persist (local workhorses), specialists rotate

**Scenario 2: Sparse boundary region**
```
Step 1→2: [vae_3, vae_7, primary_d] (VAE provides coverage)
Step 2→3: [vae_3, spectral_centroid, tonal_pc1] (bridge via timbre/harmony)
Step 3→4: [bpm, vae_3, rhythmic_pc1] (re-enter dense region)
```
Pattern: VAE dominates in sparse areas, core/PCA re-emerge in dense regions

**Scenario 3: Within-genre exploration**
```
Step 1→2: [spectral_centroid, crest, tonal_pc2] (genre constant, timbre/texture vary)
Step 2→3: [spectral_centroid, spectral_pc1, vae_2] (stay in timbral space)
```
Pattern: Genre features (bpm) absent, timbral specialists dominate

### Validation of Toolkit Approach

**If successful, we expect:**
1. **Different cardinalities matter:** Core/PCA/VAE each contribute unique dimensions
   - Core: raw discriminative power (bpm, spectral_centroid)
   - PCA: domain-decomposed specialists (tonal_pc2, rhythmic_pc1)
   - VAE: learned cross-domain patterns (vae_3 might encode "intensity")

2. **Adaptive selection wins:** Beats any fixed embedding by >10%
   - Fixed PCA: ~74% coverage
   - Fixed VAE: ~80% coverage
   - Adaptive (top 5 from 36): ~90% coverage

3. **Dimension usage varies meaningfully:**
   - Dense regions: prefer core features (direct, fast)
   - Sparse regions: prefer VAE (manifold coverage)
   - Boundaries: mix of PCA specialists (domain-specific bridges)

4. **Explainability emerges:**
   - "Used vae_3 + bpm because high variance in this neighborhood"
   - "Dropped air_sizzle - correlates 0.95 with spectral_flatness"
   - "Step into jazz cluster: switching to tonal_pc1 + tonal_pc2"

**If this fails (adaptive ≤ fixed):** Some dimensions are truly redundant, or utility metrics are wrong. Iterate on scoring logic.

---

## Open Questions for Future Agent

1. **Server language for new APIs:** TypeScript/Node as existing, or consider exposing Python directly?

2. **Analysis refresh frequency:** How often should these be run? On-demand only, or periodic?

3. **Clustering parameters:** How many clusters? Auto-determine or user-specified?

4. **Discovery mechanisms:** Once we know what's under-covered, how aggressively should we surface it?
   - Inject into search results?
   - Separate "explore" mode?
   - Weighted randomization?

5. **Real-time vs batch:** Should any of this work in real-time, or all offline analysis?

6. **Visualization:** User said "visualizations irrelevant" for metrics, but might interactive exploration tools be useful for debugging?

---

## Notes

- **Philosophy:** Use ML primitives liberally because agents make them cheap to generate
- **Focus:** Reachability topology, not historical access patterns
- **Output:** Health metrics and actionable insights, not dashboards
- **Tools:** Ad-hoc and comprehensive, not routine monitoring
- **Flexibility:** Language/implementation choices optimized for useful results, not code maintenance

---

## Next Steps for Agent Picking This Up

1. Review current state:
   - Read PCA implementation (check recent commits re: PCA weights)
   - Understand current embedding pipeline (import → postgres)
   - Check kd-tree.js implementation

2. Start with instrumentation:
   - Create analytics.db schema
   - Add server endpoints
   - Test with manual API calls

3. Add KD-tree inspection APIs:
   - Start with simplest ones (stats, single-track queries)
   - Test with curl/postman
   - Add batch endpoints for efficiency

4. Set up analysis environment:
   - Create analysis/ directory
   - Set up Python venv + requirements
   - Build API client wrapper
   - Test data fetching

5. Build first tool (density analysis):
   - Start simple: just fetch data and compute local densities
   - Add statistics and output formatting
   - Run on real data, review results
   - Iterate to add more useful metrics

6. Proceed through remaining tools based on findings

**Estimated effort:**
- Phase 1 (Instrumentation): 4-6 hours
- Phase 2 (Dimension APIs): 8-10 hours (more complex - all 36 dims)
- Phase 3 (Analysis tools):
  - Core dimension analysis (tools 0-2): 12-16 hours
  - Topology analysis (tools 3-5): 8-12 hours
  - Specialized tools: 4-6 hours
- Phase 4 (ML Primitives): 16-24 hours
- Phase 5 (VAE + Adaptive Selection): 30-40 hours
  - VAE training & integration: 12-16 hours
  - Dimension labeling: 4-6 hours
  - Adaptive selection implementation: 8-12 hours
  - Journey tracking & pattern analysis: 6-8 hours

**Total:** ~80-110 hours for complete dimension toolkit approach

**Note:** This is significantly more ambitious than the original embedding comparison approach, but the payoff is a truly adaptive navigation system rather than a simple A/B test.
