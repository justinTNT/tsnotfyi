-- Migration 004: Add cursor_position to playlists
-- A playlist is a session with a cursor: everything before = history, cursor = now, after = tray

ALTER TABLE playlists ADD COLUMN IF NOT EXISTS cursor_position INTEGER DEFAULT 0;

COMMENT ON COLUMN playlists.cursor_position IS 'Current playback position (0-based index into playlist_items)';
