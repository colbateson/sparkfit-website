const encoder = new TextEncoder();

export const nowIso = () => new Date().toISOString();
export const id = (prefix) => `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;
export const clean = (value, max = 200) => String(value ?? '').trim().replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max);
export const email = (value) => clean(value, 180).toLowerCase();
export const validEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i.test(value);
export const integer = (value, min, max) => Number.isInteger(Number(value)) && Number(value) >= min && Number(value) <= max;
export const isoAfterDays = (days, from = Date.now()) => new Date(from + days * 86400000).toISOString();

export function normaliseWebsite(value, required = false) {
  const entered = clean(value, 300);
  if (!entered) return required ? null : '';
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(entered) ? entered : `https://${entered}`;
  try {
    const parsed = new URL(candidate);
    if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname.includes('.')) return null;
    return parsed.toString();
  } catch { return null; }
}

export function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...extra,
    },
  });
}

export async function sha256(value) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function randomToken(bytes = 32) {
  const data = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...data)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

export async function audit(db, actor, action, targetType, targetId, organisationId = null, metadata = {}) {
  await db.prepare(`INSERT INTO audit_logs
    (id, actor_email, actor_role, organisation_id, action, target_type, target_id, metadata, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id('aud'), actor.email || 'system', actor.role || 'system', organisationId, action, targetType, targetId, JSON.stringify(metadata), nowIso())
    .run();
}

export async function parseJson(request, limit = 30000) {
  if (!(request.headers.get('Content-Type') || '').toLowerCase().includes('application/json')) throw new HttpError(415, 'JSON is required.');
  const length = Number(request.headers.get('Content-Length') || 0);
  if (length > limit) throw new HttpError(413, 'Request is too large.');
  try { return await request.json(); } catch { throw new HttpError(400, 'Invalid JSON.'); }
}

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function corsHeaders(request, env) {
  const origin = request.headers.get('Origin');
  const allowed = new Set([env.PUBLIC_APP_ORIGIN, 'http://127.0.0.1:4173', 'http://localhost:4173'].filter(Boolean));
  if (!origin || !allowed.has(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, Stripe-Signature, CF-Turnstile-Token',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    Vary: 'Origin',
  };
}

export async function verifyTurnstile(request, env, token) {
  if (env.TURNSTILE_REQUIRED !== 'true') return true;
  if (!env.TURNSTILE_SECRET_KEY || !token) return false;
  const body = new FormData();
  body.append('secret', env.TURNSTILE_SECRET_KEY);
  body.append('response', token);
  const ip = request.headers.get('CF-Connecting-IP');
  if (ip) body.append('remoteip', ip);
  const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body });
  if (!response.ok) return false;
  return (await response.json()).success === true;
}

export async function enforceRateLimit(request, env, scope, limit, periodSeconds = 60) {
  if (env.RATE_LIMITING_ENABLED !== 'true') return;
  if (!env.DB) throw new HttpError(503, 'Request protection is temporarily unavailable.');
  const forwarded = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For')?.split(',')[0] || 'unknown';
  const windowStartedAt = Math.floor(Date.now() / (periodSeconds * 1000)) * periodSeconds;
  const keyHash = await sha256(`${scope}:${forwarded}:${windowStartedAt}`);
  const expiresAt = new Date((windowStartedAt + periodSeconds * 2) * 1000).toISOString();
  const row = await env.DB.prepare(`INSERT INTO api_rate_limits (key_hash, scope, request_count, window_started_at, expires_at)
    VALUES (?, ?, 1, ?, ?)
    ON CONFLICT(key_hash) DO UPDATE SET request_count = request_count + 1
    RETURNING request_count`)
    .bind(keyHash, scope, new Date(windowStartedAt * 1000).toISOString(), expiresAt).first();
  if (Number(row?.request_count || 1) > limit) throw new HttpError(429, 'Too many requests. Please wait and try again.');
}
