'use strict';
/* global el, api, formatTime, formatDate, formatDuration, formatPrice, stars */

const $ = (sel) => document.querySelector(sel);
let CONFIG = null;
let bookings = [];
let reviews = [];
let today = '';
let filter = 'upcoming';

const STATUS_LABEL = { pending: 'Pending', confirmed: 'Confirmed', completed: 'Completed', cancelled: 'Cancelled' };

function showError(msg) {
  const box = $('#admin-error');
  box.textContent = msg || '';
  box.hidden = !msg;
}

function handleAuthError(err) {
  if (err.status === 401) { showLogin(); return true; }
  return false;
}

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------
function showLogin() {
  $('#app-view').hidden = true;
  $('#logout').hidden = true;
  $('#login-view').hidden = false;
  $('#login-form [name="password"]').focus();
}

async function showApp() {
  $('#login-view').hidden = true;
  $('#app-view').hidden = false;
  $('#logout').hidden = false;
  await Promise.all([loadBookings(), loadReviews()]);
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  const btn = form.querySelector('button');
  const errBox = $('#login-error');
  btn.disabled = true;
  errBox.hidden = true;
  try {
    await api('/api/admin/login', { method: 'POST', body: { password: form.password.value } });
    form.reset();
    await showApp();
  } catch (err) {
    errBox.textContent = err.message;
    errBox.hidden = false;
  } finally {
    btn.disabled = false;
  }
});

$('#logout').addEventListener('click', async () => {
  try { await api('/api/admin/logout', { method: 'POST' }); } catch { /* ignore */ }
  bookings = [];
  reviews = [];
  showLogin();
});

// ---------------------------------------------------------------------------
// Bookings
// ---------------------------------------------------------------------------
async function loadBookings() {
  try {
    const data = await api('/api/admin/bookings');
    bookings = data.bookings;
    today = data.today;
    showError('');
    renderStats();
    renderBookings();
  } catch (err) {
    if (!handleAuthError(err)) showError(err.message);
  }
}

function renderStats() {
  const active = bookings.filter((b) => b.status !== 'cancelled');
  const todays = active.filter((b) => b.date === today);
  const upcoming = active.filter((b) => b.date >= today && b.status !== 'completed');
  const pending = active.filter((b) => b.status === 'pending' && b.date >= today);
  const weekEnd = addDaysLocal(today, 6);
  const weekRevenue = active.filter((b) => b.date >= today && b.date <= weekEnd).reduce((s, b) => s + (b.price || 0), 0);
  const stat = (label, value, f) => el('button', { class: 'stat card', onclick: f ? () => setFilter(f) : null },
    el('span', { class: 'stat-value', text: String(value) }), el('span', { class: 'stat-label', text: label }));
  $('#stats').replaceChildren(
    stat('Today', todays.length, 'today'),
    stat('Upcoming', upcoming.length, 'upcoming'),
    stat('Need confirming', pending.length, 'pending'),
    stat('Booked next 7 days', CONFIG ? formatPrice(weekRevenue, CONFIG.currency) : weekRevenue, null));
}

