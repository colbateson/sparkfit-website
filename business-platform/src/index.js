import { audit, clean, corsHeaders, email, enforceRateLimit, HttpError, id, integer, isoAfterDays, json, normaliseWebsite, nowIso, parseJson, randomToken, sha256, validEmail, verifyTurnstile } from './lib.js';
import { consumeMagicLink, issueMagicLink, requireSession } from './auth.js';
import { emailWebhook, flushEmailOutbox, queueEmail, templates } from './email.js';
import { priceAnnual } from './pricing.js';
import { reconcileBusinessEntitlement } from './revenuecat.js';
import { enforcePaidLifecycle, persistSubscription } from './billing.js';
import { runRetention } from './retention.js';
import {
  createBillingPortalSession,
  createCheckoutSession,
  retrieveStripeResource,
  scheduleSubscriptionQuantity,
  stripeSubscriptionIdFromInvoice,
  updateSubscriptionQuantity,
  verifyStripeWebhook,
} from './stripe.js';
import { exchangeAppVerification, requestAppVerification, requireAppSession, revokeAppSession, verifyAppEmail } from './app-auth.js';

const adminEmails = (env) => new Set(String(env.ADMIN_EMAILS || '').split(',').map(email).filter(Boolean));
const appOrigin = (env) => env.PUBLIC_APP_ORIGIN || 'https://spark-fit.com';
const serviceOrigin = (request) => new URL(request.url).origin;

async function pilotApplication(request, env) {
  await enforceRateLimit(request, env, 'pilot_application', 5, 600);
  const body = await parseJson(request);
  if (clean(body.website, 200)) return json({ ok: true });
  if (!(await verifyTurnstile(request, env, clean(body.turnstileToken, 2048), 'pilot_application'))) throw new HttpError(403, 'Please complete the security check.');
  const application = {
    id: id('pilot'),
    companyName: clean(body.companyName, 120),
    companyWebsite: normaliseWebsite(body.companyWebsite, true),
    contactName: clean(body.contactName, 120),
    jobTitle: clean(body.jobTitle, 120),
    businessEmail: email(body.businessEmail),
    companySize: Number(body.companySize),
    requestedSeats: Number(body.requestedSeats),
    message: clean(body.message, 2000),
    marketingConsent: body.marketingConsent === true ? 1 : 0,
  };
  if (!application.companyName || !application.companyWebsite || !application.contactName || !application.jobTitle
    || !validEmail(application.businessEmail) || !integer(application.companySize, 1, 1000000) || !integer(application.requestedSeats, 1, Number(env.PILOT_MAX_SEATS || 20))) {
    throw new HttpError(422, 'Please check the pilot application details.');
  }
  const now = nowIso();
  await env.DB.prepare(`INSERT INTO pilot_applications
    (id, company_name, company_website, contact_name, job_title, business_email, company_size, requested_seats, message, marketing_consent, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(application.id, application.companyName, application.companyWebsite, application.contactName, application.jobTitle, application.businessEmail,
      application.companySize, application.requestedSeats, application.message, application.marketingConsent, now, now).run();
  await Promise.all([
    queueEmail(env, 'pilot_application_received', application.businessEmail, templates.pilotReceived(application.contactName, application.id)),
    queueEmail(env, 'pilot_application_admin', env.PARTNERSHIPS_EMAIL || 'partnerships@spark-fit.com', templates.pilotAdmin(application.companyName, application.id)),
    audit(env.DB, { email: application.businessEmail, role: 'applicant' }, 'pilot.application.created', 'pilot_application', application.id, null, { requestedSeats: application.requestedSeats }),
  ]);
  return json({ ok: true, applicationId: application.id, status: 'pending_approval' }, 201);
}

async function requestSignIn(request, env, destination = 'employer') {
  await enforceRateLimit(request, env, destination === 'admin' ? 'admin_sign_in_request' : 'sign_in_request', 10, 600);
  const body = await parseJson(request);
  const address = email(body.email);
  if (!validEmail(address)) throw new HttpError(422, 'Enter a valid business email.');
  let role = null;
  let organisationId = null;
  if (destination === 'admin') {
    if (adminEmails(env).has(address)) role = 'sparkfit_admin';
  } else {
    const admin = await env.DB.prepare(`SELECT oa.email, oa.organisation_id, oa.role FROM organisation_admins oa
      JOIN organisations o ON o.id = oa.organisation_id
      WHERE oa.email = ? AND oa.status = 'active' AND o.status = 'active'
      ORDER BY oa.created_at DESC LIMIT 1`).bind(address).first();
    if (admin) { role = admin.role; organisationId = admin.organisation_id; }
  }
  // Always return the same response to prevent account enumeration.
  if (!role) return json({ ok: true });
  const token = await issueMagicLink(env, address, role, organisationId);
  const link = `${new URL(request.url).origin}/v1/auth/consume?token=${encodeURIComponent(token)}`;
  const destinationLabel = role === 'sparkfit_admin' ? 'SparkFit admin dashboard' : 'employer portal';
  await queueEmail(env, 'magic_link', address, { subject: 'Your secure SparkFit sign-in link', heading: 'Your secure sign-in link', eyebrow: destinationLabel, preheader: 'This one-time sign-in link expires in 30 minutes.', actionUrl: link, actionLabel: `Continue to ${destinationLabel}`, text: `Use this one-time link to sign in to the ${destinationLabel}. It expires after 30 minutes and can only be used once.` });
  await flushEmailOutbox(env, 10);
  return json({ ok: true, ...(env.ENVIRONMENT === 'test' ? { testToken: token } : {}) });
}

const MAGIC_LINK_COOKIE = 'sparkfit_employer_magic_link';

function signInConfirmation(token) {
  const safeToken = clean(token, 200);
  if (!safeToken) throw new HttpError(400, 'This sign-in link is invalid or expired. Request a new link.');
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>Confirm sign-in | SparkFit Business</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f7f5fb;color:#171321;font:16px/1.5 system-ui,sans-serif}.card{box-sizing:border-box;width:min(92vw,480px);padding:36px;border:1px solid #e5e0ec;border-radius:24px;background:#fff;box-shadow:0 18px 50px #24144212}h1{font-size:30px;line-height:1.1;margin:0 0 14px}p{color:#655d70}.button{width:100%;margin:16px 0 0;padding:15px;border:0;border-radius:999px;background:#6c2ff2;color:white;font:700 16px system-ui;cursor:pointer}.note{font-size:13px}</style></head><body><main class="card"><h1>Confirm your sign-in</h1><p>Your secure link is ready. Press Continue to open your SparkFit dashboard in this browser.</p><form method="post" action="/v1/auth/consume"><button class="button" type="submit">Continue to SparkFit</button></form><p class="note">If you did not request this link, close this page. The link expires after 30 minutes.</p></main></body></html>`;
  const headers = new Headers({
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store, max-age=0',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    'Set-Cookie': `${MAGIC_LINK_COOKIE}=${encodeURIComponent(safeToken)}; Path=/v1/auth/consume; HttpOnly; Secure; SameSite=Strict; Max-Age=1800`,
  });
  return new Response(body, { status: 200, headers });
}

function magicLinkToken(request) {
  const header = request.headers.get('Cookie') || '';
  const value = header.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${MAGIC_LINK_COOKIE}=`));
  return value ? clean(decodeURIComponent(value.slice(MAGIC_LINK_COOKIE.length + 1)), 200) : '';
}

async function consumeSignIn(request, env) {
  if (request.method === 'GET') return signInConfirmation(new URL(request.url).searchParams.get('token'));
  const token = magicLinkToken(request);
  if (!token) throw new HttpError(401, 'Open your sign-in link in this browser and try again.');
  const result = await consumeMagicLink(env, token);
  const target = result.session.role === 'sparkfit_admin' ? '/admin/' : '/portal/';
  const headers = new Headers({ Location: `${serviceOrigin(request)}${target}`, 'Set-Cookie': result.cookie, 'Cache-Control': 'no-store' });
  headers.append('Set-Cookie', `${MAGIC_LINK_COOKIE}=; Path=/v1/auth/consume; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);
  return new Response(null, { status: 302, headers });
}

