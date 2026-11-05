'use strict';
/* global el, api, DAY_NAMES, formatTime, formatDate, addDaysYmd, formatDuration, formatPrice, stars, showFieldErrors */

let CONFIG = null;
let selectedTime = null;
let slotsRequest = 0; // guards against out-of-order availability responses

const $ = (sel) => document.querySelector(sel);
const bookingForm = $('#booking-form');
const serviceSelect = $('#b-service');
const dateInput = $('#b-date');
const slotsBox = $('#slots');

// ---------------------------------------------------------------------------
// Mobile nav
// ---------------------------------------------------------------------------
const toggle = $('.nav-toggle');
const navLinks = $('#nav-links');
toggle.addEventListener('click', () => {
  const open = navLinks.classList.toggle('open');
  toggle.setAttribute('aria-expanded', String(open));
  toggle.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
});
navLinks.addEventListener('click', (e) => {
  if (e.target.closest('a')) {
    navLinks.classList.remove('open');
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-label', 'Open menu');
  }
});

$('#year').textContent = new Date().getFullYear();

// ---------------------------------------------------------------------------
// Page content from config
// ---------------------------------------------------------------------------
function fill(key, value) {
  document.querySelectorAll(`[data-bind="${key}"]`).forEach((n) => { n.textContent = value; });
}

function renderConfig(c) {
  document.title = `${c.name} | Book Online`;
  fill('name', c.name);
  fill('tagline', c.tagline);
  fill('stylistLine', `Hair by ${c.stylist}`);
  fill('aboutTitle', `Meet ${c.stylist}`);
  fill('about', c.about);
  fill('address', c.address);
  fill('phone', c.phone);
  fill('email', c.email);
  $('#contact-phone').href = `tel:${c.phone.replace(/[^\d+]/g, '')}`;
  $('#contact-email').href = `mailto:${c.email}`;
  if (c.instagram) {
    $('#contact-ig').href = c.instagram;
    $('#contact-ig-row').hidden = false;
  }

  // Services
  const list = $('#services-list');
  list.replaceChildren(...c.services.map((s) =>
    el('article', { class: 'service' },
      el('div', { class: 'service-top' },
        el('h3', { text: s.name }),
        el('span', { class: 'price', text: formatPrice(s.price, c.currency) })),
      el('p', { class: 'muted', text: s.description || '' }),
      el('div', { class: 'service-bottom' },
        el('span', { class: 'duration', text: formatDuration(s.minutes) }),
        el('a', {
          href: '#book', class: 'link', text: 'Book this →',
          onclick: () => { serviceSelect.value = s.id; onServiceOrDateChange(); },
        })))));

  serviceSelect.append(...c.services.map((s) =>
    el('option', { value: s.id, text: `${s.name} · ${formatDuration(s.minutes)} · ${formatPrice(s.price, c.currency)}` })));

  // Hours
  const order = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  $('#hours-table').replaceChildren(el('tbody', null, order.map((k) => {
    const h = c.hours[k];
    return el('tr', { class: h ? '' : 'closed' },
      el('th', { scope: 'row', text: DAY_NAMES[k] }),
      el('td', { text: h ? `${formatTime(h.open)} – ${formatTime(h.close)}` : 'Closed' }));
  })));

  $('#policies').replaceChildren(...c.policies.map((p) => el('li', { text: p })));

  // Date limits
  dateInput.min = c.today;
  dateInput.max = addDaysYmd(c.today, c.maxDaysAhead);
}

// ---------------------------------------------------------------------------
// Booking
// ---------------------------------------------------------------------------
function currentService() {
  return CONFIG && CONFIG.services.find((s) => s.id === serviceSelect.value);
}

function updateSummary() {
  const s = currentService();
  const box = $('#booking-summary');
  if (!s || !dateInput.value || !selectedTime) { box.hidden = true; return; }
  box.replaceChildren(
    el('strong', { text: s.name }),
    el('span', { text: `${formatDate(dateInput.value)} at ${formatTime(selectedTime)}` }),
    el('span', { class: 'muted', text: `${formatDuration(s.minutes)} · ${formatPrice(s.price, CONFIG.currency)}` }));
  box.hidden = false;
}

function slotMessage(text) {
  slotsBox.replaceChildren(el('p', { class: 'muted', text }));
}

async function onServiceOrDateChange() {
  selectedTime = null;
  updateSummary();
  const s = currentService();
  const date = dateInput.value;
  if (!s || !date) { slotMessage('Choose a service and date to see free times.'); return; }
  if ((dateInput.min && date < dateInput.min) || (dateInput.max && date > dateInput.max)) {
    slotMessage(`Please choose a date between ${formatDate(dateInput.min)} and ${formatDate(dateInput.max)}.`);
    return;
  }
  const reqId = ++slotsRequest;
  slotMessage('Checking availability…');
  try {
    const data = await api(`/api/availability?service=${encodeURIComponent(s.id)}&date=${encodeURIComponent(date)}`);
    if (reqId !== slotsRequest) return;
    if (data.closed) { slotMessage(`We're closed on ${formatDate(date, { weekday: 'long' })}s. Please pick another day.`); return; }
    if (!data.slots.length) { slotMessage('No free times left that day for this service. Try another day.'); return; }
    slotsBox.replaceChildren(...data.slots.map((t) => el('button', {
      type: 'button', class: 'slot', role: 'radio', 'aria-checked': 'false', 'data-time': t, text: formatTime(t),
      onclick: (e) => selectSlot(e.currentTarget),
    })));
  } catch (err) {
    if (reqId === slotsRequest) slotMessage(err.message);
  }
}

