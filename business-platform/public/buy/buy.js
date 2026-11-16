import { api, getPublicConfig, mountTurnstile, setStatus } from '/common.js';
const form = document.querySelector('[data-buy-form]'); const status = document.querySelector('[data-status]'); const input = form.elements.seats;
const clientRequestId = crypto.randomUUID();
const organisationId = new URLSearchParams(location.search).get('organisationId');
getPublicConfig().then((config) => {
  if (config.testMode) {
    const notice = document.createElement('p'); notice.className = 'notice';
    notice.textContent = 'Staging test environment. Use Stripe test card details only. No real payments are taken.';
    form.before(notice);
  }
}).catch(() => {});
form.addEventListener('formdata', (event) => {
  event.formData.set('clientRequestId', clientRequestId);
  if (organisationId) event.formData.set('organisationId', organisationId);
});
if (organisationId) api('/v1/portal/summary').then(({ organisation }) => {
  if (organisation.id !== organisationId) throw new Error('Sign in to the correct employer organisation.');
  form.elements.companyName.value = organisation.name;
  form.elements.companyWebsite.value = organisation.website;
}).catch((error) => setStatus(status, error.message, 'error'));
let security = { required: false, getToken: () => '' };
mountTurnstile(document.querySelector('[data-turnstile]')).then((value) => { security = value; }).catch((error) => setStatus(status, error.message, 'error'));
const directExVat = 2083;
function discount(seats) { if (seats >= 500) return .5; if (seats >= 250) return .4; if (seats >= 100) return .35; if (seats >= 75) return .3; if (seats >= 50) return .25; return .2; }
function money(pence) { return new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(pence / 100); }
function render() { const seats = Math.max(20, Math.min(500, Number(input.value) || 20)); const rate = discount(seats); const unit = Math.round(directExVat * (1 - rate)); document.querySelector('[data-hero-seats]').textContent = seats; document.querySelector('[data-discount]').textContent = `${rate * 100}%`; document.querySelector('[data-unit]').textContent = money(unit); document.querySelector('[data-total]').textContent = money(unit * seats); }
input.value = new URLSearchParams(location.search).get('seats') || 50; input.addEventListener('input', render); render();
form.addEventListener('submit', async (event) => { event.preventDefault(); const button = form.querySelector('button[type="submit"]'); button.disabled = true; const turnstileToken = security.getToken(); if (security.required && !turnstileToken) { setStatus(status, 'Please complete the security check.', 'error'); button.disabled = false; return; } try { const data = Object.fromEntries(new FormData(form).entries()); data.seats = Number(data.seats); data.turnstileToken = turnstileToken; const result = await api('/v1/checkout/sessions', { method: 'POST', body: JSON.stringify(data) }); location.href = result.checkoutUrl; } catch (error) { security.reset?.(); setStatus(status, error.message, 'error'); button.disabled = false; } });
