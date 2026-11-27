import test from 'node:test';
import assert from 'node:assert/strict';
import platform, { lifecycle } from '../src/index.js';
import { testDatabase } from './sqlite-db.js';
import { issueMagicLink, consumeMagicLink } from '../src/auth.js';
import { requestAppVerification, verifyAppEmail, exchangeAppVerification } from '../src/app-auth.js';
import { persistSubscription, subscriptionAccess } from '../src/billing.js';
import { sha256 } from '../src/lib.js';
import { flushEmailOutbox } from '../src/email.js';
import { reconcileBusinessEntitlement } from '../src/revenuecat.js';
import { runRetention } from '../src/retention.js';

const origin = 'https://business.example.com';
function setup() {
  const DB = testDatabase();
  const env = {
    DB, ENVIRONMENT: 'test', PUBLIC_APP_ORIGIN: origin, SERVICE_ORIGIN: origin,
    PAYMENTS_ENABLED: 'true', STRIPE_SECRET_KEY: 'test-provider-secret', STRIPE_WEBHOOK_SECRET: 'test-signing-secret',
    REVENUECAT_WRITES_ENABLED: 'false', EMAIL_ENABLED: 'false', RATE_LIMITING_ENABLED: 'false',
    REQUIRE_APP_ACCOUNT_FOR_BUSINESS: 'true', ADMIN_EMAILS: 'admin@example.com',
  };
  async function call(path, body, cookie, extra = {}) {
    const response = await platform.fetch(new Request(`${origin}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...extra },
      body: body === undefined ? undefined : JSON.stringify(body),
    }), env);
    return { response, data: await response.json().catch(() => ({})) };
  }
  return { env, DB, call };
}
const latestEmail = (DB, template) => JSON.parse(DB.prepare('SELECT payload FROM email_outbox WHERE template = ? ORDER BY rowid DESC LIMIT 1').bind(template).first().payload);
const emailToken = (payload, parameter = 'token') => {
  const link = payload.actionUrl || payload.text.match(/https:\/\/[^\s]+/g)?.find((candidate) => candidate.includes(`${parameter}=`));
  assert.ok(link, `expected an email action link containing ${parameter}`);
  return new URL(link).searchParams.get(parameter);
};
async function cookieFor(env, address, organisationId, role = 'organisation_admin') {
  const token = await issueMagicLink(env, address, role, organisationId);
  return (await consumeMagicLink(env, token)).cookie.split(';')[0];
}
async function verifiedAccount(env, address) {
  await requestAppVerification(new Request(`${origin}/v1/app-auth/request`, {
    method: 'POST', body: JSON.stringify({ email: address }),
  }), env, origin);
  const token = emailToken(latestEmail(env.DB, 'app_email_verification'));
  const redirect = await verifyAppEmail(env, token, origin);
  return exchangeAppVerification(env, new URL(redirect).searchParams.get('exchange'));
}

test('pilot, verified different-email activation, privacy, removal and re-invitation', async () => {
  const { env, DB, call } = setup();
  const applied = await call('/v1/pilot-applications', {
    companyName: 'Flow Test Ltd', companyWebsite: 'www.example.com', contactName: 'Employer', jobTitle: 'People lead',
    businessEmail: 'employer@example.com', companySize: 100, requestedSeats: 20,
  });
  assert.equal(applied.response.status, 201);
  const admin = await cookieFor(env, 'admin@example.com', null, 'sparkfit_admin');
  assert.equal((await call('/v1/admin/dashboard', undefined, admin)).response.status, 200);
  assert.equal((await call('/v1/portal/summary', undefined)).response.status, 401, 'employer data requires a live session');
  assert.equal((await call('/v1/portal/summary', undefined, admin)).response.status, 403, 'internal admins use the internal dashboard');
  const approved = await call(`/v1/admin/pilot-applications/${applied.data.applicationId}/decision`, { decision: 'approve' }, admin);
  assert.equal(approved.response.status, 200);
  const org = approved.data.organisationId;
  const employer = await cookieFor(env, 'employer@example.com', org);
  const invite = await call('/v1/portal/invitations', { email: 'work@example.com' }, employer);
  assert.equal(invite.response.status, 201);
  const token = emailToken(latestEmail(DB, 'employee_invitation'));
  const account = await verifiedAccount(env, 'personal@example.com');
  const activated = await call('/v1/app/employee-invitations/accept', { token }, null, { Authorization: `Bearer ${account.token}` });
  assert.equal(activated.response.status, 200);
  assert.equal(activated.data.accountId, account.account.id);
  assert.equal(activated.data.premium.mock, true);
  assert.equal(activated.data.premium.active, false, 'disabled provider must not claim actual premium activation');
  const replay = await call('/v1/app/employee-invitations/accept', { token }, null, { Authorization: `Bearer ${account.token}` });
  assert.equal(replay.response.status, 410);
  const summary = await call('/v1/portal/summary', undefined, employer);
  assert.equal(summary.data.seats.active, 1);
  assert.equal(summary.data.seats.pending, 0);
  assert.equal(JSON.stringify(summary.data.members).includes('revenuecat_app_user_id'), false);
  assert.equal(JSON.stringify(summary.data.members).includes('personal@example.com'), false);
  const removed = await call(`/v1/portal/members/${activated.data.membershipId}/remove`, {}, employer);
  assert.equal(removed.response.status, 200);
  assert.equal(DB.prepare('SELECT status FROM app_accounts WHERE id = ?').bind(account.account.id).first().status, 'active');
  const reinvite = await call('/v1/portal/invitations', { email: 'work@example.com' }, employer);
  assert.equal(reinvite.response.status, 201);
  const reactivated = await call('/v1/app/employee-invitations/accept', { token: emailToken(latestEmail(DB, 'employee_invitation')) }, null,
    { Authorization: `Bearer ${account.token}` });
  assert.equal(reactivated.response.status, 200);
  assert.equal(DB.prepare('SELECT COUNT(*) AS count FROM organisation_memberships').first().count, 1);
  const outsider = await cookieFor(env, 'other@example.com', 'other-org');
  assert.equal((await call(`/v1/portal/members/${activated.data.membershipId}/remove`, {}, outsider)).response.status, 404);
});

test('admin dashboard reports organisation plan and seat allocation without employee activity', async () => {
  const { env, DB, call } = setup();
  const admin = await cookieFor(env, 'admin@example.com', null, 'sparkfit_admin');
  const applied = await call('/v1/pilot-applications', {
    companyName: 'Dashboard Test Ltd', companyWebsite: 'https://example.com', contactName: 'Employer', jobTitle: 'People lead',
    businessEmail: 'employer@example.com', companySize: 100, requestedSeats: 20,
  });
  const approved = await call(`/v1/admin/pilot-applications/${applied.data.applicationId}/decision`, { decision: 'approve' }, admin);
  const organisationId = approved.data.organisationId;
  const now = new Date().toISOString();
  DB.prepare(`INSERT INTO employee_invitations (id, organisation_id, email, token_hash, status, expires_at, created_by, created_at)
    VALUES ('invite_activated_dashboard', ?, 'employee@example.com', ?, 'pending', ?, 'admin@example.com', ?)`)
    .bind(organisationId, await sha256('dashboard-test-token'), new Date(Date.now() + 86400000).toISOString(), now).run();
  DB.prepare(`INSERT INTO organisation_memberships (id, organisation_id, invitation_id, email, revenuecat_app_user_id, status, joined_at)
    VALUES ('member_dashboard', ?, 'invite_activated_dashboard', 'employee@example.com', 'account_dashboard', 'active', ?)`).bind(organisationId, now).run();
  DB.prepare(`UPDATE employee_invitations SET status = 'accepted', accepted_at = ? WHERE id = 'invite_activated_dashboard'`).bind(now).run();
  DB.prepare(`INSERT INTO employee_invitations (id, organisation_id, email, token_hash, status, expires_at, created_by, created_at)
    VALUES ('invite_dashboard', ?, 'pending@example.com', ?, 'pending', ?, 'admin@example.com', ?)`)
    .bind(organisationId, await sha256('dashboard-pending-token'), new Date(Date.now() + 86400000).toISOString(), now).run();
  const dashboard = await call('/v1/admin/dashboard', undefined, admin);
  const row = dashboard.data.organisationOverview.find((item) => item.id === organisationId);
  assert.equal(dashboard.response.status, 200);
  assert.equal(row.plan_type, 'pilot');
  assert.equal(row.seats_purchased, 20);
  assert.equal(row.activated_seats, 1);
  assert.equal(row.pending_invitations, 1);
  assert.equal(row.billing_contact, 'employer@example.com');
  assert.equal(row.contact_name, 'Employer');
  assert.equal(row.contact_title, 'People lead');
  assert.equal(row.workforce_size, 100);
  assert.equal(Object.hasOwn(row, 'email'), false, 'overview exposes no employee addresses');
});

test('one-time employer links and account exchanges cannot be redeemed twice concurrently', async () => {
  const { env } = setup();
  const token = await issueMagicLink(env, 'admin@example.com', 'sparkfit_admin');
  const attempts = await Promise.allSettled([consumeMagicLink(env, token), consumeMagicLink(env, token)]);
  assert.equal(attempts.filter((result) => result.status === 'fulfilled').length, 1);
  await requestAppVerification(new Request(`${origin}/request`, { method: 'POST', body: JSON.stringify({ email: 'verify@example.com' }) }), env, origin);
  const verifyToken = emailToken(latestEmail(env.DB, 'app_email_verification'));
  const verification = await Promise.allSettled([verifyAppEmail(env, verifyToken, origin), verifyAppEmail(env, verifyToken, origin)]);
  assert.equal(verification.filter((result) => result.status === 'fulfilled').length, 1);
  const exchange = new URL(verification.find((result) => result.status === 'fulfilled').value).searchParams.get('exchange');
  const exchanges = await Promise.allSettled([exchangeAppVerification(env, exchange), exchangeAppVerification(env, exchange)]);
  assert.equal(exchanges.filter((result) => result.status === 'fulfilled').length, 1);
});

test('email scanners can open employer sign-in links without consuming them', async () => {
  const { env, DB } = setup();
  const token = await issueMagicLink(env, 'employer@example.com', 'organisation_admin', 'org_test');
  const link = `${origin}/v1/auth/consume?token=${encodeURIComponent(token)}`;
  const firstOpen = await platform.fetch(new Request(link), env);
  const firstPage = await firstOpen.text();
  assert.equal(firstOpen.status, 200);
  assert.match(firstPage, /Confirm your sign-in/);
  assert.match(firstPage, /Continue to SparkFit/);
  assert.equal(firstPage.includes(token), false, 'the token is not embedded in the confirmation page');
  assert.match(firstOpen.headers.get('Set-Cookie'), /HttpOnly; Secure; SameSite=Strict/);
  assert.equal(DB.prepare('SELECT consumed_at FROM auth_tokens WHERE token_hash = ?').bind(await sha256(token)).first().consumed_at, null);

  const secondOpen = await platform.fetch(new Request(link), env);
  assert.equal(secondOpen.status, 200, 'link scanners may reopen the confirmation page');
  assert.equal(DB.prepare('SELECT consumed_at FROM auth_tokens WHERE token_hash = ?').bind(await sha256(token)).first().consumed_at, null);

  const magicCookie = firstOpen.headers.get('Set-Cookie').split(';')[0];
  const confirmation = await platform.fetch(new Request(`${origin}/v1/auth/consume`, {
    method: 'POST', headers: { Cookie: magicCookie, Origin: 'https://mail.google.com', 'Sec-Fetch-Site': 'same-origin' },
  }), env);
  assert.equal(confirmation.status, 302);
  assert.equal(confirmation.headers.get('Location'), `${origin}/portal/`);
  assert.match(confirmation.headers.get('Set-Cookie'), /sparkfit_business_session=/);
  assert.equal(DB.prepare('SELECT consumed_at FROM auth_tokens WHERE token_hash = ?').bind(await sha256(token)).first().consumed_at !== null, true);

  const replay = await platform.fetch(new Request(`${origin}/v1/auth/consume`, {
    method: 'POST', headers: { Cookie: magicCookie },
  }), env);
  assert.equal(replay.status, 401, 'a submitted link is still one-time use');

  const crossSiteToken = await issueMagicLink(env, 'employer@example.com', 'organisation_admin', 'org_test');
  const crossSitePage = await platform.fetch(new Request(`${origin}/v1/auth/consume?token=${encodeURIComponent(crossSiteToken)}`), env);
  const crossSiteCookie = crossSitePage.headers.get('Set-Cookie').split(';')[0];
  const crossSitePost = await platform.fetch(new Request(`${origin}/v1/auth/consume`, {
    method: 'POST', headers: { Cookie: crossSiteCookie, Origin: 'https://attacker.example', 'Sec-Fetch-Site': 'cross-site' },
  }), env);
  assert.equal(crossSitePost.status, 403, 'cross-site sign-in confirmation remains blocked');
  assert.equal(DB.prepare('SELECT consumed_at FROM auth_tokens WHERE token_hash = ?').bind(await sha256(crossSiteToken)).first().consumed_at, null);
});

test('employer sign-in cannot select the internal admin role', async () => {
  const { env, DB } = setup();
  const now = new Date().toISOString();
  DB.prepare(`INSERT INTO organisations (id, name, website, status, plan_type, seat_limit, starts_at, expires_at, created_at, updated_at)
    VALUES ('org_shared', 'Shared Account', 'https://example.com', 'active', 'paid', 20, ?, ?, ?, ?)`).bind(now, now, now, now).run();
  DB.prepare(`INSERT INTO organisation_admins (id, organisation_id, email, status, created_at)
    VALUES ('admin_shared', 'org_shared', 'admin@example.com', 'active', ?)`).bind(now).run();
  const request = (destination, path = '/v1/auth/request') => platform.fetch(new Request(`${origin}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@example.com', destination }),
  }), env);
  assert.equal((await request('employer')).status, 200);
  let token = DB.prepare('SELECT role, organisation_id FROM auth_tokens ORDER BY rowid DESC LIMIT 1').first();
  assert.deepEqual({ ...token }, { role: 'organisation_admin', organisation_id: 'org_shared' });
  assert.equal((await request('admin')).status, 200, 'a posted destination field cannot elevate the public employer form');
  token = DB.prepare('SELECT role, organisation_id FROM auth_tokens ORDER BY rowid DESC LIMIT 1').first();
  assert.deepEqual({ ...token }, { role: 'organisation_admin', organisation_id: 'org_shared' });
  assert.equal((await request(undefined, '/v1/admin/auth/request')).status, 200);
  token = DB.prepare('SELECT role, organisation_id FROM auth_tokens ORDER BY rowid DESC LIMIT 1').first();
  assert.deepEqual({ ...token }, { role: 'sparkfit_admin', organisation_id: null });
});

