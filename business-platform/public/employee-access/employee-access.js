import { api, setStatus } from '/common.js';
const form = document.querySelector('[data-accept-form]'); const status = document.querySelector('[data-status]'); const token = new URLSearchParams(location.search).get('token');
if (!token) { form.querySelector('button').disabled = true; setStatus(status, 'This invitation link is incomplete.', 'error'); }
form.addEventListener('submit', async (event) => {
  event.preventDefault(); const button = form.querySelector('button'); button.disabled = true;
  try {
    const result = await api('/v1/employee-invitations/accept', { method: 'POST', body: JSON.stringify({ token }) });
    setStatus(status, result.premium?.disabled ? 'Your employer access has been recorded. Premium provisioning is disabled in this staging environment.' : 'Your SparkFit Premium access is active. Open the app and refresh your subscription status.', 'success');
    form.reset();
  } catch (error) { setStatus(status, error.message, 'error'); button.disabled = false; }
});
