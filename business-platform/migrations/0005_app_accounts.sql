CREATE TABLE IF NOT EXISTS app_accounts (
  id TEXT PRIMARY KEY,
  primary_email TEXT NOT NULL UNIQUE,
  email_verified_at TEXT NOT NULL,
  legacy_revenuecat_app_user_id TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS app_auth_challenges (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS app_auth_exchanges (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES app_accounts(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS app_sessions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES app_accounts(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_app_auth_challenge_email ON app_auth_challenges(email, expires_at);
CREATE INDEX IF NOT EXISTS idx_app_sessions_account ON app_sessions(account_id, expires_at);