async function adminDashboard(request, env) {
  await requireSession(request, env, ['sparkfit_admin']);
  const [applicationCounts, organisationCounts, seats, failed, audits, organisationOverview] = await Promise.all([
    env.DB.prepare(`SELECT status, COUNT(*) AS count FROM pilot_applications GROUP BY status`).all(),
    env.DB.prepare(`SELECT plan_type, status, COUNT(*) AS count FROM organisations GROUP BY plan_type, status`).all(),
    env.DB.prepare(`SELECT COALESCE(SUM(seat_limit), 0) AS purchased,
      (SELECT COUNT(*) FROM organisation_memberships WHERE status = 'active') AS allocated FROM organisations WHERE status = 'active'`).first(),
    env.DB.prepare(`SELECT COUNT(*) AS count FROM employer_entitlements WHERE provision_status = 'failed'`).first(),
    env.DB.prepare(`SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 50`).all(),
    env.DB.prepare(`SELECT o.id, o.name, o.website, o.status AS organisation_status, o.plan_type, o.seat_limit,
      o.starts_at, o.expires_at, o.created_at,
      COALESCE(es.seats, o.seat_limit) AS seats_purchased, es.status AS subscription_status,
      es.current_period_end, es.cancel_at_period_end, es.pending_seats, es.payment_failed_at, es.grace_ends_at,
      co.subtotal_ex_vat AS annual_total_ex_vat, co.discount_bps,
      COALESCE(co.contact_name, (SELECT pa.contact_name FROM pilot_applications pa
        WHERE pa.organisation_id = o.id ORDER BY pa.created_at LIMIT 1)) AS contact_name,
      COALESCE(co.billing_email, (SELECT oa.email FROM organisation_admins oa
        WHERE oa.organisation_id = o.id AND oa.status = 'active' ORDER BY oa.created_at LIMIT 1)) AS billing_contact,
      COALESCE(co.company_website, o.website) AS contact_website,
      (SELECT pa.job_title FROM pilot_applications pa WHERE pa.organisation_id = o.id ORDER BY pa.created_at LIMIT 1) AS contact_title,
      (SELECT pa.company_size FROM pilot_applications pa WHERE pa.organisation_id = o.id ORDER BY pa.created_at LIMIT 1) AS workforce_size,
      (SELECT pa.message FROM pilot_applications pa WHERE pa.organisation_id = o.id ORDER BY pa.created_at LIMIT 1) AS pilot_message,
      co.created_at AS purchase_date,
      (SELECT COUNT(*) FROM organisation_memberships m WHERE m.organisation_id = o.id AND m.status = 'active') AS activated_seats,
      (SELECT COUNT(*) FROM employee_invitations i WHERE i.organisation_id = o.id AND i.status = 'pending' AND i.expires_at > ?) AS pending_invitations
      FROM organisations o
      LEFT JOIN employer_subscriptions es ON es.id = (SELECT es2.id FROM employer_subscriptions es2
        WHERE es2.organisation_id = o.id ORDER BY es2.created_at DESC LIMIT 1)
      LEFT JOIN checkout_orders co ON co.id = (SELECT co2.id FROM checkout_orders co2
        WHERE co2.organisation_id = o.id ORDER BY co2.created_at DESC LIMIT 1)
      ORDER BY o.created_at DESC LIMIT 250`).bind(nowIso()).all(),
  ]);
  const paid = await env.DB.prepare(`SELECT COUNT(*) AS organisations, COALESCE(SUM(es.seats), 0) AS seats,
    COALESCE(SUM(co.unit_amount_ex_vat * es.seats), 0) AS arr_pence
    FROM employer_subscriptions es LEFT JOIN checkout_orders co ON co.organisation_id = es.organisation_id
    WHERE es.status = 'active'`).first();
  return json({ applications: applicationCounts.results || [], organisations: organisationCounts.results || [], organisationOverview: organisationOverview.results || [], seats, paid, failedProvisioning: Number(failed?.count || 0), audits: audits.results || [] });
}

async function prepareFirstLiveCheckout(request, env) {
  if (env.ENVIRONMENT !== 'production' || env.LAUNCH_ENABLED === 'true' || env.FIRST_LIVE_CHECKOUT_ENABLED !== 'true') {
    throw new HttpError(404, 'This checkout preparation page is unavailable.');
  }
  const actor = await requireSession(request, env, ['sparkfit_admin']);
  await enforceRateLimit(request, env, 'admin_first_live_checkout', 2, 3600);
  const existing = await env.DB.prepare(`SELECT * FROM checkout_orders WHERE request_key = 'production-first-live-checkout-v1'`).first();
  if (existing?.stripe_checkout_session_id) {
    const session = await retrieveStripeResource(env, `/checkout/sessions/${encodeURIComponent(existing.stripe_checkout_session_id)}`);
    if (session.status === 'open') return json({ checkoutUrl: session.url, orderId: existing.id, reused: true });
    throw new HttpError(409, 'The first live Checkout has already been completed or expired. Review Stripe before creating another.');
  }
  const price = priceAnnual(20);
  const order = existing || {
    id: id('ord'), company_name: 'SparkFit', company_website: 'https://spark-fit.com/',
    billing_email: 'partnerships@spark-fit.com', contact_name: 'SparkFit Partnerships', seats: 20,
    unit_amount_ex_vat: price.unitExVat, subtotal_ex_vat: price.subtotalExVat,
    discount_bps: price.discountBps, pricing_version: price.pricingVersion,
  };
  const now = nowIso();
  if (!existing) {
    await env.DB.prepare(`INSERT INTO checkout_orders
      (id, company_name, company_website, billing_email, contact_name, seats, unit_amount_ex_vat, subtotal_ex_vat, discount_bps, pricing_version, created_at, updated_at, request_key)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'production-first-live-checkout-v1')`)
      .bind(order.id, order.company_name, order.company_website, order.billing_email, order.contact_name, order.seats,
        order.unit_amount_ex_vat, order.subtotal_ex_vat, order.discount_bps, order.pricing_version, now, now).run();
    await audit(env.DB, actor, 'billing.first_live_checkout.prepared', 'checkout_order', order.id, null,
      { seats: order.seats, subtotalExVat: order.subtotal_ex_vat, discountBps: order.discount_bps });
  }
  const session = await createCheckoutSession(env, order,
    `${serviceOrigin(request)}/checkout-success/?session_id={CHECKOUT_SESSION_ID}`,
    `${serviceOrigin(request)}/buy/?seats=${order.seats}`, { allowWhenPaymentsDisabled: true });
  await env.DB.prepare(`UPDATE checkout_orders SET stripe_checkout_session_id = ?, status = 'checkout_created', updated_at = ? WHERE id = ?`)
    .bind(session.id, nowIso(), order.id).run();
  return json({ checkoutUrl: session.url, orderId: order.id, reused: false });
}

async function listPilots(request, env) {
  await requireSession(request, env, ['sparkfit_admin']);
  const rows = await env.DB.prepare(`SELECT * FROM pilot_applications ORDER BY created_at DESC LIMIT 200`).all();
  return json({ applications: rows.results || [] });
}

