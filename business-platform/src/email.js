import { id, nowIso } from './lib.js';

export async function queueEmail(env, template, recipient, payload, sendAfter = nowIso()) {
  await env.DB.prepare(`INSERT INTO email_outbox (id, template, recipient, payload, send_after, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(id('mail'), template, recipient, JSON.stringify(payload), sendAfter, nowIso()).run();
}

export async function flushEmailOutbox(env, limit = 25) {
  if (env.EMAIL_ENABLED !== 'true' || !env.RESEND_API_KEY) return { sent: 0, disabled: true };
  const rows = await env.DB.prepare(`SELECT * FROM email_outbox WHERE status = 'pending' AND send_after <= ? ORDER BY created_at LIMIT ?`)
    .bind(nowIso(), limit).all();
  let sent = 0;
  for (const row of rows.results || []) {
    const data = JSON.parse(row.payload);
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: env.EMAIL_FROM || 'SparkFit Partnerships <partnerships@spark-fit.com>',
        reply_to: env.EMAIL_REPLY_TO || 'partnerships@spark-fit.com',
        to: [row.recipient],
        subject: data.subject,
        text: data.text,
      }),
    });
    if (response.ok) {
      sent += 1;
      await env.DB.prepare(`UPDATE email_outbox SET status = 'sent', sent_at = ?, attempts = attempts + 1 WHERE id = ?`).bind(nowIso(), row.id).run();
      if (data.invitationId) await env.DB.prepare(`UPDATE employee_invitations SET delivery_status = 'sent' WHERE id = ?`).bind(data.invitationId).run();
    } else {
      await env.DB.prepare(`UPDATE email_outbox SET attempts = attempts + 1, last_error = ? WHERE id = ?`).bind(`Resend ${response.status}`, row.id).run();
      if (data.invitationId) await env.DB.prepare(`UPDATE employee_invitations SET delivery_status = 'failed' WHERE id = ?`).bind(data.invitationId).run();
    }
  }
  return { sent, disabled: false };
}

export const templates = {
  pilotReceived: (name, applicationId) => ({ subject: 'We received your SparkFit employee pilot request', text: `Hello ${name},\n\nWe received your SparkFit employee pilot request (${applicationId}). It is pending review. No employee access has been activated and no payment details are required.\n\nSparkFit Partnerships` }),
  pilotAdmin: (company, applicationId) => ({ subject: `New SparkFit pilot request: ${company}`, text: `Application ${applicationId} from ${company} is ready for review in the SparkFit admin dashboard.` }),
  pilotApproved: (company, link) => ({ subject: 'Your SparkFit employee pilot has been approved', text: `${company}'s pilot has been approved. Use this secure link to access the employer portal:\n\n${link}\n\nSparkFit Partnerships` }),
  employeeInvite: (company, link) => ({ subject: `${company} has invited you to SparkFit Premium`, text: `${company} is providing SparkFit Premium for you. No employee payment is required.\n\n1. Download SparkFit for iPhone: https://apps.apple.com/gb/app/sparkfit-15-min-workouts/id6754826325\n2. Download SparkFit for Android: https://play.google.com/store/apps/details?id=app.spark.fit\n3. Complete onboarding using the email address that received this invitation.\n4. Verify that email and activate access using this secure link:\n\n${link}\n\nAlready use SparkFit with this email? Use the same link. If your existing account uses another email, contact SparkFit before activating so a duplicate account is not created.\n\nYour employer can see activation status only. Your individual SparkFit activity remains private.` }),
  employeeInviteReminder: (company, link) => ({ subject: `Reminder: activate your ${company} SparkFit access`, text: `${company} has invited you to activate employer-funded SparkFit Premium at no cost to you. Your secure invitation expires soon. Complete SparkFit onboarding with the invited email, then verify it here:\n\n${link}\n\nYour employer can see activation status only. Your individual SparkFit activity remains private.` }),
  pilotExpiring: (company, days, upgradeLink) => ({ subject: `${company}'s SparkFit pilot ends in ${days} days`, text: `${company}'s SparkFit employee pilot ends in ${days} days. Employee accounts and personal data will remain in place. Employer-funded Premium will end unless another valid access source applies.\n\nDiscuss paid access: ${upgradeLink}\n\nSparkFit Partnerships` }),
  pilotExpired: (company, upgradeLink) => ({ subject: `${company}'s SparkFit pilot has ended`, text: `${company}'s SparkFit employee pilot has ended. Employee accounts and personal data remain in place. Any independently purchased Premium access remains unaffected.\n\nDiscuss paid access: ${upgradeLink}\n\nSparkFit Partnerships` }),
  paymentSuccessful: (company) => ({ subject: `${company}'s SparkFit subscription is active`, text: `Payment has been confirmed and ${company}'s SparkFit employer subscription is active. Sign in to the employer portal to invite employees and manage access.\n\nSparkFit Partnerships` }),
  paymentFailed: (company) => ({ subject: `Payment needs attention for ${company}`, text: `We could not confirm the latest payment for ${company}'s SparkFit employer subscription. Please use the secure billing portal or contact SparkFit Partnerships. Employee access is not removed immediately while the billing issue is reviewed.\n\nSparkFit Partnerships` }),
  subscriptionCancelled: (company) => ({ subject: `${company}'s SparkFit subscription has been cancelled`, text: `${company}'s SparkFit employer subscription is marked as cancelled. Employer-funded access will follow the confirmed subscription end date. Employee accounts and independently purchased Premium remain unaffected.\n\nSparkFit Partnerships` }),
};
