if (location.protocol === 'file:') {
  document.getElementById('local-preview').hidden = false;
  document.querySelector('[type="submit"]').disabled = true;
} else {
  import('./buy.js').catch(() => {
    document.querySelector('[type="submit"]').disabled = true;
    const status = document.querySelector('[data-status]');
    status.textContent = 'We could not load checkout. Please reload this page.';
    status.className = 'status error';
  });
}