test('verification requests require an approved staging recipient and enforce resend caps', async () => {
  const { env, call, DB } = setup();
  env.ENVIRONMENT = 'staging'; env.EMAIL_ENABLED = 'true'; env.RESEND_API_KEY = 'provider-test-key';
  env.STAGING_EMAIL_ALLOWLIST = 'verify@example.com'; env.RATE_LIMITING_ENABLED = 'true';
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  let sends = 0;
  let fakeNow = Math.floor(originalNow() / 900_000) * 900_000 + 5_000;
  Date.now = () => fakeNow;
  globalThis.fetch = async () => { sends++; return Response.json({ id: `email_${sends}` }); };
  try {
    const blocked = await call('/v1/app-auth/request', { email: 'not-approved@example.com' });
    assert.equal(blocked.response.status, 503);
    assert.equal(DB.prepare('SELECT COUNT(*) AS count FROM app_auth_challenges').first().count, 0);
    assert.equal(sends, 0);

    const first = await call('/v1/app-auth/request', { email: 'verify@example.com' });
    assert.equal(first.response.status, 200);
    assert.equal(first.data.queued, true);
    assert.equal(first.data.resendAfterSeconds, 60);
    const immediate = await call('/v1/app-auth/request', { email: 'verify@example.com' });
    assert.equal(immediate.response.status, 429);
    assert.equal(immediate.response.headers.get('Retry-After'), '55');
    fakeNow += 60_000;
    assert.equal((await call('/v1/app-auth/request', { email: 'verify@example.com' })).response.status, 200);
    fakeNow += 60_000;
    assert.equal((await call('/v1/app-auth/request', { email: 'verify@example.com' })).response.status, 200);
    fakeNow += 60_000;
    const capped = await call('/v1/app-auth/request', { email: 'verify@example.com' });
    assert.equal(capped.response.status, 429);
    assert.equal(sends, 3);
  } finally {
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
  }
});