function addDaysLocal(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

function setFilter(f) {
  filter = f;
  $('#date-filter').value = '';
  document.querySelectorAll('#filters .chip').forEach((c) => c.setAttribute('aria-pressed', String(c.dataset.filter === f)));
  renderBookings();
}

function filteredBookings() {
  const q = $('#search').value.trim().toLowerCase();
  const day = $('#date-filter').value;
  let list = bookings;
  if (day) {
    list = list.filter((b) => b.date === day);
  } else {
    switch (filter) {
      case 'today': list = list.filter((b) => b.date === today && b.status !== 'cancelled'); break;
      case 'upcoming': list = list.filter((b) => b.date >= today && (b.status === 'pending' || b.status === 'confirmed')); break;
      case 'pending': list = list.filter((b) => b.status === 'pending'); break;
      case 'past': list = list.filter((b) => b.date < today && b.status !== 'cancelled').reverse(); break;
      case 'cancelled': list = list.filter((b) => b.status === 'cancelled'); break;
      default: break;
    }
  }
  if (q) {
    const qDigits = q.replace(/\D/g, '');
    list = list.filter((b) =>
      b.name.toLowerCase().includes(q) ||
      b.reference.toLowerCase().includes(q) ||
      (b.email || '').includes(q) ||
      b.serviceName.toLowerCase().includes(q) ||
      (qDigits.length >= 3 && b.phone.replace(/\D/g, '').includes(qDigits)));
  }
  return list;
}

function endTime(b) {
  const [h, m] = b.time.split(':').map(Number);
  const total = h * 60 + m + b.minutes;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function actionButtons(b) {
  const btn = (label, status, cls = '') => el('button', {
    class: `btn btn-small ${cls}`, text: label, onclick: () => updateStatus(b, status),
  });
  const out = [];
  if (b.status === 'pending') out.push(btn('Confirm', 'confirmed'));
  if (b.status === 'confirmed' || (b.status === 'pending' && b.date <= today)) out.push(btn('Mark done', 'completed', 'btn-ghost'));
  if (b.status === 'pending' || b.status === 'confirmed') out.push(btn('Cancel', 'cancelled', 'btn-ghost btn-danger'));
  if (b.status === 'cancelled') out.push(btn('Restore', 'pending', 'btn-ghost'));
  if (b.status === 'completed') out.push(btn('Undo', 'confirmed', 'btn-ghost'));
  out.push(el('button', { class: 'btn btn-small btn-ghost btn-danger', text: 'Delete', onclick: () => deleteBooking(b) }));
  return out;
}

function renderBookings() {
  const list = filteredBookings();
  const box = $('#bookings-list');
  if (!list.length) {
    box.replaceChildren(el('p', { class: 'empty card', text: 'No bookings here.' }));
    return;
  }
  // Group by date for easy reading.
  const groups = new Map();
  for (const b of list) {
    if (!groups.has(b.date)) groups.set(b.date, []);
    groups.get(b.date).push(b);
  }
  box.replaceChildren(...[...groups].map(([date, items]) =>
    el('section', { class: 'day-group' },
      el('h2', { class: 'day-title' },
        formatDate(date), date === today ? el('span', { class: 'badge', text: 'Today' }) : null,
        el('span', { class: 'muted day-count', text: `${items.length} booking${items.length === 1 ? '' : 's'}` })),
      items.map((b) =>
        el('article', { class: `booking-row card row-${b.status}` },
          el('div', { class: 'b-time' },
            el('strong', { text: formatTime(b.time) }),
            el('span', { class: 'muted', text: `to ${formatTime(endTime(b))}` })),
          el('div', { class: 'b-main' },
            el('div', { class: 'b-name' },
              el('strong', { text: b.name }),
              el('span', { class: `status status-${b.status}`, text: STATUS_LABEL[b.status] || b.status })),
            el('div', { class: 'b-service', text: `${b.serviceName} · ${formatDuration(b.minutes)}${CONFIG ? ` · ${formatPrice(b.price, CONFIG.currency)}` : ''}` }),
            el('div', { class: 'b-contact' },
              el('a', { href: `tel:${b.phone.replace(/[^\d+]/g, '')}`, text: b.phone }),
              b.email ? el('a', { href: `mailto:${b.email}`, text: b.email }) : null,
              el('span', { class: 'muted', text: `Ref ${b.reference}` })),
            b.notes ? el('p', { class: 'b-notes', text: b.notes }) : null),
          el('div', { class: 'b-actions' }, actionButtons(b)))))));
}

async function updateStatus(b, status) {
  if (status === 'cancelled' && !confirm(`Cancel ${b.name}'s booking on ${formatDate(b.date)} at ${formatTime(b.time)}?`)) return;
  try {
    await api(`/api/admin/bookings/${b.id}`, { method: 'PATCH', body: { status } });
    await loadBookings();
  } catch (err) {
    if (!handleAuthError(err)) showError(err.message);
  }
}

async function deleteBooking(b) {
  if (!confirm(`Permanently delete ${b.name}'s booking (${b.reference})? This cannot be undone.`)) return;
  try {
    await api(`/api/admin/bookings/${b.id}`, { method: 'DELETE' });
    await loadBookings();
  } catch (err) {
    if (!handleAuthError(err)) showError(err.message);
  }
}

$('#filters').addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (chip) setFilter(chip.dataset.filter);
});
$('#search').addEventListener('input', renderBookings);
$('#date-filter').addEventListener('change', () => {
  if ($('#date-filter').value) document.querySelectorAll('#filters .chip').forEach((c) => c.setAttribute('aria-pressed', 'false'));
  else setFilter(filter);
  renderBookings();
});
$('#refresh').addEventListener('click', () => { loadBookings(); loadReviews(); });

