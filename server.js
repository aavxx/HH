'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const SESSION_HOURS = 12;
const COOKIE_NAME = 'admin_session';
const SECURE_COOKIE = process.env.NODE_ENV === 'production';

let ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (!ADMIN_PASSWORD) {
  ADMIN_PASSWORD = crypto.randomBytes(9).toString('base64url');
  console.warn('\n  ADMIN_PASSWORD is not set. A temporary password was generated for this run:');
  console.warn(`  ${ADMIN_PASSWORD}`);
  console.warn('  Set ADMIN_PASSWORD in the environment to choose your own.\n');
}
// Sessions survive restarts only if SESSION_SECRET is set.
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const BOOKING_STATUSES = ['pending', 'confirmed', 'completed', 'cancelled'];

// ---------------------------------------------------------------------------
// Validate config at startup so mistakes fail loudly, not silently.
// ---------------------------------------------------------------------------
function toMinutes(hhmm) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm);
  return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
}
function fromMinutes(min) {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}
(function validateConfig() {
  const ids = new Set();
  for (const s of config.services) {
    if (!s.id || ids.has(s.id)) throw new Error(`config: duplicate or missing service id "${s.id}"`);
    if (!(s.minutes > 0)) throw new Error(`config: service "${s.id}" needs minutes > 0`);
    ids.add(s.id);
  }
  for (const k of DAY_KEYS) {
    const h = config.hours[k];
    if (h === null || h === undefined) continue;
    const o = toMinutes(h.open);
    const c = toMinutes(h.close);
    if (Number.isNaN(o) || Number.isNaN(c) || o >= c) throw new Error(`config: bad hours for ${k}`);
  }
  if (!(config.slotMinutes > 0)) throw new Error('config: slotMinutes must be > 0');
  new Intl.DateTimeFormat('en-US', { timeZone: config.timezone }); // throws on a bad zone
})();

