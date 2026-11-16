import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { priceAnnual } from '../src/pricing.js';

const execute = promisify(execFile);
const cli = process.env.STRIPE_CLI || '/private/tmp/stripe-cli-1.55.11/stripe';
const runId = `ord_e2e_${crypto.randomUUID().replaceAll('-', '')}`;
const report = { runId, checks: [], completed: false, startedAt: new Date().toISOString() };
const sqlQuote = (value) => `'${String(value).replaceAll("'", "''")}'`;
async function stripe(args) {
  const { stdout } = await execute(cli, args, { maxBuffer: 4 * 1024 * 1024 });
  const data = JSON.parse(stdout.slice(stdout.indexOf('{')));
  if (data.error) throw new Error(data.error.message);
  return data;
}
async function database(sql) {
  const { stdout } = await execute('npx', ['wrangler', 'd1', 'execute', 'sparkfit-business-staging', '--remote', '--json', '--command', sql], { maxBuffer: 4 * 1024 * 1024 });
  return JSON.parse(stdout.slice(stdout.indexOf('[')))[0].results;
}
async function waitFor(predicate, label) {
  for (let i = 0; i < 12; i++) {
    const rows = await database(`SELECT es.*, o.status AS organisation_status FROM employer_subscriptions es JOIN organisations o ON o.id = es.organisation_id
      JOIN checkout_orders co ON co.organisation_id = o.id WHERE co.id = ${sqlQuote(runId)}`);
    if (rows[0] && predicate(rows[0])) return rows[0];
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  throw new Error(`Timed out waiting for ${label}`);
}
let subscriptionId;
try {
  const identity = await stripe(['whoami', '--format', 'json']);
  assert.equal(identity.account_id, 'acct_1UblTe2SRn2PAsMs'); assert.equal(identity.mode, 'test');
  const price = priceAnnual(20); const now = new Date().toISOString();
  await database(`INSERT INTO checkout_orders (id, company_name, billing_email, contact_name, seats, unit_amount_ex_vat,
    subtotal_ex_vat, discount_bps, pricing_version, created_at, updated_at) VALUES (${sqlQuote(runId)},
    ${sqlQuote(`Staging billing E2E ${runId}`)}, 'partnerships@spark-fit.com', 'Staging billing acceptance test',
    20, ${price.unitExVat}, ${price.subtotalExVat}, ${price.discountBps}, ${sqlQuote(price.pricingVersion)}, ${sqlQuote(now)}, ${sqlQuote(now)})`);
  const customer = await stripe(['customers', 'create', '-d', 'name=SparkFit deployed billing fixture',
    '-d', 'payment_method=pm_card_visa', '-d', 'invoice_settings[default_payment_method]=pm_card_visa', '-d', `metadata[e2e_run]=${runId}`]);
  const catalogPrice = await stripe(['prices', 'create', '-d', 'product=prod_VdSiz9mECAEbw3', '-d', 'currency=gbp',
    '-d', `unit_amount=${price.unitExVat}`, '-d', 'recurring[interval]=year', '-d', 'tax_behavior=exclusive']);
  const subscription = await stripe(['subscriptions', 'create', '-d', `customer=${customer.id}`, '-d', `items[0][price]=${catalogPrice.id}`,
    '-d', 'items[0][quantity]=20', '-d', 'automatic_tax[enabled]=false', '-d', `metadata[order_id]=${runId}`, '-e', 'latest_invoice']);
  subscriptionId = subscription.id; report.subscriptionId = subscriptionId;
  assert.equal(subscription.latest_invoice.status, 'paid');
  assert.equal(subscription.latest_invoice.total, price.subtotalExVat);
  const active = await waitFor((row) => row.status === 'active' && row.organisation_status === 'active', 'real Stripe webhook fulfilment');
  report.organisationId = active.organisation_id;
  report.checks.push('Real Stripe payment creates paid organisation through the deployed webhook');
  await stripe(['subscriptions', 'update', subscriptionId, '-d', 'cancel_at_period_end=true']);
  await waitFor((row) => row.cancel_at_period_end === 1 && row.organisation_status === 'active', 'period-end cancellation webhook');
  report.checks.push('Period-end cancellation retains employer access in the deployed ledger');
  const events = await stripe(['events', 'list', '--type', 'customer.subscription.created', '--limit', '100']);
  const event = events.data.find((row) => row.data.object.id === subscriptionId);
  assert.ok(event);
  await stripe(['events', 'resend', event.id, '--webhook-endpoint', 'we_1Uc72w2SRn2PAsMsStb6JU2F']);
  await waitFor((row) => row.cancel_at_period_end === 1 && row.organisation_status === 'active', 'replayed older event convergence');
  report.checks.push('Replayed older Stripe event does not undo cancellation state');
  const rows = await database(`SELECT COUNT(*) AS count FROM organisations WHERE id = ${sqlQuote(active.organisation_id)}`);
  assert.equal(rows[0].count, 1);
  report.checks.push('Paid organisation is not duplicated');
  await stripe(['subscriptions', 'cancel', subscriptionId, '--confirm']);
  await waitFor((row) => row.status === 'ended' && row.organisation_status === 'suspended', 'ended subscription webhook');
  report.checks.push('Subscription removal suspends employer access through the deployed webhook');
  report.completed = true;
} catch (error) { report.failure = error.message; process.exitCode = 1; }
finally {
  if (subscriptionId && !report.completed) {
    try { await stripe(['subscriptions', 'cancel', subscriptionId, '--confirm']); report.cleanup = 'test subscription canceled'; }
    catch { report.cleanup = 'check test subscription manually'; }
  }
  report.finishedAt = new Date().toISOString();
  await writeFile(new URL('../STAGING_BILLING_RESULTS.json', import.meta.url), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
}