async function decidePilot(request, env, applicationId) {
  const actor = await requireSession(request, env, ['sparkfit_admin']);
  const body = await parseJson(request);
  const decision = clean(body.decision, 20);
  if (!['approve', 'reject'].includes(decision)) throw new HttpError(422, 'Decision must be approve or reject.');
  const application = await env.DB.prepare(`SELECT * FROM pilot_applications WHERE id = ?`).bind(applicationId).first();
  if (!application || application.status !== 'pending_approval') throw new HttpError(409, 'This application is not pending approval.');
  if (decision === 'reject') {
    await env.DB.prepare(`UPDATE pilot_applications SET status = 'rejected', updated_at = ? WHERE id = ?`).bind(nowIso(), applicationId).run();
    await audit(env.DB, actor, 'pilot.application.rejected', 'pilot_application', applicationId);
    await queueEmail(env, 'pilot_rejected', application.business_email, { subject: 'Update on your SparkFit employee pilot request', text: 'Thank you for your interest. SparkFit is unable to approve this pilot request at this time.\n\nSparkFit Partnerships' });
    return json({ ok: true, status: 'rejected' });
  }
  const seats = Number(body.seats || application.requested_seats);
  const days = Number(body.days || env.PILOT_DEFAULT_DAYS || 30);
  if (!integer(seats, 1, Number(env.PILOT_MAX_SEATS || 20)) || !integer(days, 1, 90)) throw new HttpError(422, 'Pilot seats or duration are invalid.');
  const organisationId = id('org');
  const adminId = id('oadm');
  const now = nowIso();
  const expiresAt = isoAfterDays(days);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO organisations (id, name, website, status, plan_type, seat_limit, starts_at, expires_at, created_at, updated_at)
      VALUES (?, ?, ?, 'active', 'pilot', ?, ?, ?, ?, ?)`).bind(organisationId, application.company_name, application.company_website, seats, now, expiresAt, now, now),
    env.DB.prepare(`INSERT INTO organisation_admins (id, organisation_id, email, role, status, created_at)
      VALUES (?, ?, ?, 'organisation_admin', 'active', ?)`).bind(adminId, organisationId, application.business_email, now),
    env.DB.prepare(`UPDATE pilot_applications SET status = 'approved', approved_seats = ?, pilot_days = ?, organisation_id = ?, updated_at = ? WHERE id = ?`)
      .bind(seats, days, organisationId, now, applicationId),
  ]);
  const token = await issueMagicLink(env, application.business_email, 'organisation_admin', organisationId);
  const link = `${new URL(request.url).origin}/v1/auth/consume?token=${encodeURIComponent(token)}`;
  await queueEmail(env, 'pilot_approved', application.business_email, templates.pilotApproved(application.company_name, link));
  await audit(env.DB, actor, 'pilot.application.approved', 'pilot_application', applicationId, organisationId, { seats, days, expiresAt });
  return json({ ok: true, status: 'approved', organisationId, seats, expiresAt });
}

async function portalSummary(request, env) {
  const actor = await requireSession(request, env, ['organisation_admin']);
  const organisationId = actor.organisationId;
  if (!organisationId) throw new HttpError(401, 'Please sign in to your employer account.');
  const organisation = await env.DB.prepare(`SELECT * FROM organisations WHERE id = ?`).bind(organisationId).first();
  if (!organisation) throw new HttpError(404, 'Organisation not found.');
  const [members, invites, subscription] = await Promise.all([
    env.DB.prepare(`SELECT id, email, status, joined_at, ended_at FROM organisation_memberships WHERE organisation_id = ? ORDER BY joined_at DESC`).bind(organisationId).all(),
    env.DB.prepare(`SELECT id, email, status, delivery_status, expires_at, last_sent_at, created_at FROM employee_invitations WHERE organisation_id = ? ORDER BY created_at DESC`).bind(organisationId).all(),
    env.DB.prepare(`SELECT * FROM employer_subscriptions WHERE organisation_id = ? ORDER BY created_at DESC LIMIT 1`).bind(organisationId).first(),
  ]);
  const activeCount = (members.results || []).filter((row) => row.status === 'active').length;
  const pendingCount = (invites.results || []).filter((row) => row.status === 'pending' && new Date(row.expires_at) > new Date()).length;
  const invitationLimit = Math.min(organisation.seat_limit, subscription?.pending_seats || organisation.seat_limit);
  return json({ organisation, subscription, paymentsEnabled: env.PAYMENTS_ENABLED === 'true', seats: { purchased: organisation.seat_limit, active: activeCount, pending: pendingCount, allocated: activeCount + pendingCount, available: Math.max(0, invitationLimit - activeCount - pendingCount) }, members: members.results || [], invitations: invites.results || [] });
}

async function createInvitation(request, env) {
  const actor = await requireSession(request, env, ['organisation_admin']);
  const body = await parseJson(request);
  const recipient = email(body.email);
  if (!validEmail(recipient)) throw new HttpError(422, 'Enter a valid employee email.');
  const organisation = await env.DB.prepare(`SELECT * FROM organisations WHERE id = ? AND status = 'active'`).bind(actor.organisationId).first();
  if (!organisation || Date.parse(organisation.expires_at) <= Date.now()) throw new HttpError(409, 'The organisation is not active.');
  const capacity = await env.DB.prepare(`SELECT
    (SELECT COUNT(*) FROM organisation_memberships WHERE organisation_id = ? AND status = 'active') AS active,
    (SELECT COUNT(*) FROM employee_invitations WHERE organisation_id = ? AND status = 'pending' AND expires_at > ?) AS pending`)
    .bind(actor.organisationId, actor.organisationId, nowIso()).first();
  if (Number(capacity?.active || 0) + Number(capacity?.pending || 0) >= organisation.seat_limit) throw new HttpError(409, 'No employee seats are available. Pending invitations also reserve seats.');
  const token = randomToken();
  const invitationId = id('inv');
  const expiresAt = new Date(Math.min(Date.now() + 7 * 86400000, Date.parse(organisation.expires_at))).toISOString();
  try {
    const createdAt = nowIso();
    await env.DB.prepare(`INSERT INTO employee_invitations (id, organisation_id, email, token_hash, expires_at, created_by, created_at, last_sent_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(organisation_id, email) DO UPDATE SET token_hash = excluded.token_hash, status = 'pending',
        expires_at = excluded.expires_at, revoked_at = NULL, delivery_status = 'queued', last_sent_at = excluded.last_sent_at
      WHERE employee_invitations.status IN ('revoked', 'expired', 'accepted')
        AND NOT EXISTS (SELECT 1 FROM organisation_memberships WHERE organisation_id = excluded.organisation_id AND email = excluded.email AND status = 'active')`)
      .bind(invitationId, actor.organisationId, recipient, await sha256(token), expiresAt, actor.email, createdAt, createdAt).run();
  } catch (error) {
    if (String(error).includes('seat limit')) throw new HttpError(409, 'No employee seats are available. Pending invitations also reserve seats.');
    throw new HttpError(409, 'This employee already has an invitation for the organisation.');
  }
  const saved = await env.DB.prepare(`SELECT id, token_hash FROM employee_invitations WHERE organisation_id = ? AND email = ?`).bind(actor.organisationId, recipient).first();
  if (saved.token_hash !== await sha256(token)) throw new HttpError(409, 'This employee already has an invitation or active membership.');
  const link = `${serviceOrigin(request)}/employee-access/?token=${encodeURIComponent(token)}`;
  await queueEmail(env, 'employee_invitation', recipient, { ...templates.employeeInvite(organisation.name, link), invitationId: saved.id });
  await flushEmailOutbox(env, 10);
  const delivery = await env.DB.prepare(`SELECT delivery_status FROM employee_invitations WHERE id = ?`).bind(saved.id).first();
  await audit(env.DB, actor, 'employee.invited', 'employee_invitation', invitationId, actor.organisationId, { recipient });
  return json({ ok: true, invitationId: saved.id, expiresAt, deliveryStatus: delivery?.delivery_status || 'queued' }, 201);
}

async function invitationAction(request, env, invitationId) {
  const actor = await requireSession(request, env, ['organisation_admin']);
  const body = await parseJson(request);
  const action = clean(body.action, 20);
  const invitation = await env.DB.prepare(`SELECT i.*, o.name AS organisation_name FROM employee_invitations i
    JOIN organisations o ON o.id = i.organisation_id WHERE i.id = ? AND i.organisation_id = ?`)
    .bind(invitationId, actor.organisationId).first();
  if (!invitation) throw new HttpError(404, 'Invitation not found.');
  if (action === 'revoke') {
    if (invitation.status !== 'pending') throw new HttpError(409, 'Only pending invitations can be revoked.');
    await env.DB.prepare(`UPDATE employee_invitations SET status = 'revoked', revoked_at = ? WHERE id = ?`).bind(nowIso(), invitationId).run();
    await audit(env.DB, actor, 'employee.invitation.revoked', 'employee_invitation', invitationId, actor.organisationId);
    return json({ ok: true, status: 'revoked' });
  }
  if (action === 'resend') {
    if (!['pending', 'expired'].includes(invitation.status)) throw new HttpError(409, 'Only pending or expired invitations can be resent.');
    const token = randomToken();
    const expiresAt = isoAfterDays(7);
    await env.DB.prepare(`UPDATE employee_invitations SET token_hash = ?, expires_at = ?, status = 'pending', revoked_at = NULL, delivery_status = 'queued', last_sent_at = ? WHERE id = ?`)
      .bind(await sha256(token), expiresAt, nowIso(), invitationId).run();
    const link = `${serviceOrigin(request)}/employee-access/?token=${encodeURIComponent(token)}`;
    await queueEmail(env, 'employee_invitation_reminder', invitation.email, { ...templates.employeeInviteReminder(invitation.organisation_name, link), invitationId });
    await flushEmailOutbox(env, 10);
    const delivery = await env.DB.prepare(`SELECT delivery_status FROM employee_invitations WHERE id = ?`).bind(invitationId).first();
    await audit(env.DB, actor, 'employee.invitation.resent', 'employee_invitation', invitationId, actor.organisationId);
    return json({ ok: true, status: 'pending', expiresAt, deliveryStatus: delivery?.delivery_status || 'queued' });
  }
  if (action === 'correct') {
    if (!['pending', 'expired'].includes(invitation.status)) throw new HttpError(409, 'An activated employee must be removed before inviting a different address.');
    const corrected = email(body.email);
    if (!validEmail(corrected)) throw new HttpError(422, 'Enter a valid corrected employee email.');
    const token = randomToken();
    const expiresAt = isoAfterDays(7);
    try {
      await env.DB.prepare(`UPDATE employee_invitations SET email = ?, token_hash = ?, expires_at = ?, status = 'pending', revoked_at = NULL, delivery_status = 'queued', last_sent_at = ? WHERE id = ?`)
        .bind(corrected, await sha256(token), expiresAt, nowIso(), invitationId).run();
    } catch { throw new HttpError(409, 'That email is already associated with this organisation.'); }
    const link = `${serviceOrigin(request)}/employee-access/?token=${encodeURIComponent(token)}`;
    await queueEmail(env, 'employee_invitation', corrected, { ...templates.employeeInvite(invitation.organisation_name, link), invitationId });
    await flushEmailOutbox(env, 10);
    const delivery = await env.DB.prepare(`SELECT delivery_status FROM employee_invitations WHERE id = ?`).bind(invitationId).first();
    await audit(env.DB, actor, 'employee.invitation.corrected', 'employee_invitation', invitationId, actor.organisationId, { previousEmail: invitation.email, correctedEmail: corrected });
    return json({ ok: true, status: 'pending', email: corrected, expiresAt, deliveryStatus: delivery?.delivery_status || 'queued' });
  }
  throw new HttpError(422, 'Action must be resend, revoke or correct.');
}

async function adminOrganisationAction(request, env, organisationId) {
  const actor = await requireSession(request, env, ['sparkfit_admin']);
  const body = await parseJson(request);
  const action = clean(body.action, 30);
  const organisation = await env.DB.prepare(`SELECT * FROM organisations WHERE id = ?`).bind(organisationId).first();
  if (!organisation) throw new HttpError(404, 'Organisation not found.');
  if (action === 'extend_pilot') {
    if (organisation.plan_type !== 'pilot') throw new HttpError(409, 'Only pilots can be extended.');
    const days = Number(body.days);
    if (!integer(days, 1, 90)) throw new HttpError(422, 'Extension must be between 1 and 90 days.');
    const base = Math.max(Date.now(), new Date(organisation.expires_at || 0).getTime());
    const expiresAt = isoAfterDays(days, base);
    await env.DB.batch([
      env.DB.prepare(`UPDATE organisations SET status = 'active', expires_at = ?, updated_at = ? WHERE id = ?`).bind(expiresAt, nowIso(), organisationId),
      env.DB.prepare(`UPDATE employer_entitlements SET status = 'active', expires_at = ?, updated_at = ? WHERE organisation_id = ? AND status IN ('active', 'expired')`).bind(expiresAt, nowIso(), organisationId),
    ]);
    const users = await env.DB.prepare(`SELECT DISTINCT revenuecat_app_user_id FROM employer_entitlements WHERE organisation_id = ?`).bind(organisationId).all();
    for (const user of users.results || []) await reconcileBusinessEntitlement(env, user.revenuecat_app_user_id);
    await audit(env.DB, actor, 'pilot.extended', 'organisation', organisationId, organisationId, { days, expiresAt });
    return json({ ok: true, status: 'active', expiresAt });
  }
  if (action === 'end_pilot') {
    if (organisation.plan_type !== 'pilot') throw new HttpError(409, 'Only pilots can be ended with this action.');
    const users = await env.DB.prepare(`SELECT DISTINCT revenuecat_app_user_id FROM employer_entitlements WHERE organisation_id = ? AND status = 'active'`).bind(organisationId).all();
    await env.DB.batch([
      env.DB.prepare(`UPDATE organisations SET status = 'ended', expires_at = ?, updated_at = ? WHERE id = ?`).bind(nowIso(), nowIso(), organisationId),
      env.DB.prepare(`UPDATE employer_entitlements SET status = 'revoked', updated_at = ? WHERE organisation_id = ? AND status = 'active'`).bind(nowIso(), organisationId),
    ]);
    for (const user of users.results || []) await reconcileBusinessEntitlement(env, user.revenuecat_app_user_id);
    await audit(env.DB, actor, 'pilot.ended', 'organisation', organisationId, organisationId);
    return json({ ok: true, status: 'ended' });
  }
  if (action === 'retry_provisioning') {
    const users = await env.DB.prepare(`SELECT DISTINCT revenuecat_app_user_id FROM employer_entitlements WHERE organisation_id = ? AND provision_status = 'failed'`).bind(organisationId).all();
    for (const user of users.results || []) await reconcileBusinessEntitlement(env, user.revenuecat_app_user_id);
    await audit(env.DB, actor, 'entitlement.provisioning.retried', 'organisation', organisationId, organisationId, { users: users.results?.length || 0 });
    return json({ ok: true, retried: users.results?.length || 0 });
  }
  throw new HttpError(422, 'Unsupported organisation action.');
}

async function acceptInvitation(request, env) {
  await enforceRateLimit(request, env, 'employee_activation', 10, 600);
  const body = await parseJson(request);
  const token = clean(body.token, 200);
  const tokenHash = await sha256(token);
  const invitation = await env.DB.prepare(`SELECT i.*, o.plan_type, o.expires_at AS organisation_expires_at, o.status AS organisation_status
    FROM employee_invitations i JOIN organisations o ON o.id = i.organisation_id
    WHERE i.token_hash = ? AND i.status IN ('pending', 'accepted')`).bind(tokenHash).first();
  if (!invitation || invitation.organisation_status !== 'active' || Date.parse(invitation.organisation_expires_at) <= Date.now()
    || (invitation.status === 'pending' && Date.parse(invitation.expires_at) <= Date.now())) throw new HttpError(410, 'This invitation is invalid or expired.');
  if (invitation.status === 'accepted') {
    const acceptedMembership = await env.DB.prepare(`SELECT id FROM organisation_memberships
      WHERE organisation_id = ? AND invitation_id = ? AND revenuecat_app_user_id = ? AND status = 'active' LIMIT 1`)
      .bind(invitation.organisation_id, invitation.id, account.id).first();
    if (!acceptedMembership) throw new HttpError(410, 'This invitation is no longer available for this account.');
    const reconciliation = await reconcileBusinessEntitlement(env, account.id);
    return json({ ok: true, membershipId: acceptedMembership.id, accountId: account.id, premium: reconciliation, alreadyActivated: true });
  }
  if (env.REQUIRE_APP_ACCOUNT_FOR_BUSINESS === 'true') throw new HttpError(409, 'Open this invitation in the SparkFit app and sign in with a verified account.');
  // Current SparkFit releases identify RevenueCat customers by normalised onboarding email.
  // The email comes only from the server-side invitation record after possession of the
  // one-time emailed token has been proven. No client-supplied RevenueCat ID is accepted.
  const appUserId = invitation.email;
  const accountHash = await sha256(`sparkfit-account:${invitation.email}`);
  const sparkfitAccountId = `acct_${accountHash.slice(0, 32)}`;
  const previousMembership = await env.DB.prepare(`SELECT id FROM organisation_memberships WHERE organisation_id = ? AND email = ?`).bind(invitation.organisation_id, invitation.email).first();
  const membershipId = previousMembership?.id || id('mem');
  const entitlementId = id('ent');
  const now = nowIso();
  const expiry = invitation.organisation_expires_at;
  try {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO organisation_memberships (id, organisation_id, invitation_id, email, revenuecat_app_user_id, sparkfit_account_id, joined_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(organisation_id, email) DO UPDATE SET invitation_id = excluded.invitation_id,
          revenuecat_app_user_id = excluded.revenuecat_app_user_id, sparkfit_account_id = excluded.sparkfit_account_id,
          status = 'active', joined_at = excluded.joined_at, ended_at = NULL WHERE organisation_memberships.status = 'ended'`)
        .bind(membershipId, invitation.organisation_id, invitation.id, invitation.email, appUserId, sparkfitAccountId, now),
      env.DB.prepare(`INSERT INTO employer_entitlements (id, organisation_id, membership_id, revenuecat_app_user_id, source, status, starts_at, expires_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)
        ON CONFLICT(organisation_id, membership_id) DO UPDATE SET revenuecat_app_user_id = excluded.revenuecat_app_user_id,
          status = 'active', source = excluded.source, expires_at = excluded.expires_at, provision_status = 'pending', updated_at = excluded.updated_at`)
        .bind(entitlementId, invitation.organisation_id, membershipId, appUserId, invitation.plan_type, now, expiry, now),
      env.DB.prepare(`UPDATE employee_invitations SET status = 'accepted', accepted_at = ?, verified_at = ? WHERE id = ?`).bind(now, now, invitation.id),
    ]);
  } catch (error) {
    if (String(error).includes('seat limit')) throw new HttpError(409, 'No employee seats are available.');
    throw error;
  }
  const reconciliation = await reconcileBusinessEntitlement(env, appUserId);
  await audit(env.DB, { email: invitation.email, role: 'employee' }, 'employee.invitation.accepted', 'membership', membershipId, invitation.organisation_id);
  return json({ ok: true, membershipId, premium: reconciliation });
}

