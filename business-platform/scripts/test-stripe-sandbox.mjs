import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { createCheckoutSession, scheduleSubscriptionQuantity, updateSubscriptionQuantity, createBillingPortalSession } from '../src/stripe.js';
import { priceAnnual } from '../src/pricing.js';

const execute = promisify(execFile);
const cli = process.env.STRIPE_CLI || '/private/tmp/stripe-cli-1.55.11/stripe';
const runId = `e2e_${crypto.randomUUID().replaceAll('-', '')}`;
const report = { runId, startedAt: new Date().toISOString(), checks: [], fixtures: [], completed: false };
const origin = 'https://sparkfit-business-platform-staging.colbateson.workers.dev';
async function stripe(args) {
  const { stdout } = await execute(cli, args, { maxBuffer: 4 * 1024 * 1024 });
  const value = JSON.parse(stdout.slice(stdout.indexOf('{')));
  if (value.error) throw new Error(`${value.error.code || value.error.type}: ${value.error.message}`);
  return value;
}
const identity = await stripe(['whoami', '--format', 'json']);
assert.equal(identity.account_id, 'acct_1UblTe2SRn2PAsMs');
assert.equal(identity.mode, 'test');
const originalFetch = globalThis.fetch;
// Exercise the application's request encoding through the authenticated Stripe CLI.
// No API key is read, printed, or stored in this test runner.
globalThis.fetch = async (url, options = {}) => {
  if (!String(url).startsWith('https://api.stripe.com/v1/')) return originalFetch(url, options);
  const path = String(url).replace('https://api.stripe.com', '');
  const method = (options.method || 'GET').toLowerCase();
  const args = [method, path, '--stripe-version', '2026-10-28.endive'];
  for (const [key, value] of new URLSearchParams(options.body || '')) args.push('-d', `${key}=${value}`);
  const idem = options.headers?.['Idempotency-Key'];
  if (idem) args.push('--idempotency', idem);
  const response = await stripe(args);
  return Response.json(response);
};
const env = { PAYMENTS_ENABLED: 'true', STRIPE_SECRET_KEY: 'CLI_AUTHENTICATED_TEST_TRANSPORT',
  STRIPE_PORTAL_CONFIGURATION_ID: 'bpc_1Uc7312SRn2PAsMsKTgnOiqM', STRIPE_PRODUCT_TAX_CODE: 'txcd_10103101' };
