PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS pilot_applications (
  id TEXT PRIMARY KEY,
  company_name TEXT NOT NULL,
  company_website TEXT NOT NULL,
  contact_name TEXT NOT NULL,
  job_title TEXT NOT NULL,
  business_email TEXT NOT NULL,
  company_size INTEGER NOT NULL,
  requested_seats INTEGER NOT NULL CHECK (requested_seats BETWEEN 1 AND 20),
  message TEXT NOT NULL DEFAULT '',
  marketing_consent INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending_approval',
  approved_seats INTEGER,
  pilot_days INTEGER,
  organisation_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pilot_status ON pilot_applications(status, created_at);

CREATE TABLE IF NOT EXISTS organisations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  website TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  plan_type TEXT NOT NULL,
  seat_limit INTEGER NOT NULL,
  starts_at TEXT,
  expires_at TEXT,
  stripe_customer_id TEXT UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS organisation_admins (
  id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'organisation_admin',
  status TEXT NOT NULL DEFAULT 'invited',
  created_at TEXT NOT NULL,
  UNIQUE(organisation_id, email)
);

CREATE TABLE IF NOT EXISTS auth_tokens (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  role TEXT NOT NULL,
  organisation_id TEXT,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  role TEXT NOT NULL,
  organisation_id TEXT,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS employee_invitations (
  id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending',
  expires_at TEXT NOT NULL,
  accepted_at TEXT,
  revoked_at TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(organisation_id, email)
);

CREATE TABLE IF NOT EXISTS organisation_memberships (
  id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  invitation_id TEXT REFERENCES employee_invitations(id),
  email TEXT NOT NULL,
  revenuecat_app_user_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  joined_at TEXT NOT NULL,
  ended_at TEXT,
  UNIQUE(organisation_id, email)
);
CREATE INDEX IF NOT EXISTS idx_membership_user ON organisation_memberships(revenuecat_app_user_id, status);

CREATE TRIGGER IF NOT EXISTS enforce_organisation_seat_limit
BEFORE INSERT ON organisation_memberships
WHEN NEW.status = 'active'
BEGIN
  SELECT CASE WHEN (
    SELECT COUNT(*) FROM organisation_memberships
    WHERE organisation_id = NEW.organisation_id AND status = 'active'
  ) >= (
    SELECT seat_limit FROM organisations WHERE id = NEW.organisation_id
  ) THEN RAISE(ABORT, 'organisation seat limit reached') END;
END;

CREATE TABLE IF NOT EXISTS employer_entitlements (
  id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  membership_id TEXT NOT NULL REFERENCES organisation_memberships(id) ON DELETE CASCADE,
  revenuecat_app_user_id TEXT NOT NULL,
  source TEXT NOT NULL,
  status TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  provision_status TEXT NOT NULL DEFAULT 'pending',
  last_error TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE(organisation_id, membership_id)
);
CREATE INDEX IF NOT EXISTS idx_entitlement_user ON employer_entitlements(revenuecat_app_user_id, status, expires_at);

CREATE TABLE IF NOT EXISTS checkout_orders (
  id TEXT PRIMARY KEY,
  company_name TEXT NOT NULL,
  company_website TEXT NOT NULL DEFAULT '',
  billing_email TEXT NOT NULL,
  contact_name TEXT NOT NULL,
  seats INTEGER NOT NULL,
  unit_amount_ex_vat INTEGER NOT NULL,
  subtotal_ex_vat INTEGER NOT NULL,
  discount_bps INTEGER NOT NULL,
  pricing_version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending_checkout',
  stripe_checkout_session_id TEXT UNIQUE,
  organisation_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS employer_subscriptions (
  id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT UNIQUE,
  stripe_subscription_item_id TEXT,
  status TEXT NOT NULL,
  seats INTEGER NOT NULL,
  current_period_end TEXT,
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS billing_events (
  stripe_event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  payload TEXT NOT NULL,
  processed_at TEXT NOT NULL,
  processing_error TEXT
);

CREATE TABLE IF NOT EXISTS email_outbox (
  id TEXT PRIMARY KEY,
  template TEXT NOT NULL,
  recipient TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  send_after TEXT NOT NULL,
  sent_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  actor_email TEXT NOT NULL,
  actor_role TEXT NOT NULL,
  organisation_id TEXT,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_org ON audit_logs(organisation_id, created_at);
