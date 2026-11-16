-- A scheduled reduction reserves the renewal capacity immediately, so later
-- invitations cannot make the agreed renewal quantity impossible to honour.
CREATE VIEW organisation_invitation_capacity AS
SELECT o.id, MIN(o.seat_limit, COALESCE((SELECT MIN(s.pending_seats)
  FROM employer_subscriptions s WHERE s.organisation_id = o.id
  AND s.status IN ('active', 'payment_attention')), o.seat_limit)) AS seat_limit
FROM organisations o;

CREATE TRIGGER enforce_pending_renewal_invitation_insert
BEFORE INSERT ON employee_invitations WHEN NEW.status = 'pending'
BEGIN
  SELECT CASE WHEN (
    (SELECT COUNT(*) FROM organisation_memberships WHERE organisation_id = NEW.organisation_id AND status = 'active') +
    (SELECT COUNT(*) FROM employee_invitations WHERE organisation_id = NEW.organisation_id AND status = 'pending'
      AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ) >= (SELECT seat_limit FROM organisation_invitation_capacity WHERE id = NEW.organisation_id)
  THEN RAISE(ABORT, 'organisation seat limit reached') END;
END;

CREATE TRIGGER enforce_pending_renewal_invitation_update
BEFORE UPDATE OF status, expires_at ON employee_invitations WHEN NEW.status = 'pending'
BEGIN
  SELECT CASE WHEN (
    (SELECT COUNT(*) FROM organisation_memberships WHERE organisation_id = NEW.organisation_id AND status = 'active') +
    (SELECT COUNT(*) FROM employee_invitations WHERE organisation_id = NEW.organisation_id AND id != NEW.id AND status = 'pending'
      AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ) >= (SELECT seat_limit FROM organisation_invitation_capacity WHERE id = NEW.organisation_id)
  THEN RAISE(ABORT, 'organisation seat limit reached') END;
END;

CREATE TRIGGER enforce_pending_renewal_reservation
BEFORE UPDATE OF pending_seats ON employer_subscriptions WHEN NEW.pending_seats IS NOT NULL
BEGIN
  SELECT CASE WHEN NEW.pending_seats < (
    (SELECT COUNT(*) FROM organisation_memberships WHERE organisation_id = NEW.organisation_id AND status = 'active') +
    (SELECT COUNT(*) FROM employee_invitations WHERE organisation_id = NEW.organisation_id AND status = 'pending'
      AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ) THEN RAISE(ABORT, 'renewal seat limit below reserved seats') END;
END;
