import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = process.env.STRIPE_CLI || '/private/tmp/stripe-cli-1.55.11/stripe';
const cwd = fileURLToPath(new URL('../', import.meta.url));
const origin = 'https://sparkfit-business-platform-staging.colbateson.workers.dev';
function stripe(args) {
  const output = execFileSync(cli, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const result = JSON.parse(output.slice(output.indexOf('{')));
  if (result.error) throw new Error(`Stripe setup request failed: ${result.error.code || result.error.type}`);
  return result;
}
const identity = stripe(['whoami', '--format', 'json']);
if (identity.account_id !== 'acct_1UblTe2SRn2PAsMs' || identity.mode !== 'test' || !identity.authorized) {
  throw new Error('Connect the expected SparkFit sandbox in test mode before running setup.');
}
const events = [
  'checkout.session.completed', 'checkout.session.async_payment_succeeded', 'checkout.session.async_payment_failed',
  'invoice.paid', 'invoice.payment_failed', 'customer.subscription.created', 'customer.subscription.updated',
  'customer.subscription.deleted', 'charge.dispute.created', 'charge.refunded', 'radar.early_fraud_warning.created',
];
const endpoints = stripe(['webhook_endpoints', 'list', '--limit', '100']);
let endpoint = endpoints.data.find((row) => row.url === `${origin}/v1/webhooks/stripe`);
if (!endpoint) {
  endpoint = stripe(['webhook_endpoints', 'create', '--url', `${origin}/v1/webhooks/stripe`,
    '--api-version', '2026-10-28.endive', '--description', 'SparkFit business staging lifecycle',
    ...events.flatMap((event) => ['--enabled-events', event])]);
  if (!endpoint.secret) throw new Error('Stripe did not return the new webhook signing secret.');
  const saved = spawnSync('npx', ['wrangler', 'secret', 'put', 'STRIPE_WEBHOOK_SECRET'], {
    cwd, input: endpoint.secret, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (saved.status !== 0) throw new Error('Cloudflare secret storage failed. Complete signing-secret setup before enabling payments.');
}
const configurations = stripe(['billing_portal', 'configurations', 'list', '--limit', '100']);
const products = stripe(['products', 'list', '--limit', '100', '-d', 'active=true']);
let product = products.data.find((row) => row.metadata?.integration === 'sparkfit-business');
if (!product) product = stripe(['products', 'create', '--name', 'SparkFit Annual Employer Subscription',
  '-d', 'tax_code=txcd_10103101', '-d', 'metadata[integration]=sparkfit-business']);
let portal = configurations.data.find((row) => row.name === 'SparkFit Business Staging');
if (!portal) portal = stripe(['billing_portal', 'configurations', 'create', '--name', 'SparkFit Business Staging',
  '--default-return-url', `${origin}/portal/`,
  '-d', 'business_profile[headline]=Manage your SparkFit employer subscription',
  '-d', 'features[invoice_history][enabled]=true',
  '-d', 'features[payment_method_update][enabled]=true',
  '-d', 'features[subscription_cancel][enabled]=true',
  '-d', 'features[subscription_cancel][mode]=at_period_end',
  '-d', 'features[subscription_update][enabled]=false']);
console.log(JSON.stringify({ account: identity.account_id, mode: identity.mode,
  webhookId: endpoint.id, webhookStatus: endpoint.status, portalConfigurationId: portal.id, productId: product.id,
  paymentsEnabled: false }, null, 2));
