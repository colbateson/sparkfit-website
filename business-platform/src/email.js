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
      const recipients = String(env.STAGING_EMAIL_ALLOWLIST || env.PARTNERSHIPS_EMAIL || '').split(',');
      if (row.template === 'app_email_verification') recipients.push(...String(env.STAGING_APP_EMAIL_ALLOWLIST || '').split(','));
      const allowed = new Set(recipients.map((value) => value.trim().toLowerCase()).filter(Boolean));
      if (!allowed.has(row.recipient.toLowerCase())) {
        await env.DB.prepare(`UPDATE email_outbox SET status = 'suppressed', last_error = 'Recipient is not approved for staging email' WHERE id = ? AND status = 'pending'`).bind(row.id).run();
        const invitationId = JSON.parse(row.payload).invitationId;
        if (invitationId) await env.DB.prepare(`UPDATE employee_invitations SET delivery_status = 'suppressed' WHERE id = ?`).bind(invitationId).run();
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
        text: data.actionUrl ? `${data.text || ''}\n\n${data.actionLabel || 'Open SparkFit'}: ${data.actionUrl}` : data.text,
        html: data.html || renderTransactionalEmail(data),
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
      if (data.invitationId) await env.DB.prepare(`UPDATE employee_invitations SET delivery_status = ? WHERE id = ?`)
        .bind(retry && row.attempts < 7 ? 'retrying' : 'failed', data.invitationId).run();
    }
  }
  return { sent, disabled: false };
}

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char]));

