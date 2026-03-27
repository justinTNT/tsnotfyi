-- D1 schema: user data only. No library data — that lives in R2 blobs and KV.

CREATE TABLE IF NOT EXISTS ratings (
  identifier TEXT PRIMARY KEY,
  rating INTEGER NOT NULL,  -- -1 (hate), 0 (neutral), 1 (love)
  rated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS play_stats (
  identifier TEXT PRIMARY KEY,
  completion_count INTEGER DEFAULT 0,
  last_completed TEXT
);

CREATE TABLE IF NOT EXISTS playlists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT,
  folder_id INTEGER,
  position INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS playlist_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  playlist_id INTEGER NOT NULL,
  identifier TEXT NOT NULL,
  direction TEXT,
  scope TEXT DEFAULT 'magnify',
  position INTEGER DEFAULT 0,
  FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS playlist_folders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  parent_id INTEGER,
  position INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS named_sessions (
  name TEXT PRIMARY KEY,
  state_json TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);
