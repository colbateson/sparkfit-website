import { api, getPublicConfig, setStatus } from '/common.js';
const form = document.querySelector('[data-accept-form]'); const status = document.querySelector('[data-status]'); const token = new URLSearchParams(location.search).get('token');
const copyButton = document.querySelector('[data-copy-invite]'); const copyStatus = document.querySelector('[data-copy-status]');
copyButton.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(location.href);
    setStatus(copyStatus, 'Secure invitation link copied. Paste it into an email to yourself, then open that email on your phone.', 'success');
  } catch {
    setStatus(copyStatus, 'Copy was blocked by this browser. Forward the original invitation email to your personal inbox instead.', 'error');
  }
});
if (!token) { form.querySelector('button').disabled = true; copyButton.disabled = true; setStatus(status, 'This invitation link is incomplete.', 'error'); }
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
      intro.textContent = 'Your employer has paid for your SparkFit Premium access. Use the SparkFit account you want this access attached to; its email can be different from the work email your employer invited.';
      document.querySelector('[data-invitation-steps]').hidden = false;
      document.querySelector('[data-install-links]').hidden = false;
      document.querySelector('[data-help]').textContent = 'If SparkFit is not installed, install it below, then return to this invitation on your phone. Sign in to your existing personal SparkFit account, even if it uses a different email. The invitation is linked only after you confirm activation in the app.';
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