function selectSlot(btn) {
  slotsBox.querySelectorAll('.slot').forEach((b) => b.setAttribute('aria-checked', 'false'));
  btn.setAttribute('aria-checked', 'true');
  selectedTime = btn.dataset.time;
  bookingForm.querySelector('[data-err="time"]').textContent = '';
  updateSummary();
}

serviceSelect.addEventListener('change', onServiceOrDateChange);
dateInput.addEventListener('change', onServiceOrDateChange);

bookingForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(bookingForm);
  const payload = {
    service: fd.get('service'), date: fd.get('date'), time: selectedTime,
    name: fd.get('name'), phone: fd.get('phone'), email: fd.get('email'), notes: fd.get('notes'), website: fd.get('website'),
  };

  // Client-side checks (the server checks everything again).
  const errs = {};
  if (!payload.service) errs.service = 'Choose a service.';
  if (!payload.date) errs.date = 'Choose a date.';
  if (!payload.time) errs.time = 'Pick a time.';
  if (!payload.name || payload.name.trim().length < 2) errs.name = 'Enter your name.';
  if (!payload.phone || payload.phone.replace(/\D/g, '').length < 7) errs.phone = 'Enter a valid phone number.';
  showFieldErrors(bookingForm, errs);
  const errorBox = $('#booking-error');
  if (Object.keys(errs).length) {
    errorBox.textContent = 'Please fill in the highlighted fields.';
    errorBox.hidden = false;
    return;
  }

  const btn = $('#booking-submit');
  btn.disabled = true;
  btn.textContent = 'Booking…';
  errorBox.hidden = true;
  try {
    const r = await api('/api/bookings', { method: 'POST', body: payload });
    $('#booking-done-text').textContent =
      `${r.service} on ${formatDate(r.date)} at ${formatTime(r.time)} (${formatDuration(r.minutes)}).`;
    $('#booking-ref').textContent = r.reference;
    bookingForm.hidden = true;
    const done = $('#booking-done');
    done.hidden = false;
    done.focus();
    done.scrollIntoView({ behavior: 'smooth', block: 'center' });
  } catch (err) {
    showFieldErrors(bookingForm, (err.data && err.data.fields) || {});
    errorBox.textContent = err.message;
    errorBox.hidden = false;
    if (err.status === 409) onServiceOrDateChange(); // refresh slots
  } finally {
    btn.disabled = false;
    btn.textContent = 'Request booking';
  }
});

$('#booking-again').addEventListener('click', () => {
  bookingForm.reset();
  showFieldErrors(bookingForm, {});
  $('#booking-error').hidden = true;
  $('#booking-done').hidden = true;
  bookingForm.hidden = false;
  onServiceOrDateChange();
  bookingForm.scrollIntoView({ behavior: 'smooth' });
});

// ---------------------------------------------------------------------------
// Reviews
// ---------------------------------------------------------------------------
async function loadReviews() {
  const list = $('#reviews-list');
  try {
    const data = await api('/api/reviews');
    if (!data.count) {
      $('#reviews-summary').textContent = 'No reviews yet. Been in recently? Be the first.';
      list.replaceChildren();
      return;
    }
    const summary = `${data.average.toFixed(1)} out of 5 from ${data.count} review${data.count === 1 ? '' : 's'}`;
    $('#reviews-summary').textContent = summary;
    const hero = $('#hero-rating');
    hero.textContent = `${stars(data.average)}  ${summary}`;
    hero.hidden = false;
    list.replaceChildren(...data.reviews.slice(0, 12).map((r) =>
      el('figure', { class: 'review card' },
        el('div', { class: 'stars', 'aria-label': `${r.rating} out of 5 stars`, text: stars(r.rating) }),
        el('blockquote', { text: r.text }),
        el('figcaption', null,
          el('strong', { text: r.name }),
          el('span', { class: 'muted', text: new Date(r.createdAt).toLocaleDateString(undefined, { month: 'short', year: 'numeric' }) })))));
  } catch (err) {
    $('#reviews-summary').textContent = 'Reviews could not be loaded right now.';
  }
}

const reviewForm = $('#review-form');
reviewForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(reviewForm);
  const payload = { rating: Number(fd.get('rating')), name: fd.get('name'), text: fd.get('text'), website: fd.get('website') };
  const errorBox = $('#review-error');
  const btn = reviewForm.querySelector('button[type="submit"]');
  btn.disabled = true;
  errorBox.hidden = true;
  try {
    await api('/api/reviews', { method: 'POST', body: payload });
    reviewForm.hidden = true;
    $('#review-done').hidden = false;
  } catch (err) {
    showFieldErrors(reviewForm, (err.data && err.data.fields) || {});
    errorBox.textContent = err.message;
    errorBox.hidden = false;
  } finally {
    btn.disabled = false;
  }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
(async function init() {
  try {
    CONFIG = await api('/api/config');
    renderConfig(CONFIG);
  } catch (err) {
    slotMessage('Online booking is unavailable right now. Please call to book.');
    $('#booking-submit').disabled = true;
  }
  loadReviews();
})();
