# ML Analysis Toolkit

The ML Analysis Toolkit provides comprehensive validation and comparison tools for the music recommendation system's embedding approaches (Core features, PCA, VAE, Auto mode).

## Overview

This toolkit validates whether the existing adaptive dimension selection (`auto` mode) is working optimally by comparing different embedding types across three key metrics:

- **Dimension Utility**: Which features are workhorses vs specialists vs redundant
- **Density Distribution**: Local neighborhood quality and isolation patterns  
- **Reachability**: Multi-hop connectivity and dead zone analysis

## Quick Start

### 1. Test System Connectivity
```bash
python scripts/run_complete_analysis.py --test-only
```
Validates server and database connectivity before running analysis.

### 2. Run Complete Analysis (Recommended)
```bash
# Quick analysis (assumes VAE already trained)
python scripts/run_complete_analysis.py --quick

# Full analysis including VAE training
python scripts/run_complete_analysis.py --train-vae --epochs 50

# Custom parameters
python scripts/run_complete_analysis.py --quick --sample-tracks 2000 --radius 0.4
```

The complete pipeline:
1. Tests connectivity
2. Optionally trains VAE model
3. Runs all three analysis tools
4. Generates decision report with recommendations

## Individual Analysis Tools

### Dimension Utility Analysis
```bash
python scripts/analyze_dimension_utility.py --sample-tracks 1000 --radius 0.3
```

**Purpose**: Identify which dimensions are workhorses (broadly useful), specialists (niche but valuable), or redundant (overlapping with others).

**Metrics**:
- Variance: How much each dimension varies across the music library
- Coverage: Percentage of tracks reachable via this dimension
- Clustering: How well tracks cluster in this dimension
- Spread: Distribution quality across the dimension range

### Density Distribution Analysis
```bash
python scripts/analyze_density.py --sample-tracks 1000 --radius 0.3
```

**Purpose**: Measure local neighborhood quality and identify isolation problems.

**Metrics**:
- Mean/median neighbors per track within radius
- Isolation percentage (tracks with <3 neighbors)
- Distance meaningfulness (curse of dimensionality assessment)
- Comparative density across embedding types

### Reachability Analysis
```bash
python scripts/analyze_reachability.py --samples 500 --max-hops 5 --radius 0.3
```

**Purpose**: Analyze multi-hop connectivity and identify dead zones.

**Metrics**:
- Coverage: Tracks reachable from random starting points
- Path lengths: Average hops needed to reach distant tracks
- Dead zones: Tracks that are rarely/never reached
- Connectivity comparison across embeddings

### Comprehensive Comparison
```bash
python scripts/compare_embedding_coverage_updated.py --sample-tracks 1000 --radius 0.3
```

**Purpose**: Orchestrates all three tools and generates unified comparison report.

## Understanding Results

### Decision Thresholds

The analysis pipeline uses these decision criteria:

- **>15% improvement**: Implement VAE (significant benefit)
- **5-15% improvement**: Consider VAE (modest benefit, evaluate costs)
- **±5% difference**: Stick with current approach (similar performance)
- **<-5% difference**: Optimize PCA (VAE underperforms)

### Key Metrics to Watch

1. **Composite Scores**: Weighted combination of density + reachability + utility
2. **VAE vs PCA Improvement**: Direct performance comparison
3. **Isolation Rates**: High isolation (>20%) indicates poor embedding quality
4. **Dead Zone Counts**: Many unreachable tracks suggest connectivity problems

### Interpreting Recommendations

The analysis generates actionable recommendations:

```json
{
  "decision": "implement_vae",
  "reason": "VAE shows significant 18.5% improvement",
  "recommendations": [
    "Best overall embedding: vae (score: 0.847)",
    "🎉 VAE shows significant improvement (18.5%) - implement full VAE pipeline",
    "Consider dimension reduction: 8/36 dimensions appear redundant"
  ]
}
```

## Common Usage Patterns

### Development/Testing
```bash
# Quick connectivity test
python scripts/run_complete_analysis.py --test-only

# Fast analysis with small sample
python scripts/run_complete_analysis.py --quick --sample-tracks 500
```

### Production Analysis
```bash
# Full analysis for decision making
python scripts/run_complete_analysis.py --train-vae --epochs 100 --sample-tracks 2000
```

### Debugging Specific Issues
```bash
# Focus on density problems
python scripts/analyze_density.py --sample-tracks 2000 --radius 0.2

# Investigate connectivity issues
python scripts/analyze_reachability.py --samples 1000 --max-hops 7
```

## Output Files

- `vae_decision_report.json`: Final decision with recommendations
- `comprehensive_embedding_analysis.json`: Complete analysis results
- `dimension_utility_results.json`: Dimension analysis details
- `density_analysis_results.json`: Density distribution data
- `reachability_analysis_results.json`: Connectivity analysis data

## Architecture Notes

The toolkit validates the existing **adaptive dimension selection** already implemented in `kd-tree.js`:

```javascript
case 'auto':
    // Prefer VAE if available, fallback to PCA, then features
    if (centerTrack.vae?.latent) {
        return this.vaeRadiusSearch(centerTrack, radius, limit);
    } else if (centerTrack.pca) {
        return this.pcaRadiusSearch(centerTrack, resolution, discriminator, limit);
    } else {
        return this.radiusSearch(centerTrack, radius, weights, limit);
    }
```

This analysis determines whether this preference order (VAE → PCA → Features) is optimal, or if adjustments are needed.

## Future Enhancements

### Journey Tracking
Add logging to `smartRadiusSearch` to track which embedding types are actually used:

```javascript
console.log(`🔍 Search completed using: ${selectedEmbedding} for track ${centerTrack.identifier}`);
```

### Usage Analytics
Collect and analyze patterns:
- Which embedding types are used most frequently?
- Do certain music genres prefer specific embeddings?
- Are there temporal patterns in embedding usage?

## Troubleshooting

### "Server connectivity failed"
- Ensure tsnotfyi server is running: `cd tsnotfyi && node server.js`
- Check server URL parameter: `--server-url http://localhost:3001`

### "Database connection failed"  
- Verify PostgreSQL is running
- Check database exists and is accessible
- Ensure VAE columns exist if testing VAE embeddings

### "No VAE embeddings found"
- Run VAE training: `--train-vae` flag
- Check migration applied: `migrations/003_add_vae_columns.sql`
- Verify VAE service is functional

### High rejection rates
- Increase sample size: `--sample-tracks 2000`
- Adjust search radius: `--radius 0.4`
- Check for data quality issues in specific dimensions