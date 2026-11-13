import { HttpError } from './lib.js';

const encoder = new TextEncoder();

function formEncode(entries) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(entries)) if (value !== undefined && value !== null) params.append(key, String(value));
  return params.toString();
}

async function stripeRequest(env, path, values) {
  if (env.PAYMENTS_ENABLED !== 'true') throw new HttpError(503, 'Online purchasing is not enabled in this environment.');
  if (!env.STRIPE_SECRET_KEY) throw new Error('Stripe is not configured.');
  const response = await fetch(`https://api.stripe.com/v1${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: formEncode(values),
  });
  const payload = await response.json();
  if (!response.ok) throw new HttpError(502, payload?.error?.message || `Stripe returned ${response.status}.`);
  return payload;
}

export function createCheckoutSession(env, order, successUrl, cancelUrl) {
  return stripeRequest(env, '/checkout/sessions', {
    mode: 'subscription',
    customer_email: order.billing_email,
    client_reference_id: order.id,
    success_url: successUrl,
    cancel_url: cancelUrl,
    'automatic_tax[enabled]': 'true',
    'customer_update[name]': 'auto',
    'customer_update[address]': 'auto',
    'billing_address_collection': 'required',
    'line_items[0][price_data][currency]': 'gbp',
    'line_items[0][price_data][product_data][name]': 'SparkFit Annual Employer Subscription',
    'line_items[0][price_data][product_data][metadata][pricing_version]': order.pricing_version,
    'line_items[0][price_data][recurring][interval]': 'year',
    'line_items[0][price_data][tax_behavior]': 'exclusive',
    'line_items[0][price_data][unit_amount]': order.unit_amount_ex_vat,
    'line_items[0][quantity]': order.seats,
    'subscription_data[metadata][order_id]': order.id,
    'subscription_data[metadata][seats]': order.seats,
    'subscription_data[metadata][pricing_version]': order.pricing_version,
    'metadata[order_id]': order.id,
  });
}

export function createBillingPortalSession(env, customerId, returnUrl) {
  return stripeRequest(env, '/billing_portal/sessions', {
    customer: customerId,
    return_url: returnUrl,
  });
}

export function updateSubscriptionQuantity(env, itemId, seats) {
  return stripeRequest(env, `/subscription_items/${encodeURIComponent(itemId)}`, {
    quantity: seats,
    proration_behavior: 'create_prorations',
  });
}

function parseSignature(header) {
  const values = Object.fromEntries(String(header || '').split(',').map((part) => part.split('=').map((item) => item.trim())));
  return { timestamp: Number(values.t), signature: values.v1 || '' };
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
  const { timestamp, signature } = parseSignature(signatureHeader);
  if (!timestamp || !signature || Math.abs(Date.now() / 1000 - timestamp) > toleranceSeconds) return false;
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const expected = hex(await crypto.subtle.sign('HMAC', key, encoder.encode(`${timestamp}.${rawBody}`)));
  return constantTimeEqual(expected, signature);
}

export function normaliseSubscriptionStatus(status) {
  if (['active', 'trialing'].includes(status)) return 'active';
  if (['past_due', 'unpaid', 'incomplete'].includes(status)) return 'payment_attention';
  if (['canceled', 'incomplete_expired'].includes(status)) return 'ended';
  return 'pending';
}
