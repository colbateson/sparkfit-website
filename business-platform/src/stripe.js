import { HttpError } from './lib.js';
import { priceAnnual } from './pricing.js';

const encoder = new TextEncoder();

function formEncode(entries) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(entries)) if (value !== undefined && value !== null) params.append(key, String(value));
  return params.toString();
}

async function stripeRequest(env, path, values, options = {}) {
  if (!env.STRIPE_SECRET_KEY) throw new Error('Stripe is not configured.');
  if (env.ENVIRONMENT === 'staging' && !/^(sk|rk)_test_/.test(env.STRIPE_SECRET_KEY)) throw new Error('Staging requires a Stripe test-mode key.');
  const headers = {
    Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
    'Content-Type': 'application/x-www-form-urlencoded',
    'Stripe-Version': env.STRIPE_API_VERSION || '2026-10-28.endive',
  };
  if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;
  const response = await fetch(`https://api.stripe.com/v1${path}`, {
    method: options.method || 'POST',
    headers,
    body: options.method === 'GET' ? undefined : formEncode(values),
  });
  const payload = await response.json();
  if (!response.ok) throw new HttpError(502, payload?.error?.message || `Stripe returned ${response.status}.`);
  return payload;
}

export function createCheckoutSession(env, order, successUrl, cancelUrl, { allowWhenPaymentsDisabled = false } = {}) {
  if (env.PAYMENTS_ENABLED !== 'true' && !allowWhenPaymentsDisabled) throw new HttpError(503, 'Online purchasing is not enabled in this environment.');
  const managedPayments = env.STRIPE_MANAGED_PAYMENTS_ENABLED === 'true';
  return stripeRequest(env, '/checkout/sessions', {
    mode: 'subscription',
    'managed_payments[enabled]': managedPayments ? 'true' : 'false',
    customer_email: order.billing_email,
    client_reference_id: order.id,
    success_url: successUrl,
    cancel_url: cancelUrl,
    ...(!managedPayments ? { 'automatic_tax[enabled]': env.STRIPE_AUTOMATIC_TAX_ENABLED === 'true' ? 'true' : 'false' } : {}),
    'billing_address_collection': 'required',
    ...(!managedPayments ? { 'tax_id_collection[enabled]': 'true' } : {}),
    ...(managedPayments ? { 'name_collection[business][enabled]': 'true' } : {}),
    'line_items[0][price_data][currency]': 'gbp',
    ...(env.STRIPE_PRODUCT_ID ? { 'line_items[0][price_data][product]': env.STRIPE_PRODUCT_ID } : {
      'line_items[0][price_data][product_data][name]': 'SparkFit Annual Employer Subscription',
      'line_items[0][price_data][product_data][tax_code]': env.STRIPE_PRODUCT_TAX_CODE || 'txcd_10103101',
      'line_items[0][price_data][product_data][metadata][pricing_version]': order.pricing_version,
    }),
    'line_items[0][price_data][recurring][interval]': 'year',
    'line_items[0][price_data][tax_behavior]': 'exclusive',
    'line_items[0][price_data][unit_amount]': order.unit_amount_ex_vat,
    'line_items[0][quantity]': order.seats,
    'subscription_data[metadata][order_id]': order.id,
    'subscription_data[metadata][seats]': order.seats,
    'subscription_data[metadata][pricing_version]': order.pricing_version,
    'metadata[order_id]': order.id,
    integration_identifier: `sparkfit_business_${order.id.slice(-8).split('').map((letter) => String.fromCharCode(97 + letter.charCodeAt(0) % 26)).join('')}`,
  }, { idempotencyKey: `checkout-${order.id}` });
}

export function createBillingPortalSession(env, customerId, returnUrl) {
  return stripeRequest(env, '/billing_portal/sessions', {
    customer: customerId,
    configuration: env.STRIPE_PORTAL_CONFIGURATION_ID,
    return_url: returnUrl,
  });
}

export async function cancelStripeSubscription(env, subscriptionId) {
  const current = await retrieveStripeResource(env, `/subscriptions/${encodeURIComponent(subscriptionId)}`);
  if (current.status === 'canceled') return current;
  return stripeRequest(env, `/subscriptions/${encodeURIComponent(subscriptionId)}`, {}, { method: 'DELETE' });
}

async function annualPrice(env, product, seats) {
  const amount = priceAnnual(seats).unitExVat;
  return stripeRequest(env, '/prices', { currency: 'gbp', product, unit_amount: amount,
    tax_behavior: 'exclusive', 'recurring[interval]': 'year' }, { idempotencyKey: `annual-price-${product}-${amount}` });
}

