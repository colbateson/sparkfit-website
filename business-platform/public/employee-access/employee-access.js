import { api, getPublicConfig, setStatus } from '/common.js';
const form = document.querySelector('[data-accept-form]'); const status = document.querySelector('[data-status]'); const token = new URLSearchParams(location.search).get('token');
if (!token) { form.querySelector('button').disabled = true; setStatus(status, 'This invitation link is incomplete.', 'error'); }
else {
  form.querySelector('button').disabled = true;
  getPublicConfig().then((config) => {
    if (config.requireAppAccountForBusiness) {
      const ios = /iPhone|iPad|iPod/i.test(navigator.userAgent);
      const appLink = document.createElement('a');
      appLink.className = 'button';
      appLink.href = `${ios ? 'app.sparkfit' : 'myapp'}://business-invitation?token=${encodeURIComponent(token)}`;
      appLink.textContent = 'Continue in SparkFit';
      form.querySelector('button').replaceWith(appLink);

      const intro = document.querySelector('[data-invitation-intro]');
      intro.textContent = 'Your employer has paid for your SparkFit Premium access. Open the invitation in SparkFit, sign in or verify your email, then tap “Activate Premium access”.';
      document.querySelector('[data-invitation-steps]').hidden = false;
      document.querySelector('[data-install-links]').hidden = false;
      document.querySelector('[data-help]').textContent = 'If SparkFit is not installed, install it below, then return to this invitation and tap “Continue in SparkFit”. Use the account you already have. If its email is different, sign in to that account before activating.';
      setStatus(status, 'Your next step is to continue in the SparkFit app. Activation is completed there.');
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
