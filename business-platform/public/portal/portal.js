import { api, escapeHtml, formatDate, setStatus } from '/common.js';

const pageStatus = document.querySelector('[data-page-status]');
let summary;

function table(rows, columns) {
  if (!rows.length) return '<div class="empty">Nothing to show yet.</div>';
  return `<table class="table"><thead><tr>${columns.map((column) => `<th>${column.label}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${columns.map((column) => `<td>${column.render(row)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}

async function load() {
  try {
    summary = await api('/v1/portal/summary');
    const { organisation, seats, members, invitations, subscription } = summary;
    document.querySelector('[data-org-name]').textContent = organisation.name;
    document.querySelector('[data-plan-line]').textContent = `${organisation.plan_type === 'pilot' ? 'Employee pilot' : 'Employer subscription'} | ${organisation.status} | ends ${formatDate(organisation.expires_at)}`;
    document.querySelector('[data-purchased]').textContent = seats.purchased;
    document.querySelector('[data-active]').textContent = seats.active;
    document.querySelector('[data-pending]').textContent = seats.pending;
    document.querySelector('[data-available]').textContent = seats.available;
    document.querySelector('[data-adoption]').textContent = `${seats.purchased ? Math.round((seats.allocated / seats.purchased) * 100) : 0}%`;
    const pending = invitations.filter((item) => item.status === 'pending');
    document.querySelector('[data-pending-count]').textContent = `${pending.length} pending`;
    document.querySelector('[data-active-count]').textContent = `${members.filter((item) => item.status === 'active').length} active`;
    document.querySelector('[data-invitations]').innerHTML = table(invitations, [
      { label: 'Employee', render: (row) => escapeHtml(row.email) },
      { label: 'Status', render: (row) => `<span class="tag ${escapeHtml(row.status)}">${escapeHtml(row.status)}</span>` },
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
    }
    setStatus(pageStatus, '');
  } catch (error) {
    if (error.status === 401) location.href = '/sign-in/';
    else setStatus(pageStatus, error.message, 'error');
  }
}

document.querySelector('[data-invite-form]').addEventListener('submit', async (event) => {
  event.preventDefault(); const status = document.querySelector('[data-invite-status]');
  try { await api('/v1/portal/invitations', { method: 'POST', body: JSON.stringify({ email: new FormData(event.currentTarget).get('email') }) }); event.currentTarget.reset(); setStatus(status, 'Invitation queued.', 'success'); await load(); }
  catch (error) { setStatus(status, error.message, 'error'); }
});

async function inviteMany(raw, status) {
  const emails = [...new Set(raw.split(/[\s,;]+/).map((value) => value.trim().toLowerCase()).filter((value) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value)))];
  if (!emails.length) return setStatus(status, 'No valid email addresses were found.', 'error');
  let sent = 0; const failures = [];
  for (const email of emails) { try { await api('/v1/portal/invitations', { method: 'POST', body: JSON.stringify({ email }) }); sent += 1; } catch (error) { failures.push(`${email}: ${error.message}`); } }
  setStatus(status, `${sent} invitation${sent === 1 ? '' : 's'} queued.${failures.length ? ` ${failures.length} could not be queued.` : ''}`, failures.length ? 'error' : 'success'); await load();
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
  try {
    if (action) {
      const correctedEmail = action.dataset.inviteAction === 'correct' ? prompt('Enter the corrected employee email address') : undefined;
      if (action.dataset.inviteAction === 'correct' && !correctedEmail) return;
      await api(`/v1/portal/invitations/${encodeURIComponent(action.dataset.id)}/action`, { method: 'POST', body: JSON.stringify({ action: action.dataset.inviteAction, email: correctedEmail }) });
    }
    if (remove && confirm('Remove this employee from employer-funded access? Their account and any personal subscription remain unaffected.')) await api(`/v1/portal/members/${encodeURIComponent(remove.dataset.removeMember)}/remove`, { method: 'POST', body: '{}' });
    if (action || remove) await load();
  } catch (error) { setStatus(pageStatus, error.message, 'error'); }
});

document.querySelector('[data-billing]').addEventListener('click', async () => { try { const result = await api('/v1/portal/billing-portal', { method: 'POST', body: '{}' }); location.href = result.url; } catch (error) { setStatus(pageStatus, error.message, 'error'); } });
document.querySelector('[data-seats-form]').addEventListener('submit', async (event) => { event.preventDefault(); const status = document.querySelector('[data-seats-status]'); try { await api('/v1/portal/seats', { method: 'POST', body: JSON.stringify({ seats: Number(new FormData(event.currentTarget).get('seats')) }) }); setStatus(status, 'Seat change sent to Stripe. The portal will update after webhook confirmation.', 'success'); } catch (error) { setStatus(status, error.message, 'error'); } });

load();
