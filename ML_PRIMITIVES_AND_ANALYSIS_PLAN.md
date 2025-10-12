# ML Primitives & Embedding Space Analysis Plan

## Overview
Build a reusable ML primitives library and comprehensive analysis toolkit to understand and optimize the embedding space. Focus on measuring distribution, reachability, and system health to inform discovery mechanisms.

**Priority:** After TypeScript upgrade
**Philosophy:** Agents generate ML components easily → use them more liberally

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

## Phase 2: KD-Tree Inspection APIs

### Goal
Expose the embedding space structure for analysis without duplicating code.

### New Server Endpoints

**GET /api/kd-tree/stats**
```json
{
  "total_tracks": 5234,
  "dimensions": 12,
  "tree_depth": 15,
  "tracks_per_leaf_avg": 8.2
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

**GET /api/kd-tree/track/:id/position**
```json
{
  "track_id": "abc123",
  "embedding": [0.23, -0.45, ...],
  "local_density": 23,  // neighbors within default radius
  "nearest_distance": 0.02
}
```

**POST /api/kd-tree/batch-neighbors**
Body: `{track_ids: ["id1", "id2", ...], radius: 0.1}`
Returns neighbors for multiple tracks (efficient for analysis)

**GET /api/kd-tree/random-tracks?count=100**
Returns random sample of track IDs (for reachability analysis)

**GET /api/kd-tree/all-tracks**
Returns all track IDs + embeddings (paginated if needed)
- For offline analysis
- Format: newline-delimited JSON

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
    api_client.py      # wrapper for server APIs
    embeddings.py      # load/cache embedding data
    metrics.py         # common metric calculations
  tools/
    analyze_density.py
    analyze_reachability.py
    analyze_connectivity.py
    simulate_search.py
    export_data.py
```

### Tool Specifications

#### 1. `analyze_density.py`

**Purpose:** Understand local density distribution across the embedding space

**Usage:**
```bash
python analysis/tools/analyze_density.py --radius 0.1 --output density_report.json
```

**Algorithm:**
1. Fetch all tracks + embeddings from server
2. For each track, query neighbors within radius
3. Compute local density (neighbor count)
4. Calculate statistics:
   - Mean, median, std dev of densities
   - Percentiles (10th, 25th, 50th, 75th, 90th)
   - Isolation score: % tracks with density < threshold (e.g., < 3)
   - Cluster identification: connected components via neighbor links

**Output (JSON):**
```json
{
  "params": {"radius": 0.1, "total_tracks": 5234},
  "density_stats": {
    "mean": 15.3,
    "median": 12,
    "std": 8.7,
    "percentiles": {"10": 2, "25": 6, "50": 12, "75": 20, "90": 28}
  },
  "isolated_tracks": 234,  // count with density < 3
  "isolated_fraction": 0.045,
  "clusters": [
    {"size": 1200, "avg_density": 22},
    {"size": 800, "avg_density": 18},
    ...
  ],
  "density_histogram": {
    "0-5": 150,
    "5-10": 400,
    "10-15": 800,
    ...
  }
}
```

**Also export CSV:** track_id, density, nearest_distance

---

#### 2. `analyze_reachability.py`

**Purpose:** Measure what's reachable from random starting points via similarity search

**Usage:**
```bash
python analysis/tools/analyze_reachability.py \
  --samples 1000 \
  --max-distance 0.5 \
  --hop-limit 5 \
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
    "hop_limit": 5
  },
  "coverage": {
    "total_tracks": 5234,
    "reachable_from_any": 4892,
    "unreachable_from_any": 342,
    "coverage_pct": 93.5
  },
  "reach_distribution": {
    "reached_from_all": 1200,
    "reached_from_90pct": 2800,
    "reached_from_50pct": 4200,
    "reached_from_10pct": 4892
  },
  "path_stats": {
    "avg_hops": 2.3,
    "max_hops_observed": 5,
    "unreachable_within_limit": 342
  },
  "dead_zones": [
    {"track_id": "abc", "reached_from": 0.02},  // only 2% of samples
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
python analysis/tools/analyze_connectivity.py --threshold 0.1 --output connectivity_report.json
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
  "params": {"threshold": 0.1},
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
   - Use findings to inform next steps

5. **ML Primitives Library** - refactor + extend
   - Extract existing PCA/similarity
   - Add clustering
   - Apply to discovered problems

### Long-term
6. **New Discovery Mechanisms** - based on analysis
   - Design informed by metrics
   - Target under-covered areas
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
- Phase 2 (APIs): 6-8 hours
- Phase 3 (Analysis tools): 12-16 hours (2-3 hours per tool)
- Phase 4 (ML Primitives): 16-24 hours

**Total:** ~40-50 hours for comprehensive implementation
