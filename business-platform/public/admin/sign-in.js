import { api, setStatus } from '/common.js';

const form = document.querySelector('[data-admin-signin]');
const status = document.querySelector('[data-status]');
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = form.querySelector('button');
  button.disabled = true;
  try {
    await api('/v1/admin/auth/request', {
      method: 'POST',
      body: JSON.stringify({ email: new FormData(form).get('email') }),
    });
    setStatus(status, 'If this email is authorised, an admin sign-in link has been queued. Check your inbox.', 'success');
  } catch (error) {
    setStatus(status, error.message, 'error');
  } finally {
    button.disabled = false;
  }
});