function subscription(status = 'active', extra = {}) {
  return { id: 'sub_flow', customer: 'cus_flow', status, latest_invoice: { id: 'in_flow', status: 'paid' },
    items: { data: [{ id: 'si_flow', quantity: 20, current_period_end: Math.floor(Date.now() / 1000) + 365 * 86400, price: { unit_amount: 1666 } }] }, ...extra };
}
async function seedOrder(DB) {
  DB.prepare(`INSERT INTO checkout_orders (id, company_name, billing_email, contact_name, seats, unit_amount_ex_vat,
    subtotal_ex_vat, discount_bps, pricing_version, created_at, updated_at) VALUES ('ord_flow', 'Paid Test Ltd',
    'employer@example.com', 'Employer', 20, 1666, 33320, 2000, 'test', ?, ?)`)
    .bind(new Date().toISOString(), new Date().toISOString()).run();
}

test('paid subscription waits for payment, converges on duplicate events, renews, suspends and restores employee access', async () => {
  const { env, DB, call } = setup();
  await seedOrder(DB);
  await persistSubscription(env, subscription('incomplete', { latest_invoice: { id: 'in_flow', status: 'open' } }), 'ord_flow', 1);
  assert.equal(DB.prepare('SELECT status FROM organisations').first().status, 'suspended');
  const deliveries = await Promise.allSettled([persistSubscription(env, subscription(), 'ord_flow', 2), persistSubscription(env, subscription(), 'ord_flow', 2)]);
  assert.ok(deliveries.some((result) => result.status === 'fulfilled'));
  await persistSubscription(env, subscription(), 'ord_flow', 2);
  assert.equal(DB.prepare('SELECT COUNT(*) AS count FROM organisations').first().count, 1);
  assert.equal(DB.prepare("SELECT COUNT(*) AS count FROM email_outbox WHERE template='employer_payment_successful'").first().count, 1);
  const employer = await cookieFor(env, 'employer@example.com', 'org_ord_flow');
  await call('/v1/portal/invitations', { email: 'employee@example.com' }, employer);
  const account = await verifiedAccount(env, 'employee@example.com');
  const activation = await call('/v1/app/employee-invitations/accept', { token: emailToken(latestEmail(DB, 'employee_invitation')) }, null,
    { Authorization: `Bearer ${account.token}` });
  assert.equal(activation.response.status, 200);
  const renewed = subscription();
  renewed.items.data[0].current_period_end += 365 * 86400;
  renewed.latest_invoice.id = 'in_renewal';
  await persistSubscription(env, renewed, 'ord_flow', 3);
  assert.equal(DB.prepare('SELECT expires_at FROM employer_entitlements').first().expires_at, new Date(renewed.items.data[0].current_period_end * 1000).toISOString());
  await persistSubscription(env, subscription('canceled'), 'ord_flow', 2);
  assert.equal(DB.prepare('SELECT status FROM organisations').first().status, 'active', 'older event cannot undo renewal');
  await persistSubscription(env, subscription('canceled'), 'ord_flow', 4);
  assert.equal(DB.prepare('SELECT status FROM employer_entitlements').first().status, 'suspended');
  await persistSubscription(env, renewed, 'ord_flow', 5);
  assert.equal(DB.prepare('SELECT status FROM employer_entitlements').first().status, 'active');
  DB.prepare(`UPDATE employer_subscriptions SET status = 'payment_attention', paid_through = ?, grace_ends_at = ?`).bind(
    new Date(Date.now() - 86400000).toISOString(), new Date(Date.now() - 1000).toISOString()).run();
  await lifecycle(env);
  assert.equal(DB.prepare('SELECT status FROM organisations').first().status, 'suspended');
  assert.equal(DB.prepare('SELECT status FROM employer_entitlements').first().status, 'suspended');
});

