import { HttpError, id, nowIso } from './lib.js';
import { reconcileBusinessEntitlement } from './revenuecat.js';
import { queueEmail, templates } from './email.js';
import { cancelStripeSubscription } from './stripe.js';

const iso = (seconds) => seconds ? new Date(seconds * 1000).toISOString() : null;

export function subscriptionAccess(subscription, previous = {}, now = Date.now()) {
  const periodEnd = subscription.items?.data?.[0]?.current_period_end || subscription.current_period_end;
  const invoice = subscription.latest_invoice;
  const invoicePaid = typeof invoice === 'object' && invoice !== null && (invoice.status === 'paid' || invoice.paid === true);
  const activePaid = subscription.status === 'active' && invoicePaid;
  const paidThrough = activePaid ? iso(periodEnd) : previous.paid_through || null;
  const failedAt = activePaid ? null : previous.payment_failed_at || (['past_due', 'unpaid'].includes(subscription.status) ? new Date(now).toISOString() : null);
  const graceEnd = failedAt ? previous.grace_ends_at || new Date(Date.parse(failedAt) + 14 * 86400000).toISOString() : null;
  const ended = ['canceled', 'incomplete_expired'].includes(subscription.status);
  const paidStillValid = paidThrough && Date.parse(paidThrough) > now;
  const inGrace = paidThrough && graceEnd && Date.parse(graceEnd) > now;
  const access = !ended && (activePaid || paidStillValid || inGrace);
  const expiresAt = access ? new Date(Math.max(Date.parse(paidThrough) || 0, inGrace ? Date.parse(graceEnd) : 0)).toISOString() : paidThrough;
  const status = ended ? 'ended' : activePaid ? 'active' : failedAt ? 'payment_attention' : 'pending';
  return { status, access: Boolean(access), paidThrough, failedAt, graceEnd, expiresAt, periodEnd: iso(periodEnd) };
}

export async function syncOrganisationAccess(env, organisationId, access, expiresAt, source = 'paid') {
  await env.DB.batch([
    env.DB.prepare(`UPDATE organisations SET status = ?, expires_at = ?, updated_at = ? WHERE id = ?`)
      .bind(access ? 'active' : 'suspended', expiresAt, nowIso(), organisationId),
    env.DB.prepare(`UPDATE employer_entitlements SET status = ?, expires_at = COALESCE(?, expires_at),
      source = ?, provision_status = 'pending', updated_at = ? WHERE organisation_id = ? AND status IN ('active', 'suspended', 'expired')
      AND membership_id IN (SELECT id FROM organisation_memberships WHERE status = 'active')
      AND (status != ? OR expires_at != COALESCE(?, expires_at))`)
      .bind(access ? 'active' : 'suspended', expiresAt, source, nowIso(), organisationId, access ? 'active' : 'suspended', expiresAt),
  ]);
  const users = await env.DB.prepare(`SELECT DISTINCT revenuecat_app_user_id FROM employer_entitlements WHERE organisation_id = ? AND provision_status != 'synced'`)
    .bind(organisationId).all();
  // Provisioning is a retryable side effect. A provider outage must not undo the billing ledger.
  for (const user of users.results || []) {
    try { await reconcileBusinessEntitlement(env, user.revenuecat_app_user_id); }
    catch { /* Failed rows are retried by the lifecycle task. */ }
  }
}

