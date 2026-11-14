export async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || 'The request could not be completed.');
    error.status = response.status;
    throw error;
  }
  return payload;
}

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character]));
}

export function formatDate(value) {
  if (!value) return 'Not set';
  return new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium' }).format(new Date(value));
}

export function setStatus(element, message, type = '') {
  element.textContent = message;
  element.className = `status ${type}`.trim();
}

let publicConfigPromise;
export function getPublicConfig() {
  if (!publicConfigPromise) publicConfigPromise = api('/v1/public-config').catch(() => ({ turnstileRequired: false, turnstileSiteKey: '' }));
  return publicConfigPromise;
}

let turnstileScriptPromise;
function loadTurnstileScript() {
  if (window.turnstile) return Promise.resolve();
  if (!turnstileScriptPromise) {
    turnstileScriptPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      script.async = true;
      script.defer = true;
      script.onload = resolve;
      script.onerror = () => reject(new Error('The security check could not load.'));
      document.head.append(script);
    });
  }
  return turnstileScriptPromise;
}

export async function mountTurnstile(container) {
  const config = await getPublicConfig();
  if (!config.turnstileRequired) return { required: false, getToken: () => '' };
  if (!container || !config.turnstileSiteKey) throw new Error('The security check is not configured.');
  await loadTurnstileScript();
  let token = '';
  const widgetId = window.turnstile.render(container, {
    sitekey: config.turnstileSiteKey,
    callback: (value) => { token = value; },
    'expired-callback': () => { token = ''; },
    'error-callback': () => { token = ''; },
  });
  return {
    required: true,
    getToken: () => token,
    reset: () => { token = ''; window.turnstile.reset(widgetId); },
  };
}

document.querySelectorAll('[data-year]').forEach((element) => { element.textContent = new Date().getFullYear(); });
