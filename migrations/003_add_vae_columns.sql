-- Migration 003: Add VAE embedding columns to music_analysis table
-- This adds 8 VAE dimensions (vae_0 through vae_7) to store learned embeddings

BEGIN;

-- Add 8 VAE columns to the music_analysis table
ALTER TABLE music_analysis 
ADD COLUMN vae_0 REAL,
ADD COLUMN vae_1 REAL,
ADD COLUMN vae_2 REAL,
ADD COLUMN vae_3 REAL,
ADD COLUMN vae_4 REAL,
ADD COLUMN vae_5 REAL,
ADD COLUMN vae_6 REAL,
ADD COLUMN vae_7 REAL;

-- Add index for VAE-based searches (composite index on first few VAE dimensions)
CREATE INDEX idx_music_analysis_vae_primary ON music_analysis(vae_0, vae_1, vae_2);
CREATE INDEX idx_music_analysis_vae_secondary ON music_analysis(vae_3, vae_4, vae_5);

-- Add comments for documentation
COMMENT ON COLUMN music_analysis.vae_0 IS 'VAE latent dimension 0 - learned from 18D core features';
COMMENT ON COLUMN music_analysis.vae_1 IS 'VAE latent dimension 1 - learned from 18D core features';
COMMENT ON COLUMN music_analysis.vae_2 IS 'VAE latent dimension 2 - learned from 18D core features';
COMMENT ON COLUMN music_analysis.vae_3 IS 'VAE latent dimension 3 - learned from 18D core features';
COMMENT ON COLUMN music_analysis.vae_4 IS 'VAE latent dimension 4 - learned from 18D core features';
COMMENT ON COLUMN music_analysis.vae_5 IS 'VAE latent dimension 5 - learned from 18D core features';
COMMENT ON COLUMN music_analysis.vae_6 IS 'VAE latent dimension 6 - learned from 18D core features';
COMMENT ON COLUMN music_analysis.vae_7 IS 'VAE latent dimension 7 - learned from 18D core features';

COMMIT;