// Business records only. Consumer app accounts and personal purchases are never
// removed by employer retention. A legal hold takes precedence over expiry.
export async function runRetention(env, now = new Date()) {
  if (env.RETENTION_ENABLED !== 'true') return { disabled: true };
  const current = now.toISOString(); const day = current.slice(0, 10);
  const cutoff = (days) => new Date(now.getTime() - days * 86400000).toISOString();
  const year = (years) => { const date = new Date(now); date.setUTCFullYear(date.getUTCFullYear() - years); return date.toISOString(); };
  const claimed = await env.DB.prepare(`INSERT INTO retention_runs (day,started_at) VALUES (?,?)
    ON CONFLICT(day) DO UPDATE SET started_at=excluded.started_at WHERE completed_at IS NULL AND started_at < ? RETURNING day`)
    .bind(day, current, cutoff(1)).first();
  if (!claimed) return { skipped: true };
  const noHold = `NOT EXISTS (SELECT 1 FROM organisations h WHERE h.id = organisation_id AND h.legal_hold_until > '${current}')`;
  const holds = await env.DB.prepare(`SELECT COUNT(*) AS count FROM organisations WHERE legal_hold_until > ?`).bind(current).first();
  const statements = [
    env.DB.prepare(`DELETE FROM api_rate_limits WHERE expires_at < ?`).bind(cutoff(1)),
    env.DB.prepare(`DELETE FROM auth_tokens WHERE expires_at < ? AND ${noHold}`).bind(cutoff(1)),
    env.DB.prepare(`DELETE FROM sessions WHERE expires_at < ? AND ${noHold}`).bind(cutoff(30)),
    env.DB.prepare(`DELETE FROM app_auth_challenges WHERE expires_at < ?`).bind(cutoff(1)),
    env.DB.prepare(`DELETE FROM app_auth_exchanges WHERE expires_at < ?`).bind(cutoff(1)),
    env.DB.prepare(`DELETE FROM app_sessions WHERE expires_at < ?`).bind(cutoff(30)),
    env.DB.prepare(`UPDATE employee_invitations SET token_hash='retired:' || id WHERE status != 'pending' AND token_hash NOT LIKE 'retired:%' AND ${noHold}`),
    env.DB.prepare(`UPDATE employee_invitations SET email='removed+' || id || '@retained.invalid', created_by='', token_hash='retired:' || id
      WHERE status IN ('revoked','expired') AND COALESCE(revoked_at,expires_at) < ? AND ${noHold}`).bind(cutoff(90)),
    env.DB.prepare(`UPDATE employer_entitlements SET revenuecat_app_user_id='retained:' || membership_id
      WHERE membership_id IN (SELECT m.id FROM organisation_memberships m JOIN organisations o ON o.id=m.organisation_id
        WHERE COALESCE(m.ended_at,CASE WHEN o.status IN ('ended','expired','suspended') THEN o.expires_at END) < ?
        AND (o.legal_hold_until IS NULL OR o.legal_hold_until <= ?))
      AND status IN ('revoked','expired','suspended') AND provision_status='synced'`).bind(year(2), current),
    env.DB.prepare(`UPDATE organisation_memberships SET email='removed+' || id || '@retained.invalid', revenuecat_app_user_id='retained:' || id,
      sparkfit_account_id=NULL,status='ended',ended_at=COALESCE(ended_at,(SELECT expires_at FROM organisations WHERE id=organisation_id))
      WHERE COALESCE(ended_at,(SELECT CASE WHEN status IN ('ended','expired','suspended') THEN expires_at END FROM organisations WHERE id=organisation_id)) < ?
      AND ${noHold} AND NOT EXISTS (SELECT 1 FROM employer_entitlements e WHERE e.membership_id=organisation_memberships.id
        AND (e.status='active' OR e.provision_status != 'synced'))`).bind(year(2)),
    env.DB.prepare(`UPDATE pilot_applications SET company_name='Removed organisation',company_website='',contact_name='Removed contact',
      job_title='',business_email='removed+' || id || '@retained.invalid',message='',marketing_consent=0
      WHERE ((status IN ('rejected','pending_approval') AND updated_at < ?)
        OR (status='approved' AND organisation_id IN (SELECT id FROM organisations WHERE status IN ('ended','expired') AND expires_at < ?)))
      AND ${noHold}`).bind(year(1), year(2)),
    env.DB.prepare(`UPDATE employee_invitations SET email='removed+' || id || '@retained.invalid',created_by='',token_hash='retired:' || id
      WHERE status='accepted' AND id IN (SELECT invitation_id FROM organisation_memberships WHERE revenuecat_app_user_id LIKE 'retained:%') AND ${noHold}`),
    env.DB.prepare(`UPDATE organisation_admins SET status='disabled',email='removed+' || id || '@retained.invalid'
      WHERE organisation_id IN (SELECT id FROM organisations WHERE status IN ('ended','expired') AND expires_at < ?)
      AND ${noHold}`).bind(cutoff(90)),
    env.DB.prepare(`DELETE FROM audit_logs WHERE created_at < ? AND ${noHold}`).bind(year(2)),
    env.DB.prepare(`UPDATE checkout_orders SET company_name='Removed organisation',company_website='',contact_name='Removed contact',
      billing_email='removed+' || id || '@retained.invalid' WHERE updated_at < ? AND ${noHold}
      AND (organisation_id IS NULL OR organisation_id IN (SELECT id FROM organisations WHERE status IN ('ended','expired') AND expires_at < ?))`)
      .bind(`${now.getUTCFullYear()-8}-01-01T00:00:00.000Z`, `${now.getUTCFullYear()-8}-01-01T00:00:00.000Z`),
  ];
  // Outbox and provider events do not always contain an organisation ID. Be
  // conservative and retain these when any organisation has a current hold.
  if (!holds.count) {
    statements.push(
      env.DB.prepare(`UPDATE email_outbox SET payload='{"subject":"Content removed under retention policy","text":""}'
        WHERE status NOT IN ('pending','sending') AND created_at < ?`).bind(cutoff(30)),
      env.DB.prepare(`DELETE FROM email_outbox WHERE status NOT IN ('pending','sending') AND created_at < ?`).bind(year(1)),
      env.DB.prepare(`DELETE FROM email_delivery_events WHERE received_at < ?`).bind(year(1)),
      // Eight calendar years is conservative when the financial year end is unknown.
      env.DB.prepare(`DELETE FROM billing_events WHERE processed_at < ? AND status='completed'`).bind(`${now.getUTCFullYear()-8}-01-01T00:00:00.000Z`),
    );
  }
  const results = await env.DB.batch(statements);
  const summary = { rules: statements.length, changed: results.reduce((n,r) => n + Number(r.meta?.changes || 0),0), legalHolds: holds.count };
  await env.DB.prepare(`UPDATE retention_runs SET completed_at=?,summary=? WHERE day=?`).bind(current, JSON.stringify(summary), day).run();
  return summary;
}