let activeSubscription;
try {
  const registrations = await stripe(['tax', 'registrations', 'list', '--limit', '100']);
  const product = await stripe(['products', 'create', '--name', 'SparkFit Business E2E fixture',
    '-d', 'tax_code=txcd_10103101', '-d', `metadata[e2e_run]=${runId}`]);
  env.STRIPE_PRODUCT_ID = product.id;
  report.fixtures.push({ type: 'product', id: product.id });
  report.taxRegistrations = registrations.data.map((row) => ({ country: row.country, status: row.status }));
  for (const seats of [20, 50, 500]) {
    const quote = priceAnnual(seats);
    const session = await createCheckoutSession(env, {
      id: `${runId}_${seats}`, billing_email: 'sparkfit-e2e@example.com', seats,
      unit_amount_ex_vat: quote.unitExVat, pricing_version: quote.pricingVersion,
    }, `${origin}/checkout-success/?session_id={CHECKOUT_SESSION_ID}`, `${origin}/buy/`);
    assert.equal(session.livemode, false);
    assert.equal(session.mode, 'subscription');
    const lines = await stripe(['checkout', 'sessions', 'list_line_items', session.id]);
    assert.equal(lines.data[0].quantity, seats);
    assert.equal(lines.data[0].price.unit_amount, quote.unitExVat);
    assert.equal(lines.data[0].price.tax_behavior, 'exclusive');
    report.fixtures.push({ type: 'checkout', id: session.id, seats, url: session.url });
    report.checks.push({ name: `Checkout ${seats} seats`, result: 'passed', subtotalExVat: quote.subtotalExVat });
    if (seats === 20) {
      const customer = await stripe(['customers', 'create', '-d', 'name=SparkFit E2E test fixture',
        '-d', `metadata[e2e_run]=${runId}`, '-d', 'address[country]=GB', '-d', 'address[postal_code]=M1 1AE',
        '-d', 'payment_method=pm_card_visa', '-d', 'invoice_settings[default_payment_method]=pm_card_visa']);
      report.fixtures.push({ type: 'customer', id: customer.id });
      const annualPrice = await stripe(['prices', 'create', '-d', `product=${lines.data[0].price.product}`,
        '-d', 'currency=gbp', '-d', `unit_amount=${quote.unitExVat}`, '-d', 'tax_behavior=exclusive', '-d', 'recurring[interval]=year']);
      const subscription = await stripe(['subscriptions', 'create', '-d', `customer=${customer.id}`,
        '-d', `items[0][price]=${annualPrice.id}`, '-d', 'items[0][quantity]=20',
        '-d', 'automatic_tax[enabled]=false', '-d', `metadata[e2e_run]=${runId}`, '-e', 'latest_invoice']);
      activeSubscription = subscription.id;
      report.fixtures.push({ type: 'subscription', id: subscription.id });
      assert.equal(subscription.status, 'active');
      assert.equal(subscription.latest_invoice.status, 'paid');
      assert.equal(subscription.automatic_tax.enabled, false);
      assert.equal(subscription.latest_invoice.total, quote.subtotalExVat);
      report.taxCheck = { mode: 'not_vat_registered', addedVat: 0, invoiceTotal: subscription.latest_invoice.total };
      report.checks.push({ name: 'Successful sandbox invoice', result: 'passed' });
      const portal = await createBillingPortalSession(env, customer.id, `${origin}/portal/`);
      assert.ok(portal.url.startsWith('https://billing.stripe.com/'));
      report.checks.push({ name: 'Customer Portal session', result: 'passed' });
      const increased = await updateSubscriptionQuantity(env, subscription.items.data[0].id, 50);
      assert.equal(increased.items.data[0].quantity, 50);
      assert.equal(increased.items.data[0].price.unit_amount, priceAnnual(50).unitExVat);
      report.checks.push({ name: 'Prorated increase with volume repricing', result: 'passed' });
      const schedule = await scheduleSubscriptionQuantity(env, subscription.id, 20);
      assert.equal(schedule.phases[0].items[0].quantity, 50);
      assert.equal(schedule.phases[1].items[0].quantity, 20);
      report.checks.push({ name: 'Seat reduction scheduled at renewal', result: 'passed' });
      await stripe(['subscription_schedules', 'release', schedule.id]);
      const cancelled = await stripe(['subscriptions', 'update', subscription.id, '-d', 'cancel_at_period_end=true']);
      assert.equal(cancelled.cancel_at_period_end, true);
      assert.equal(cancelled.status, 'active');
      report.checks.push({ name: 'Cancellation retains current paid term', result: 'passed' });
    }
    await stripe(['checkout', 'sessions', 'expire', session.id]);
  }
  report.completed = true;
} catch (error) {
  report.failure = error.message;
  process.exitCode = 1;
} finally {
  globalThis.fetch = originalFetch;
  if (activeSubscription) {
    try { await stripe(['subscriptions', 'cancel', activeSubscription, '--confirm']); report.subscriptionCleanup = 'canceled test subscription'; }
    catch { report.subscriptionCleanup = 'manual cleanup required'; }
  }
  for (const fixture of report.fixtures.filter((fixture) => fixture.type === 'checkout')) {
    try { const session = await stripe(['checkout', 'sessions', 'retrieve', fixture.id]);
      if (session.status === 'open') await stripe(['checkout', 'sessions', 'expire', fixture.id]);
      fixture.status = 'expired'; delete fixture.url;
    } catch { fixture.cleanup = 'check session status'; }
  }
  report.finishedAt = new Date().toISOString();
  await writeFile(new URL('../STRIPE_SANDBOX_RESULTS.json', import.meta.url), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
}
