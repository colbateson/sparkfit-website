import { HttpError, id, json, nowIso } from './lib.js';

export async function verifyEmailWebhook(raw, headers, secret) {
  if (!secret?.startsWith('whsec_')) return false;
  const timestamp = headers.get('svix-timestamp');
  const eventId = headers.get('svix-id');
  if (!eventId || !Number.isFinite(Number(timestamp)) || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  try {
    const key = await crypto.subtle.importKey('raw', Uint8Array.from(atob(secret.slice(6)), (char) => char.charCodeAt(0)),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const signature = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign('HMAC', key,
      new TextEncoder().encode(`${eventId}.${timestamp}.${raw}`)))));
    return (headers.get('svix-signature') || '').split(' ').some((part) => {
      const candidate = part.startsWith('v1,') ? part.slice(3) : '';
      if (candidate.length !== signature.length) return false;
      let difference = 0;
      for (let i = 0; i < signature.length; i++) difference |= signature.charCodeAt(i) ^ candidate.charCodeAt(i);
      return difference === 0;
    });
  } catch { return false; }
}

export async function emailWebhook(request, env) {
  if (!env.RESEND_WEBHOOK_SECRET) throw new HttpError(503, 'Email delivery tracking is not configured.');
  const raw = await request.text();
  if (!await verifyEmailWebhook(raw, request.headers, env.RESEND_WEBHOOK_SECRET)) throw new HttpError(400, 'Invalid email webhook signature.');
  const event = JSON.parse(raw);
  const states = { 'email.delivered': 'delivered', 'email.bounced': 'bounced', 'email.complained': 'complained', 'email.failed': 'failed', 'email.delivery_delayed': 'delayed' };
  const state = states[event.type];
  if (!state || !event.data?.email_id) return json({ received: true });
  await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO email_delivery_events (id, provider_id, event_type, occurred_at, received_at) VALUES (?, ?, ?, ?, ?)`)
      .bind(request.headers.get('svix-id'), event.data.email_id, event.type, event.created_at || nowIso(), nowIso()),
    env.DB.prepare(`UPDATE email_outbox SET status = ?, last_error = ? WHERE provider_id = ?
      AND (status NOT IN ('bounced', 'complained', 'failed') OR ? IN ('bounced', 'complained'))
      AND (status != 'delivered' OR ? != 'delayed')`)
      .bind(state, ['bounced', 'complained', 'failed'].includes(state) ? event.type : null, event.data.email_id, state, state),
    env.DB.prepare(`UPDATE employee_invitations SET delivery_status = ? WHERE id IN
      (SELECT json_extract(payload, '$.invitationId') FROM email_outbox WHERE provider_id = ? AND status = ?)`)
      .bind(state, event.data.email_id, state),
  ]);
  return json({ received: true });
}

export async function queueEmail(env, template, recipient, payload, sendAfter = nowIso(), dedupeKey = null) {
  await env.DB.prepare(`INSERT OR IGNORE INTO email_outbox (id, template, recipient, payload, send_after, created_at, dedupe_key)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(id('mail'), template, recipient, JSON.stringify(payload), sendAfter, nowIso(), dedupeKey).run();
}

export async function flushEmailOutbox(env, limit = 25) {
  if (env.EMAIL_ENABLED !== 'true' || !env.RESEND_API_KEY) return { sent: 0, disabled: true };
  const stale = new Date(Date.now() - 10 * 60000).toISOString();
  const rows = await env.DB.prepare(`SELECT * FROM email_outbox WHERE (status = 'pending' OR (status = 'sending' AND claimed_at < ?))
    AND attempts < 8 AND send_after <= ? ORDER BY created_at LIMIT ?`).bind(stale, nowIso(), limit).all();
  let sent = 0;
  for (const row of rows.results || []) {
    if (env.ENVIRONMENT === 'staging') {
      const allowed = new Set(String(env.STAGING_EMAIL_ALLOWLIST || env.PARTNERSHIPS_EMAIL || '').split(',').map((value) => value.trim().toLowerCase()).filter(Boolean));
      if (!allowed.has(row.recipient.toLowerCase())) {
        await env.DB.prepare(`UPDATE email_outbox SET status = 'suppressed', last_error = 'Recipient is not approved for staging email' WHERE id = ? AND status = 'pending'`).bind(row.id).run();
        continue;
      }
    }
    const claimed = await env.DB.prepare(`UPDATE email_outbox SET status = 'sending', claimed_at = ?, attempts = attempts + 1
      WHERE id = ? AND (status = 'pending' OR (status = 'sending' AND claimed_at < ?)) RETURNING id`)
      .bind(nowIso(), row.id, stale).first();
    if (!claimed) continue;
    const data = JSON.parse(row.payload);
    let response;
    try { response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json', 'Idempotency-Key': `sparkfit-email-${row.id}` },
      body: JSON.stringify({
        from: env.EMAIL_FROM || 'SparkFit Partnerships <partnerships@spark-fit.com>',
        reply_to: env.EMAIL_REPLY_TO || 'partnerships@spark-fit.com',
        to: [row.recipient],
        subject: data.subject,
        text: data.text,
      }),
    }); } catch { response = { ok: false, status: 0 }; }
    if (response.ok) {
      const delivery = await response.json();
      sent += 1;
      await env.DB.prepare(`UPDATE email_outbox SET status = 'sent', sent_at = ?, provider_id = ?, last_error = NULL WHERE id = ?`).bind(nowIso(), delivery.id || null, row.id).run();
      if (data.invitationId) await env.DB.prepare(`UPDATE employee_invitations SET delivery_status = 'sent' WHERE id = ?`).bind(data.invitationId).run();
    } else {
      const retry = response.status === 0 || response.status === 429 || response.status >= 500;
      const next = new Date(Date.now() + Math.min(3600000, 60000 * 2 ** Number(row.attempts))).toISOString();
      await env.DB.prepare(`UPDATE email_outbox SET status = ?, send_after = ?, last_error = ? WHERE id = ?`)
        .bind(retry && row.attempts < 7 ? 'pending' : 'failed', next, `Resend ${response.status}`, row.id).run();
      if (data.invitationId) await env.DB.prepare(`UPDATE employee_invitations SET delivery_status = 'failed' WHERE id = ?`).bind(data.invitationId).run();
    }
  }
  return { sent, disabled: false };
}

