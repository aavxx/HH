'use strict';
// End-to-end tests. Run with: npm test
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'salon-test-'));
process.env.ADMIN_PASSWORD = 'test-pass';
const config = require('./config');
const { server, salonNow, addDays } = require('./server');

let base;
let cookie = '';
async function call(method, url, body, headers = {}) {
  const res = await fetch(base + url, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, headers: res.headers };
}

// Find the next open day at least 2 days ahead (avoids same-day lead-time edge cases).
function nextOpenDay() {
  const days = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  for (let i = 2; i < 14; i++) {
    const d = addDays(salonNow().date, i);
    const [y, m, dd] = d.split('-').map(Number);
    if (config.hours[days[new Date(Date.UTC(y, m - 1, dd)).getUTCDay()]]) return d;
  }
  throw new Error('no open day');
}
function nextClosedDay() {
  const days = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  for (let i = 1; i < 8; i++) {
    const d = addDays(salonNow().date, i);
    const [y, m, dd] = d.split('-').map(Number);
    if (!config.hours[days[new Date(Date.UTC(y, m - 1, dd)).getUTCDay()]]) return d;
  }
  return null;
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const svc = config.services.find((s) => s.minutes === 60) || config.services[0];
const day = nextOpenDay();
const good = { service: svc.id, date: day, name: 'Jane Doe', phone: '+1 555 123 4567', email: 'jane@example.com', notes: 'Hi' };
let firstSlot;
let bookingId;

test('serves homepage and admin page', async () => {
  const home = await call('GET', '/');
  assert.equal(home.status, 200);
  assert.match(home.data, /Book online/);
  const admin = await call('GET', '/admin');
  assert.equal(admin.status, 200);
  assert.match(admin.data, /Staff login/);
  assert.equal((await call('GET', '/nope')).status, 404);
});

test('blocks path traversal', async () => {
  const r = await call('GET', '/..%2fserver.js');
  assert.ok(r.status === 403 || r.status === 404, `got ${r.status}`);
  assert.doesNotMatch(String(r.data), /ADMIN_PASSWORD/);
});

test('config endpoint hides nothing secret', async () => {
  const r = await call('GET', '/api/config');
  assert.equal(r.status, 200);
  assert.equal(r.data.services.length, config.services.length);
  assert.ok(!JSON.stringify(r.data).includes('test-pass'));
});

test('availability lists slots on an open day', async () => {
  const r = await call('GET', `/api/availability?service=${svc.id}&date=${day}`);
  assert.equal(r.status, 200);
  assert.ok(r.data.slots.length > 0);
  firstSlot = r.data.slots[0];
});

test('closed day and past day have no slots', async () => {
  const closed = nextClosedDay();
  if (closed) {
    const r = await call('GET', `/api/availability?service=${svc.id}&date=${closed}`);
    assert.equal(r.data.closed, true);
    assert.equal(r.data.slots.length, 0);
  }
  const past = await call('GET', `/api/availability?service=${svc.id}&date=2020-01-07`);
  assert.equal(past.data.slots.length, 0);
});

test('rejects invalid booking input', async () => {
  const r = await call('POST', '/api/bookings', { service: 'x', date: '2025-02-30', time: '25:00', name: '', phone: 'abc' });
  assert.equal(r.status, 400);
  for (const f of ['service', 'date', 'time', 'name', 'phone']) assert.ok(r.data.fields[f], `missing error for ${f}`);
});

test('rejects non-JSON body', async () => {
  const r = await call('POST', '/api/bookings', undefined, { 'Content-Type': 'text/plain' });
  assert.equal(r.status, 415);
});

test('creates a booking', async () => {
  const r = await call('POST', '/api/bookings', { ...good, time: firstSlot });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.match(r.data.reference, /^[A-Z2-9]{6}$/);
});

test('prevents double booking of the same and overlapping times', async () => {
  const same = await call('POST', '/api/bookings', { ...good, time: firstSlot });
  assert.equal(same.status, 409);
  const after = await call('GET', `/api/availability?service=${svc.id}&date=${day}`);
  assert.ok(!after.data.slots.includes(firstSlot));
  // A slot starting inside the booked hour must be gone too.
  const [h, m] = firstSlot.split(':').map(Number);
  const inside = `${String(h + Math.floor((m + 30) / 60)).padStart(2, '0')}:${String((m + 30) % 60).padStart(2, '0')}`;
  assert.ok(!after.data.slots.includes(inside), `${inside} should overlap`);
});

test('rejects a time not on the grid or outside hours', async () => {
  const r1 = await call('POST', '/api/bookings', { ...good, time: '03:00' });
  assert.equal(r1.status, 409);
  const r2 = await call('POST', '/api/bookings', { ...good, time: '23:59' });
  assert.equal(r2.status, 409);
});

test('admin endpoints require login', async () => {
  const r = await call('GET', '/api/admin/bookings');
  assert.equal(r.status, 401);
  const forged = await call('GET', '/api/admin/bookings', undefined, { Cookie: 'admin_session=9999999999999.abc.fake' });
  assert.equal(forged.status, 401);
});

test('wrong password rejected, right password logs in', async () => {
  const bad = await call('POST', '/api/admin/login', { password: 'nope' });
  assert.equal(bad.status, 401);
  const ok = await call('POST', '/api/admin/login', { password: 'test-pass' });
  assert.equal(ok.status, 200);
  const set = ok.headers.get('set-cookie');
  assert.match(set, /HttpOnly/);
  assert.match(set, /SameSite=Strict/);
  cookie = set.split(';')[0];
});

test('admin sees the booking and can change status', async () => {
  const r = await call('GET', '/api/admin/bookings');
  assert.equal(r.status, 200);
  assert.equal(r.data.bookings.length, 1);
  const b = r.data.bookings[0];
  assert.equal(b.name, 'Jane Doe');
  assert.equal(b.status, 'pending');
  bookingId = b.id;
  const c = await call('PATCH', `/api/admin/bookings/${b.id}`, { status: 'confirmed' });
  assert.equal(c.data.booking.status, 'confirmed');
  const bad = await call('PATCH', `/api/admin/bookings/${b.id}`, { status: 'weird' });
  assert.equal(bad.status, 400);
});

test('cancelling frees the slot; restore blocked if re-booked', async () => {
  await call('PATCH', `/api/admin/bookings/${bookingId}`, { status: 'cancelled' });
  const avail = await call('GET', `/api/availability?service=${svc.id}&date=${day}`);
  assert.ok(avail.data.slots.includes(firstSlot));
  const savedCookie = cookie; cookie = '';
  const rebook = await call('POST', '/api/bookings', { ...good, name: 'Someone Else', time: firstSlot });
  assert.equal(rebook.status, 201);
  cookie = savedCookie;
  const restore = await call('PATCH', `/api/admin/bookings/${bookingId}`, { status: 'pending' });
  assert.equal(restore.status, 409);
});

test('admin can delete a booking', async () => {
  const d = await call('DELETE', `/api/admin/bookings/${bookingId}`);
  assert.equal(d.status, 200);
  const r = await call('GET', '/api/admin/bookings');
  assert.equal(r.data.bookings.length, 1);
});

test('reviews: submitted ones are hidden until approved', async () => {
  cookie = '';
  const bad = await call('POST', '/api/reviews', { name: 'A', rating: 9, text: 'x' });
  assert.equal(bad.status, 400);
  const ok = await call('POST', '/api/reviews', { name: 'Maria', rating: 5, text: 'Best haircut I have had in years! <script>x</script>' });
  assert.equal(ok.status, 201);
  assert.equal((await call('GET', '/api/reviews')).data.count, 0);
  await call('POST', '/api/admin/login', { password: 'test-pass' }).then((r) => { cookie = r.headers.get('set-cookie').split(';')[0]; });
  const list = await call('GET', '/api/admin/reviews');
  const id = list.data.reviews[0].id;
  await call('PATCH', `/api/admin/reviews/${id}`, { approved: true });
  cookie = '';
  const pub = await call('GET', '/api/reviews');
  assert.equal(pub.data.count, 1);
  assert.equal(pub.data.average, 5);
});

test('data is persisted to disk', async () => {
  const saved = JSON.parse(fs.readFileSync(path.join(process.env.DATA_DIR, 'db.json'), 'utf8'));
  assert.equal(saved.bookings.length, 1);
  assert.equal(saved.reviews.length, 1);
});

test('logout clears the session cookie', async () => {
  const r = await call('POST', '/api/admin/logout');
  assert.match(r.headers.get('set-cookie'), /Max-Age=0/);
});

test('login is rate limited after 5 failures', async () => {
  let last;
  for (let i = 0; i < 6; i++) last = await call('POST', '/api/admin/login', { password: 'wrong' });
  assert.equal(last.status, 429);
});

(async () => {
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
  let failed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log(`  ✓ ${name}`); } catch (e) { failed++; console.log(`  ✗ ${name}\n    ${e.message}`); }
  }
  server.close();
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
  console.log(failed ? `\n${failed} failed` : `\nAll ${tests.length} tests passed`);
  process.exit(failed ? 1 : 0);
})();
