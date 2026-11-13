import { api, escapeHtml, formatDate, setStatus } from '/common.js';
const status = document.querySelector('[data-status]');

function count(rows, predicate) { return rows.filter(predicate).reduce((total, row) => total + Number(row.count || 0), 0); }

async function load() {
  try {
    const [dashboard, pilots] = await Promise.all([api('/v1/admin/dashboard'), api('/v1/admin/pilot-applications')]);
    document.querySelector('[data-pending]').textContent = count(dashboard.applications, (row) => row.status === 'pending_approval');
    document.querySelector('[data-pilots]').textContent = count(dashboard.organisations, (row) => row.plan_type === 'pilot' && row.status === 'active');
    document.querySelector('[data-paid]').textContent = count(dashboard.organisations, (row) => row.plan_type === 'paid' && row.status === 'active');
    document.querySelector('[data-failed]').textContent = dashboard.failedProvisioning;
    document.querySelector('[data-applications]').innerHTML = pilots.applications.length ? `<table class="table"><thead><tr><th>Organisation</th><th>Contact</th><th>Request</th><th>Status</th><th>Action</th></tr></thead><tbody>${pilots.applications.map((item) => `<tr><td><strong>${escapeHtml(item.company_name)}</strong><br><small>${escapeHtml(item.company_website)}</small></td><td>${escapeHtml(item.contact_name)}<br><small>${escapeHtml(item.business_email)}</small></td><td>${item.requested_seats} seats<br><small>${formatDate(item.created_at)}</small></td><td><span class="tag ${escapeHtml(item.status)}">${escapeHtml(item.status)}</span></td><td>${item.status === 'pending_approval' ? `<div class="inline-actions"><button class="small-button" data-decision="approve" data-id="${escapeHtml(item.id)}" data-seats="${item.requested_seats}">Approve</button><button class="small-button danger" data-decision="reject" data-id="${escapeHtml(item.id)}">Reject</button></div>` : item.organisation_id ? `<div class="inline-actions"><button class="small-button" data-org-action="extend_pilot" data-org="${escapeHtml(item.organisation_id)}">Extend</button><button class="small-button danger" data-org-action="end_pilot" data-org="${escapeHtml(item.organisation_id)}">End</button><button class="small-button" data-org-action="retry_provisioning" data-org="${escapeHtml(item.organisation_id)}">Retry access</button></div>` : ''}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">No applications yet.</div>';
    document.querySelector('[data-audits]').innerHTML = dashboard.audits.length ? `<table class="table"><thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Target</th></tr></thead><tbody>${dashboard.audits.map((item) => `<tr><td>${escapeHtml(formatDate(item.created_at))}</td><td>${escapeHtml(item.actor_email)}<br><small>${escapeHtml(item.actor_role)}</small></td><td>${escapeHtml(item.action)}</td><td>${escapeHtml(item.target_type)}<br><small>${escapeHtml(item.target_id)}</small></td></tr>`).join('')}</tbody></table>` : '<div class="empty">No audit activity yet.</div>';
    setStatus(status, '');
  } catch (error) { if (error.status === 401) location.href = '/sign-in/'; else setStatus(status, error.message, 'error'); }
}

document.addEventListener('click', async (event) => {
  if (event.target.matches('[data-refresh]')) return load();
  const decision = event.target.closest('[data-decision]'); const action = event.target.closest('[data-org-action]');
  try {
    if (decision) {
      const approved = decision.dataset.decision === 'approve';
      const days = approved ? Number(prompt('Pilot duration in days', '30')) : null;
      if (approved && (!Number.isInteger(days) || days < 1 || days > 90)) return setStatus(status, 'Enter a duration from 1 to 90 days.', 'error');
      await api(`/v1/admin/pilot-applications/${encodeURIComponent(decision.dataset.id)}/decision`, { method: 'POST', body: JSON.stringify({ decision: decision.dataset.decision, seats: Number(decision.dataset.seats), days }) });
    }
    if (action) {
      let days;
      if (action.dataset.orgAction === 'extend_pilot') { days = Number(prompt('Extend by how many days?', '7')); if (!Number.isInteger(days) || days < 1 || days > 90) return; }
      if (action.dataset.orgAction === 'end_pilot' && !confirm('End this pilot and employer-funded access now? Personal subscriptions remain unaffected.')) return;
      await api(`/v1/admin/organisations/${encodeURIComponent(action.dataset.org)}/action`, { method: 'POST', body: JSON.stringify({ action: action.dataset.orgAction, days }) });
    }
    if (decision || action) { setStatus(status, 'Update completed.', 'success'); await load(); }
  } catch (error) { setStatus(status, error.message, 'error'); }
});
load();
