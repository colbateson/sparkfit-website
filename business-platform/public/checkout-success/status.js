import { api } from '/common.js';
const session = new URLSearchParams(location.search).get('session_id');
const title = document.querySelector('[data-title]');
const status = document.querySelector('[data-status]');
let attempts = 0;
async function check() {
  try {
    const order = await api(`/v1/checkout/status?session_id=${encodeURIComponent(session)}`);
    if (order.ready) {
      title.textContent = 'Your team’s SparkFit access is ready.';
      status.textContent = 'Sign in with your billing contact email to invite employees. We have also queued your confirmation email.';
      return;
    }
    if (order.status === 'payment_failed') {
      title.textContent = 'Your payment was not completed.';
      status.textContent = 'Return to the purchase form to try again, or contact partnerships@spark-fit.com.';
      return;
    }
  } catch { /* Keep the sign-in route available during delayed confirmation. */ }
  if (++attempts < 20) setTimeout(check, 3000);
  else status.textContent = 'Your payment is still being confirmed. You can close this page. We will email your billing contact when your portal is ready.';
}
if (session) check();
else { title.textContent = 'Check your SparkFit order'; status.textContent = 'Sign in with your billing email to see your organisation and subscription.'; }