// ---------------------------------------------------------------------------
// Storage: a JSON file, written atomically. All writes are synchronous, so in a
// single Node process two requests can never interleave a read-check-write.
// ---------------------------------------------------------------------------
function loadDb() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) return { bookings: [], reviews: [] };
  const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  db.bookings = Array.isArray(db.bookings) ? db.bookings : [];
  db.reviews = Array.isArray(db.reviews) ? db.reviews : [];
  return db;
}
const db = loadDb();
function saveDb() {
  const tmp = `${DB_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

// ---------------------------------------------------------------------------
// Date / time helpers (all in the salon's time zone)
// ---------------------------------------------------------------------------
function salonNow() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: config.timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t).value;
  return { date: `${get('year')}-${get('month')}-${get('day')}`, minutes: Number(get('hour')) * 60 + Number(get('minute')) };
}
function parseDate(str) {
  if (typeof str !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(str)) return null;
  const [y, m, d] = str.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt;
}
function addDays(dateStr, n) {
  const dt = parseDate(dateStr);
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}
function hoursFor(dateStr) {
  const dt = parseDate(dateStr);
  return config.hours[DAY_KEYS[dt.getUTCDay()]] || null;
}

// Returns the list of free start times ("HH:MM") for a service on a date.
function availableSlots(dateStr, service, ignoreBookingId) {
  const dt = parseDate(dateStr);
  if (!dt) return [];
  const now = salonNow();
  if (dateStr < now.date || dateStr > addDays(now.date, config.maxDaysAhead)) return [];
  const hours = hoursFor(dateStr);
  if (!hours) return [];

  const open = toMinutes(hours.open);
  const close = toMinutes(hours.close);
  const taken = db.bookings
    .filter((b) => b.date === dateStr && b.status !== 'cancelled' && b.id !== ignoreBookingId)
    .map((b) => [toMinutes(b.time), toMinutes(b.time) + b.minutes]);

  const earliest = dateStr === now.date ? now.minutes + config.leadMinutes : -1;
  const slots = [];
  for (let start = open; start + service.minutes <= close; start += config.slotMinutes) {
    if (start < earliest) continue;
    const end = start + service.minutes;
    if (taken.some(([s, e]) => start < e && end > s)) continue;
    slots.push(fromMinutes(start));
  }
  return slots;
}

// ---------------------------------------------------------------------------
// Input helpers
// ---------------------------------------------------------------------------
function cleanText(v, max) {
  if (typeof v !== 'string') return '';
  return v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, max);
}
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
function validPhone(p) {
  const digits = p.replace(/\D/g, '');
  return /^[+\d][\d\s().-]*$/.test(p) && digits.length >= 7 && digits.length <= 15;
}
function newId() {
  return crypto.randomBytes(8).toString('hex');
}
function newReference() {
  // Short, readable, no ambiguous characters.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let ref;
  do {
    ref = Array.from(crypto.randomBytes(6), (b) => alphabet[b % alphabet.length]).join('');
  } while (db.bookings.some((b) => b.reference === ref));
  return ref;
}

// ---------------------------------------------------------------------------
// Auth: signed, expiring cookie. Password compared in constant time.
// ---------------------------------------------------------------------------
function sign(value) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('base64url');
}
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}
function makeSession() {
  const payload = `${Date.now() + SESSION_HOURS * 3600 * 1000}.${newId()}`;
  return `${payload}.${sign(payload)}`;
}
function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((c) => {
    const i = c.indexOf('=');
    if (i > -1) out[c.slice(0, i).trim()] = decodeURIComponent(c.slice(i + 1).trim());
  });
  return out;
}
function isAdmin(req) {
  const token = parseCookies(req)[COOKIE_NAME];
  if (!token) return false;
  const i = token.lastIndexOf('.');
  if (i < 0) return false;
  const payload = token.slice(0, i);
  if (!safeEqual(sign(payload), token.slice(i + 1))) return false;
  return Number(payload.split('.')[0]) > Date.now();
}
function sessionCookie(value, maxAgeSec) {
  return `${COOKIE_NAME}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${SECURE_COOKIE ? '; Secure' : ''}`;
}

// Simple in-memory rate limiter: { key -> [timestamps] }
const hits = new Map();
function rateLimited(key, limit, windowMs) {
  const now = Date.now();
  const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
  list.push(now);
  hits.set(key, list);
  return list.length > limit;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, list] of hits) if (list.every((t) => now - t > 3600 * 1000)) hits.delete(k);
}, 10 * 60 * 1000).unref();

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Content-Security-Policy':
    "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; script-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
};
function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
  res.end(body);
}
function json(res, status, data, headers = {}) {
  send(res, status, JSON.stringify(data), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    if (!(req.headers['content-type'] || '').startsWith('application/json')) {
      return reject(Object.assign(new Error('Expected JSON'), { status: 415 }));
    }
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 20 * 1024) {
        reject(Object.assign(new Error('Request too large'), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        const data = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
        resolve(data);
      } catch {
        reject(Object.assign(new Error('Invalid JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}
function clientIp(req) {
  return req.socket.remoteAddress || 'unknown';
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
};
function serveStatic(req, res, pathname) {
  if (pathname === '/') pathname = '/index.html';
  if (pathname === '/admin' || pathname === '/admin/') pathname = '/admin.html';
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { return send(res, 400, 'Bad request'); }
  const file = path.normalize(path.join(PUBLIC_DIR, decoded));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, 'Forbidden');
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      return fs.readFile(path.join(PUBLIC_DIR, '404.html'), (e, html) =>
        send(res, 404, e ? 'Not found' : html, { 'Content-Type': 'text/html; charset=utf-8' }));
    }
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': type, 'Content-Length': st.size, 'Cache-Control': 'no-cache' });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

// ---------------------------------------------------------------------------
// API handlers
// ---------------------------------------------------------------------------
function publicConfig() {
  const { name, stylist, tagline, about, phone, email, address, instagram, currency, hours, services, policies, maxDaysAhead } = config;
  return { name, stylist, tagline, about, phone, email, address, instagram, currency, hours, services, policies, maxDaysAhead, today: salonNow().date };
}

function publicReview(r) {
  return { id: r.id, name: r.name, rating: r.rating, text: r.text, createdAt: r.createdAt };
}

async function handleApi(req, res, url) {
  const p = url.pathname;
  const m = req.method;

  // ---- Public ----
  if (p === '/api/config' && m === 'GET') return json(res, 200, publicConfig());

  if (p === '/api/availability' && m === 'GET') {
    const service = config.services.find((s) => s.id === url.searchParams.get('service'));
    const date = url.searchParams.get('date');
    if (!service) return json(res, 400, { error: 'Unknown service.' });
    if (!parseDate(date)) return json(res, 400, { error: 'Invalid date.' });
    return json(res, 200, { date, closed: !hoursFor(date), slots: availableSlots(date, service) });
  }

  if (p === '/api/bookings' && m === 'POST') {
    if (rateLimited(`book:${clientIp(req)}`, 10, 60 * 60 * 1000)) {
      return json(res, 429, { error: 'Too many booking attempts. Please call us instead.' });
    }
    const body = await readJson(req);
    if (body.website) return json(res, 201, { ok: true, reference: 'RECEIVED' }); // honeypot
    const service = config.services.find((s) => s.id === body.service);
    const name = cleanText(body.name, 80);
    const phone = cleanText(body.phone, 30);
    const email = cleanText(body.email, 120).toLowerCase();
    const notes = cleanText(body.notes, 500);
    const date = body.date;
    const time = body.time;
    const errors = {};
    if (!service) errors.service = 'Choose a service.';
    if (!parseDate(date)) errors.date = 'Choose a valid date.';
    if (typeof time !== 'string' || Number.isNaN(toMinutes(time))) errors.time = 'Choose a time.';
    if (name.length < 2) errors.name = 'Enter your name.';
    if (!validPhone(phone)) errors.phone = 'Enter a valid phone number.';
    if (email && !EMAIL_RE.test(email)) errors.email = 'Enter a valid email or leave it empty.';
    if (Object.keys(errors).length) return json(res, 400, { error: 'Please fix the highlighted fields.', fields: errors });

    // Re-check availability on the server at the moment of booking.
    if (!availableSlots(date, service).includes(time)) {
      return json(res, 409, { error: 'Sorry, that time was just taken or is no longer available. Please pick another.', fields: { time: 'No longer available.' } });
    }
    const booking = {
      id: newId(),
      reference: newReference(),
      serviceId: service.id,
      serviceName: service.name,
      price: service.price,
      minutes: service.minutes,
      date,
      time,
      name,
      phone,
      email,
      notes,
      status: 'pending',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    db.bookings.push(booking);
    saveDb();
    console.log(`New booking ${booking.reference}: ${booking.date} ${booking.time} ${booking.serviceName} for ${booking.name}`);
    return json(res, 201, {
      ok: true, reference: booking.reference, date, time, service: service.name, minutes: service.minutes, price: service.price,
    });
  }

  if (p === '/api/reviews' && m === 'GET') {
    const approved = db.reviews.filter((r) => r.approved).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const avg = approved.length ? approved.reduce((s, r) => s + r.rating, 0) / approved.length : 0;
    return json(res, 200, { count: approved.length, average: Math.round(avg * 10) / 10, reviews: approved.map(publicReview) });
  }

  if (p === '/api/reviews' && m === 'POST') {
    if (rateLimited(`review:${clientIp(req)}`, 5, 60 * 60 * 1000)) {
      return json(res, 429, { error: 'Too many reviews from this connection. Try again later.' });
    }
    const body = await readJson(req);
    if (body.website) return json(res, 201, { ok: true });
    const name = cleanText(body.name, 60);
    const text = cleanText(body.text, 1000);
    const rating = Number(body.rating);
    const errors = {};
    if (name.length < 2) errors.name = 'Enter your name.';
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) errors.rating = 'Pick a rating from 1 to 5 stars.';
    if (text.length < 10) errors.text = 'Write at least a short sentence (10+ characters).';
    if (Object.keys(errors).length) return json(res, 400, { error: 'Please fix the highlighted fields.', fields: errors });
    db.reviews.push({ id: newId(), name, rating, text, approved: false, createdAt: new Date().toISOString() });
    saveDb();
    return json(res, 201, { ok: true });
  }

  // ---- Admin auth ----
  if (p === '/api/admin/login' && m === 'POST') {
    const ip = clientIp(req);
    const body = await readJson(req);
    const recentFails = (hits.get(`login:${ip}`) || []).filter((t) => Date.now() - t < 15 * 60 * 1000).length;
    if (recentFails >= 5) return json(res, 429, { error: 'Too many failed attempts. Wait 15 minutes and try again.' });
    if (typeof body.password !== 'string' || !safeEqual(body.password, ADMIN_PASSWORD)) {
      rateLimited(`login:${ip}`, Infinity, 15 * 60 * 1000); // record the failure
      return json(res, 401, { error: 'Wrong password.' });
    }
    hits.delete(`login:${ip}`);
    return json(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(makeSession(), SESSION_HOURS * 3600) });
  }
  if (p === '/api/admin/logout' && m === 'POST') {
    return json(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie('', 0) });
  }
  if (p === '/api/admin/me' && m === 'GET') return json(res, 200, { loggedIn: isAdmin(req) });

  // ---- Admin (protected) ----
  if (p.startsWith('/api/admin/')) {
    if (!isAdmin(req)) return json(res, 401, { error: 'Please log in.' });

    if (p === '/api/admin/bookings' && m === 'GET') {
      const list = [...db.bookings].sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
      return json(res, 200, { today: salonNow().date, bookings: list });
    }

    let match = /^\/api\/admin\/bookings\/([a-f0-9]{16})$/.exec(p);
    if (match) {
      const booking = db.bookings.find((b) => b.id === match[1]);
      if (!booking) return json(res, 404, { error: 'Booking not found.' });
      if (m === 'PATCH') {
        const body = await readJson(req);
        if (!BOOKING_STATUSES.includes(body.status)) return json(res, 400, { error: 'Invalid status.' });
        // Re-activating a cancelled booking must not create a double booking.
        if (booking.status === 'cancelled' && body.status !== 'cancelled') {
          const clash = db.bookings.some((b) => b.id !== booking.id && b.date === booking.date && b.status !== 'cancelled' &&
            toMinutes(booking.time) < toMinutes(b.time) + b.minutes && toMinutes(booking.time) + booking.minutes > toMinutes(b.time));
          if (clash) return json(res, 409, { error: 'That time now overlaps another booking, so it cannot be restored.' });
        }
        booking.status = body.status;
        booking.updatedAt = new Date().toISOString();
        saveDb();
        return json(res, 200, { ok: true, booking });
      }
      if (m === 'DELETE') {
        db.bookings = db.bookings.filter((b) => b.id !== booking.id);
        saveDb();
        return json(res, 200, { ok: true });
      }
    }

    if (p === '/api/admin/reviews' && m === 'GET') {
      const list = [...db.reviews].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return json(res, 200, { reviews: list });
    }

    match = /^\/api\/admin\/reviews\/([a-f0-9]{16})$/.exec(p);
    if (match) {
      const review = db.reviews.find((r) => r.id === match[1]);
      if (!review) return json(res, 404, { error: 'Review not found.' });
      if (m === 'PATCH') {
        const body = await readJson(req);
        if (typeof body.approved !== 'boolean') return json(res, 400, { error: 'approved must be true or false.' });
        review.approved = body.approved;
        saveDb();
        return json(res, 200, { ok: true, review });
      }
      if (m === 'DELETE') {
        db.reviews = db.reviews.filter((r) => r.id !== review.id);
        saveDb();
        return json(res, 200, { ok: true });
      }
    }
  }

  return json(res, 404, { error: 'Not found.' });
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    return send(res, 400, 'Bad request');
  }
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
    return serveStatic(req, res, url.pathname);
  } catch (err) {
    if (err.status) return json(res, err.status, { error: err.message });
    console.error(err);
    if (!res.headersSent) json(res, 500, { error: 'Something went wrong. Please try again or call us.' });
  }
});

if (require.main === module) {
  server.listen(PORT, () => console.log(`${config.name} running at http://localhost:${PORT}  (admin: /admin)`));
}

module.exports = { server, availableSlots, salonNow, addDays };
