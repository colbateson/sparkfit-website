import { api, escapeHtml, formatDate, setStatus } from '/common.js';
const status = document.querySelector('[data-status]');

function count(rows, predicate) { return rows.filter(predicate).reduce((total, row) => total + Number(row.count || 0), 0); }
const pounds = (pence) => pence === null || pence === undefined ? 'Not recorded' : new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(Number(pence) / 100);
const date = (value) => value ? formatDate(value) : 'Not set';
const title = (value) => ({ payment_attention: 'Payment needs attention', pending: 'Payment pending', active: 'Active', ended: 'Ended', suspended: 'Suspended', expired: 'Expired', cancelled: 'Cancelled' }[value] || value || 'Not recorded');

function renderOrganisations(rows) {
  if (!rows.length) return '<div class="empty">No organisations have signed up yet.</div>';
  return rows.map((org) => {
    const capacity = Number(org.seats_purchased || org.seat_limit || 0);
    const activated = Number(org.activated_seats || 0);
    const pending = Number(org.pending_invitations || 0);
    const available = Math.max(0, capacity - activated - pending);
    const percent = capacity ? Math.min(100, Math.round((activated / capacity) * 100)) : 0;
    const plan = org.plan_type === 'paid' ? 'Annual paid plan' : 'Employee pilot';
    const billingState = org.plan_type === 'pilot' ? `Pilot ends ${date(org.expires_at)}`
      : org.subscription_status === 'payment_attention' ? `Payment needs attention${org.grace_ends_at ? ` · grace ends ${date(org.grace_ends_at)}` : ''}`
        : org.cancel_at_period_end ? `Ends ${date(org.current_period_end)}`
          : `${title(org.subscription_status)}${org.current_period_end ? ` · renews ${date(org.current_period_end)}` : ''}`;
    const price = org.plan_type === 'paid' ? `${pounds(org.annual_total_ex_vat)} / year, excluding VAT` : 'No charge during pilot';
    const discount = Number(org.discount_bps) > 0 ? `${Number(org.discount_bps) / 100}% volume discount` : '';
    const nextSeats = Number(org.pending_seats) > 0 ? `${org.pending_seats} seats from ${date(org.current_period_end)}` : '';
    const contactInfo = [org.contact_title, org.workforce_size ? `${org.workforce_size} employees` : ''].filter(Boolean).join(' · ');
    const emailLink = org.billing_contact ? `<a href="mailto:${escapeHtml(org.billing_contact)}">${escapeHtml(org.billing_contact)}</a>` : 'No contact email recorded';
    const websiteLink = org.contact_website ? `<a href="${escapeHtml(/^https?:\/\//i.test(org.contact_website) ? org.contact_website : `https://${org.contact_website}`)}" target="_blank" rel="noopener noreferrer">${escapeHtml(org.contact_website)}</a>` : '';
    const renewalEmail = org.billing_contact ? `<a class="small-button" href="mailto:${escapeHtml(org.billing_contact)}?subject=${encodeURIComponent(`SparkFit renewal for ${org.name}`)}">Email contact</a>` : '';
    const pilotNotes = org.pilot_message ? `<details class="org-notes"><summary>Original pilot enquiry</summary><p>${escapeHtml(org.pilot_message)}</p></details>` : '';
    return `<article class="org-card"><header class="org-card-head"><div><h3>${escapeHtml(org.name)}</h3><p class="org-contact-name">${escapeHtml(org.contact_name || 'Primary contact not recorded')}${contactInfo ? ` · ${escapeHtml(contactInfo)}` : ''}</p><p>${emailLink}${websiteLink ? ` · ${websiteLink}` : ''}</p></div><div class="org-tags"><span class="tag">${escapeHtml(plan)}</span><span class="tag ${escapeHtml(org.organisation_status)}">${escapeHtml(title(org.organisation_status))}</span></div></header><div class="org-facts"><div class="org-fact"><span>Subscription</span><strong>${escapeHtml(title(org.subscription_status || org.organisation_status))}</strong><small>${escapeHtml(billingState)}</small></div><div class="org-fact"><span>Seats purchased</span><strong>${capacity}</strong><small>${escapeHtml(nextSeats || 'Current subscription capacity')}</small></div><div class="org-fact"><span>Activated employees</span><strong>${activated} of ${capacity}</strong><div class="org-seat-meter" role="progressbar" aria-label="Activated employee seats" aria-valuemin="0" aria-valuemax="${capacity}" aria-valuenow="${Math.min(activated, capacity)}"><span style="width:${percent}%"></span></div></div><div class="org-fact"><span>Invitations pending</span><strong>${pending}</strong><small>${available} seats available to allocate</small></div><div class="org-fact"><span>Annual price</span><strong>${escapeHtml(price)}</strong><small>${escapeHtml(discount || (org.plan_type === 'paid' ? 'Volume pricing applied at checkout' : ''))}</small></div><div class="org-fact"><span>Purchase date</span><strong>${escapeHtml(date(org.purchase_date || org.starts_at || org.created_at))}</strong><small>Renewal or end date: ${escapeHtml(date(org.current_period_end || org.expires_at))}</small></div></div>${pilotNotes}<div class="org-actions">${renewalEmail}</div></article>`;
  }).join('');
}