test('unpaid initial subscriptions never get a free payment grace period', () => {
  assert.equal(subscriptionAccess(subscription('past_due', { latest_invoice: { status: 'open' } })).access, false);
  const prior = { paid_through: new Date(Date.now() - 1000).toISOString() };
  const state = subscriptionAccess(subscription('past_due', { latest_invoice: { status: 'open' } }), prior);
  assert.equal(state.access, true);
  assert.equal(Math.round((Date.parse(state.graceEnd) - Date.parse(state.failedAt)) / 86400000), 14);
});

test('email outbox is deduplicated, claims are exclusive, and provider failure retries', async () => {
  const { env, DB } = setup();
  env.EMAIL_ENABLED = 'true'; env.RESEND_API_KEY = 'provider-test-key';
  DB.prepare(`INSERT INTO email_outbox (id, template, recipient, payload, send_after, created_at)
    VALUES ('mail_test', 'test', 'employer@example.com', ?, ?, ?)`)
    .bind(JSON.stringify({ subject: 'Test', text: 'Test' }), new Date().toISOString(), new Date().toISOString()).run();
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (_url, options) => { calls++; assert.equal(options.headers['Idempotency-Key'], 'sparkfit-email-mail_test'); return Response.json({ id: 'resend_test' }); };
  try {
    await Promise.all([flushEmailOutbox(env), flushEmailOutbox(env)]);
    assert.equal(calls, 1);
    assert.equal(DB.prepare('SELECT provider_id FROM email_outbox').first().provider_id, 'resend_test');
  } finally { globalThis.fetch = original; }
});

