-- Named sessions: persist session state across server restarts
CREATE TABLE IF NOT EXISTS named_sessions (
    name TEXT PRIMARY KEY,
    state JSONB NOT NULL,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
