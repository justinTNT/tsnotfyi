## VAE Integration Plan for tsnotfyi

### Project Goal
Replace linear PCA-based music exploration in [tsnotfyi](https://github.com/justinTNT/tsnotfyi) with a VAE that learns non-linear manifolds of the music collection, enabling more musical exploration paths while maintaining the current API structure.

### Phase 1: VAE Module Integration
1. **Copy VAE module from agent-vomit**
   - Source: `/Users/jtnt/Play/agent-vomit/modules/autoencoder.py` (the VAE class)
   - Destination: Create `tsnotfyi/src/ml/vae.py`
   - Add PyTorch to tsnotfyi dependencies

2. **Create VAE training script**
   - Location: `tsnotfyi/src/ml/train_vae.py`
   - Load existing 18D features from PostgreSQL (see `tsnotfyi/src/db/musicalDB.js` for schema)
   - Train VAE with:
     - input_dim=18 (matching current feature dimensions)
     - latent_dim=8 (compressed but expressive)
     - beta=4.0 (for disentangled representations)
   - Save trained model to `tsnotfyi/models/music_vae.pt`

### Phase 2: Service Integration
1. **Create VAE service wrapper**
   - Location: `tsnotfyi/src/services/vaeService.js`
   - Python subprocess to load model and handle inference
   - Methods needed:
     - `encode(features)` - Project 18D features to 8D latent
     - `decode(latent)` - Generate valid 18D features from latent
     - `interpolate(latent1, latent2, steps)` - Non-linear path between tracks
     - `flow(latent, direction, amount)` - Move in latent space

2. **Update RadialSearchService**
   - File: `tsnotfyi/src/services/radialSearchService.js`
   - Add VAE mode alongside existing PCA mode
   - In `findRadialTracks()` method, add switch for VAE-based search
   - Keep PCA as default, VAE as opt-in mode

### Phase 3: API Updates
1. **Extend exploration endpoint**
   - File: `tsnotfyi/server.js`
   - Add `mode` parameter to `/explore` endpoint
   - Options: `"pca"` (default), `"vae"` (new)
   - Pass mode through to RadialSearchService

2. **Add VAE-specific endpoints**
   - `/api/vae/interpolate` - Find paths between two tracks
   - `/api/vae/dimensions` - Explore learned latent dimensions
   - Integration point: Near existing `/api/points/:trackId/radial` endpoint

### Phase 4: Database Extensions
1. **Cache VAE embeddings**
   - Add `vae_latent` column to tracks table (REAL[8])
   - Pre-compute during training for faster runtime
   - Update after model retraining

### Technical Requirements
- PyTorch + NumPy for VAE operations
- Python subprocess communication from Node.js
- Model versioning strategy for retraining
- Graceful fallback to PCA if VAE unavailable

### Testing Strategy
1. **Comparative exploration tests**
   - Same starting track, compare PCA vs VAE paths
   - Verify VAE paths stay within "musical" regions
   - Check edge cases (very sparse/dense regions)

2. **Performance benchmarks**
   - VAE inference time vs PCA computation
   - Memory usage with model loaded
   - Batch processing capabilities

### Success Metrics
- VAE explorations avoid "dead zones" that PCA hits
- Smooth interpolations between previously unreachable track pairs  
- Learned dimensions correspond to musical concepts
- No degradation in exploration response time

### Implementation Notes
- Keep all existing KD-Tree and PCA code intact
- VAE is additive, not replacement
- Focus on musical validity over mathematical optimization
- Use existing track features without recomputation

### Reference Points in tsnotfyi
- Feature extraction: See Essentia integration in README
- Current PCA: `src/services/radialSearchService.js` lines 97-112
- KD-Tree usage: `src/utils/musicalKDTree.js`
- Track feature schema: `src/db/musicalDB.js`