ALTER TABLE organisations ADD COLUMN legal_hold_until TEXT;
ALTER TABLE organisations ADD COLUMN legal_hold_reason TEXT;
CREATE TABLE retention_runs (
  day TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  summary TEXT
);
