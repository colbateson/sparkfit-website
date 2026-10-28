const PARTNERSHIPS_EMAIL = 'partnerships@spark-fit.com';
const ALLOWED_ENQUIRY_TYPES = new Set([
  'Free Founding Partner Trial',
  'Annual Employee Wellbeing Partnership',
  'Distribution / Community Partnership',
  'General Partnership Enquiry'
]);

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  }
});

const clean = (value, maxLength) => String(value ?? '').trim().replace(/[\u0000-\u001F\u007F]/g, '').slice(0, maxLength);
const isEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i.test(value);
const isPositiveInteger = (value) => /^\d+$/.test(value) && Number(value) > 0 && Number(value) <= 1000000;

const verifyTurnstile = async (token, request, secret) => {
  const form = new FormData();
  form.append('secret', secret);
  form.append('response', token);
  const ip = request.headers.get('CF-Connecting-IP');
  if (ip) form.append('remoteip', ip);
  const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    body: form
  });
  if (!response.ok) return false;
  const result = await response.json();
  return result.success === true;
};

const sendEmail = async (apiKey, payload) => {
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });
  if (!response.ok) throw new Error(`Email provider returned ${response.status}`);
};

export async function onRequestPost(context) {
  const { request, env } = context;
  const contentType = request.headers.get('Content-Type') || '';
  const contentLength = Number(request.headers.get('Content-Length') || 0);
  const requestOrigin = request.headers.get('Origin');
  const siteOrigin = new URL(request.url).origin;

  if (!contentType.toLowerCase().includes('application/json')) return json({ message: 'Unsupported request format.' }, 415);
  if (contentLength > 20000) return json({ message: 'Request is too large.' }, 413);
  if (requestOrigin && requestOrigin !== siteOrigin) return json({ message: 'Request origin is not allowed.' }, 403);

  let raw;
  try {
    raw = await request.json();
  } catch (_) {
    return json({ message: 'Invalid request.' }, 400);
  }

  // Quietly accept honeypot submissions so automated senders get no useful signal.
  if (clean(raw.website, 200)) return json({ ok: true });

  const lead = {
    enquiryType: clean(raw.enquiryType, 80),
    organisation: clean(raw.organisation, 120),
    ukLocation: clean(raw.ukLocation, 120),
    contactName: clean(raw.contactName, 120),
    workEmail: clean(raw.workEmail, 180).toLowerCase(),
    employeeCount: clean(raw.employeeCount, 12),
    licenceQuantity: clean(raw.licenceQuantity, 12),
    launchTimeframe: clean(raw.launchTimeframe, 80),
    requirements: clean(raw.requirements, 2000),
    privacyAccepted: clean(raw.privacyAccepted, 10)
  };

  const missingRequired = !ALLOWED_ENQUIRY_TYPES.has(lead.enquiryType)
    || !lead.organisation
    || !lead.ukLocation
    || !lead.contactName
    || !isEmail(lead.workEmail)
    || !isPositiveInteger(lead.employeeCount)
    || !lead.launchTimeframe
    || lead.privacyAccepted !== 'yes';

  const missingAnnualDetails = lead.enquiryType === 'Annual Employee Wellbeing Partnership'
    && !isPositiveInteger(lead.licenceQuantity);

  if (missingRequired || missingAnnualDetails) return json({ message: 'Please check the required fields and try again.' }, 422);

  if (env.TURNSTILE_REQUIRED === 'true') {
    if (!env.TURNSTILE_SECRET_KEY) return json({ message: 'Enquiry protection is not configured.' }, 503);
    const token = clean(raw.turnstileToken, 2048);
    if (!token || !(await verifyTurnstile(token, request, env.TURNSTILE_SECRET_KEY))) {
      return json({ message: 'Please complete the security check and try again.' }, 403);
    }
  }

  if (!env.RESEND_API_KEY) return json({ message: 'The enquiry service is temporarily unavailable.' }, 503);

  const receivedAt = new Date().toISOString();
  const subject = `[SparkFit Partnerships] ${lead.enquiryType} — ${lead.organisation}`;
  const notificationText = [
    'New SparkFit Partnerships enquiry',
    '',
    `Enquiry type: ${lead.enquiryType}`,
    `Organisation: ${lead.organisation}`,
    `UK location: ${lead.ukLocation}`,
    `Contact: ${lead.contactName}`,
    `Work email: ${lead.workEmail}`,
    `Approximate employee count: ${lead.employeeCount}`,
    `Desired licence quantity: ${lead.licenceQuantity || 'Not supplied / not applicable'}`,
    `Intended launch timeframe: ${lead.launchTimeframe}`,
    '',
    'Additional requirements:',
    lead.requirements || 'None supplied',
    '',
    `Privacy notice accepted: ${lead.privacyAccepted}`,
    `Received: ${receivedAt}`
  ].join('\n');

  try {
    await sendEmail(env.RESEND_API_KEY, {
      from: `SparkFit Partnerships <${PARTNERSHIPS_EMAIL}>`,
      to: [PARTNERSHIPS_EMAIL],
      reply_to: lead.workEmail,
      subject,
      text: notificationText
    });

    // The acknowledgement is useful but must not make a successfully captured lead look failed.
    await sendEmail(env.RESEND_API_KEY, {
      from: `SparkFit Partnerships <${PARTNERSHIPS_EMAIL}>`,
      to: [lead.workEmail],
      reply_to: PARTNERSHIPS_EMAIL,
      subject: 'We received your SparkFit partnership enquiry',
      text: [
        `Hello ${lead.contactName},`,
        '',
        `Thank you for contacting SparkFit Partnerships about: ${lead.enquiryType}.`,
        'We have received your enquiry and will reply from partnerships@spark-fit.com.',
        '',
        'Submitting this form does not create a paid agreement or automatic renewal.',
        '',
        'SparkFit Partnerships',
        PARTNERSHIPS_EMAIL
      ].join('\n')
    }).catch(() => {});
  } catch (_) {
    return json({ message: 'We could not send the enquiry securely right now.' }, 502);
  }

  return json({ ok: true });
}

export function onRequest() {
  return json({ message: 'Method not allowed.' }, 405);
}