async function activateInvitationForAccount(request, env) {
  const account = await requireAppSession(request, env);
  await enforceRateLimit(request, env, 'employee_activation_account', 10, 60, account.id);
  const body = await parseJson(request);
  const tokenHash = await sha256(clean(body.token, 200));
  const invitation = await env.DB.prepare(`SELECT i.*, o.plan_type, o.expires_at AS organisation_expires_at, o.status AS organisation_status
    FROM employee_invitations i JOIN organisations o ON o.id = i.organisation_id
    WHERE i.token_hash = ? AND i.status = 'pending' AND i.expires_at > ?`).bind(tokenHash, nowIso()).first();
  if (!invitation || invitation.organisation_status !== 'active' || Date.parse(invitation.organisation_expires_at) <= Date.now()) throw new HttpError(410, 'This invitation is invalid or expired.');
  const activeAccountMembership = await env.DB.prepare(`SELECT * FROM organisation_memberships
    WHERE organisation_id = ? AND revenuecat_app_user_id = ? AND status = 'active' LIMIT 1`)
    .bind(invitation.organisation_id, account.id).first();
  if (activeAccountMembership) {
    if (account.primary_email !== invitation.email) {
      throw new HttpError(409, 'This SparkFit account already has access for this organisation under a different email. Sign in to the account linked to the invitation, or ask your employer to update the invited email.');
    }
    const now = nowIso();
    await env.DB.batch([
      env.DB.prepare(`UPDATE employee_invitations SET status = 'revoked', revoked_at = ?
        WHERE id = ? AND id != ? AND status = 'accepted'`)
        .bind(now, activeAccountMembership.invitation_id, invitation.id),
      env.DB.prepare(`UPDATE organisation_memberships SET email = ?, invitation_id = ?
        WHERE id = ? AND organisation_id = ? AND status = 'active'`)
        .bind(invitation.email, invitation.id, activeAccountMembership.id, invitation.organisation_id),
      env.DB.prepare(`UPDATE employee_invitations SET status = 'accepted', accepted_at = COALESCE(accepted_at, ?),
        verified_at = COALESCE(verified_at, ?) WHERE id = ? AND status = 'pending'`)
        .bind(now, now, invitation.id),
    ]);
    const reconciliation = await reconcileBusinessEntitlement(env, account.id);
    await audit(env.DB, { email: account.primary_email, role: 'employee' }, 'employee.invitation.relinked', 'membership', activeAccountMembership.id, invitation.organisation_id,
      { previousEmail: activeAccountMembership.email, invitedEmail: invitation.email });
    return json({ ok: true, membershipId: activeAccountMembership.id, accountId: account.id, premium: reconciliation, relinked: true });
  }
  const previousMembership = await env.DB.prepare(`SELECT id FROM organisation_memberships WHERE organisation_id = ? AND email = ?`).bind(invitation.organisation_id, invitation.email).first();
  const membershipId = previousMembership?.id || id('mem');
  const entitlementId = id('ent');
  const now = nowIso();
  try {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO organisation_memberships (id, organisation_id, invitation_id, email, revenuecat_app_user_id, sparkfit_account_id, joined_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(organisation_id, email) DO UPDATE SET invitation_id = excluded.invitation_id,
          revenuecat_app_user_id = excluded.revenuecat_app_user_id, sparkfit_account_id = excluded.sparkfit_account_id,
          status = 'active', joined_at = excluded.joined_at, ended_at = NULL WHERE organisation_memberships.status = 'ended'`)
        .bind(membershipId, invitation.organisation_id, invitation.id, invitation.email, account.id, account.id, now),
      env.DB.prepare(`INSERT INTO employer_entitlements (id, organisation_id, membership_id, revenuecat_app_user_id, source, status, starts_at, expires_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)
        ON CONFLICT(organisation_id, membership_id) DO UPDATE SET revenuecat_app_user_id = excluded.revenuecat_app_user_id,
          status = 'active', source = excluded.source, expires_at = excluded.expires_at, provision_status = 'pending', updated_at = excluded.updated_at`)
        .bind(entitlementId, invitation.organisation_id, membershipId, account.id, invitation.plan_type, now, invitation.organisation_expires_at, now),
      env.DB.prepare(`UPDATE employee_invitations SET status = 'accepted', accepted_at = ?, verified_at = ? WHERE id = ?`).bind(now, now, invitation.id),
    ]);
  } catch (error) {
    if (String(error).includes('seat limit')) throw new HttpError(409, 'No employee seats are available.');
    if (String(error).includes('account already activated')) throw new HttpError(409, 'This SparkFit account already has employee access for this organisation.');
    throw error;
  }
  const reconciliation = await reconcileBusinessEntitlement(env, account.id);
  await audit(env.DB, { email: account.primary_email, role: 'employee' }, 'employee.invitation.accepted', 'membership', membershipId, invitation.organisation_id, { invitedEmail: invitation.email });
  return json({ ok: true, membershipId, accountId: account.id, premium: reconciliation });
}

async function removeMember(request, env, membershipId) {
  const actor = await requireSession(request, env, ['organisation_admin']);
  const membership = await env.DB.prepare(`SELECT * FROM organisation_memberships WHERE id = ? AND organisation_id = ? AND status = 'active'`)
    .bind(membershipId, actor.organisationId).first();
  if (!membership) throw new HttpError(404, 'Active employee membership not found.');
  await env.DB.batch([
    env.DB.prepare(`UPDATE organisation_memberships SET status = 'ended', ended_at = ? WHERE id = ?`).bind(nowIso(), membershipId),
    env.DB.prepare(`UPDATE employer_entitlements SET status = 'revoked', updated_at = ? WHERE membership_id = ?`).bind(nowIso(), membershipId),
  ]);
  const reconciliation = await reconcileBusinessEntitlement(env, membership.revenuecat_app_user_id);
  await audit(env.DB, actor, 'employee.removed', 'membership', membershipId, actor.organisationId);
  return json({ ok: true, premium: reconciliation });
}

async function billingPortal(request, env) {
  const actor = await requireSession(request, env, ['organisation_admin']);
  const organisation = await env.DB.prepare(`SELECT * FROM organisations WHERE id = ?`).bind(actor.organisationId).first();
  if (!organisation?.stripe_customer_id) throw new HttpError(409, 'Billing is not available for this organisation.');
  const session = await createBillingPortalSession(env, organisation.stripe_customer_id, `${serviceOrigin(request)}/portal/`);
  return json({ url: session.url });
}

async function updateSeats(request, env) {
  const actor = await requireSession(request, env, ['organisation_admin']);
  const body = await parseJson(request);
  if (env.PAYMENTS_ENABLED !== 'true') throw new HttpError(503, 'Seat purchasing is not enabled in this environment.');
  const seats = Number(body.seats);
  if (!integer(seats, 20, 500)) throw new HttpError(422, 'Seat quantity must be between 20 and 500.');
  const subscription = await env.DB.prepare(`SELECT * FROM employer_subscriptions WHERE organisation_id = ? AND status IN ('active', 'payment_attention') ORDER BY created_at DESC LIMIT 1`)
    .bind(actor.organisationId).first();
  if (!subscription?.stripe_subscription_item_id) throw new HttpError(409, 'An active Stripe subscription is required.');
  const allocated = await env.DB.prepare(`SELECT
    (SELECT COUNT(*) FROM organisation_memberships WHERE organisation_id = ? AND status = 'active') +
    (SELECT COUNT(*) FROM employee_invitations WHERE organisation_id = ? AND status = 'pending' AND expires_at > ?) AS count`)
    .bind(actor.organisationId, actor.organisationId, nowIso()).first();
  if (seats < Number(allocated?.count || 0)) throw new HttpError(409, 'Remove employees or cancel pending invitations before reducing below reserved seats.');
  if (seats < Number(subscription.seats)) {
    // Reserve capacity before calling Stripe. Database triggers close the race
    // with invitations created after the initial allocation check.
    try {
      await env.DB.prepare(`UPDATE employer_subscriptions SET pending_seats = ?, updated_at = ? WHERE id = ?`)
        .bind(seats, nowIso(), subscription.id).run();
    } catch (error) {
      if (String(error).includes('seat limit')) throw new HttpError(409, 'Remove employees or cancel pending invitations before reducing below reserved seats.');
      throw error;
    }
    try { await scheduleSubscriptionQuantity(env, subscription.stripe_subscription_id, seats); }
    catch (error) {
      await env.DB.prepare(`UPDATE employer_subscriptions SET pending_seats = ?, updated_at = ? WHERE id = ? AND pending_seats = ?`)
        .bind(subscription.pending_seats, nowIso(), subscription.id, seats).run();
      throw error;
    }
  } else {
    await updateSubscriptionQuantity(env, subscription.stripe_subscription_item_id, seats);
    await env.DB.prepare(`UPDATE employer_subscriptions SET pending_seats = NULL, updated_at = ? WHERE id = ?`).bind(nowIso(), subscription.id).run();
  }
  await audit(env.DB, actor, 'subscription.seats.requested', 'employer_subscription', subscription.id, actor.organisationId, { seats });
  return json({ ok: true, effective: seats < Number(subscription.seats) ? 'renewal' : 'after_payment_confirmation', pendingWebhookConfirmation: true });
}

async function checkout(request, env) {
  if (env.PAYMENTS_ENABLED !== 'true') throw new HttpError(503, 'Online purchasing is not enabled in this environment.');
  await enforceRateLimit(request, env, 'checkout_creation', 5, 600);
  const body = await parseJson(request);
  if (!(await verifyTurnstile(request, env, clean(body.turnstileToken, 2048), 'checkout_creation'))) throw new HttpError(403, 'Please complete the security check.');
  const order = {
    id: id('ord'), company_name: clean(body.companyName, 120), company_website: normaliseWebsite(body.companyWebsite),
    billing_email: email(body.billingEmail), contact_name: clean(body.contactName, 120), seats: Number(body.seats),
  };
  if (body.organisationId) {
    const actor = await requireSession(request, env, ['organisation_admin']);
    if (actor.organisationId !== body.organisationId) throw new HttpError(403, 'This organisation is not available to your account.');
    const organisation = await env.DB.prepare(`SELECT * FROM organisations WHERE id = ?`).bind(actor.organisationId).first();
    if (organisation?.plan_type !== 'pilot') throw new HttpError(409, 'Use the billing portal to manage your existing subscription.');
    Object.assign(order, { organisation_id: organisation.id, company_name: organisation.name,
      company_website: organisation.website, billing_email: actor.email });
  } else {
    // Ended pilots and ended subscriptions should not permanently block a new
    // purchase for the same billing contact. Active organisations still need
    // to manage upgrades or renewals through their employer portal.
    const existing = await env.DB.prepare(`SELECT oa.organisation_id FROM organisation_admins oa
      JOIN organisations o ON o.id = oa.organisation_id
      WHERE oa.email = ? AND oa.status = 'active' AND o.status = 'active' LIMIT 1`).bind(order.billing_email).first();
    if (existing) throw new HttpError(409, 'Sign in to your employer portal to upgrade or manage your existing organisation.');
  }
  if (!order.company_name || order.company_website === null || !validEmail(order.billing_email) || !order.contact_name || !integer(order.seats, 20, 500)) throw new HttpError(422, 'Please check the order details.');
  const price = priceAnnual(order.seats);
  if (price.provisional) throw new HttpError(409, 'Pricing above 500 seats requires commercial approval.');
  Object.assign(order, { unit_amount_ex_vat: price.unitExVat, subtotal_ex_vat: price.subtotalExVat, discount_bps: price.discountBps, pricing_version: price.pricingVersion });
  const requestKey = clean(body.clientRequestId, 100) || crypto.randomUUID();
  if (!/^[a-zA-Z0-9_-]{16,100}$/.test(requestKey)) throw new HttpError(422, 'Please reload the order form and try again.');
  const prior = await env.DB.prepare(`SELECT * FROM checkout_orders WHERE request_key = ?`).bind(requestKey).first();
  if (prior) {
    if (prior.billing_email !== order.billing_email || prior.seats !== order.seats || prior.company_name !== order.company_name) throw new HttpError(409, 'The order details have changed. Reload the form to start a new order.');
    if (prior.stripe_checkout_session_id) {
      const existing = await retrieveStripeResource(env, `/checkout/sessions/${encodeURIComponent(prior.stripe_checkout_session_id)}`);
      if (existing.status === 'open') return json({ checkoutUrl: existing.url, orderId: prior.id });
      throw new HttpError(409, 'This checkout has finished. Sign in to your employer portal or start a new order.');
    }
    Object.assign(order, prior);
  }
  const now = nowIso();
  if (!prior) await env.DB.prepare(`INSERT INTO checkout_orders
    (id, company_name, company_website, billing_email, contact_name, seats, unit_amount_ex_vat, subtotal_ex_vat, discount_bps, pricing_version, created_at, updated_at, request_key, organisation_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(order.id, order.company_name, order.company_website, order.billing_email, order.contact_name, order.seats, order.unit_amount_ex_vat,
      order.subtotal_ex_vat, order.discount_bps, order.pricing_version, now, now, requestKey, order.organisation_id || null).run();
  const session = await createCheckoutSession(env, order, `${serviceOrigin(request)}/checkout-success/?session_id={CHECKOUT_SESSION_ID}`, `${serviceOrigin(request)}/buy/?seats=${order.seats}`);
  await env.DB.prepare(`UPDATE checkout_orders SET stripe_checkout_session_id = ?, status = 'checkout_created', updated_at = ? WHERE id = ?`).bind(session.id, nowIso(), order.id).run();
  return json({ checkoutUrl: session.url, orderId: order.id });
}

async function stripeWebhook(request, env) {
  const raw = await request.text();
  if (!(await verifyStripeWebhook(raw, request.headers.get('Stripe-Signature'), env.STRIPE_WEBHOOK_SECRET))) throw new HttpError(400, 'Invalid Stripe signature.');
  const event = JSON.parse(raw);
  if (!event.id || !event.type || event.livemode === true && env.ENVIRONMENT !== 'production') throw new HttpError(400, 'Unexpected Stripe event.');
  const exists = await env.DB.prepare(`SELECT stripe_event_id, status FROM billing_events WHERE stripe_event_id = ?`).bind(event.id).first();
  if (exists?.status === 'completed') return json({ received: true, duplicate: true });
  const claimed = await env.DB.prepare(`INSERT INTO billing_events
    (stripe_event_id, event_type, payload, processed_at, status, attempts, event_created, processing_started_at)
    VALUES (?, ?, ?, ?, 'processing', 1, ?, ?)
    ON CONFLICT(stripe_event_id) DO UPDATE SET status = 'processing', attempts = attempts + 1,
      processing_started_at = excluded.processing_started_at, processing_error = NULL
    WHERE billing_events.status = 'failed' OR
      (billing_events.status = 'processing' AND billing_events.processing_started_at < ?)
    RETURNING stripe_event_id`)
    .bind(event.id, event.type, raw, nowIso(), Number(event.created || 0), nowIso(), new Date(Date.now() - 5 * 60000).toISOString()).first();
  if (!claimed) throw new HttpError(409, 'This Stripe event is already processing.');
  try {
    const object = event.data?.object || {};
    const orderId = object.metadata?.order_id || object.parent?.subscription_details?.metadata?.order_id;
    if (['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(event.type) && orderId) {
      const paid = object.payment_status !== 'unpaid';
      await env.DB.prepare(`UPDATE checkout_orders SET status = ?, stripe_checkout_session_id = ?, updated_at = ? WHERE id = ?`)
        .bind(paid ? 'checkout_completed' : 'checkout_pending_payment', object.id, nowIso(), orderId).run();
      if (paid && object.subscription) {
        const subscription = await retrieveStripeResource(env, `/subscriptions/${encodeURIComponent(object.subscription)}?expand[]=latest_invoice`);
        await upsertPaidSubscription(env, subscription, orderId, event.created);
      }
    }
    if (event.type === 'checkout.session.async_payment_failed' && orderId) {
      await env.DB.prepare(`UPDATE checkout_orders SET status = 'payment_failed', updated_at = ? WHERE id = ?`).bind(nowIso(), orderId).run();
    }
    if (event.type.startsWith('customer.subscription.') || ['invoice.paid', 'invoice.payment_failed'].includes(event.type)) {
      const subscriptionId = event.type.startsWith('customer.subscription.') ? object.id : stripeSubscriptionIdFromInvoice(object);
      if (subscriptionId) {
        const subscription = await retrieveStripeResource(env, `/subscriptions/${encodeURIComponent(subscriptionId)}?expand[]=latest_invoice`);
        const existingOrder = await env.DB.prepare(`SELECT co.id FROM checkout_orders co JOIN employer_subscriptions es
          ON co.organisation_id = es.organisation_id WHERE es.stripe_subscription_id = ? ORDER BY co.created_at DESC LIMIT 1`).bind(subscriptionId).first();
        const resolvedOrderId = existingOrder?.id || subscription.metadata?.order_id;
        if (resolvedOrderId) await upsertPaidSubscription(env, subscription, resolvedOrderId, event.created);
      }
    }
    if (['charge.dispute.created', 'charge.refunded', 'radar.early_fraud_warning.created'].includes(event.type)) {
      await recordStripeRiskEvent(env, event, object, raw);
    }
    await env.DB.prepare(`UPDATE billing_events SET status = 'completed', processed_at = ?, processing_error = NULL WHERE stripe_event_id = ?`).bind(nowIso(), event.id).run();
    return json({ received: true });
  } catch (error) {
    await env.DB.prepare(`UPDATE billing_events SET status = 'failed', processing_error = ? WHERE stripe_event_id = ?`).bind(clean(error.message, 1000), event.id).run();
    throw error;
  }
}

async function recordStripeRiskEvent(env, event, object, raw) {
  let charge = event.type === 'charge.refunded' ? object : null;
  const chargeId = charge?.id || object.charge;
  if (!charge && chargeId) charge = await retrieveStripeResource(env, `/charges/${encodeURIComponent(chargeId)}`);
  let subscriptionId = null;
  if (charge?.invoice) {
    const invoiceId = typeof charge.invoice === 'string' ? charge.invoice : charge.invoice.id;
    const invoice = await retrieveStripeResource(env, `/invoices/${encodeURIComponent(invoiceId)}`);
    subscriptionId = stripeSubscriptionIdFromInvoice(invoice);
  }
  const customerId = typeof charge?.customer === 'string' ? charge.customer : charge?.customer?.id || null;
  await env.DB.prepare(`INSERT OR IGNORE INTO stripe_risk_events
    (stripe_event_id, event_type, stripe_object_id, stripe_customer_id, stripe_subscription_id, payload, occurred_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(event.id, event.type, object.id || null, customerId, subscriptionId, raw,
      new Date(Number(event.created || 0) * 1000).toISOString(), nowIso()).run();
  const row = await env.DB.prepare(`SELECT o.name FROM employer_subscriptions es JOIN organisations o ON o.id = es.organisation_id
    WHERE es.stripe_subscription_id = ? OR es.stripe_customer_id = ? LIMIT 1`).bind(subscriptionId, customerId).first();
  if (env.PARTNERSHIPS_EMAIL) await queueEmail(env, 'stripe_risk_alert', env.PARTNERSHIPS_EMAIL,
    templates.stripeRiskAlert(row?.name || 'an unknown organisation', event.type, object.id));
}

async function upsertPaidSubscription(env, subscription, orderId, stripeEventCreated = 0) {
  return persistSubscription(env, subscription, orderId, stripeEventCreated);
}

async function lifecycle(env) {
  const now = nowIso();
  await enforcePaidLifecycle(env);
  await env.DB.prepare(`UPDATE employee_invitations SET status = 'expired' WHERE status = 'pending' AND expires_at <= ?`).bind(now).run();
  const upgradeLink = `${appOrigin(env)}/business/#pricing`;
  for (const days of [7, 3]) {
    const start = new Date(Date.now() + days * 86400000).toISOString();
    const end = new Date(Date.now() + (days + 1) * 86400000).toISOString();
    const reminders = await env.DB.prepare(`SELECT o.id, o.name, oa.email FROM organisations o
      JOIN organisation_admins oa ON oa.organisation_id = o.id AND oa.status = 'active'
      WHERE o.status = 'active' AND o.plan_type = 'pilot' AND o.expires_at >= ? AND o.expires_at < ?`).bind(start, end).all();
    for (const organisation of reminders.results || []) {
      try {
        await env.DB.prepare(`INSERT INTO lifecycle_notifications (organisation_id, notification_type, queued_at) VALUES (?, ?, ?)`)
          .bind(organisation.id, `pilot_expiring_${days}`, now).run();
        await queueEmail(env, `pilot_expiring_${days}`, organisation.email, templates.pilotExpiring(organisation.name, days, upgradeLink));
      } catch (error) {
        if (!String(error).includes('UNIQUE')) throw error;
      }
    }
  }
  const expiring = await env.DB.prepare(`SELECT * FROM organisations WHERE status = 'active' AND plan_type = 'pilot' AND expires_at <= ?`).bind(now).all();
  let ended = 0;
  for (const organisation of expiring.results || []) {
    const users = await env.DB.prepare(`SELECT DISTINCT revenuecat_app_user_id FROM employer_entitlements WHERE organisation_id = ? AND status = 'active'`).bind(organisation.id).all();
    await env.DB.batch([
      env.DB.prepare(`UPDATE organisations SET status = 'expired', updated_at = ? WHERE id = ?`).bind(now, organisation.id),
      env.DB.prepare(`UPDATE employer_entitlements SET status = 'expired', updated_at = ? WHERE organisation_id = ? AND status = 'active'`).bind(now, organisation.id),
    ]);
    for (const user of users.results || []) await reconcileBusinessEntitlement(env, user.revenuecat_app_user_id);
    const admin = await env.DB.prepare(`SELECT email FROM organisation_admins WHERE organisation_id = ? AND status = 'active' LIMIT 1`).bind(organisation.id).first();
    if (admin) {
      try {
        await env.DB.prepare(`INSERT INTO lifecycle_notifications (organisation_id, notification_type, queued_at) VALUES (?, 'pilot_expired', ?)`).bind(organisation.id, now).run();
        await queueEmail(env, 'pilot_expired', admin.email, templates.pilotExpired(organisation.name, upgradeLink));
      } catch (error) {
        if (!String(error).includes('UNIQUE')) throw error;
      }
    }
    ended += 1;
  }
  const retries = await env.DB.prepare(`SELECT DISTINCT revenuecat_app_user_id FROM employer_entitlements WHERE provision_status IN ('pending', 'failed') LIMIT 100`).all();
  for (const user of retries.results || []) {
    try { await reconcileBusinessEntitlement(env, user.revenuecat_app_user_id); } catch { /* Retry next run. */ }
  }
  const emailResult = await flushEmailOutbox(env);
  const retention = await runRetention(env);
  return { ended, email: emailResult, retention };
}

async function route(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/$/, '') || '/';
  const signedWebhook = request.method === 'POST' && ['/v1/webhooks/stripe', '/v1/webhooks/resend'].includes(path);
  const preparationRoute = path.startsWith('/v1/admin/') || path === '/v1/auth/consume';
  if (env.ENVIRONMENT === 'production' && env.LAUNCH_ENABLED !== 'true' && path.startsWith('/v1/') && path !== '/v1/public-config' && !signedWebhook && !preparationRoute) {
    throw new HttpError(503, 'SparkFit Business is being prepared for launch. Please contact partnerships@spark-fit.com.');
  }
  if (request.method === 'GET' && path === '/health') return json({ ok: true, environment: env.ENVIRONMENT, paymentsEnabled: env.PAYMENTS_ENABLED === 'true', revenueCatWritesEnabled: env.REVENUECAT_WRITES_ENABLED === 'true', emailEnabled: env.EMAIL_ENABLED === 'true' });
  if (request.method === 'GET' && path === '/v1/public-config') return json({
    testMode: env.ENVIRONMENT !== 'production',
    paymentsEnabled: env.PAYMENTS_ENABLED === 'true',
    turnstileRequired: env.TURNSTILE_REQUIRED === 'true',
    turnstileSiteKey: env.TURNSTILE_SITE_KEY || '',
    requireAppAccountForBusiness: env.REQUIRE_APP_ACCOUNT_FOR_BUSINESS === 'true',
  });
  if (request.method === 'GET' && path === '/v1/checkout/status') {
    const sessionId = clean(url.searchParams.get('session_id'), 200);
    if (!sessionId.startsWith('cs_')) throw new HttpError(422, 'The checkout reference is invalid.');
    const order = await env.DB.prepare(`SELECT status, organisation_id FROM checkout_orders WHERE stripe_checkout_session_id = ?`).bind(sessionId).first();
    if (!order) throw new HttpError(404, 'The checkout reference was not found.');
    return json({ status: order.status, ready: order.status === 'subscription_created', signInUrl: `${serviceOrigin(request)}/sign-in/` });
  }
  if (request.method === 'POST' && path === '/v1/app-auth/request') {
    await enforceRateLimit(request, env, 'app_auth_request', 5, 600);
    return json(await requestAppVerification(request, env, serviceOrigin(request)));
  }
  if (request.method === 'GET' && path === '/v1/app-auth/verify') {
    const target = await verifyAppEmail(env, clean(url.searchParams.get('token'), 200), serviceOrigin(request));
    return new Response(null, { status: 302, headers: { Location: target, 'Cache-Control': 'no-store' } });
  }
  if (request.method === 'POST' && path === '/v1/app-auth/exchange') {
    const body = await parseJson(request);
    return json(await exchangeAppVerification(env, clean(body.exchangeToken, 200)));
  }
  if (request.method === 'GET' && path === '/v1/app-auth/me') {
    const account = await requireAppSession(request, env);
    return json({ account: { id: account.id, email: account.primary_email, emailVerifiedAt: account.email_verified_at, legacyRevenueCatAppUserId: account.legacy_revenuecat_app_user_id } });
  }
  if (request.method === 'POST' && path === '/v1/app-auth/logout') {
    await revokeAppSession(request, env);
    return json({ ok: true });
  }
  if (request.method === 'POST' && path === '/v1/pilot-applications') return pilotApplication(request, env);
  if (request.method === 'POST' && path === '/v1/auth/request') return requestSignIn(request, env);
  if (request.method === 'POST' && path === '/v1/admin/auth/request') return requestSignIn(request, env, 'admin');
  if (['GET', 'POST'].includes(request.method) && path === '/v1/auth/consume') return consumeSignIn(request, env);
  if (request.method === 'GET' && path === '/v1/admin/pilot-applications') return listPilots(request, env);
  if (request.method === 'GET' && path === '/v1/admin/dashboard') return adminDashboard(request, env);
  if (request.method === 'POST' && path === '/v1/admin/first-live-checkout') return prepareFirstLiveCheckout(request, env);
  const pilotMatch = path.match(/^\/v1\/admin\/pilot-applications\/([^/]+)\/decision$/);
  if (request.method === 'POST' && pilotMatch) return decidePilot(request, env, pilotMatch[1]);
  const organisationActionMatch = path.match(/^\/v1\/admin\/organisations\/([^/]+)\/action$/);
  if (request.method === 'POST' && organisationActionMatch) return adminOrganisationAction(request, env, organisationActionMatch[1]);
  if (request.method === 'GET' && path === '/v1/portal/summary') return portalSummary(request, env);
  if (request.method === 'POST' && path === '/v1/portal/invitations') return createInvitation(request, env);
  const invitationMatch = path.match(/^\/v1\/portal\/invitations\/([^/]+)\/action$/);
  if (request.method === 'POST' && invitationMatch) return invitationAction(request, env, invitationMatch[1]);
  if (request.method === 'POST' && path === '/v1/employee-invitations/accept') return acceptInvitation(request, env);
  if (request.method === 'POST' && path === '/v1/app/employee-invitations/accept') return activateInvitationForAccount(request, env);
  const memberMatch = path.match(/^\/v1\/portal\/members\/([^/]+)\/remove$/);
  if (request.method === 'POST' && memberMatch) return removeMember(request, env, memberMatch[1]);
  if (request.method === 'POST' && path === '/v1/portal/billing-portal') return billingPortal(request, env);
  if (request.method === 'POST' && path === '/v1/portal/seats') return updateSeats(request, env);
  if (request.method === 'POST' && path === '/v1/checkout/sessions') return checkout(request, env);
  if (request.method === 'POST' && path === '/v1/webhooks/stripe') return stripeWebhook(request, env);
  if (request.method === 'POST' && path === '/v1/webhooks/resend') return emailWebhook(request, env);
  if (['GET', 'HEAD'].includes(request.method) && env.ASSETS) return env.ASSETS.fetch(request);
  throw new HttpError(404, 'Route not found.');
}

export default {
  async fetch(request, env, ctx) {
    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    try {
      const origin = request.headers.get('Origin');
      const allowed = new Set([env.PUBLIC_APP_ORIGIN, env.SERVICE_ORIGIN, new URL(request.url).origin]);
      if (env.ENVIRONMENT !== 'production') { allowed.add('http://localhost:4173'); allowed.add('http://127.0.0.1:4173'); }
      const sameOriginSignInPost = request.method === 'POST'
        && new URL(request.url).pathname === '/v1/auth/consume'
        && request.headers.get('Sec-Fetch-Site') === 'same-origin';
      if (!['GET', 'HEAD'].includes(request.method) && origin && !allowed.has(origin) && !sameOriginSignInPost) {
        throw new HttpError(403, 'This request origin is not allowed.');
      }
      const response = await route(request, env);
      if (ctx?.waitUntil && request.method === 'POST') ctx.waitUntil(flushEmailOutbox(env).catch(() => {}));
      const headers = new Headers(response.headers);
      for (const [key, value] of Object.entries(cors)) headers.set(key, value);
      headers.set('Referrer-Policy', 'no-referrer');
      headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    } catch (error) {
      console.error('request_failed', { message: error.message, path: new URL(request.url).pathname });
      const limited = error instanceof HttpError && error.status === 429;
      const retryAfterSeconds = limited ? Math.max(1, Number(error.retryAfterSeconds || 60)) : 0;
      return json({ error: error instanceof HttpError ? error.message : 'The service could not complete this request.', ...(limited ? { retryAfterSeconds } : {}) }, error instanceof HttpError ? error.status : 500, { ...cors, ...(limited ? { 'Retry-After': String(retryAfterSeconds) } : {}) });
    }
  },
  async scheduled(_controller, env, ctx) { ctx.waitUntil(lifecycle(env)); },
};

export { lifecycle, pilotApplication, acceptInvitation, upsertPaidSubscription };
