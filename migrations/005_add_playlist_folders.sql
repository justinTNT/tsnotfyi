-- Migration 005: Add playlist folders for nested organization

CREATE TABLE IF NOT EXISTS playlist_folders (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    parent_id INTEGER REFERENCES playlist_folders(id) ON DELETE CASCADE,
    position INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE playlists ADD COLUMN IF NOT EXISTS folder_id INTEGER REFERENCES playlist_folders(id) ON DELETE SET NULL;
ALTER TABLE playlists ADD COLUMN IF NOT EXISTS position INTEGER DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_playlist_folders_parent ON playlist_folders(parent_id);
CREATE INDEX IF NOT EXISTS idx_playlists_folder ON playlists(folder_id);

-- Reuse existing update_updated_at_column() function from migration 002
CREATE TRIGGER update_playlist_folders_updated_at
    BEFORE UPDATE ON playlist_folders
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