// ---------------------------------------------------------------------------
// Reviews
// ---------------------------------------------------------------------------
async function loadReviews() {
  try {
    const data = await api('/api/admin/reviews');
    reviews = data.reviews;
    renderReviews();
  } catch (err) {
    if (!handleAuthError(err)) showError(err.message);
  }
}

function renderReviews() {
  const pending = reviews.filter((r) => !r.approved).length;
  const badge = $('#pending-reviews');
  badge.textContent = String(pending);
  badge.hidden = pending === 0;

  const box = $('#reviews-admin');
  if (!reviews.length) {
    box.replaceChildren(el('p', { class: 'empty card', text: 'No reviews yet. New reviews from the website show up here for you to approve.' }));
    return;
  }
  box.replaceChildren(...reviews.map((r) =>
    el('article', { class: `review-admin card ${r.approved ? '' : 'is-pending'}` },
      el('div', { class: 'b-name' },
        el('strong', { text: r.name }),
        el('span', { class: 'stars', 'aria-label': `${r.rating} out of 5`, text: stars(r.rating) }),
        el('span', { class: `status ${r.approved ? 'status-confirmed' : 'status-pending'}`, text: r.approved ? 'Live on site' : 'Waiting for approval' })),
      el('p', { text: r.text }),
      el('div', { class: 'b-actions' },
        el('span', { class: 'muted', text: new Date(r.createdAt).toLocaleString() }),
        el('button', {
          class: `btn btn-small ${r.approved ? 'btn-ghost' : ''}`, text: r.approved ? 'Hide' : 'Approve',
          onclick: () => setReview(r, !r.approved),
        }),
        el('button', { class: 'btn btn-small btn-ghost btn-danger', text: 'Delete', onclick: () => deleteReview(r) })))));
}

async function setReview(r, approved) {
  try {
    await api(`/api/admin/reviews/${r.id}`, { method: 'PATCH', body: { approved } });
    await loadReviews();
  } catch (err) {
    if (!handleAuthError(err)) showError(err.message);
  }
}

async function deleteReview(r) {
  if (!confirm(`Delete the review from ${r.name}?`)) return;
  try {
    await api(`/api/admin/reviews/${r.id}`, { method: 'DELETE' });
    await loadReviews();
  } catch (err) {
    if (!handleAuthError(err)) showError(err.message);
  }
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------
document.querySelectorAll('.tab').forEach((tab) => tab.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach((t) => t.setAttribute('aria-selected', String(t === tab)));
  $('#panel-bookings').hidden = tab.dataset.tab !== 'bookings';
  $('#panel-reviews').hidden = tab.dataset.tab !== 'reviews';
}));

// Auto-refresh every 60s while the tab is visible, so new bookings appear.
setInterval(() => {
  if (!document.hidden && !$('#app-view').hidden) { loadBookings(); loadReviews(); }
}, 60000);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
(async function init() {
  try {
    CONFIG = await api('/api/config');
    $('#brand-name').textContent = CONFIG.name;
    document.title = `Booking Portal | ${CONFIG.name}`;
  } catch { /* portal still works without it */ }
  try {
    const me = await api('/api/admin/me');
    if (me.loggedIn) await showApp();
    else showLogin();
  } catch {
    showLogin();
  }
})();
