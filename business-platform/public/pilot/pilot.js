import { api, setStatus } from '/common.js';

const form = document.querySelector('[data-pilot-form]');
const status = document.querySelector('[data-status]');

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!form.reportValidity()) return;
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  setStatus(status, 'Submitting your application...');
  const data = new FormData(form);
  try {
    const result = await api('/v1/pilot-applications', { method: 'POST', body: JSON.stringify({
      companyName: data.get('companyName'), companyWebsite: data.get('companyWebsite'), contactName: data.get('contactName'),
      jobTitle: data.get('jobTitle'), businessEmail: data.get('businessEmail'), companySize: Number(data.get('companySize')),
      requestedSeats: Number(data.get('requestedSeats')), message: data.get('message'), website: data.get('website'),
      marketingConsent: data.get('marketingConsent') === 'on',
    }) });
    form.reset();
    setStatus(status, `Application received. Your reference is ${result.applicationId}. SparkFit will review it before any access is activated.`, 'success');
  } catch (error) { setStatus(status, error.message, 'error'); }
  finally { button.disabled = false; }
});
