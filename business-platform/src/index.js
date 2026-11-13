import { audit, clean, corsHeaders, email, HttpError, id, integer, isoAfterDays, json, nowIso, parseJson, randomToken, sha256, validEmail, verifyTurnstile } from './lib.js';
import { consumeMagicLink, issueMagicLink, requireSession } from './auth.js';
import { flushEmailOutbox, queueEmail, templates } from './email.js';
import { priceAnnual } from './pricing.js';
import { reconcileBusinessEntitlement } from './revenuecat.js';
import { createBillingPortalSession, createCheckoutSession, normaliseSubscriptionStatus, updateSubscriptionQuantity, verifyStripeWebhook } from './stripe.js';

const adminEmails = (env) => new Set(String(env.ADMIN_EMAILS || '').split(',').map(email).filter(Boolean));
const appOrigin = (env) => env.PUBLIC_APP_ORIGIN || 'https://spark-fit.com';
const serviceOrigin = (request) => new URL(request.url).origin;

async function pilotApplication(request, env) {
  const body = await parseJson(request);
  if (clean(body.website, 200)) return json({ ok: true });
  if (!(await verifyTurnstile(request, env, clean(body.turnstileToken, 2048)))) throw new HttpError(403, 'Please complete the security check.');
  const application = {
    id: id('pilot'),
    companyName: clean(body.companyName, 120),
    companyWebsite: clean(body.companyWebsite, 300),
    contactName: clean(body.contactName, 120),
    jobTitle: clean(body.jobTitle, 120),
    businessEmail: email(body.businessEmail),
    companySize: Number(body.companySize),
    requestedSeats: Number(body.requestedSeats),
    message: clean(body.message, 2000),
    marketingConsent: body.marketingConsent === true ? 1 : 0,
  };
  if (!application.companyName || !/^https:\/\//i.test(application.companyWebsite) || !application.contactName || !application.jobTitle
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

async function requestSignIn(request, env) {
  const body = await parseJson(request);
  const address = email(body.email);
  if (!validEmail(address)) throw new HttpError(422, 'Enter a valid business email.');
  let role = null;
  let organisationId = null;
  if (adminEmails(env).has(address)) role = 'sparkfit_admin';
  else {
    const admin = await env.DB.prepare(`SELECT email, organisation_id, role FROM organisation_admins WHERE email = ? AND status = 'active'`).bind(address).first();
    if (admin) { role = admin.role; organisationId = admin.organisation_id; }
  }
  // Always return the same response to prevent account enumeration.
  if (!role) return json({ ok: true });
  const token = await issueMagicLink(env, address, role, organisationId);
  const link = `${new URL(request.url).origin}/v1/auth/consume?token=${encodeURIComponent(token)}`;
  await queueEmail(env, 'magic_link', address, { subject: 'Your secure SparkFit Partnerships sign-in link', text: `Use this one-time link within 30 minutes:\n\n${link}` });
  return json({ ok: true, ...(env.ENVIRONMENT === 'test' ? { testToken: token } : {}) });
}

async function consumeSignIn(request, env) {
  const token = clean(new URL(request.url).searchParams.get('token'), 200);
  const result = await consumeMagicLink(env, token);
  const target = result.session.role === 'sparkfit_admin' ? '/admin/' : '/portal/';
  return new Response(null, { status: 302, headers: { Location: `${serviceOrigin(request)}${target}`, 'Set-Cookie': result.cookie, 'Cache-Control': 'no-store' } });
}

async function adminDashboard(request, env) {
  await requireSession(request, env, ['sparkfit_admin']);
  const [applicationCounts, organisationCounts, seats, failed, audits] = await Promise.all([
    env.DB.prepare(`SELECT status, COUNT(*) AS count FROM pilot_applications GROUP BY status`).all(),
    env.DB.prepare(`SELECT plan_type, status, COUNT(*) AS count FROM organisations GROUP BY plan_type, status`).all(),
    env.DB.prepare(`SELECT COALESCE(SUM(seat_limit), 0) AS purchased,
      (SELECT COUNT(*) FROM organisation_memberships WHERE status = 'active') AS allocated FROM organisations WHERE status = 'active'`).first(),
    env.DB.prepare(`SELECT COUNT(*) AS count FROM employer_entitlements WHERE provision_status = 'failed'`).first(),
    env.DB.prepare(`SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 50`).all(),
  ]);
  const paid = await env.DB.prepare(`SELECT COUNT(*) AS organisations, COALESCE(SUM(seats), 0) AS seats,
    COALESCE(SUM(co.unit_amount_ex_vat * es.seats), 0) AS arr_pence
    FROM employer_subscriptions es LEFT JOIN checkout_orders co ON co.organisation_id = es.organisation_id
    WHERE es.status = 'active'`).first();
  return json({ applications: applicationCounts.results || [], organisations: organisationCounts.results || [], seats, paid, failedProvisioning: Number(failed?.count || 0), audits: audits.results || [] });
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
  const actor = await requireSession(request, env, ['organisation_admin', 'sparkfit_admin']);
  const requestedOrg = clean(new URL(request.url).searchParams.get('organisationId'), 100);
  const organisationId = actor.role === 'sparkfit_admin' ? requestedOrg : actor.organisationId;
  if (!organisationId) throw new HttpError(422, 'Organisation is required.');
  const organisation = await env.DB.prepare(`SELECT * FROM organisations WHERE id = ?`).bind(organisationId).first();
  if (!organisation) throw new HttpError(404, 'Organisation not found.');
  const [members, invites, subscription] = await Promise.all([
    env.DB.prepare(`SELECT id, email, status, joined_at, ended_at FROM organisation_memberships WHERE organisation_id = ? ORDER BY joined_at DESC`).bind(organisationId).all(),
    env.DB.prepare(`SELECT id, email, status, delivery_status, expires_at, last_sent_at, created_at FROM employee_invitations WHERE organisation_id = ? ORDER BY created_at DESC`).bind(organisationId).all(),
    env.DB.prepare(`SELECT * FROM employer_subscriptions WHERE organisation_id = ? ORDER BY created_at DESC LIMIT 1`).bind(organisationId).first(),
  ]);
  const activeCount = (members.results || []).filter((row) => row.status === 'active').length;
  const pendingCount = (invites.results || []).filter((row) => row.status === 'pending' && new Date(row.expires_at) > new Date()).length;
  return json({ organisation, subscription, seats: { purchased: organisation.seat_limit, active: activeCount, pending: pendingCount, allocated: activeCount + pendingCount, available: Math.max(0, organisation.seat_limit - activeCount - pendingCount) }, members: members.results || [], invitations: invites.results || [] });
}

async function createInvitation(request, env) {
  const actor = await requireSession(request, env, ['organisation_admin']);
  const body = await parseJson(request);
  const recipient = email(body.email);
  if (!validEmail(recipient)) throw new HttpError(422, 'Enter a valid employee email.');
  const organisation = await env.DB.prepare(`SELECT * FROM organisations WHERE id = ? AND status = 'active'`).bind(actor.organisationId).first();
  if (!organisation) throw new HttpError(409, 'The organisation is not active.');
  const capacity = await env.DB.prepare(`SELECT
    (SELECT COUNT(*) FROM organisation_memberships WHERE organisation_id = ? AND status = 'active') AS active,
    (SELECT COUNT(*) FROM employee_invitations WHERE organisation_id = ? AND status = 'pending' AND expires_at > ?) AS pending`)
    .bind(actor.organisationId, actor.organisationId, nowIso()).first();
  if (Number(capacity?.active || 0) + Number(capacity?.pending || 0) >= organisation.seat_limit) throw new HttpError(409, 'No employee seats are available. Pending invitations also reserve seats.');
  const token = randomToken();
  const invitationId = id('inv');
  const expiresAt = isoAfterDays(7);
  try {
    const createdAt = nowIso();
    await env.DB.prepare(`INSERT INTO employee_invitations (id, organisation_id, email, token_hash, expires_at, created_by, created_at, last_sent_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(invitationId, actor.organisationId, recipient, await sha256(token), expiresAt, actor.email, createdAt, createdAt).run();
  } catch (error) {
    if (String(error).includes('seat limit')) throw new HttpError(409, 'No employee seats are available. Pending invitations also reserve seats.');
    throw new HttpError(409, 'This employee already has an invitation for the organisation.');
  }
  const link = `${serviceOrigin(request)}/employee-access/?token=${encodeURIComponent(token)}`;
  await queueEmail(env, 'employee_invitation', recipient, { ...templates.employeeInvite(organisation.name, link), invitationId });
  await audit(env.DB, actor, 'employee.invited', 'employee_invitation', invitationId, actor.organisationId, { recipient });
  return json({ ok: true, invitationId, expiresAt }, 201);
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
    await audit(env.DB, actor, 'employee.invitation.resent', 'employee_invitation', invitationId, actor.organisationId);
    return json({ ok: true, status: 'pending', expiresAt });
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
    await audit(env.DB, actor, 'employee.invitation.corrected', 'employee_invitation', invitationId, actor.organisationId, { previousEmail: invitation.email, correctedEmail: corrected });
    return json({ ok: true, status: 'pending', email: corrected, expiresAt });
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
  const body = await parseJson(request);
  const token = clean(body.token, 200);
  const tokenHash = await sha256(token);
  const invitation = await env.DB.prepare(`SELECT i.*, o.plan_type, o.expires_at AS organisation_expires_at, o.status AS organisation_status
    FROM employee_invitations i JOIN organisations o ON o.id = i.organisation_id
    WHERE i.token_hash = ? AND i.status = 'pending' AND i.expires_at > ?`).bind(tokenHash, nowIso()).first();
  if (!invitation || invitation.organisation_status !== 'active') throw new HttpError(410, 'This invitation is invalid or expired.');
  // Current SparkFit releases identify RevenueCat customers by normalised onboarding email.
  // The email comes only from the server-side invitation record after possession of the
  // one-time emailed token has been proven. No client-supplied RevenueCat ID is accepted.
  const appUserId = invitation.email;
  const accountHash = await sha256(`sparkfit-account:${invitation.email}`);
  const sparkfitAccountId = `acct_${accountHash.slice(0, 32)}`;
  const membershipId = id('mem');
  const entitlementId = id('ent');
  const now = nowIso();
  const expiry = invitation.organisation_expires_at;
  try {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO organisation_memberships (id, organisation_id, invitation_id, email, revenuecat_app_user_id, sparkfit_account_id, joined_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(membershipId, invitation.organisation_id, invitation.id, invitation.email, appUserId, sparkfitAccountId, now),
      env.DB.prepare(`INSERT INTO employer_entitlements (id, organisation_id, membership_id, revenuecat_app_user_id, source, status, starts_at, expires_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)`).bind(entitlementId, invitation.organisation_id, membershipId, appUserId, invitation.plan_type, now, expiry, now),
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
  await updateSubscriptionQuantity(env, subscription.stripe_subscription_item_id, seats);
  await audit(env.DB, actor, 'subscription.seats.requested', 'employer_subscription', subscription.id, actor.organisationId, { seats });
  return json({ ok: true, pendingWebhookConfirmation: true });
}

async function checkout(request, env) {
  const body = await parseJson(request);
  const order = {
    id: id('ord'), company_name: clean(body.companyName, 120), company_website: clean(body.companyWebsite, 300),
    billing_email: email(body.billingEmail), contact_name: clean(body.contactName, 120), seats: Number(body.seats),
  };
  if (!order.company_name || !validEmail(order.billing_email) || !order.contact_name || !integer(order.seats, 20, 1000)) throw new HttpError(422, 'Please check the order details.');
  const price = priceAnnual(order.seats);
  if (price.provisional) throw new HttpError(409, 'Pricing above 500 seats requires commercial approval.');
  Object.assign(order, { unit_amount_ex_vat: price.unitExVat, subtotal_ex_vat: price.subtotalExVat, discount_bps: price.discountBps, pricing_version: price.pricingVersion });
  const now = nowIso();
  await env.DB.prepare(`INSERT INTO checkout_orders
    (id, company_name, company_website, billing_email, contact_name, seats, unit_amount_ex_vat, subtotal_ex_vat, discount_bps, pricing_version, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(order.id, order.company_name, order.company_website, order.billing_email, order.contact_name, order.seats, order.unit_amount_ex_vat,
      order.subtotal_ex_vat, order.discount_bps, order.pricing_version, now, now).run();
  const session = await createCheckoutSession(env, order, `${appOrigin(env)}/business/checkout-success/?session_id={CHECKOUT_SESSION_ID}`, `${appOrigin(env)}/business/#pricing`);
  await env.DB.prepare(`UPDATE checkout_orders SET stripe_checkout_session_id = ?, status = 'checkout_created', updated_at = ? WHERE id = ?`).bind(session.id, nowIso(), order.id).run();
  return json({ checkoutUrl: session.url, orderId: order.id });
}

async function stripeWebhook(request, env) {
  const raw = await request.text();
  if (!(await verifyStripeWebhook(raw, request.headers.get('Stripe-Signature'), env.STRIPE_WEBHOOK_SECRET))) throw new HttpError(400, 'Invalid Stripe signature.');
  const event = JSON.parse(raw);
  const exists = await env.DB.prepare(`SELECT stripe_event_id, status FROM billing_events WHERE stripe_event_id = ?`).bind(event.id).first();
  if (exists?.status === 'completed') return json({ received: true, duplicate: true });
  if (!exists) {
    await env.DB.prepare(`INSERT INTO billing_events (stripe_event_id, event_type, payload, processed_at, status, attempts) VALUES (?, ?, ?, ?, 'processing', 1)`)
      .bind(event.id, event.type, raw, nowIso()).run();
  } else {
    await env.DB.prepare(`UPDATE billing_events SET status = 'processing', attempts = attempts + 1, processing_error = NULL WHERE stripe_event_id = ?`).bind(event.id).run();
  }
  try {
    const object = event.data?.object || {};
    const orderId = object.metadata?.order_id || object.parent?.subscription_details?.metadata?.order_id;
    if (event.type === 'checkout.session.completed' && orderId) {
      await env.DB.prepare(`UPDATE checkout_orders SET status = 'checkout_completed', stripe_checkout_session_id = ?, updated_at = ? WHERE id = ?`)
        .bind(object.id, nowIso(), orderId).run();
    }
    if (event.type.startsWith('customer.subscription.') && orderId) await upsertPaidSubscription(env, object, orderId);
    if (event.type === 'invoice.payment_failed') {
      await env.DB.prepare(`UPDATE employer_subscriptions SET status = 'payment_attention', updated_at = ? WHERE stripe_subscription_id = ?`).bind(nowIso(), object.subscription).run();
      const row = await env.DB.prepare(`SELECT o.name, oa.email FROM employer_subscriptions es JOIN organisations o ON o.id = es.organisation_id
        JOIN organisation_admins oa ON oa.organisation_id = o.id AND oa.status = 'active' WHERE es.stripe_subscription_id = ? LIMIT 1`).bind(object.subscription).first();
      if (row) await queueEmail(env, 'employer_payment_failed', row.email, templates.paymentFailed(row.name));
    }
    if (event.type === 'invoice.paid') {
      const row = await env.DB.prepare(`SELECT o.name, oa.email FROM employer_subscriptions es JOIN organisations o ON o.id = es.organisation_id
        JOIN organisation_admins oa ON oa.organisation_id = o.id AND oa.status = 'active' WHERE es.stripe_subscription_id = ? LIMIT 1`).bind(object.subscription).first();
      if (row) await queueEmail(env, 'employer_payment_successful', row.email, templates.paymentSuccessful(row.name));
    }
    await env.DB.prepare(`UPDATE billing_events SET status = 'completed', processed_at = ?, processing_error = NULL WHERE stripe_event_id = ?`).bind(nowIso(), event.id).run();
    return json({ received: true });
  } catch (error) {
    await env.DB.prepare(`UPDATE billing_events SET status = 'failed', processing_error = ? WHERE stripe_event_id = ?`).bind(clean(error.message, 1000), event.id).run();
    throw error;
  }
}

async function upsertPaidSubscription(env, subscription, orderId) {
  const order = await env.DB.prepare(`SELECT * FROM checkout_orders WHERE id = ?`).bind(orderId).first();
  if (!order) throw new Error(`Unknown checkout order ${orderId}`);
  let organisationId = order.organisation_id;
  const now = nowIso();
  const periodEnd = subscription.items?.data?.[0]?.current_period_end || subscription.current_period_end;
  if (!organisationId) {
    organisationId = id('org');
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO organisations (id, name, website, status, plan_type, seat_limit, starts_at, expires_at, stripe_customer_id, created_at, updated_at)
        VALUES (?, ?, ?, 'active', 'paid', ?, ?, ?, ?, ?, ?)`).bind(organisationId, order.company_name, order.company_website, order.seats, now, periodEnd ? new Date(periodEnd * 1000).toISOString() : null, subscription.customer, now, now),
      env.DB.prepare(`INSERT INTO organisation_admins (id, organisation_id, email, role, status, created_at) VALUES (?, ?, ?, 'organisation_admin', 'active', ?)`)
        .bind(id('oadm'), organisationId, order.billing_email, now),
      env.DB.prepare(`UPDATE checkout_orders SET organisation_id = ?, status = 'subscription_created', updated_at = ? WHERE id = ?`).bind(organisationId, now, orderId),
    ]);
  }
  const status = normaliseSubscriptionStatus(subscription.status);
  await env.DB.prepare(`INSERT INTO employer_subscriptions
    (id, organisation_id, stripe_customer_id, stripe_subscription_id, stripe_subscription_item_id, status, seats, current_period_end, cancel_at_period_end, updated_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(stripe_subscription_id) DO UPDATE SET status = excluded.status, seats = excluded.seats, current_period_end = excluded.current_period_end,
      cancel_at_period_end = excluded.cancel_at_period_end, updated_at = excluded.updated_at`)
    .bind(id('sub'), organisationId, subscription.customer, subscription.id, subscription.items?.data?.[0]?.id || null, status,
      Number(subscription.items?.data?.[0]?.quantity || order.seats), periodEnd ? new Date(periodEnd * 1000).toISOString() : null,
      subscription.cancel_at_period_end ? 1 : 0, now, now).run();
  await env.DB.prepare(`UPDATE organisations SET status = ?, seat_limit = ?, expires_at = ?, updated_at = ? WHERE id = ?`)
    .bind(status === 'active' ? 'active' : status, Number(subscription.items?.data?.[0]?.quantity || order.seats), periodEnd ? new Date(periodEnd * 1000).toISOString() : null, now, organisationId).run();
}

async function lifecycle(env) {
  const now = nowIso();
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
  const emailResult = await flushEmailOutbox(env);
  return { ended, email: emailResult };
}

async function route(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/$/, '') || '/';
  if (request.method === 'GET' && path === '/health') return json({ ok: true, environment: env.ENVIRONMENT, paymentsEnabled: env.PAYMENTS_ENABLED === 'true', revenueCatWritesEnabled: env.REVENUECAT_WRITES_ENABLED === 'true', emailEnabled: env.EMAIL_ENABLED === 'true' });
  if (request.method === 'POST' && path === '/v1/pilot-applications') return pilotApplication(request, env);
  if (request.method === 'POST' && path === '/v1/auth/request') return requestSignIn(request, env);
  if (request.method === 'GET' && path === '/v1/auth/consume') return consumeSignIn(request, env);
  if (request.method === 'GET' && path === '/v1/admin/pilot-applications') return listPilots(request, env);
  if (request.method === 'GET' && path === '/v1/admin/dashboard') return adminDashboard(request, env);
  const pilotMatch = path.match(/^\/v1\/admin\/pilot-applications\/([^/]+)\/decision$/);
  if (request.method === 'POST' && pilotMatch) return decidePilot(request, env, pilotMatch[1]);
  const organisationActionMatch = path.match(/^\/v1\/admin\/organisations\/([^/]+)\/action$/);
  if (request.method === 'POST' && organisationActionMatch) return adminOrganisationAction(request, env, organisationActionMatch[1]);
  if (request.method === 'GET' && path === '/v1/portal/summary') return portalSummary(request, env);
  if (request.method === 'POST' && path === '/v1/portal/invitations') return createInvitation(request, env);
  const invitationMatch = path.match(/^\/v1\/portal\/invitations\/([^/]+)\/action$/);
  if (request.method === 'POST' && invitationMatch) return invitationAction(request, env, invitationMatch[1]);
  if (request.method === 'POST' && path === '/v1/employee-invitations/accept') return acceptInvitation(request, env);
  const memberMatch = path.match(/^\/v1\/portal\/members\/([^/]+)\/remove$/);
  if (request.method === 'POST' && memberMatch) return removeMember(request, env, memberMatch[1]);
  if (request.method === 'POST' && path === '/v1/portal/billing-portal') return billingPortal(request, env);
  if (request.method === 'POST' && path === '/v1/portal/seats') return updateSeats(request, env);
  if (request.method === 'POST' && path === '/v1/checkout/sessions') return checkout(request, env);
  if (request.method === 'POST' && path === '/v1/webhooks/stripe') return stripeWebhook(request, env);
  if (['GET', 'HEAD'].includes(request.method) && env.ASSETS) return env.ASSETS.fetch(request);
  throw new HttpError(404, 'Route not found.');
}

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    try {
      const response = await route(request, env);
      const headers = new Headers(response.headers);
      for (const [key, value] of Object.entries(cors)) headers.set(key, value);
      headers.set('Referrer-Policy', 'no-referrer');
      headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    } catch (error) {
      console.error('request_failed', { message: error.message, path: new URL(request.url).pathname });
      return json({ error: error instanceof HttpError ? error.message : 'The service could not complete this request.' }, error instanceof HttpError ? error.status : 500, cors);
    }
  },
  async scheduled(_controller, env, ctx) { ctx.waitUntil(lifecycle(env)); },
};

export { lifecycle, pilotApplication, acceptInvitation, upsertPaidSubscription };