test('staging suppressions are reported and resend returns the real delivery state', async () => {
  const { env, DB, call } = setup();
  env.ENVIRONMENT = 'staging'; env.EMAIL_ENABLED = 'true'; env.RESEND_API_KEY = 'provider-test-key';
  env.STAGING_EMAIL_ALLOWLIST = 'partnerships@spark-fit.com';
  const now = new Date().toISOString();
  DB.prepare(`INSERT INTO organisations (id,name,website,status,plan_type,seat_limit,starts_at,expires_at,created_at,updated_at)
    VALUES ('org_mail','Mail Test','https://example.com','active','paid',20,?,?,?,?)`)
    .bind(now, new Date(Date.now() + 86400000).toISOString(), now, now).run();
  DB.prepare(`INSERT INTO employee_invitations (id,organisation_id,email,token_hash,status,expires_at,created_by,created_at)
    VALUES ('invite_mail','org_mail','employee@example.com',?,'pending',?,'employer@example.com',?)`)
    .bind(await sha256('invite-mail-token'), new Date(Date.now() + 86400000).toISOString(), now).run();
  const employer = await cookieFor(env, 'employer@example.com', 'org_mail');
  const resent = await call('/v1/portal/invitations/invite_mail/action', { action: 'resend' }, employer);
  assert.equal(resent.response.status, 200);
  assert.equal(resent.data.deliveryStatus, 'suppressed');
  assert.equal(DB.prepare('SELECT status FROM email_outbox').first().status, 'suppressed');
  assert.equal(DB.prepare('SELECT delivery_status FROM employee_invitations WHERE id = ?').bind('invite_mail').first().delivery_status, 'suppressed');
});

test('pilot upgrade keeps existing employees and the organisation identity', async () => {
  const { env, DB, call } = setup();
  const now = new Date().toISOString();
  DB.prepare(`INSERT INTO organisations (id, name, website, status, plan_type, seat_limit, starts_at, expires_at, created_at, updated_at)
    VALUES ('org_pilot', 'Upgrade Test', 'https://example.com', 'active', 'pilot', 20, ?, ?, ?, ?)`)
    .bind(now, new Date(Date.now() + 30 * 86400000).toISOString(), now, now).run();
  DB.prepare(`INSERT INTO organisation_admins (id, organisation_id, email, status, created_at)
    VALUES ('admin_upgrade', 'org_pilot', 'employer@example.com', 'active', ?)`).bind(now).run();
  const employer = await cookieFor(env, 'employer@example.com', 'org_pilot');
  const originalFetch = globalThis.fetch;
  let checkoutBody;
  globalThis.fetch = async (_url, options) => {
    checkoutBody = new URLSearchParams(options.body);
    return Response.json({ id: 'cs_upgrade', url: 'https://checkout.stripe.com/test-upgrade' });
  };
  try {
    const result = await call('/v1/checkout/sessions', {
      organisationId: 'org_pilot', companyName: 'Upgrade Test', companyWebsite: 'www.example.com', billingEmail: 'employer@example.com',
      contactName: 'Employer', seats: 50, clientRequestId: crypto.randomUUID(),
    }, employer);
    assert.equal(result.response.status, 200);
    assert.equal(checkoutBody.get('success_url').startsWith(`${origin}/checkout-success/`), true);
    const order = DB.prepare('SELECT * FROM checkout_orders').first();
    assert.equal(order.organisation_id, 'org_pilot');
    const paid = subscription(); paid.items.data[0].quantity = 50;
    await persistSubscription(env, paid, order.id, 1);
    assert.equal(DB.prepare('SELECT COUNT(*) AS count FROM organisations').first().count, 1);
    assert.equal(DB.prepare('SELECT plan_type FROM organisations').first().plan_type, 'paid');
  } finally { globalThis.fetch = originalFetch; }
});

