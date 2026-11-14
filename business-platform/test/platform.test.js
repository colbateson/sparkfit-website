import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { priceAnnual, TIERS } from '../src/pricing.js';
import { normaliseSubscriptionStatus, verifyStripeWebhook } from '../src/stripe.js';
import { revenueCatPolicy } from '../src/revenuecat.js';
import { normaliseWebsite } from '../src/lib.js';

const schema = readFileSync(new URL('../migrations/0001_init.sql', import.meta.url), 'utf8');
const lifecycleSchema = readFileSync(new URL('../migrations/0002_lifecycle_and_webhook_state.sql', import.meta.url), 'utf8');
const emailActivationSchema = readFileSync(new URL('../migrations/0003_verified_email_activation.sql', import.meta.url), 'utf8');
const rateLimitSchema = readFileSync(new URL('../migrations/0004_rate_limits.sql', import.meta.url), 'utf8');
const appAccountSchema = readFileSync(new URL('../migrations/0005_app_accounts.sql', import.meta.url), 'utf8');
const worker = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
const config = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
const commonClient = readFileSync(new URL('../public/common.js', import.meta.url), 'utf8');
const pilotClient = readFileSync(new URL('../public/pilot/pilot.js', import.meta.url), 'utf8');
const buyClient = readFileSync(new URL('../public/buy/buy.js', import.meta.url), 'utf8');

test('preserves approved annual volume pricing milestones', () => {
  assert.deepEqual(TIERS.map((tier) => [tier.min, tier.discountBps]), [[20, 2000], [50, 2500], [75, 3000], [100, 3500], [250, 4000], [500, 5000]]);
  assert.equal(priceAnnual(20).subtotalExVat, 33320);
  assert.equal(priceAnnual(50).subtotalExVat, 78100);
  assert.equal(priceAnnual(100).subtotalExVat, 135400);
});

test('accepts company websites with or without a protocol', () => {
  assert.equal(normaliseWebsite('www.google.com', true), 'https://www.google.com/');
  assert.equal(normaliseWebsite('google.com/path', true), 'https://google.com/path');
  assert.equal(normaliseWebsite('https://example.com', true), 'https://example.com/');
  assert.equal(normaliseWebsite('not a website', true), null);
  assert.equal(normaliseWebsite('', false), '');
});

test('accepts every integer seat quantity and flags unapproved extension', () => {
  for (let seats = 20; seats <= 1000; seats += 1) assert.equal(priceAnnual(seats).seats, seats);
  assert.equal(priceAnnual(500).provisional, false);
  assert.equal(priceAnnual(501).provisional, true);
  assert.throws(() => priceAnnual(19), RangeError);
  assert.throws(() => priceAnnual(1001), RangeError);
});

test('verifies Stripe webhook HMAC and rejects altered payloads', async () => {
  const secret = 'whsec_test_only';
  const body = '{"id":"evt_test","type":"invoice.paid"}';
  const timestamp = Math.floor(Date.now() / 1000);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = [...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${body}`)))]
    .map((byte) => byte.toString(16).padStart(2, '0')).join('');
  assert.equal(await verifyStripeWebhook(body, `t=${timestamp},v1=${signature}`, secret), true);
  assert.equal(await verifyStripeWebhook(`${body}x`, `t=${timestamp},v1=${signature}`, secret), false);
});

test('maps Stripe subscription states without granting on a success page', () => {
  assert.equal(normaliseSubscriptionStatus('active'), 'active');
  assert.equal(normaliseSubscriptionStatus('past_due'), 'payment_attention');
  assert.equal(normaliseSubscriptionStatus('canceled'), 'ended');
  assert.match(worker, /checkout\.session\.completed/);
  assert.match(worker, /customer\.subscription\./);
});

test('keeps consumer and employer RevenueCat sources separate', () => {
  assert.equal(revenueCatPolicy.consumerEntitlement, 'Pro');
  assert.equal(revenueCatPolicy.onboardingEntitlement, 'Trial');
  assert.match(revenueCatPolicy.accessRule, /Pro OR Trial OR Business/);
  assert.match(revenueCatPolicy.revokeRule, /Never revoke Pro/);
});

test('schema enforces core isolation, idempotency and seat controls', () => {
  for (const table of ['organisations', 'organisation_admins', 'pilot_applications', 'organisation_memberships', 'employee_invitations', 'employer_subscriptions', 'employer_entitlements', 'billing_events', 'audit_logs']) {
    assert.match(schema, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  }
  assert.match(schema, /stripe_event_id TEXT PRIMARY KEY/);
  assert.match(schema, /enforce_organisation_seat_limit/);
  assert.match(schema, /token_hash TEXT NOT NULL UNIQUE/);
  assert.match(emailActivationSchema, /enforce_pending_invitation_seat_limit/);
  assert.match(emailActivationSchema, /sparkfit_account_id/);
  assert.match(emailActivationSchema, /verified_at/);
  assert.match(lifecycleSchema, /lifecycle_notifications/);
});

test('employee activation is email-link driven and rejects client supplied RevenueCat identities', () => {
  assert.match(worker, /const appUserId = invitation\.email/);
  assert.match(worker, /one-time emailed token/);
  assert.doesNotMatch(worker, /email\(body\.appUserId\)/);
  assert.match(worker, /pending invitations also reserve seats/i);
  assert.match(worker, /employee\.invitation\.corrected/);
  assert.doesNotMatch(`${worker}\n${schema}\n${emailActivationSchema}`, /redemption[_ -]?code|licen[cs]e[_ -]?key/i);
});

test('revocation targets the immutable stored RevenueCat mapping and preserves consumer access policy', () => {
  assert.match(worker, /membership\.revenuecat_app_user_id/);
  assert.match(worker, /UPDATE employer_entitlements SET status = 'revoked'/);
  assert.match(revenueCatPolicy.revokeRule, /Never revoke Pro/);
});

test('staging config disables external side effects by default', () => {
  assert.match(config, /PAYMENTS_ENABLED = "false"/);
  assert.match(config, /REVENUECAT_WRITES_ENABLED = "false"/);
  assert.match(config, /EMAIL_ENABLED = "false"/);
  assert.doesNotMatch(`${worker}\n${schema}`, /sk_live_|whsec_[A-Za-z0-9]/);
});

test('protects public routes with configurable Turnstile and persisted rate limits', () => {
  assert.match(rateLimitSchema, /CREATE TABLE IF NOT EXISTS api_rate_limits/);
  for (const scope of ['pilot_application', 'sign_in_request', 'employee_activation', 'checkout_creation']) assert.match(worker, new RegExp(scope));
  assert.match(config, /RATE_LIMITING_ENABLED = "true"/);
  assert.match(config, /TURNSTILE_REQUIRED = "false"/);
  assert.match(commonClient, /challenges\.cloudflare\.com\/turnstile/);
  assert.match(pilotClient, /turnstileToken/);
  assert.match(buyClient, /turnstileToken/);
});

test('supports verified app accounts with stable server-issued RevenueCat identity', () => {
  for (const table of ['app_accounts', 'app_auth_challenges', 'app_auth_exchanges', 'app_sessions']) assert.match(appAccountSchema, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  assert.match(worker, /account\.id, account\.id/);
  assert.match(worker, /REQUIRE_APP_ACCOUNT_FOR_BUSINESS/);
  assert.match(worker, /v1\/app-auth\/exchange/);
  assert.match(worker, /v1\/app\/employee-invitations\/accept/);
});
