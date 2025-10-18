-- Migration 002: Add User Data Tables
-- Creates tables for play statistics, ratings, and playlists

-- Play statistics table
-- Tracks completion counts for successful crossfades
CREATE TABLE IF NOT EXISTS play_stats (
    identifier VARCHAR(32) PRIMARY KEY REFERENCES music_analysis(identifier) ON DELETE CASCADE,
    completion_count INTEGER DEFAULT 0,
    last_completed TIMESTAMP,
    total_play_time INTEGER DEFAULT 0, -- seconds of total listening time
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- User ratings table  
-- Simple love/hate ratings (-1, 0, 1)
CREATE TABLE IF NOT EXISTS ratings (
    identifier VARCHAR(32) PRIMARY KEY REFERENCES music_analysis(identifier) ON DELETE CASCADE,
    rating INTEGER CHECK (rating IN (-1, 0, 1)), -- -1=hate, 0=neutral/unset, 1=love
    rated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Playlists table
-- Named collections of tracks with journey directions
CREATE TABLE IF NOT EXISTS playlists (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Playlist items table
-- Individual tracks within playlists with position and context
CREATE TABLE IF NOT EXISTS playlist_items (
    id SERIAL PRIMARY KEY,
    playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
    identifier VARCHAR(32) NOT NULL REFERENCES music_analysis(identifier) ON DELETE CASCADE,
    position INTEGER NOT NULL, -- 0-based ordering within playlist
    direction TEXT, -- how we arrived at this track (e.g., "bpm_positive", null for first track)
    scope TEXT CHECK (scope IN ('micro', 'magnify', 'tele', 'jump')), -- resolution level
    added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    -- Ensure unique positions within each playlist
    UNIQUE(playlist_id, position)
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_play_stats_completion_count ON play_stats(completion_count);
CREATE INDEX IF NOT EXISTS idx_play_stats_last_completed ON play_stats(last_completed);
CREATE INDEX IF NOT EXISTS idx_ratings_rating ON ratings(rating);
CREATE INDEX IF NOT EXISTS idx_ratings_rated_at ON ratings(rated_at);
CREATE INDEX IF NOT EXISTS idx_playlist_items_playlist_id ON playlist_items(playlist_id);
CREATE INDEX IF NOT EXISTS idx_playlist_items_position ON playlist_items(playlist_id, position);

-- Function to update updated_at timestamps
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Triggers to automatically update updated_at
CREATE TRIGGER update_play_stats_updated_at 
    BEFORE UPDATE ON play_stats 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_playlists_updated_at 
    BEFORE UPDATE ON playlists 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Comments for documentation
COMMENT ON TABLE play_stats IS 'Track completion statistics from successful crossfades';
COMMENT ON COLUMN play_stats.completion_count IS 'Number of times track completed successfully in a crossfade';
COMMENT ON COLUMN play_stats.total_play_time IS 'Total seconds of listening time across all plays';

COMMENT ON TABLE ratings IS 'User love/hate ratings for tracks';
COMMENT ON COLUMN ratings.rating IS 'User rating: -1=hate, 0=neutral/unset, 1=love';

COMMENT ON TABLE playlists IS 'Named collections of tracks representing musical journeys';
COMMENT ON TABLE playlist_items IS 'Individual tracks within playlists with journey context';
COMMENT ON COLUMN playlist_items.direction IS 'Direction used to reach this track from previous (e.g., bpm_positive)';
COMMENT ON COLUMN playlist_items.scope IS 'Search scope used: micro/magnify/tele/jump';