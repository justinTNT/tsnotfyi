# VAE Integration Phase 1: Database Migration & Training

This directory contains scripts for Phase 1 of VAE integration into tsnotfyi.

## Phase 1 Overview

Phase 1 adds VAE (Variational Autoencoder) capabilities to tsnotfyi as a database migration and standalone training process. This phase:

1. **Adds VAE columns** to the existing PostgreSQL `music_analysis` table
2. **Trains a VAE** on the existing 18D music features  
3. **Stores 8D latent embeddings** back to the database
4. **Saves the trained model** for later runtime use

## Files

- `../migrations/001_add_vae_columns.sql` - Database migration script
- `train_music_vae.py` - Standalone VAE training script
- `requirements_vae.txt` - Python dependencies for VAE training
- `README_VAE_Phase1.md` - This file

## Prerequisites

1. **PostgreSQL database** with existing `music_analysis` table containing 18D features
2. **Python 3.8+** with pip
3. **Sufficient training data** (recommended: 1000+ tracks)

## Installation

1. **Install Python dependencies:**
   ```bash
   pip install -r requirements_vae.txt
   ```

2. **Run database migration:**
   ```bash
   psql -d your_database -f ../migrations/001_add_vae_columns.sql
   ```

## Usage

### Option 1: Using tsnotfyi config file
```bash
python train_music_vae.py --config /path/to/tsnotfyi-config.json
```

### Option 2: Using command line arguments
```bash
python train_music_vae.py \
    --host localhost \
    --port 5432 \
    --database music \
    --user postgres \
    --epochs 100 \
    --model-path ./models/music_vae.pt
```

### Environment Variables
Set `PGPASSWORD` for database authentication:
```bash
export PGPASSWORD=your_password
python train_music_vae.py --config tsnotfyi-config.json
```

## Training Configuration

The VAE training uses these parameters:
- **Input dimensions:** 18 (existing music features)
- **Latent dimensions:** 8 (compressed representation)
- **Architecture:** 18 → 64 → 32 → 8 → 32 → 64 → 18
- **Beta:** 4.0 (β-VAE for disentangled representations)
- **Activation:** GELU (better for music data than ReLU)
- **Dropout:** 0.1 (regularization)

## Output

After successful training:

1. **Database updated** with VAE embeddings in `vae_latent_0` through `vae_latent_7` columns
2. **Model saved** to specified path (default: `./models/music_vae.pt`)
3. **Metadata added** including model version and computation timestamp

## Validation

Check that embeddings were computed correctly:
```sql
SELECT 
    COUNT(*) as total_tracks,
    COUNT(vae_latent_0) as tracks_with_vae,
    AVG(vae_latent_0) as avg_latent_0,
    STDDEV(vae_latent_0) as std_latent_0
FROM music_analysis;
```

## Next Steps

After Phase 1 completion:
- **Phase 2:** Update `kd-tree.js` and `radial-search.js` to use VAE embeddings
- **Phase 3:** Add VAE service wrapper and API endpoints
- **Phase 4:** Integrate VAE training into `beets2tsnot.py` import process

## Troubleshooting

**"Only N tracks available - VAE may be unstable"**
- Minimum 1000 tracks recommended for stable training
- Consider reducing latent dimensions if dataset is very small

**"Failed to save embeddings"**
- Check database permissions
- Verify migration was applied correctly
- Check disk space

**CUDA out of memory**
- Reduce batch size: `--batch-size 64`
- Train on CPU (slower but uses less memory)

**Training loss not decreasing**
- Increase epochs: `--epochs 200`
- Check for NaN values in input data
- Verify feature normalization is working

## Architecture Notes

The VAE is specifically designed for music data:
- **GELU activation** works better than ReLU for continuous music features
- **β-VAE (β=4.0)** encourages disentangled latent representations
- **Deterministic encoding** during inference (using μ, not sampling)
- **Standard scaling** normalizes the 18D input features

The latent space is designed to capture musical relationships that linear PCA might miss, enabling more musical exploration paths while maintaining the existing API structure.