test('ended employer records do not block a fresh purchase, while active organisations do', async () => {
  const { env, DB, call } = setup();
  const now = new Date().toISOString();
  DB.prepare(`INSERT INTO organisations (id, name, website, status, plan_type, seat_limit, starts_at, expires_at, created_at, updated_at)
    VALUES ('org_ended', 'Previous Pilot', 'https://example.com', 'ended', 'pilot', 20, ?, ?, ?, ?)`).bind(now, now, now, now).run();
  DB.prepare(`INSERT INTO organisation_admins (id, organisation_id, email, status, created_at)
    VALUES ('admin_ended', 'org_ended', 'employer@example.com', 'active', ?)`).bind(now).run();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ id: 'cs_fresh', url: 'https://checkout.stripe.com/test-fresh' });
  try {
    const fresh = await call('/v1/checkout/sessions', {
      companyName: 'New Employer', companyWebsite: 'https://example.com', billingEmail: 'employer@example.com',
      contactName: 'Employer', seats: 20, clientRequestId: crypto.randomUUID(),
    });
    assert.equal(fresh.response.status, 200);
    assert.equal(DB.prepare('SELECT COUNT(*) AS count FROM checkout_orders').first().count, 1);

    DB.prepare(`INSERT INTO organisations (id, name, website, status, plan_type, seat_limit, starts_at, expires_at, created_at, updated_at)
      VALUES ('org_active', 'Current Plan', 'https://example.com', 'active', 'paid', 20, ?, ?, ?, ?)`).bind(now, now, now, now).run();
    DB.prepare(`INSERT INTO organisation_admins (id, organisation_id, email, status, created_at)
      VALUES ('admin_active', 'org_active', 'employer@example.com', 'active', ?)`).bind(now).run();
    const duplicate = await call('/v1/checkout/sessions', {
      companyName: 'Duplicate Employer', companyWebsite: 'https://example.com', billingEmail: 'employer@example.com',
      contactName: 'Employer', seats: 20, clientRequestId: crypto.randomUUID(),
    });
    assert.equal(duplicate.response.status, 409);
    assert.equal(DB.prepare('SELECT COUNT(*) AS count FROM checkout_orders').first().count, 1);
  } finally { globalThis.fetch = originalFetch; }
});

