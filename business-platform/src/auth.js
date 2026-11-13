import { HttpError, email, id, nowIso, randomToken, sha256 } from './lib.js';

const COOKIE = 'sparkfit_business_session';

function cookieValue(request) {
  const header = request.headers.get('Cookie') || '';
  const match = header.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${COOKIE}=`));
  return match ? decodeURIComponent(match.slice(COOKIE.length + 1)) : '';
}

export async function issueMagicLink(env, userEmail, role, organisationId = null) {
  const token = randomToken();
  await env.DB.prepare(`INSERT INTO auth_tokens (id, email, role, organisation_id, token_hash, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(id('auth'), email(userEmail), role, organisationId, await sha256(token), new Date(Date.now() + 30 * 60000).toISOString(), nowIso())
    .run();
  return token;
}

export async function consumeMagicLink(env, token) {
  const hash = await sha256(token);
  const row = await env.DB.prepare(`SELECT * FROM auth_tokens WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ?`).bind(hash, nowIso()).first();
  if (!row) throw new HttpError(401, 'This sign-in link is invalid or expired.');
  const sessionToken = randomToken();
  const sessionId = id('ses');
  const expiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
  await env.DB.batch([
    env.DB.prepare('UPDATE auth_tokens SET consumed_at = ? WHERE id = ?').bind(nowIso(), row.id),
    env.DB.prepare(`INSERT INTO sessions (id, email, role, organisation_id, token_hash, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(sessionId, row.email, row.role, row.organisation_id, await sha256(sessionToken), expiresAt, nowIso()),
  ]);
  return {
    session: { id: sessionId, email: row.email, role: row.role, organisationId: row.organisation_id },
    cookie: `${COOKIE}=${encodeURIComponent(sessionToken)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=43200`,
  };
}

export async function requireSession(request, env, roles = []) {
  const bearer = request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '') || '';
  if (bearer && env.ADMIN_API_TOKEN && bearer === env.ADMIN_API_TOKEN) return { email: 'service-admin', role: 'sparkfit_admin', organisationId: null };
  const token = cookieValue(request);
  if (!token) throw new HttpError(401, 'Sign in is required.');
  const row = await env.DB.prepare(`SELECT * FROM sessions WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?`)
    .bind(await sha256(token), nowIso()).first();
  if (!row) throw new HttpError(401, 'Your session has expired.');
  if (roles.length && !roles.includes(row.role)) throw new HttpError(403, 'You do not have permission for this action.');
  return { email: row.email, role: row.role, organisationId: row.organisation_id };
}