function formatEmailText(text) {
  const lines = String(text || '').split(/\r?\n/);
  const blocks = [];
  const inline = (value) => String(value).split(/(https:\/\/[^\s]+)/g).map((part) => /^https:\/\//.test(part)
    ? `<a href="${escapeHtml(part)}" style="color:#6428df;text-decoration:underline;word-break:break-word">${escapeHtml(part)}</a>`
    : escapeHtml(part)).join('');
  let paragraph = [];
  let list = [];
  const flushParagraph = () => {
    if (paragraph.length) blocks.push(`<p style="margin:0 0 16px;color:#514b5f;font-size:16px;line-height:1.65">${paragraph.map(inline).join('<br>')}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (list.length) blocks.push(`<ol style="margin:0 0 20px;padding-left:22px;color:#514b5f;font-size:16px;line-height:1.7">${list.map((item) => `<li style="padding:0 0 8px 4px">${inline(item)}</li>`).join('')}</ol>`);
    list = [];
  };
  for (const line of lines) {
    const value = line.trim();
    const numbered = value.match(/^\d+[.)]\s+(.*)$/);
    if (numbered) { flushParagraph(); list.push(numbered[1]); continue; }
    if (!value) { flushParagraph(); flushList(); continue; }
    flushList();
    paragraph.push(value);
  }
  flushParagraph();
  flushList();
  return blocks.join('');
}

function renderTransactionalEmail(data) {
  const actionUrl = /^https:\/\//.test(data.actionUrl || '') ? data.actionUrl : '';
  const actionLabel = escapeHtml(data.actionLabel || 'Open SparkFit');
  const button = actionUrl ? `<tr><td style="padding:8px 0 24px"><a href="${escapeHtml(actionUrl)}" style="display:inline-block;background:#702cff;color:#ffffff;text-decoration:none;font-weight:700;font-size:16px;line-height:1;padding:16px 24px;border-radius:999px">${actionLabel}</a></td></tr><tr><td style="padding:0 0 22px;color:#716a7d;font-size:13px;line-height:1.6">If the button does not open, copy this secure link into your browser:<br><a href="${escapeHtml(actionUrl)}" style="color:#6428df;word-break:break-all">${escapeHtml(actionUrl)}</a></td></tr>` : '';
  const title = escapeHtml(data.heading || data.subject || 'A message from SparkFit');
  const privacy = data.privacyNotice ? '<div style="margin-top:18px;padding:16px 18px;background:#f1eafd;border-radius:14px;color:#5e3a9d;font-size:14px;line-height:1.6">Your personal SparkFit activity stays private. Employers can see access activation status only.</div>' : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${title}</title></head><body style="margin:0;padding:0;background:#f5f1fb;font-family:Arial,Helvetica,sans-serif;color:#191323"><div style="display:none;max-height:0;overflow:hidden;opacity:0">${escapeHtml(data.preheader || data.subject || 'A message from SparkFit Partnerships')}</div><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f5f1fb"><tr><td align="center" style="padding:32px 16px"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:620px"><tr><td style="padding:0 0 18px"><table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr><td width="42" height="42" align="center" valign="middle" style="background:#702cff;border-radius:12px;color:#fff;font-size:25px;font-weight:700">⚡</td><td style="padding-left:12px;color:#191323;font-size:17px;font-weight:800;letter-spacing:3px">SPARKFIT<br><span style="color:#746d7d;font-size:10px;font-weight:600;letter-spacing:2.5px">PARTNERSHIPS</span></td></tr></table></td></tr><tr><td style="background:#ffffff;border:1px solid #e4dced;border-radius:22px;padding:36px 38px 30px"><div style="margin:0 0 12px;color:#702cff;font-size:11px;font-weight:800;letter-spacing:2.4px;text-transform:uppercase">${escapeHtml(data.eyebrow || 'A message from SparkFit')}</div><h1 style="margin:0 0 22px;color:#191323;font-size:30px;line-height:1.15;letter-spacing:-.7px">${title}</h1>${formatEmailText(data.text)}<table role="presentation" cellspacing="0" cellpadding="0" border="0">${button}</table>${privacy}</td></tr><tr><td style="padding:20px 8px 0;color:#777080;font-size:12px;line-height:1.6">SparkFit Partnerships<br><a href="mailto:partnerships@spark-fit.com" style="color:#6428df;text-decoration:underline">partnerships@spark-fit.com</a><br><span style="color:#9993a2">${escapeHtml(data.footerNote || 'This is a service email about your SparkFit account or partnership.')}</span></td></tr></table></td></tr></table></body></html>`;
}

export const templates = {
  appEmailVerification: (link) => ({ subject: 'Verify your SparkFit email', heading: 'Verify your email to continue', eyebrow: 'Your SparkFit account', preheader: 'Your secure verification link expires in 30 minutes.', actionUrl: link, actionLabel: 'Verify email', privacyNotice: true, text: `Use the secure button below to verify your email and continue with your SparkFit account.\n\nThis link expires in 30 minutes and can only be used once. If you did not request this email, you can ignore it.` }),
  pilotReceived: (name, applicationId) => ({ subject: 'We received your SparkFit employee pilot request', text: `Hello ${name},\n\nWe received your SparkFit employee pilot request (${applicationId}). It is pending review. No employee access has been activated and no payment details are required.\n\nSparkFit Partnerships` }),
  pilotAdmin: (company, applicationId) => ({ subject: `New SparkFit pilot request: ${company}`, text: `Application ${applicationId} from ${company} is ready for review in the SparkFit admin dashboard.` }),
  pilotApproved: (company, link) => ({ subject: 'Your SparkFit employee pilot has been approved', heading: 'Your pilot is approved', eyebrow: 'SparkFit for your team', actionUrl: link, actionLabel: 'Open employer portal', text: `${company}'s employee pilot is approved. Use your secure link to open the employer portal and arrange employee access.` }),
  employeeInvite: (company, link) => ({ subject: `${company} has invited you to SparkFit Premium`, heading: 'Your SparkFit access is ready', eyebrow: 'An invitation for your wellbeing', preheader: `${company} is providing SparkFit Premium for you at no cost.`, actionUrl: link, actionLabel: 'Open your invitation', privacyNotice: true, text: `${company} is providing SparkFit Premium for you. No employee payment is required.\n\nUsing your work email on a work device? Forward this entire invitation email to your personal inbox, then open it on the phone where you use SparkFit. You can also copy the secure invitation link from the page and email it to yourself. Keep the link intact and only send it to your own inbox; anyone with the link could accept the invitation.\n\n1. Open the invitation on your personal phone.\n2. Download SparkFit for iPhone: https://apps.apple.com/gb/app/sparkfit-15-min-workouts/id6754826325\n3. Download SparkFit for Android: https://play.google.com/store/apps/details?id=app.spark.fit\n4. Sign in to your existing SparkFit account, or verify your email to create one. Use the account you want to receive access; it can use a different email from the work address invited.\n5. Open the invitation in SparkFit, confirm the account, then tap “Activate Premium access”. You do not need to create a second account.` }),
  employeeInviteReminder: (company, link) => ({ subject: `Reminder: activate your ${company} SparkFit access`, heading: 'Your invitation is waiting', eyebrow: 'SparkFit employee access', actionUrl: link, actionLabel: 'Continue activation', privacyNotice: true, text: `${company} has invited you to activate employer-funded SparkFit Premium at no cost to you. Your secure invitation expires soon. If your work email is not on your phone, forward this entire email to your personal inbox and open it there. Sign in to the SparkFit account you want to receive access; its email can differ from the work email invited. Confirm the account and accept in the app. Keep the secure link private.` }),
  pilotExpiring: (company, days, upgradeLink) => ({ subject: `${company}'s SparkFit pilot ends in ${days} days`, heading: `Your pilot ends in ${days} days`, eyebrow: 'A note from SparkFit Partnerships', actionUrl: upgradeLink, actionLabel: 'Discuss paid access', text: `${company}'s SparkFit employee pilot ends in ${days} days. Employee accounts and personal data will remain in place. Employer-funded Premium will end unless another valid access source applies.` }),
  pilotExpired: (company, upgradeLink) => ({ subject: `${company}'s SparkFit pilot has ended`, heading: 'Your pilot has ended', eyebrow: 'SparkFit for your team', actionUrl: upgradeLink, actionLabel: 'Discuss paid access', text: `${company}'s SparkFit employee pilot has ended. Employee accounts and personal data remain in place. Any independently purchased Premium access remains unaffected.` }),
  paymentSuccessful: (company) => ({ subject: `${company}'s SparkFit subscription is active`, heading: 'Your team access is active', eyebrow: 'Payment confirmed', text: `Payment has been confirmed and ${company}'s SparkFit employer subscription is active. Sign in to invite employees, view activation status and manage billing.` }),
  paymentFailed: (company, billingLink) => ({ subject: `Payment needs attention for ${company}`, heading: 'Please review your payment', eyebrow: 'Billing update', actionUrl: billingLink, actionLabel: 'Review billing', text: `We could not confirm the latest payment for ${company}'s SparkFit employer subscription. Please use the secure billing portal or contact SparkFit Partnerships. Employer-funded access remains available for the first 14 days after the failed payment. If it remains unpaid, access is suspended after day 14 and the subscription may be ended after 30 days. Personal SparkFit accounts and purchases are unaffected.` }),
  paymentFailedReminder: (company, day, billingLink) => ({ subject: `Action needed: ${company}'s SparkFit payment is still overdue`, heading: day >= 12 ? 'Please resolve your overdue payment' : 'Your payment is still overdue', eyebrow: 'Billing reminder', actionUrl: billingLink, actionLabel: 'Update payment details', text: `The renewal payment for ${company}'s SparkFit employer subscription is still overdue. Please update payment details in the secure billing portal. Employer-funded access is scheduled to be suspended after day 14 and the subscription may be ended after 30 days. Personal SparkFit accounts and purchases are unaffected.` }),
  subscriptionCancelled: (company) => ({ subject: `${company}'s SparkFit subscription has been cancelled`, heading: 'Subscription cancellation confirmed', eyebrow: 'Billing update', text: `${company}'s SparkFit employer subscription is marked as cancelled. Employer-funded access will follow the confirmed subscription end date. Employee accounts and independently purchased Premium remain unaffected.` }),
  stripeRiskAlert: (company, eventType, objectId) => ({ subject: `Stripe review required for ${company}`, text: `Stripe reported ${eventType} for ${company}. Review the payment and subscription before changing employee access.\n\nStripe object: ${objectId}\n\nSparkFit Partnerships` }),
};
