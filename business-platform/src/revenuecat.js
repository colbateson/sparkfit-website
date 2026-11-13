import { nowIso } from './lib.js';

async function rcRequest(env, path, method = 'GET', body) {
  if (env.REVENUECAT_WRITES_ENABLED !== 'true') return { mock: true };
  if (!env.REVENUECAT_SECRET_KEY || !env.REVENUECAT_PROJECT_ID || !env.REVENUECAT_BUSINESS_ENTITLEMENT_ID) throw new Error('RevenueCat business integration is not configured.');
  const response = await fetch(`https://api.revenuecat.com/v2/projects/${encodeURIComponent(env.REVENUECAT_PROJECT_ID)}${path}`, {
    method,
    headers: { Authorization: `Bearer ${env.REVENUECAT_SECRET_KEY}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) throw new Error(`RevenueCat returned ${response.status}: ${(await response.text()).slice(0, 300)}`);
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
  const row = await env.DB.prepare(`SELECT MAX(expires_at) AS effective_expiry FROM employer_entitlements
    WHERE revenuecat_app_user_id = ? AND status = 'active' AND expires_at > ?`).bind(appUserId, nowIso()).first();
  try {
    if (row?.effective_expiry) await grant(env, appUserId, row.effective_expiry);
    else await revoke(env, appUserId);
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