export async function updateSubscriptionQuantity(env, itemId, seats) {
  const item = await retrieveStripeResource(env, `/subscription_items/${encodeURIComponent(itemId)}`);
  const subscription = await retrieveStripeResource(env, `/subscriptions/${encodeURIComponent(item.subscription)}`);
  if (subscription.pending_update) throw new HttpError(409, 'Complete the pending payment before changing seats again.');
  if (subscription.cancel_at_period_end) throw new HttpError(409, 'Resume the subscription before changing seats.');
  if (subscription.schedule) {
    const scheduleId = typeof subscription.schedule === 'string' ? subscription.schedule : subscription.schedule.id;
    await stripeRequest(env, `/subscription_schedules/${encodeURIComponent(scheduleId)}/release`, {});
  }
  const price = await annualPrice(env, item.price.product, seats);
  return stripeRequest(env, `/subscriptions/${encodeURIComponent(subscription.id)}`, {
    'items[0][id]': itemId, 'items[0][quantity]': seats, 'items[0][price]': price.id,
    payment_behavior: 'pending_if_incomplete', proration_behavior: 'always_invoice',
  });
}

export function retrieveStripeResource(env, path) {
  return stripeRequest(env, path, {}, { method: 'GET' });
}

export async function scheduleSubscriptionQuantity(env, subscriptionId, seats) {
  const subscription = await retrieveStripeResource(env, `/subscriptions/${encodeURIComponent(subscriptionId)}`);
  if (subscription.pending_update) throw new HttpError(409, 'Complete the pending payment before changing seats again.');
  if (subscription.cancel_at_period_end) throw new HttpError(409, 'Resume the subscription before scheduling a seat change.');
  let schedule;
  if (subscription.schedule) {
    const scheduleId = typeof subscription.schedule === 'string' ? subscription.schedule : subscription.schedule.id;
    schedule = await retrieveStripeResource(env, `/subscription_schedules/${encodeURIComponent(scheduleId)}`);
  } else {
    schedule = await stripeRequest(env, '/subscription_schedules', { from_subscription: subscriptionId }, {
      idempotencyKey: `seat-reduction-schedule-${subscriptionId}-${seats}`,
    });
  }
  const now = Math.floor(Date.now() / 1000);
  const current = schedule.phases?.find((phase) => phase.start_date <= now && phase.end_date > now) || schedule.phases?.[0];
  const item = current?.items?.[0];
  const priceId = typeof item?.price === 'string' ? item.price : item?.price?.id;
  if (!current?.start_date || !current?.end_date || !priceId) throw new Error('Stripe did not return a schedulable subscription phase.');
  const subscriptionItem = subscription.items.data[0];
  const nextPrice = await annualPrice(env, subscriptionItem.price.product, seats);
  return stripeRequest(env, `/subscription_schedules/${encodeURIComponent(schedule.id)}`, {
    end_behavior: 'release',
    'phases[0][start_date]': current.start_date,
    'phases[0][end_date]': current.end_date,
    'phases[0][items][0][price]': priceId,
    'phases[0][items][0][quantity]': item.quantity,
    'phases[0][proration_behavior]': 'none',
    'phases[1][start_date]': current.end_date,
    'phases[0][automatic_tax][enabled]': subscription.automatic_tax?.enabled ? 'true' : 'false',
    'phases[1][items][0][price]': nextPrice.id,
    'phases[1][items][0][quantity]': seats,
    'phases[1][duration][interval]': 'year',
    'phases[1][duration][interval_count]': 1,
    'phases[1][automatic_tax][enabled]': subscription.automatic_tax?.enabled ? 'true' : 'false',
    'phases[1][proration_behavior]': 'none',
  });
}

export function stripeSubscriptionIdFromInvoice(invoice) {
  return invoice?.subscription
    || invoice?.parent?.subscription_details?.subscription
    || invoice?.lines?.data?.find((line) => line.parent?.subscription_item_details)?.parent?.subscription_item_details?.subscription
    || null;
}

function parseSignature(header) {
  const parts = String(header || '').split(',').map((part) => part.trim().split('='));
  return {
    timestamp: Number(parts.find(([name]) => name === 't')?.[1]),
    signatures: parts.filter(([name]) => name === 'v1').map(([, value]) => value),
  };
}

function hex(buffer) { return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join(''); }

function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i += 1) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}

export async function verifyStripeWebhook(rawBody, signatureHeader, secret, toleranceSeconds = 300) {
  if (!secret) throw new Error('Stripe webhook secret is not configured.');
  const { timestamp, signatures } = parseSignature(signatureHeader);
  if (!Number.isFinite(timestamp) || !timestamp || !signatures.length || Math.abs(Date.now() / 1000 - timestamp) > toleranceSeconds) return false;
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const expected = hex(await crypto.subtle.sign('HMAC', key, encoder.encode(`${timestamp}.${rawBody}`)));
  return signatures.some((signature) => constantTimeEqual(expected, signature));
}

export function normaliseSubscriptionStatus(status) {
  if (['active', 'trialing'].includes(status)) return 'active';
  if (['past_due', 'unpaid', 'incomplete'].includes(status)) return 'payment_attention';
  if (['canceled', 'incomplete_expired'].includes(status)) return 'ended';
  return 'pending';
}
