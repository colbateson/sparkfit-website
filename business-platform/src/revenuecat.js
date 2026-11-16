import { nowIso } from './lib.js';

async function rcRequest(env, path, method = 'GET', body) {
  if (env.REVENUECAT_WRITES_ENABLED !== 'true') return { mock: true };
  if (!env.REVENUECAT_SECRET_KEY || !env.REVENUECAT_PROJECT_ID || !env.REVENUECAT_BUSINESS_ENTITLEMENT_ID) throw new Error('RevenueCat business integration is not configured.');
  const response = await fetch(`https://api.revenuecat.com/v2/projects/${encodeURIComponent(env.REVENUECAT_PROJECT_ID)}${path}`, {
    method,
    headers: { Authorization: `Bearer ${env.REVENUECAT_SECRET_KEY}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    const error = new Error(`RevenueCat returned ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response.status === 204 ? {} : response.json();
}

async function grant(env, appUserId, expiresAt) {
  return rcRequest(env, `/customers/${encodeURIComponent(appUserId)}/actions/grant_entitlement`, 'POST', {
    entitlement_id: env.REVENUECAT_BUSINESS_ENTITLEMENT_ID,
    expires_at: Date.parse(expiresAt),
  });
}

async function revoke(env, appUserId) {
  return rcRequest(env, `/customers/${encodeURIComponent(appUserId)}/actions/revoke_granted_entitlement`, 'POST', {
    entitlement_id: env.REVENUECAT_BUSINESS_ENTITLEMENT_ID,
  });
}

export async function reconcileBusinessEntitlement(env, appUserId) {
  const row = await env.DB.prepare(`SELECT MAX(e.expires_at) AS effective_expiry FROM employer_entitlements e
    JOIN organisations o ON o.id = e.organisation_id JOIN organisation_memberships m ON m.id = e.membership_id
    WHERE e.revenuecat_app_user_id = ? AND e.status = 'active' AND e.expires_at > ?
      AND o.status = 'active' AND o.expires_at > ? AND m.status = 'active'`).bind(appUserId, nowIso(), nowIso()).first();
  if (env.REVENUECAT_WRITES_ENABLED !== 'true') return { active: false, requestedActive: Boolean(row?.effective_expiry), expiresAt: row?.effective_expiry || null, mock: true };
  try {
    let customer;
    try { customer = await rcRequest(env, `/customers/${encodeURIComponent(appUserId)}`); }
    catch (error) {
      if (error.status !== 404) throw error;
      if (row?.effective_expiry) customer = await rcRequest(env, '/customers', 'POST', { id: appUserId });
    }
    const current = customer?.active_entitlements?.items?.find((entitlement) => entitlement.entitlement_id === env.REVENUECAT_BUSINESS_ENTITLEMENT_ID);
    if (row?.effective_expiry) {
      const wanted = Date.parse(row.effective_expiry);
      if (!current || Number(current.expires_at) !== wanted) {
        // RevenueCat ignores grants within two hours of an existing grant and does not shorten them.
        if (current && (wanted < Number(current.expires_at) || Math.abs(wanted - Number(current.expires_at)) < 2 * 3600000)) await revoke(env, appUserId);
        await grant(env, appUserId, row.effective_expiry);
      }
    } else if (customer && current) {
      try { await revoke(env, appUserId); }
      catch (error) { if (error.status !== 404) throw error; }
    }
    await env.DB.prepare(`UPDATE employer_entitlements SET provision_status = 'synced', last_error = NULL, updated_at = ?
      WHERE revenuecat_app_user_id = ?`).bind(nowIso(), appUserId).run();
    return { active: Boolean(row?.effective_expiry), expiresAt: row?.effective_expiry || null, mock: env.REVENUECAT_WRITES_ENABLED !== 'true' };
  } catch (error) {
    await env.DB.prepare(`UPDATE employer_entitlements SET provision_status = 'failed', last_error = ?, updated_at = ?
      WHERE revenuecat_app_user_id = ?`).bind(String(error.message).slice(0, 500), nowIso(), appUserId).run();
    throw error;
  }
}

export const revenueCatPolicy = Object.freeze({
  consumerEntitlement: 'Pro',
  onboardingEntitlement: 'Trial',
  employerEntitlement: 'separate RevenueCat entitlement configured by internal ID',
  accessRule: 'Pro OR Trial OR Business',
  revokeRule: 'Reconcile the server ledger before revoking the separate Business grant. Never revoke Pro.',
});
