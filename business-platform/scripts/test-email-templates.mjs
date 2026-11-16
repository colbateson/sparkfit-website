import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { templates } from '../src/email.js';

const execute = promisify(execFile);
const origin = 'https://business-staging.spark-fit.com';
const recipient = 'partnerships@spark-fit.com';
const startedAt = new Date().toISOString();
const runId = `template_${crypto.randomUUID().replaceAll('-', '')}`;
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
async function database(sql) {
  const { stdout } = await execute('npx', ['wrangler', 'd1', 'execute', 'sparkfit-business-staging', '--remote', '--json', '--command', sql], { maxBuffer: 1024 * 1024 });
  return JSON.parse(stdout.slice(stdout.indexOf('[')))[0].results;
}
const health = await (await fetch(`${origin}/health`)).json();
assert.equal(health.environment, 'staging');
assert.equal(health.emailEnabled, true);
const link = `${origin}/sign-in/`;
const examples = {
  appEmailVerification: [link], pilotReceived: ['Staging reviewer', 'preview-only'],
  pilotAdmin: ['Staging preview company', 'preview-only'], pilotApproved: ['Staging preview company', link],
  employeeInvite: ['Staging preview company', `${origin}/employee-access/`],
  employeeInviteReminder: ['Staging preview company', `${origin}/employee-access/`],
  pilotExpiring: ['Staging preview company', 7, `${origin}/buy/`],
  pilotExpired: ['Staging preview company', `${origin}/buy/`], paymentSuccessful: ['Staging preview company'],
  paymentFailed: ['Staging preview company'], subscriptionCancelled: ['Staging preview company'],
  stripeRiskAlert: ['Staging preview company', 'PREVIEW ONLY', 'preview-only'],
};
assert.deepEqual(Object.keys(templates).sort(), Object.keys(examples).sort());
const inserts = Object.entries(examples).map(([name, args], index) => {
  const payload = templates[name](...args);
  payload.subject = `[STAGING PREVIEW] ${payload.subject}`;
  payload.text = `TEMPLATE PREVIEW: ${name}. No real application, payment or invitation is associated with this message. Links do not contain usable activation tokens.\n\n${payload.text}`;
  return `INSERT INTO email_outbox (id, template, recipient, payload, send_after, created_at, dedupe_key)
    VALUES (${quote(`${runId}_${index}`)}, ${quote(`preview_${name}`)}, ${quote(recipient)}, ${quote(JSON.stringify(payload))},
    ${quote(startedAt)}, ${quote(startedAt)}, ${quote(`${runId}_${index}`)});`;
});
await database(inserts.join('\n'));
// An ordinary allowlisted sign-in request triggers the existing background outbox drain.
const response = await fetch(`${origin}/v1/auth/request`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: recipient }) });
assert.ok(response.ok);
const report = { runId, startedAt, templatesQueued: Object.keys(examples), recipient, placementVerified: false };
await writeFile(new URL('../STAGING_EMAIL_RESULTS.json', import.meta.url), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ runId, queued: inserts.length, recipient, placementVerified: false }));
