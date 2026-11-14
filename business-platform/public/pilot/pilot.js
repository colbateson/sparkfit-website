import { api, mountTurnstile, setStatus } from '/common.js';

const form = document.querySelector('[data-pilot-form]');
const status = document.querySelector('[data-status]');
let security = { required: false, getToken: () => '' };
mountTurnstile(document.querySelector('[data-turnstile]')).then((value) => { security = value; }).catch((error) => setStatus(status, error.message, 'error'));

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!form.reportValidity()) return;
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  setStatus(status, 'Submitting your application...');
  const data = new FormData(form);
  const turnstileToken = security.getToken();
  if (security.required && !turnstileToken) { setStatus(status, 'Please complete the security check.', 'error'); button.disabled = false; return; }
  try {
    const result = await api('/v1/pilot-applications', { method: 'POST', body: JSON.stringify({
      companyName: data.get('companyName'), companyWebsite: data.get('companyWebsite'), contactName: data.get('contactName'),
      jobTitle: data.get('jobTitle'), businessEmail: data.get('businessEmail'), companySize: Number(data.get('companySize')),
      requestedSeats: Number(data.get('requestedSeats')), message: data.get('message'), website: data.get('website'),
      marketingConsent: data.get('marketingConsent') === 'on', turnstileToken,
    }) });
    form.reset();
    security.reset?.();
    setStatus(status, `Application received. Your reference is ${result.applicationId}. SparkFit will review it before any access is activated.`, 'success');
  } catch (error) { setStatus(status, error.message, 'error'); }
  finally { button.disabled = false; }
});
