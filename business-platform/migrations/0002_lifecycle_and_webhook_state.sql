ALTER TABLE billing_events ADD COLUMN status TEXT NOT NULL DEFAULT 'completed';
ALTER TABLE billing_events ADD COLUMN attempts INTEGER NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS lifecycle_notifications (
  organisation_id TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  notification_type TEXT NOT NULL,
  queued_at TEXT NOT NULL,
  PRIMARY KEY (organisation_id, notification_type)
);

CREATE INDEX IF NOT EXISTS idx_organisations_plan_expiry
  ON organisations(plan_type, status, expires_at);