export const templates = {
  appEmailVerification: (link) => ({ subject: 'Verify your SparkFit email', text: `Verify your email to create or access your secure SparkFit account. This link expires in 30 minutes.\n\n${link}\n\nIf you did not request this email, you can ignore it.\n\nSparkFit` }),
  pilotReceived: (name, applicationId) => ({ subject: 'We received your SparkFit employee pilot request', text: `Hello ${name},\n\nWe received your SparkFit employee pilot request (${applicationId}). It is pending review. No employee access has been activated and no payment details are required.\n\nSparkFit Partnerships` }),
  pilotAdmin: (company, applicationId) => ({ subject: `New SparkFit pilot request: ${company}`, text: `Application ${applicationId} from ${company} is ready for review in the SparkFit admin dashboard.` }),
  pilotApproved: (company, link) => ({ subject: 'Your SparkFit employee pilot has been approved', text: `${company}'s pilot has been approved. Use this secure link to access the employer portal:\n\n${link}\n\nSparkFit Partnerships` }),
  employeeInvite: (company, link) => ({ subject: `${company} has invited you to SparkFit Premium`, text: `${company} is providing SparkFit Premium for you. No employee payment is required.\n\n1. Download SparkFit for iPhone: https://apps.apple.com/gb/app/sparkfit-15-min-workouts/id6754826325\n2. Download SparkFit for Android: https://play.google.com/store/apps/details?id=app.spark.fit\n3. Sign in to your existing SparkFit account, or verify your email to create one.\n4. Open this secure invitation in SparkFit and confirm which account should receive access:\n\n${link}\n\nAlready use a different email in SparkFit? Sign in to that account before accepting this invitation. You do not need to create a second account.\n\nYour employer can see activation status only. Your individual SparkFit activity remains private.` }),
  employeeInviteReminder: (company, link) => ({ subject: `Reminder: activate your ${company} SparkFit access`, text: `${company} has invited you to activate employer-funded SparkFit Premium at no cost to you. Your secure invitation expires soon. Complete SparkFit onboarding with the invited email, then verify it here:\n\n${link}\n\nYour employer can see activation status only. Your individual SparkFit activity remains private.` }),
  pilotExpiring: (company, days, upgradeLink) => ({ subject: `${company}'s SparkFit pilot ends in ${days} days`, text: `${company}'s SparkFit employee pilot ends in ${days} days. Employee accounts and personal data will remain in place. Employer-funded Premium will end unless another valid access source applies.\n\nDiscuss paid access: ${upgradeLink}\n\nSparkFit Partnerships` }),
  pilotExpired: (company, upgradeLink) => ({ subject: `${company}'s SparkFit pilot has ended`, text: `${company}'s SparkFit employee pilot has ended. Employee accounts and personal data remain in place. Any independently purchased Premium access remains unaffected.\n\nDiscuss paid access: ${upgradeLink}\n\nSparkFit Partnerships` }),
  paymentSuccessful: (company) => ({ subject: `${company}'s SparkFit subscription is active`, text: `Payment has been confirmed and ${company}'s SparkFit employer subscription is active. Sign in to the employer portal to invite employees and manage access.\n\nSparkFit Partnerships` }),
  paymentFailed: (company) => ({ subject: `Payment needs attention for ${company}`, text: `We could not confirm the latest payment for ${company}'s SparkFit employer subscription. Please use the secure billing portal or contact SparkFit Partnerships. Employee access is not removed immediately while the billing issue is reviewed.\n\nSparkFit Partnerships` }),
  subscriptionCancelled: (company) => ({ subject: `${company}'s SparkFit subscription has been cancelled`, text: `${company}'s SparkFit employer subscription is marked as cancelled. Employer-funded access will follow the confirmed subscription end date. Employee accounts and independently purchased Premium remain unaffected.\n\nSparkFit Partnerships` }),
  stripeRiskAlert: (company, eventType, objectId) => ({ subject: `Stripe review required for ${company}`, text: `Stripe reported ${eventType} for ${company}. Review the payment and subscription before changing employee access.\n\nStripe object: ${objectId}\n\nSparkFit Partnerships` }),
};