export async function persistSubscription(env, subscription, orderId, eventCreated = 0) {
  const order = await env.DB.prepare(`SELECT * FROM checkout_orders WHERE id = ?`).bind(orderId).first();
  if (!order) return; // Other integrations can share this Stripe account.
  const lockKey = order.organisation_id || `org_${order.id}`;
  const lockOwner = crypto.randomUUID();
  const locked = await env.DB.prepare(`INSERT INTO billing_locks (id, owner, expires_at) VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET owner = excluded.owner, expires_at = excluded.expires_at
    WHERE billing_locks.expires_at < ? RETURNING owner`)
    .bind(lockKey, lockOwner, Date.now() + 120000, Date.now()).first();
  if (!locked) throw new HttpError(409, 'Another billing event is updating this organisation. Please retry.');
  try {
  const previous = await env.DB.prepare(`SELECT * FROM employer_subscriptions WHERE stripe_subscription_id = ?`).bind(subscription.id).first();
  if (previous && Number(previous.stripe_event_created) > Number(eventCreated)) return;
  const now = nowIso();
  const organisationId = order.organisation_id || `org_${order.id}`;
  const customerId = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer.id;
  const state = subscriptionAccess(subscription, previous || {});
  const item = subscription.items?.data?.[0];
  const seats = Number(item?.quantity || order.seats);
  if (!Number.isInteger(seats) || seats < 20 || seats > 500) throw new Error('Stripe subscription seat count requires review.');
  await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO organisations
      (id, name, website, status, plan_type, seat_limit, starts_at, expires_at, stripe_customer_id, created_at, updated_at)
      VALUES (?, ?, ?, 'pending', 'paid', ?, ?, ?, ?, ?, ?)`)
      .bind(organisationId, order.company_name, order.company_website, seats, now, state.expiresAt, customerId, now, now),
    env.DB.prepare(`INSERT OR IGNORE INTO organisation_admins (id, organisation_id, email, role, status, created_at)
      VALUES (?, ?, ?, 'organisation_admin', 'active', ?)`).bind(id('oadm'), organisationId, order.billing_email, now),
    env.DB.prepare(`UPDATE checkout_orders SET organisation_id = ?, status = ?, updated_at = ? WHERE id = ?`)
      .bind(organisationId, state.access ? 'subscription_created' : 'payment_pending', now, orderId),
    env.DB.prepare(`INSERT INTO employer_subscriptions
      (id, organisation_id, stripe_customer_id, stripe_subscription_id, stripe_subscription_item_id, status, seats,
       current_period_end, cancel_at_period_end, stripe_event_created, paid_through, payment_failed_at, grace_ends_at,
       unit_amount_ex_vat, last_invoice_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(stripe_subscription_id) DO UPDATE SET
        status = excluded.status, seats = excluded.seats, current_period_end = excluded.current_period_end,
        cancel_at_period_end = excluded.cancel_at_period_end, stripe_event_created = excluded.stripe_event_created,
        paid_through = excluded.paid_through, payment_failed_at = excluded.payment_failed_at, grace_ends_at = excluded.grace_ends_at,
        unit_amount_ex_vat = excluded.unit_amount_ex_vat, last_invoice_id = excluded.last_invoice_id,
        pending_seats = CASE WHEN excluded.seats = employer_subscriptions.pending_seats THEN NULL ELSE employer_subscriptions.pending_seats END,
        updated_at = excluded.updated_at WHERE excluded.stripe_event_created >= employer_subscriptions.stripe_event_created`)
      .bind(id('sub'), organisationId, customerId, subscription.id, item?.id || null, state.status, seats,
        state.periodEnd, subscription.cancel_at_period_end ? 1 : 0, Number(eventCreated || 0), state.paidThrough,
        state.failedAt, state.graceEnd, item?.price?.unit_amount || order.unit_amount_ex_vat,
        typeof subscription.latest_invoice === 'string' ? subscription.latest_invoice : subscription.latest_invoice?.id || null, now, now),
    env.DB.prepare(`UPDATE organisations SET plan_type = 'paid', stripe_customer_id = ?, seat_limit = ?, updated_at = ? WHERE id = ?`)
      .bind(customerId, seats, now, organisationId),
  ]);
  await syncOrganisationAccess(env, organisationId, state.access, state.expiresAt);
  if (state.status === 'active' && (previous?.status !== 'active' || previous?.last_invoice_id !== subscription.latest_invoice?.id)) {
    await queueEmail(env, 'employer_payment_successful', order.billing_email,
      { ...templates.paymentSuccessful(order.company_name), actionUrl: `${env.SERVICE_ORIGIN || 'https://sparkfit-business-platform-staging.colbateson.workers.dev'}/sign-in/`, actionLabel: 'Open employer portal' },
      now, `invoice-paid:${subscription.latest_invoice?.id}`);
  }
  if (state.failedAt && !previous?.payment_failed_at) {
    const billingLink = `${env.SERVICE_ORIGIN || 'https://sparkfit-business-platform-staging.colbateson.workers.dev'}/portal/`;
    await queueEmail(env, 'employer_payment_failed', order.billing_email, templates.paymentFailed(order.company_name, billingLink), now,
      `payment-failed:${subscription.id}:${state.failedAt}`);
  }
  if (state.status === 'ended' && previous?.status !== 'ended') {
    await queueEmail(env, 'employer_subscription_cancelled', order.billing_email, templates.subscriptionCancelled(order.company_name), now,
      `subscription-ended:${subscription.id}`);
  }
  } finally {
    await env.DB.prepare(`DELETE FROM billing_locks WHERE id = ? AND owner = ?`).bind(lockKey, lockOwner).run();
  }
}

export async function enforcePaidLifecycle(env) {
  const rows = await env.DB.prepare(`SELECT * FROM employer_subscriptions WHERE status IN ('active', 'payment_attention', 'pending', 'ended')`).all();
  for (const row of rows.results || []) {
    const failureAt = row.payment_failed_at ? Date.parse(row.payment_failed_at) : NaN;
    const failedDays = Number.isFinite(failureAt) ? (Date.now() - failureAt) / 86400000 : -1;
    if (row.status === 'payment_attention' && failedDays >= 0 && failedDays < 30) {
      const reminderDay = [3, 7, 12].find((day) => failedDays >= day && failedDays < day + (10 / 1440));
      if (reminderDay) {
        const admin = await env.DB.prepare(`SELECT email FROM organisation_admins WHERE organisation_id = ? AND status = 'active' LIMIT 1`).bind(row.organisation_id).first();
        if (admin) {
          const billingLink = `${env.SERVICE_ORIGIN || 'https://business.spark-fit.com'}/portal/`;
          await queueEmail(env, 'employer_payment_failed_reminder', admin.email,
            templates.paymentFailedReminder('your organisation', reminderDay, billingLink), nowIso(),
            `payment-failed-reminder:${row.stripe_subscription_id}:${row.payment_failed_at}:${reminderDay}`);
        }
      }
    }
    if (row.status === 'payment_attention' && failedDays >= 30 && row.stripe_subscription_id) {
      await cancelStripeSubscription(env, row.stripe_subscription_id);
      await env.DB.prepare(`UPDATE employer_subscriptions SET status = 'ended', cancel_at_period_end = 0, updated_at = ? WHERE id = ? AND status = 'payment_attention'`)
        .bind(nowIso(), row.id).run();
      await env.DB.prepare(`UPDATE organisations SET status = 'suspended', updated_at = ? WHERE id = ?`).bind(nowIso(), row.organisation_id).run();
      const admin = await env.DB.prepare(`SELECT email FROM organisation_admins WHERE organisation_id = ? AND status = 'active' LIMIT 1`).bind(row.organisation_id).first();
      if (admin) await queueEmail(env, 'employer_subscription_cancelled', admin.email,
        templates.subscriptionCancelled('your organisation'), nowIso(), `subscription-ended-after-payment-failure:${row.stripe_subscription_id}`);
      await syncOrganisationAccess(env, row.organisation_id, false, row.paid_through);
      continue;
    }
    const paid = row.paid_through && Date.parse(row.paid_through) > Date.now();
    const grace = row.paid_through && row.grace_ends_at && Date.parse(row.grace_ends_at) > Date.now();
    const access = row.status !== 'ended' && Boolean(paid || grace);
    const expiry = access ? new Date(Math.max(Date.parse(row.paid_through) || 0, grace ? Date.parse(row.grace_ends_at) : 0)).toISOString() : row.paid_through;
    await syncOrganisationAccess(env, row.organisation_id, access, expiry);
    if (row.status === 'active' && !row.cancel_at_period_end && row.current_period_end) {
      const days = Math.ceil((Date.parse(row.current_period_end) - Date.now()) / 86400000);
      if ([30, 7].includes(days)) {
        const admin = await env.DB.prepare(`SELECT email FROM organisation_admins WHERE organisation_id = ? AND status = 'active' LIMIT 1`).bind(row.organisation_id).first();
        if (admin) await queueEmail(env, 'subscription_renewal_reminder', admin.email, {
          subject: `Your SparkFit employer subscription renews in ${days} days`,
          heading: `Renewal in ${days} days`, eyebrow: 'SparkFit employer subscription',
          actionUrl: `${env.SERVICE_ORIGIN || 'https://sparkfit-business-platform-staging.colbateson.workers.dev'}/sign-in/`, actionLabel: 'Review your subscription',
          text: `Your annual employer subscription renews on ${row.current_period_end.slice(0, 10)} for ${row.pending_seats || row.seats} seats. Sign in to review billing, update seats, or cancel before renewal.`,
        }, nowIso(), `renewal:${row.stripe_subscription_id}:${row.current_period_end}:${days}`);
      }
    }
  }
}
