import { email, HttpError, id, nowIso, randomToken, sha256, validEmail } from './lib.js';
import { flushEmailOutbox, queueEmail, templates } from './email.js';

export async function requestAppVerification(request, env, serviceOrigin) {
  const body = await request.json().catch(() => ({}));
  const address = email(body.email);
  if (!validEmail(address)) throw new HttpError(422, 'Enter a valid email address.');
  const token = randomToken();
  const now = nowIso();
  await env.DB.prepare(`INSERT INTO app_auth_challenges (id, email, token_hash, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?)`)
    .bind(id('avf'), address, await sha256(token), new Date(Date.now() + 30 * 60000).toISOString(), now).run();
  const link = `${serviceOrigin}/v1/app-auth/verify?token=${encodeURIComponent(token)}`;
  await queueEmail(env, 'app_email_verification', address, templates.appEmailVerification(link));
  await flushEmailOutbox(env, 10);
  return { ok: true };
}

export async function verifyAppEmail(env, token, serviceOrigin) {
  const tokenHash = await sha256(token);
  const challenge = await env.DB.prepare(`SELECT * FROM app_auth_challenges
    WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ?`).bind(tokenHash, nowIso()).first();
  if (!challenge) throw new HttpError(410, 'This verification link is invalid or expired.');
  const now = nowIso();
  let account = await env.DB.prepare(`SELECT * FROM app_accounts WHERE primary_email = ? AND status = 'active'`).bind(challenge.email).first();
  if (!account) {
    const accountId = `account_${crypto.randomUUID()}`;
    await env.DB.prepare(`INSERT INTO app_accounts
      (id, primary_email, email_verified_at, legacy_revenuecat_app_user_id, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'active', ?, ?)`)
      .bind(accountId, challenge.email, now, challenge.email, now, now).run();
    account = await env.DB.prepare(`SELECT * FROM app_accounts WHERE id = ?`).bind(accountId).first();
  }
  const exchangeToken = randomToken();
  await env.DB.batch([
    env.DB.prepare(`UPDATE app_auth_challenges SET consumed_at = ? WHERE id = ?`).bind(now, challenge.id),
    env.DB.prepare(`INSERT INTO app_auth_exchanges (id, account_id, token_hash, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?)`).bind(id('aex'), account.id, await sha256(exchangeToken), new Date(Date.now() + 10 * 60000).toISOString(), now),
  ]);
  return `${serviceOrigin}/account-verified/?exchange=${encodeURIComponent(exchangeToken)}`;
}

export async function exchangeAppVerification(env, exchangeToken) {
  const tokenHash = await sha256(exchangeToken);
  const exchange = await env.DB.prepare(`SELECT e.*, a.primary_email, a.email_verified_at, a.legacy_revenuecat_app_user_id
    FROM app_auth_exchanges e JOIN app_accounts a ON a.id = e.account_id
    WHERE e.token_hash = ? AND e.consumed_at IS NULL AND e.expires_at > ? AND a.status = 'active'`)
    .bind(tokenHash, nowIso()).first();
  if (!exchange) throw new HttpError(410, 'This verification exchange is invalid or expired.');
  const sessionToken = randomToken();
  const now = nowIso();
  const expiresAt = new Date(Date.now() + 90 * 86400000).toISOString();
  await env.DB.batch([
    env.DB.prepare(`UPDATE app_auth_exchanges SET consumed_at = ? WHERE id = ?`).bind(now, exchange.id),
    env.DB.prepare(`INSERT INTO app_sessions (id, account_id, token_hash, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?)`).bind(id('aps'), exchange.account_id, await sha256(sessionToken), expiresAt, now),
  ]);
  return {
    token: sessionToken,
    expiresAt,
    account: {
      id: exchange.account_id,
      email: exchange.primary_email,
      emailVerifiedAt: exchange.email_verified_at,
      legacyRevenueCatAppUserId: exchange.legacy_revenuecat_app_user_id,
    },
  };
}

export async function requireAppSession(request, env) {
  const token = request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '') || '';
  if (!token) throw new HttpError(401, 'A verified SparkFit account is required.');
  const account = await env.DB.prepare(`SELECT a.*, s.id AS session_id, s.expires_at AS session_expires_at
    FROM app_sessions s JOIN app_accounts a ON a.id = s.account_id
    WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ? AND a.status = 'active'`)
    .bind(await sha256(token), nowIso()).first();
  if (!account) throw new HttpError(401, 'Your SparkFit session is invalid or expired.');
  return account;
}

export async function revokeAppSession(request, env) {
  const account = await requireAppSession(request, env);
  await env.DB.prepare(`UPDATE app_sessions SET revoked_at = ? WHERE id = ?`).bind(nowIso(), account.session_id).run();
}
