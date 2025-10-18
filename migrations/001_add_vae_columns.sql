-- Migration: Add VAE latent embedding columns to music_analysis table
-- Phase 1 of VAE Integration for tsnotfyi
-- Run with: psql -d your_database -f 001_add_vae_columns.sql

BEGIN;

-- Add 8 VAE latent dimension columns (8D latent space)
ALTER TABLE music_analysis ADD COLUMN IF NOT EXISTS vae_latent_0 DOUBLE PRECISION;
ALTER TABLE music_analysis ADD COLUMN IF NOT EXISTS vae_latent_1 DOUBLE PRECISION;
ALTER TABLE music_analysis ADD COLUMN IF NOT EXISTS vae_latent_2 DOUBLE PRECISION;
ALTER TABLE music_analysis ADD COLUMN IF NOT EXISTS vae_latent_3 DOUBLE PRECISION;
ALTER TABLE music_analysis ADD COLUMN IF NOT EXISTS vae_latent_4 DOUBLE PRECISION;
ALTER TABLE music_analysis ADD COLUMN IF NOT EXISTS vae_latent_5 DOUBLE PRECISION;
ALTER TABLE music_analysis ADD COLUMN IF NOT EXISTS vae_latent_6 DOUBLE PRECISION;
ALTER TABLE music_analysis ADD COLUMN IF NOT EXISTS vae_latent_7 DOUBLE PRECISION;

-- Add metadata columns for VAE model tracking
ALTER TABLE music_analysis ADD COLUMN IF NOT EXISTS vae_model_version TEXT;
ALTER TABLE music_analysis ADD COLUMN IF NOT EXISTS vae_computed_at TIMESTAMP;

-- Create index on VAE latent dimensions for fast similarity search
-- (Optional - can be added later if needed for performance)
-- CREATE INDEX CONCURRENTLY idx_music_analysis_vae_latent ON music_analysis 
-- USING btree (vae_latent_0, vae_latent_1, vae_latent_2, vae_latent_3);

-- Verify the migration
DO $$
BEGIN
    -- Check that all columns were added
    IF EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'music_analysis' 
        AND column_name = 'vae_latent_7'
    ) THEN
        RAISE NOTICE 'VAE columns successfully added to music_analysis table';
    ELSE
        RAISE EXCEPTION 'Migration failed: VAE columns not found';
    END IF;
END $$;

COMMIT;

-- Display current table structure for verification
\d music_analysis;