async function load() {
  try {
    const [dashboard, pilots] = await Promise.all([api('/v1/admin/dashboard'), api('/v1/admin/pilot-applications')]);
    document.querySelector('[data-pending]').textContent = count(dashboard.applications, (row) => row.status === 'pending_approval');
    document.querySelector('[data-pilots]').textContent = count(dashboard.organisations, (row) => row.plan_type === 'pilot' && row.status === 'active');
    document.querySelector('[data-paid]').textContent = count(dashboard.organisations, (row) => row.plan_type === 'paid' && row.status === 'active');
    document.querySelector('[data-failed]').textContent = dashboard.failedProvisioning;
    document.querySelector('[data-organisations]').innerHTML = renderOrganisations(dashboard.organisationOverview || []);
    document.querySelector('[data-applications]').innerHTML = pilots.applications.length ? `<table class="table"><thead><tr><th>Organisation</th><th>Contact</th><th>Request</th><th>Status</th><th>Action</th></tr></thead><tbody>${pilots.applications.map((item) => `<tr><td><strong>${escapeHtml(item.company_name)}</strong><br><small>${escapeHtml(item.company_website)}</small></td><td>${escapeHtml(item.contact_name)}<br><small>${escapeHtml(item.business_email)}</small></td><td>${item.requested_seats} seats<br><small>${formatDate(item.created_at)}</small></td><td><span class="tag ${escapeHtml(item.status)}">${escapeHtml(item.status)}</span></td><td>${item.status === 'pending_approval' ? `<div class="inline-actions"><button class="small-button" data-decision="approve" data-id="${escapeHtml(item.id)}" data-seats="${item.requested_seats}">Approve</button><button class="small-button danger" data-decision="reject" data-id="${escapeHtml(item.id)}">Reject</button></div>` : item.organisation_id ? `<div class="inline-actions"><button class="small-button" data-org-action="extend_pilot" data-org="${escapeHtml(item.organisation_id)}">Extend</button><button class="small-button danger" data-org-action="end_pilot" data-org="${escapeHtml(item.organisation_id)}">End</button><button class="small-button" data-org-action="retry_provisioning" data-org="${escapeHtml(item.organisation_id)}">Retry access</button></div>` : ''}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">No applications yet.</div>';
    document.querySelector('[data-audits]').innerHTML = dashboard.audits.length ? `<table class="table"><thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Target</th></tr></thead><tbody>${dashboard.audits.map((item) => `<tr><td>${escapeHtml(formatDate(item.created_at))}</td><td>${escapeHtml(item.actor_email)}<br><small>${escapeHtml(item.actor_role)}</small></td><td>${escapeHtml(item.action)}</td><td>${escapeHtml(item.target_type)}<br><small>${escapeHtml(item.target_id)}</small></td></tr>`).join('')}</tbody></table>` : '<div class="empty">No audit activity yet.</div>';
    setStatus(status, '');
  } catch (error) { if (error.status === 401) location.href = '/admin/sign-in/'; else setStatus(status, error.message, 'error'); }
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
