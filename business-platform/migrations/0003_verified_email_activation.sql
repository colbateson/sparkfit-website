ALTER TABLE employee_invitations ADD COLUMN verified_at TEXT;
ALTER TABLE employee_invitations ADD COLUMN delivery_status TEXT NOT NULL DEFAULT 'queued';
ALTER TABLE employee_invitations ADD COLUMN last_sent_at TEXT;

ALTER TABLE organisation_memberships ADD COLUMN sparkfit_account_id TEXT;

DROP TRIGGER IF EXISTS enforce_organisation_seat_limit;

CREATE TRIGGER enforce_pending_invitation_seat_limit
BEFORE INSERT ON employee_invitations
WHEN NEW.status = 'pending'
BEGIN
  SELECT CASE WHEN (
    (SELECT COUNT(*) FROM organisation_memberships
      WHERE organisation_id = NEW.organisation_id AND status = 'active') +
    (SELECT COUNT(*) FROM employee_invitations
      WHERE organisation_id = NEW.organisation_id AND status = 'pending' AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ) >= (
    SELECT seat_limit FROM organisations WHERE id = NEW.organisation_id
  ) THEN RAISE(ABORT, 'organisation seat limit reached') END;
END;

CREATE TRIGGER enforce_organisation_seat_limit
BEFORE INSERT ON organisation_memberships
WHEN NEW.status = 'active'
BEGIN
  SELECT CASE WHEN (
    (SELECT COUNT(*) FROM organisation_memberships
      WHERE organisation_id = NEW.organisation_id AND status = 'active') +
    (SELECT COUNT(*) FROM employee_invitations
      WHERE organisation_id = NEW.organisation_id AND status = 'pending'
        AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        AND id != COALESCE(NEW.invitation_id, ''))
  ) >= (
    SELECT seat_limit FROM organisations WHERE id = NEW.organisation_id
  ) THEN RAISE(ABORT, 'organisation seat limit reached') END;
END;

CREATE INDEX IF NOT EXISTS idx_invitation_capacity
  ON employee_invitations(organisation_id, status, expires_at);
