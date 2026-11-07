CREATE TABLE tutor_usage (bucket TEXT PRIMARY KEY NOT NULL, used INTEGER NOT NULL);
CREATE TABLE tutor_requests (id TEXT PRIMARY KEY NOT NULL, fingerprint TEXT NOT NULL, created_at TEXT NOT NULL, response TEXT, status INTEGER);
CREATE INDEX tutor_requests_created_at ON tutor_requests (created_at);