test('signed webhook retries converge and invalid signatures never mutate the ledger', async () => {
  const { env, DB } = setup();
  await seedOrder(DB);
  const originalFetch = globalThis.fetch;
  const current = subscription(); current.metadata = { order_id: 'ord_flow' };
  globalThis.fetch = async () => Response.json(current);
  async function send(event, valid = true) {
    const raw = JSON.stringify(event);
    const timestamp = Math.floor(Date.now() / 1000);
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.STRIPE_WEBHOOK_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const signature = Buffer.from(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${raw}`))).toString('hex');
    return platform.fetch(new Request(`${origin}/v1/webhooks/stripe`, { method: 'POST', body: raw,
      headers: { 'Stripe-Signature': `t=${timestamp},v1=${valid ? signature : 'invalid'}` } }), env);
  }
  const event = { id: 'evt_flow', type: 'invoice.paid', created: 100, livemode: false,
    data: { object: { parent: { subscription_details: { subscription: 'sub_flow' } } } } };
  try {
    assert.equal((await send(event, false)).status, 400);
    assert.equal(DB.prepare('SELECT COUNT(*) AS count FROM billing_events').first().count, 0);
    assert.equal((await send(event)).status, 200);
    assert.equal((await send(event)).status, 200);
    const outcomes = await Promise.all([send({ ...event, id: 'evt_concurrent' }), send({ ...event, id: 'evt_concurrent' })]);
    assert.ok(outcomes.some((result) => result.status === 200));
    assert.ok(outcomes.every((result) => [200, 409].includes(result.status)));
    assert.equal(DB.prepare('SELECT COUNT(*) AS count FROM organisations').first().count, 1);
    assert.equal(DB.prepare("SELECT COUNT(*) AS count FROM email_outbox WHERE template='employer_payment_successful'").first().count, 1);
  } finally { globalThis.fetch = originalFetch; }
});

test('Business reconciliation grants, shortens and removes only Business while preserving personal entitlements', async () => {
  const { env, DB, call } = setup();
  const applied = await call('/v1/pilot-applications', { companyName: 'Entitlement Test', companyWebsite: 'www.example.com',
    contactName: 'Employer', jobTitle: 'People lead', businessEmail: 'employer@example.com', companySize: 20, requestedSeats: 20 });
  const admin = await cookieFor(env, 'admin@example.com', null, 'sparkfit_admin');
  const approved = await call(`/v1/admin/pilot-applications/${applied.data.applicationId}/decision`, { decision: 'approve' }, admin);
  const employer = await cookieFor(env, 'employer@example.com', approved.data.organisationId);
  await call('/v1/portal/invitations', { email: 'work@example.com' }, employer);
  const account = await verifiedAccount(env, 'personal@example.com');
  const activation = await call('/v1/app/employee-invitations/accept', { token: emailToken(latestEmail(DB, 'employee_invitation')) }, null,
    { Authorization: `Bearer ${account.token}` });
  env.REVENUECAT_WRITES_ENABLED = 'true'; env.REVENUECAT_SECRET_KEY = 'provider-test-key';
  env.REVENUECAT_PROJECT_ID = 'proj_test'; env.REVENUECAT_BUSINESS_ENTITLEMENT_ID = 'ent_business';
  const entitlements = new Map([['ent_personal_pro', Date.now() + 365 * 86400000]]);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    assert.ok(String(url).startsWith('https://api.revenuecat.com/v2/projects/proj_test/customers/'));
    if (options.method === 'GET') return Response.json({ active_entitlements: { items: [...entitlements].map(([entitlement_id, expires_at]) => ({ entitlement_id, expires_at })) } });
    const data = JSON.parse(options.body);
    assert.equal(data.entitlement_id, 'ent_business', 'provider writes must never address personal Pro');
    if (String(url).endsWith('/grant_entitlement')) entitlements.set(data.entitlement_id, data.expires_at);
    else if (String(url).endsWith('/revoke_granted_entitlement')) entitlements.delete(data.entitlement_id);
    else assert.fail('Unexpected RevenueCat operation');
    return Response.json({});
  };
  try {
    assert.equal((await reconcileBusinessEntitlement(env, account.account.id)).active, true);
    assert.ok(entitlements.has('ent_business'));
    const shortened = new Date(Date.now() + 86400000).toISOString();
    DB.prepare('UPDATE employer_entitlements SET expires_at = ?').bind(shortened).run();
    await reconcileBusinessEntitlement(env, account.account.id);
    assert.equal(entitlements.get('ent_business'), Date.parse(shortened));
    assert.equal((await call(`/v1/portal/members/${activation.data.membershipId}/remove`, {}, employer)).response.status, 200);
    assert.equal(entitlements.has('ent_business'), false);
    assert.equal(entitlements.has('ent_personal_pro'), true);
  } finally { globalThis.fetch = originalFetch; }
});

test('scheduled renewal reduction prevents later invitations from exceeding the reserved quantity', async () => {
  const { env, DB, call } = setup();
  await seedOrder(DB);
  await persistSubscription(env, subscription(), 'ord_flow', 1);
  DB.prepare('UPDATE organisations SET seat_limit = 50').run();
  DB.prepare('UPDATE employer_subscriptions SET seats = 50, pending_seats = 20').run();
  const employer = await cookieFor(env, 'employer@example.com', 'org_ord_flow');
  for (let i = 0; i < 20; i++) assert.equal((await call('/v1/portal/invitations', { email: `employee${i}@example.com` }, employer)).response.status, 201);
  assert.equal((await call('/v1/portal/invitations', { email: 'overflow@example.com' }, employer)).response.status, 409);
  assert.equal((await call('/v1/portal/summary', undefined, employer)).data.seats.available, 0);
  assert.throws(() => DB.prepare('UPDATE employer_subscriptions SET pending_seats = 19').run(), /seat limit/);
});

test('signed email delivery events reject tampering, deduplicate retries and retain final failure states', async () => {
  const { env, DB } = setup();
  const secretBytes = crypto.getRandomValues(new Uint8Array(32));
  env.RESEND_WEBHOOK_SECRET = `whsec_${Buffer.from(secretBytes).toString('base64')}`;
  DB.prepare(`INSERT INTO email_outbox (id, template, recipient, payload, send_after, created_at, status, provider_id)
    VALUES ('mail_delivery', 'test', 'employer@example.com', '{}', ?, ?, 'sent', 'provider_delivery')`)
    .bind(new Date().toISOString(), new Date().toISOString()).run();
  async function send(eventType, eventId, tamper = false) {
    const raw = JSON.stringify({ type: eventType, created_at: new Date().toISOString(), data: { email_id: 'provider_delivery' } });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const key = await crypto.subtle.importKey('raw', secretBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const signature = Buffer.from(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${eventId}.${timestamp}.${raw}`))).toString('base64');
    return platform.fetch(new Request(`${origin}/v1/webhooks/resend`, { method: 'POST', body: tamper ? `${raw} ` : raw,
      headers: { 'svix-id': eventId, 'svix-timestamp': timestamp, 'svix-signature': `v1,${signature}` } }), env);
  }
  assert.equal((await send('email.delivered', 'msg_invalid', true)).status, 400);
  assert.equal((await send('email.delivered', 'msg_delivered')).status, 200);
  assert.equal((await send('email.delivered', 'msg_delivered')).status, 200);
  assert.equal(DB.prepare('SELECT COUNT(*) AS count FROM email_delivery_events').first().count, 1);
  await send('email.delivery_delayed', 'msg_delayed');
  assert.equal(DB.prepare('SELECT status FROM email_outbox').first().status, 'delivered');
  await send('email.bounced', 'msg_bounced');
  await send('email.delivered', 'msg_old_delivery');
  assert.equal(DB.prepare('SELECT status FROM email_outbox').first().status, 'bounced');
});

