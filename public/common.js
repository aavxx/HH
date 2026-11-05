'use strict';
// Shared helpers for the public site and the admin portal.

// Build DOM nodes safely (text is always set via textContent, never innerHTML).
function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? '' : v);
    }
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

async function api(path, options = {}) {
  const opts = { credentials: 'same-origin', ...options, headers: { ...(options.headers || {}) } };
  if (opts.body !== undefined && typeof opts.body !== 'string') {
    opts.body = JSON.stringify(opts.body);
    opts.headers['Content-Type'] = 'application/json';
  }
  let res;
  try {
    res = await fetch(path, opts);
  } catch {
    throw Object.assign(new Error('Could not reach the server. Check your connection and try again.'), { status: 0 });
  }
  let data = {};
  try { data = await res.json(); } catch { /* non-JSON response */ }
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status, data });
  return data;
}

const DAY_NAMES = { sun: 'Sunday', mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday' };

function formatTime(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const suffix = h >= 12 ? 'pm' : 'am';
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${suffix}`;
}

// Dates are plain "YYYY-MM-DD" in the salon's zone; format them without time-zone shifts.
function formatDate(ymd, opts = { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, { ...opts, timeZone: 'UTC' });
}

function addDaysYmd(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}

function formatDuration(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return [h ? `${h} hr` : '', m ? `${m} min` : ''].filter(Boolean).join(' ');
}

function formatPrice(amount, currency) {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: amount % 1 ? 2 : 0 }).format(amount);
  } catch {
    return `${amount} ${currency}`;
  }
}

function stars(n) {
  const full = Math.round(n);
  return '★'.repeat(full) + '☆'.repeat(5 - full);
}

function showFieldErrors(form, fields = {}) {
  form.querySelectorAll('[data-err]').forEach((e) => { e.textContent = ''; });
  form.querySelectorAll('[aria-invalid]').forEach((e) => e.removeAttribute('aria-invalid'));
  for (const [name, msg] of Object.entries(fields)) {
    const slot = form.querySelector(`[data-err="${name}"]`);
    if (slot) slot.textContent = msg;
    const input = form.querySelector(`[name="${name}"]`);
    if (input) input.setAttribute('aria-invalid', 'true');
  }
}
