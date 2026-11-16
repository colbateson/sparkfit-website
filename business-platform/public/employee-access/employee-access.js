import { api, getPublicConfig, setStatus } from '/common.js';
const form = document.querySelector('[data-accept-form]'); const status = document.querySelector('[data-status]'); const token = new URLSearchParams(location.search).get('token');
if (!token) { form.querySelector('button').disabled = true; setStatus(status, 'This invitation link is incomplete.', 'error'); }
else {
  form.querySelector('button').disabled = true;
  getPublicConfig().then((config) => {
    if (config.requireAppAccountForBusiness) {
      const link = document.createElement('a');
      link.className = 'button';
      link.href = `sparkfit://business-invitation?token=${encodeURIComponent(token)}`;
      link.textContent = 'Open invitation in SparkFit';
      form.querySelector('button').replaceWith(link);
      document.querySelector('.auth-card > p').textContent = 'Open this invitation in SparkFit. Sign in to your existing account, or verify your email to create one. Your employer pays for your access.';
      document.querySelector('.help').textContent = 'Already use a different email in SparkFit? Sign in to that account before accepting this invitation. You do not need to create a second account.';
      setStatus(status, 'Open SparkFit to verify your account and accept your invitation.');
    } else { form.querySelector('button').disabled = false; }
  }).catch(() => setStatus(status, 'We could not load your invitation. Please reload and try again.', 'error'));
}
form.addEventListener('submit', async (event) => {
  event.preventDefault(); const button = form.querySelector('button'); button.disabled = true;
  try {
    const result = await api('/v1/employee-invitations/accept', { method: 'POST', body: JSON.stringify({ token }) });
    setStatus(status, result.premium?.mock ? 'Your activation has been recorded for testing. Premium access has not yet been enabled.' : 'Your SparkFit Premium access is active. Open the app and refresh your subscription status.', 'success');
    form.reset();
  } catch (error) { setStatus(status, error.message, 'error'); button.disabled = false; }
});