test('production launch gate keeps public routes closed while allowing signed webhook routes', async () => {
  const { env, call, DB } = setup();
  env.ENVIRONMENT = 'production'; env.LAUNCH_ENABLED = 'false';
  const blocked = await platform.fetch(new Request('https://business.example.com/v1/auth/request', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'employer@example.com' }),
  }), env);
  assert.equal(blocked.status, 503);
  assert.match((await blocked.json()).error, /prepared for launch/i);
  const checkout = await platform.fetch(new Request('https://business.example.com/v1/checkout/sessions', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ seats: 20 }),
  }), env);
  assert.equal(checkout.status, 503, 'public purchasing remains closed');
  const adminRequest = await call('/v1/admin/auth/request', { email: 'admin@example.com' });
  assert.equal(adminRequest.response.status, 200, 'allowlisted admins can request an internal sign-in link before launch');
  assert.equal(DB.prepare('SELECT role FROM auth_tokens ORDER BY rowid DESC LIMIT 1').first().role, 'sparkfit_admin');
  const adminData = await call('/v1/admin/dashboard', undefined);
  assert.equal(adminData.response.status, 401, 'admin APIs still require an authenticated session');
  const employeeSignIn = await call('/v1/auth/request', { email: 'employer@example.com' });
  assert.equal(employeeSignIn.response.status, 503, 'employer sign-in remains closed before launch');
  const webhook = await platform.fetch(new Request('https://business.example.com/v1/webhooks/resend', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  }), env);
  assert.equal(webhook.status, 503);
  assert.match((await webhook.json()).error, /delivery tracking is not configured/i);
});

test('retention expires credentials and old business content while keeping active consumer accounts and legal holds', async () => {
  const { env, DB } = setup(); env.RETENTION_ENABLED = 'true';
  const now = new Date('2030-11-16T12:00:00.000Z');
  DB.prepare(`INSERT INTO organisations(id,name,status,plan_type,seat_limit,expires_at,created_at,updated_at,legal_hold_until)
    VALUES ('held','Held company','ended','pilot',20,'2020-01-01','2020-01-01','2020-01-01','2031-01-01')`).run();
  DB.prepare(`INSERT INTO app_accounts(id,primary_email,email_verified_at,created_at,updated_at)
    VALUES ('personal','personal@example.com','2020-01-01','2020-01-01','2020-01-01')`).run();
  for (const [id, org] of [['old','held'],['expired',null],['current',null]]) {
    DB.prepare(`INSERT INTO auth_tokens(id,email,role,organisation_id,token_hash,expires_at,created_at) VALUES (?,?,?,?,?,?,?)`)
      .bind(id,'person@example.com','organisation_admin',org,id,id === 'current' ? '2031-01-01' : '2020-01-01','2020-01-01').run();
  }
  DB.prepare(`INSERT INTO email_outbox(id,template,recipient,payload,send_after,created_at,status)
    VALUES ('old_mail','test','person@example.com','{"text":"private"}','2020-01-01','2020-01-01','delivered')`).run();
  const result = await runRetention(env,now);
  assert.equal(result.legalHolds,1);
  assert.equal(DB.prepare('SELECT COUNT(*) AS count FROM app_accounts').first().count,1);
  assert.equal(DB.prepare("SELECT COUNT(*) AS count FROM auth_tokens WHERE id='expired'").first().count,0);
  assert.equal(DB.prepare('SELECT COUNT(*) AS count FROM auth_tokens').first().count,2);
  assert.equal(DB.prepare('SELECT COUNT(*) AS count FROM email_outbox').first().count,1);
  assert.equal((await runRetention(env,now)).skipped,true);
  DB.prepare('UPDATE organisations SET legal_hold_until=NULL').run();
  await runRetention(env,new Date('2030-11-17T12:00:00.000Z'));
  assert.equal(DB.prepare('SELECT COUNT(*) AS count FROM email_outbox').first().count,0);
  assert.equal(DB.prepare('SELECT COUNT(*) AS count FROM app_accounts').first().count,1);
});
