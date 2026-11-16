ALTER TABLE employer_subscriptions ADD COLUMN paid_through TEXT;
ALTER TABLE employer_subscriptions ADD COLUMN unit_amount_ex_vat INTEGER;
ALTER TABLE employer_subscriptions ADD COLUMN last_invoice_id TEXT;
ALTER TABLE billing_events ADD COLUMN processing_started_at TEXT;
ALTER TABLE email_outbox ADD COLUMN dedupe_key TEXT;
ALTER TABLE email_outbox ADD COLUMN provider_id TEXT;
ALTER TABLE email_outbox ADD COLUMN claimed_at TEXT;
ALTER TABLE checkout_orders ADD COLUMN request_key TEXT;
CREATE UNIQUE INDEX idx_checkout_request_key ON checkout_orders(request_key);
CREATE TABLE email_delivery_events (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  received_at TEXT NOT NULL
);
CREATE TABLE billing_locks (id TEXT PRIMARY KEY, owner TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE UNIQUE INDEX idx_email_outbox_dedupe ON email_outbox(dedupe_key);

CREATE TRIGGER validate_membership_invitation
BEFORE INSERT ON organisation_memberships
BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM employee_invitations i JOIN organisations o ON o.id = i.organisation_id
    WHERE i.id = NEW.invitation_id AND i.organisation_id = NEW.organisation_id AND i.email = NEW.email
      AND i.status = 'pending' AND i.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      AND o.status = 'active' AND o.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    THEN RAISE(ABORT, 'invitation is no longer available') END;
  SELECT CASE WHEN EXISTS (SELECT 1 FROM organisation_memberships WHERE organisation_id = NEW.organisation_id
    AND revenuecat_app_user_id = NEW.revenuecat_app_user_id AND status = 'active')
    THEN RAISE(ABORT, 'account already activated') END;
END;

CREATE TRIGGER enforce_reactivated_invitation_seat_limit
BEFORE UPDATE OF status, expires_at ON employee_invitations
WHEN NEW.status = 'pending'
BEGIN
  SELECT CASE WHEN (
    (SELECT COUNT(*) FROM organisation_memberships WHERE organisation_id = NEW.organisation_id AND status = 'active') +
    (SELECT COUNT(*) FROM employee_invitations WHERE organisation_id = NEW.organisation_id AND id != NEW.id
      AND status = 'pending' AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ) >= (SELECT seat_limit FROM organisations WHERE id = NEW.organisation_id)
  THEN RAISE(ABORT, 'organisation seat limit reached') END;
END;

CREATE TRIGGER enforce_reactivated_member_seat_limit
BEFORE UPDATE OF status ON organisation_memberships
WHEN NEW.status = 'active' AND OLD.status != 'active'
BEGIN
  SELECT CASE WHEN (
    (SELECT COUNT(*) FROM organisation_memberships WHERE organisation_id = NEW.organisation_id AND status = 'active' AND id != NEW.id) +
    (SELECT COUNT(*) FROM employee_invitations WHERE organisation_id = NEW.organisation_id AND status = 'pending'
      AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AND id != COALESCE(NEW.invitation_id, ''))
  ) >= (SELECT seat_limit FROM organisations WHERE id = NEW.organisation_id)
  THEN RAISE(ABORT, 'organisation seat limit reached') END;
END;
