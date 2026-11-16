import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const execute = promisify(execFile);
const origin = 'https://sparkfit-business-platform-staging.colbateson.workers.dev';
const address = 'partnerships@spark-fit.com';
const startedAt = new Date().toISOString();
const runId = `flow_${crypto.randomUUID().replaceAll('-', '')}`;
const report = { runId, startedAt, checks: [], completed: false };
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
async function database(sql) {
  const { stdout } = await execute('npx', ['wrangler', 'd1', 'execute', 'sparkfit-business-staging', '--remote', '--json', '--command', sql], { maxBuffer: 4 * 1024 * 1024 });
  const result = JSON.parse(stdout.slice(stdout.indexOf('[')));
  return result[0].results;
}
async function call(path, body, cookie, bearer) {
  const response = await fetch(`${origin}${path}`, { method: body === undefined ? 'GET' : 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const data = response.status === 302 ? {} : await response.json();
  if (response.status >= 400) throw new Error(`${path}: HTTP ${response.status}: ${data.error}`);
  return { response, data };
}
async function tokenFor(template) {
  const rows = await database(`SELECT payload FROM email_outbox WHERE template = ${quote(template)} AND recipient = ${quote(address)}
    AND created_at >= ${quote(startedAt)} ORDER BY created_at DESC LIMIT 1`);
  assert.ok(rows[0], `Expected ${template} email to be queued`);
  const links = JSON.parse(rows[0].payload).text.match(/https:\/\/[^\s]+/g) || [];
  return new URL(links.find((link) => link.includes('token='))).searchParams.get('token');
}
async function signIn(template) {
  const token = await tokenFor(template);
  const { response } = await call(`/v1/auth/consume?token=${encodeURIComponent(token)}`);
  assert.equal(response.status, 302);
  return response.headers.get('set-cookie').split(';')[0];
}
let admin;
let employer;
let organisationId;
try {
  const health = (await call('/health')).data;
  assert.equal(health.environment, 'staging');
  assert.equal(health.emailEnabled, true);
  assert.equal(health.revenueCatWritesEnabled, true);
  const config = (await call('/v1/public-config')).data;
  if (config.turnstileRequired && !process.env.STAGING_TEST_APPLICATION_ID && !process.env.TURNSTILE_TOKEN) {
    throw new Error('Submit a disposable pilot through the protected staging browser form, then supply STAGING_TEST_APPLICATION_ID. Do not disable Turnstile.');
  }
  await call('/v1/auth/request', { email: address });
  admin = await signIn('magic_link');
  assert.ok((await call('/v1/admin/dashboard', undefined, admin)).data);
  report.checks.push('Administrator email sign-in');
  let pilot;
  if (process.env.STAGING_TEST_APPLICATION_ID) {
    const applicationId = process.env.STAGING_TEST_APPLICATION_ID;
    const rows = await database(`SELECT id, company_name, business_email, status FROM pilot_applications WHERE id = ${quote(applicationId)}`);
    assert.equal(rows[0]?.status, 'pending_approval');
    assert.equal(rows[0]?.business_email, address);
    assert.match(rows[0]?.company_name || '', /staging|e2e|protected form/i);
    pilot = { applicationId };
  } else {
    pilot = (await call('/v1/pilot-applications', { companyName: `Staging E2E ${runId}`, companyWebsite: 'https://spark-fit.com',
      contactName: 'SparkFit staging acceptance test', jobTitle: 'Test', businessEmail: address, companySize: 20, requestedSeats: 2,
      turnstileToken: process.env.TURNSTILE_TOKEN || '' })).data;
  }
  const approved = (await call(`/v1/admin/pilot-applications/${pilot.applicationId}/decision`, { decision: 'approve' }, admin)).data;
  organisationId = approved.organisationId;
  report.organisationId = organisationId;
  employer = await signIn('pilot_approved');
  report.checks.push('Pilot application, approval and employer sign-in');
  await call('/v1/portal/invitations', { email: address }, employer);
  const invitation = await tokenFor('employee_invitation');
  await call('/v1/app-auth/request', { email: address });
  const verification = await tokenFor('app_email_verification');
  const verified = await call(`/v1/app-auth/verify?token=${encodeURIComponent(verification)}`);
  const exchange = new URL(verified.response.headers.get('location')).searchParams.get('exchange');
  const account = (await call('/v1/app-auth/exchange', { exchangeToken: exchange })).data;
  report.checks.push('Stable account creation and email verification');
  const activated = (await call('/v1/app/employee-invitations/accept', { token: invitation }, null, account.token)).data;
  assert.equal(activated.premium.mock, false);
  assert.equal(activated.premium.active, true);
  report.checks.push('Real RevenueCat Business entitlement grant');
  const summary = (await call('/v1/portal/summary', undefined, employer)).data;
  assert.equal(summary.seats.active, 1);
  assert.equal(summary.seats.pending, 0);
  assert.equal(JSON.stringify(summary.members).includes('revenuecat_app_user_id'), false);
  report.checks.push('Activation-only employer reporting');
  const removed = (await call(`/v1/portal/members/${activated.membershipId}/remove`, {}, employer)).data;
  assert.equal(removed.premium.active, false);
  const retainedAccount = (await call('/v1/app-auth/me', undefined, null, account.token)).data.account;
  assert.equal(retainedAccount.id, account.account.id);
  report.checks.push('Real Business entitlement removal with account retained');
  await call('/v1/app-auth/logout', {}, null, account.token);
  await call('/v1/portal/invitations', { email: address }, employer);
  report.checks.push('Removed employee can be invited again');
  const delivery = await database(`SELECT template, status, attempts FROM email_outbox WHERE recipient = ${quote(address)} AND created_at >= ${quote(startedAt)}`);
  report.emailDeliveries = delivery;
  report.completed = true;
} catch (error) { report.failure = error.message; process.exitCode = 1; }
finally {
  if (organisationId && admin) {
    try { await call(`/v1/admin/organisations/${organisationId}/action`, { action: 'end_pilot' }, admin); report.cleanup = 'test pilot ended'; }
    catch { report.cleanup = 'manual pilot cleanup required'; }
  }
  report.finishedAt = new Date().toISOString();
  await writeFile(new URL('../STAGING_FLOW_RESULTS.json', import.meta.url), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
}
