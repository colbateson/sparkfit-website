import { api, escapeHtml, formatDate, setStatus } from '/common.js';

const pageStatus = document.querySelector('[data-page-status]');
let summary;

function table(rows, columns) {
  if (!rows.length) return '<div class="empty">Nothing to show yet.</div>';
  return `<table class="table"><thead><tr>${columns.map((column) => `<th>${column.label}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${columns.map((column) => `<td>${column.render(row)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}

function deliveryLabel(status) {
  return ({ queued: 'Waiting to send', sent: 'Accepted by email service', delivered: 'Delivered', delayed: 'Delivery delayed', retrying: 'Retry scheduled', failed: 'Delivery failed', suppressed: 'Not sent in staging', bounced: 'Bounced', complained: 'Marked as spam' })[status] || 'Status unavailable';
}

function deliveryFeedback(status, action = 'Invitation') {
  if (status === 'suppressed') return `${action} saved, but no email was sent. Staging only sends to approved test inboxes.`;
  if (status === 'failed' || status === 'bounced' || status === 'complained') return `${action} saved, but email delivery failed. Check the address or contact SparkFit Partnerships.`;
  if (status === 'retrying') return `${action} saved. Email delivery failed temporarily and a retry is scheduled.`;
  if (status === 'sent') return `${action} accepted by the email service. Delivery confirmation will update here.`;
  if (status === 'delivered') return `${action} delivered to the recipient's mail server.`;
  if (status === 'delayed') return `${action} is delayed by the recipient's mail server.`;
  return `${action} queued. The portal will show delivery updates when available.`;
}

async function load() {
  try {
    summary = await api('/v1/portal/summary');
    const { organisation, seats, members, invitations, subscription } = summary;
    document.querySelector('[data-org-name]').textContent = organisation.name;
    document.querySelector('[data-plan-line]').textContent = `${organisation.plan_type === 'pilot' ? 'Employee pilot' : 'Employer subscription'} | ${organisation.status} | ends ${formatDate(organisation.expires_at)}`;
    let upgrade = document.querySelector('[data-upgrade]');
    if (organisation.plan_type === 'pilot' && !upgrade) {
      upgrade = document.createElement('a'); upgrade.className = 'button'; upgrade.dataset.upgrade = '';
      upgrade.href = `/buy/?organisationId=${encodeURIComponent(organisation.id)}&seats=${Math.max(20, organisation.seat_limit)}`;
      upgrade.textContent = 'Continue with annual access'; document.querySelector('.portal-head').append(upgrade);
    }
    document.querySelector('[data-purchased]').textContent = seats.purchased;
    document.querySelector('[data-active]').textContent = seats.active;
    document.querySelector('[data-pending]').textContent = seats.pending;
    document.querySelector('[data-available]').textContent = seats.available;
    const adoption = document.querySelector('[data-adoption]');
    if (adoption) adoption.textContent = `${seats.purchased ? Math.round((seats.active / seats.purchased) * 100) : 0}%`;
    const pending = invitations.filter((item) => item.status === 'pending');
    document.querySelector('[data-pending-count]').textContent = `${pending.length} pending`;
    document.querySelector('[data-active-count]').textContent = `${members.filter((item) => item.status === 'active').length} active`;
    document.querySelector('[data-invitations]').innerHTML = table(invitations, [
      { label: 'Employee', render: (row) => escapeHtml(row.email) },
      { label: 'Status', render: (row) => `<span class="tag ${escapeHtml(row.status)}">${escapeHtml(row.status)}</span>` },
      { label: 'Email delivery', render: (row) => `<span class="tag ${escapeHtml(row.delivery_status || 'queued')}">${escapeHtml(deliveryLabel(row.delivery_status || 'queued'))}</span>${row.delivery_status === 'suppressed' ? '<small class="delivery-note">Staging only sends to approved test inboxes.</small>' : ''}` },
      { label: 'Expires', render: (row) => escapeHtml(formatDate(row.expires_at)) },
      { label: 'Actions', render: (row) => ['pending', 'expired'].includes(row.status) ? `<div class="inline-actions"><button class="small-button" data-invite-action="resend" data-id="${escapeHtml(row.id)}">Resend</button><button class="small-button" data-invite-action="correct" data-id="${escapeHtml(row.id)}">Correct email</button>${row.status === 'pending' ? `<button class="small-button danger" data-invite-action="revoke" data-id="${escapeHtml(row.id)}">Cancel</button>` : ''}</div>` : '' },
    ]);
    document.querySelector('[data-members]').innerHTML = table(members, [
      { label: 'Employee', render: (row) => escapeHtml(row.email) }, { label: 'Status', render: (row) => `<span class="tag ${escapeHtml(row.status)}">${escapeHtml(row.status)}</span>` },
      { label: 'Activated', render: (row) => escapeHtml(formatDate(row.joined_at)) },
      { label: 'Action', render: (row) => row.status === 'active' ? `<button class="small-button danger" data-remove-member="${escapeHtml(row.id)}">Remove</button>` : '' },
    ]);
    if (subscription) {
      document.querySelector('[data-subscription-panel]').hidden = false;
      document.querySelector('[data-billing]').hidden = false;
      document.querySelector('[data-sub-status]').textContent = subscription.status;
      document.querySelector('[data-sub-seats]').textContent = subscription.seats;
      document.querySelector('[data-sub-end]').textContent = formatDate(subscription.current_period_end);
      document.querySelector('[data-seats-form] input').value = subscription.pending_seats || subscription.seats;
      const seatsForm = document.querySelector('[data-seats-form]');
      seatsForm.querySelectorAll('input, button').forEach((control) => { control.disabled = !summary.paymentsEnabled; });
      document.querySelector('[data-seats-unavailable]').hidden = summary.paymentsEnabled;
      if (subscription.pending_seats) setStatus(document.querySelector('[data-seats-status]'), `${subscription.pending_seats} seats are scheduled from ${formatDate(subscription.current_period_end)}.`);
    }
    setStatus(pageStatus, '');
  } catch (error) {
    if (error.status === 401) location.replace('/sign-in/');
    else if (error.status === 403) location.replace('/admin/');
    else setStatus(pageStatus, error.message, 'error');
  }
}

document.querySelector('[data-invite-form]').addEventListener('submit', async (event) => {
  event.preventDefault(); const form = event.currentTarget; const status = document.querySelector('[data-invite-status]');
  try { const result = await api('/v1/portal/invitations', { method: 'POST', body: JSON.stringify({ email: new FormData(form).get('email') }) }); form.reset(); await load(); setStatus(status, deliveryFeedback(result.deliveryStatus), result.deliveryStatus === 'suppressed' || result.deliveryStatus === 'failed' ? 'error' : 'success'); }
  catch (error) { setStatus(status, error.message, 'error'); }
});

async function inviteMany(raw, status) {
  const emails = [...new Set(raw.split(/[\s,;]+/).map((value) => value.trim().toLowerCase()).filter((value) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value)))];
  if (!emails.length) return setStatus(status, 'No valid email addresses were found.', 'error');
  let queued = 0; let suppressed = 0; const failures = [];
  for (const email of emails) { try { const result = await api('/v1/portal/invitations', { method: 'POST', body: JSON.stringify({ email }) }); queued += 1; if (result.deliveryStatus === 'suppressed') suppressed += 1; } catch (error) { failures.push(`${email}: ${error.message}`); } }
  await load();
  const message = `${queued} invitation${queued === 1 ? '' : 's'} created.${suppressed ? ` ${suppressed} email${suppressed === 1 ? ' was' : 's were'} not sent because the address is not approved for staging.` : ''}${failures.length ? ` ${failures.length} could not be created.` : ''}`;
  setStatus(status, message, suppressed || failures.length ? 'error' : 'success');
}

document.querySelector('[data-csv-form]').addEventListener('submit', async (event) => {
  event.preventDefault(); const status = document.querySelector('[data-csv-status]'); const file = new FormData(event.currentTarget).get('csv');
  await inviteMany(await file.text(), status);
});

document.querySelector('[data-paste-form]').addEventListener('submit', async (event) => {
  event.preventDefault(); const status = document.querySelector('[data-paste-status]');
  await inviteMany(String(new FormData(event.currentTarget).get('emails') || ''), status);
});

document.addEventListener('click', async (event) => {
  const action = event.target.closest('[data-invite-action]');
  const remove = event.target.closest('[data-remove-member]');
  const actionStatus = document.querySelector('[data-invitation-action-status]');
  try {
    if (action) {
      const correctedEmail = action.dataset.inviteAction === 'correct' ? prompt('Enter the corrected employee email address') : undefined;
      if (action.dataset.inviteAction === 'correct' && !correctedEmail) return;
      action.disabled = true;
      if (action.dataset.inviteAction === 'resend') action.textContent = 'Sending...';
      const result = await api(`/v1/portal/invitations/${encodeURIComponent(action.dataset.id)}/action`, { method: 'POST', body: JSON.stringify({ action: action.dataset.inviteAction, email: correctedEmail }) });
      await load();
      if (action.dataset.inviteAction === 'revoke') setStatus(actionStatus, 'Invitation canceled.', 'success');
      else setStatus(actionStatus, deliveryFeedback(result.deliveryStatus, action.dataset.inviteAction === 'resend' ? 'Reminder' : 'Corrected invitation'), result.deliveryStatus === 'suppressed' || result.deliveryStatus === 'failed' ? 'error' : 'success');
    }
    if (remove && confirm('Remove this employee from employer-funded access? Their account and any personal subscription remain unaffected.')) { await api(`/v1/portal/members/${encodeURIComponent(remove.dataset.removeMember)}/remove`, { method: 'POST', body: '{}' }); await load(); setStatus(pageStatus, 'Employee access removed. Their personal account and subscription are unaffected.', 'success'); }
  } catch (error) { setStatus(action ? actionStatus : pageStatus, error.message, 'error'); if (action) { action.disabled = false; action.textContent = 'Resend'; } }
});

document.querySelector('[data-billing]').addEventListener('click', async () => { try { const result = await api('/v1/portal/billing-portal', { method: 'POST', body: '{}' }); location.href = result.url; } catch (error) { setStatus(pageStatus, error.message, 'error'); } });
document.querySelector('[data-seats-form]').addEventListener('submit', async (event) => { event.preventDefault(); const status = document.querySelector('[data-seats-status]'); try { await api('/v1/portal/seats', { method: 'POST', body: JSON.stringify({ seats: Number(new FormData(event.currentTarget).get('seats')) }) }); setStatus(status, 'Seat change sent to Stripe. The portal will update after webhook confirmation.', 'success'); } catch (error) { setStatus(status, error.message, 'error'); } });

load();
