ALTER TABLE employer_subscriptions ADD COLUMN stripe_event_created INTEGER NOT NULL DEFAULT 0;
ALTER TABLE employer_subscriptions ADD COLUMN payment_failed_at TEXT;
ALTER TABLE employer_subscriptions ADD COLUMN grace_ends_at TEXT;
ALTER TABLE employer_subscriptions ADD COLUMN pending_seats INTEGER;

ALTER TABLE billing_events ADD COLUMN event_created INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS stripe_risk_events (
  stripe_event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  stripe_object_id TEXT,
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  status TEXT NOT NULL DEFAULT 'needs_review',
  payload TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_stripe_risk_customer
  ON stripe_risk_events(stripe_customer_id, occurred_at);
