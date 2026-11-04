// End-to-end checks for all 5 levels.
//
//   npm test                         -> spins up a throwaway local Postgres + server
//   BASE_URL=https://x API_KEY=k npm test   -> runs against a deployed instance
//
// Note: runs POST /reset, so it wipes all data on the target.
const assert = require('assert/strict');
const path = require('path');
const fs = require('fs');

let BASE = process.env.BASE_URL;
let KEY = process.env.API_KEY || 'test-key-123';
let cleanup = async () => {};

async function startLocal() {
  const EmbeddedPostgres = require('embedded-postgres').default;
  const dir = path.join(require('os').tmpdir(), `clinic-pg-${process.pid}`);
  fs.rmSync(dir, { recursive: true, force: true });
  const pg = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: 'postgres', port: 54329, persistent: false, onLog: () => {} });
  await pg.initialise();
  await pg.start();
  process.env.DATABASE_URL = 'postgres://postgres:postgres@localhost:54329/postgres';
  process.env.API_KEY = KEY;
  const app = require('../src/app');
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  BASE = `http://localhost:${server.address().port}`;
  cleanup = async () => {
    server.close();
    await require('../src/db').pool.end();
    await pg.stop();
  };
}

async function call(method, p, { body, headers = {}, key = KEY, raw } = {}) {
  const h = { ...headers };
  if (key !== null) h['X-API-Key'] = key;
  if (body !== undefined || raw !== undefined) h['Content-Type'] = 'application/json';
  const res = await fetch(BASE + p, { method, headers: h, body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, body: json, headers: res.headers };
}

const future = (mins) => new Date(Date.now() + mins * 60000).toISOString().replace(/\.\d{3}Z$/, 'Z');
const slotsFixture = () => [
  { id: 's3', provider: 'Dr Bello', start: future(180), end: future(210) },
  { id: 's1', provider: 'Dr Ade', start: future(60), end: future(90) },
  { id: 's2', provider: 'Dr Ade', start: future(120), end: future(150) },
  { id: 'past', provider: 'Dr Ade', start: '2020-01-01T09:00:00Z', end: '2020-01-01T09:30:00Z' },
  ...Array.from({ length: 30 }, (_, i) => ({ id: `p${i}`, provider: 'Dr Page', start: future(300 + i * 30), end: future(330 + i * 30) })),
];
const reset = () => call('POST', '/reset', { body: { slots: slotsFixture() } });

let passed = 0;
const failures = [];
async function check(name, fn) {
  try { await fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { failures.push(name); console.log(`  FAIL ${name}\n       ${e.message.split('\n').join('\n       ')}`); }
}

(async () => {
  if (!BASE) await startLocal();
  console.log(`Target: ${BASE}\n`);

  console.log('Level 1');
  await check('reset returns 200', async () => assert.equal((await reset()).status, 200));
  await check('slots sorted by start, with availability, past slot included', async () => {
    const r = await call('GET', '/slots');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.slots.slice(0, 4).map((s) => s.id), ['past', 's1', 's2', 's3']);
    assert.ok(r.body.slots.every((s) => s.available === true));
    assert.deepEqual(Object.keys(r.body.slots[1]).sort(), ['available', 'end', 'id', 'provider', 'start']);
    assert.equal(r.body.slots[1].provider, 'Dr Ade');
    assert.equal(r.body.slots[0].start, '2020-01-01T09:00:00Z'); // echoed exactly as sent
  });
  await check('provider filter is exact match', async () => {
    const r = await call('GET', '/slots?provider=' + encodeURIComponent('Dr Ade'));
    assert.deepEqual(r.body.slots.map((s) => s.id), ['past', 's1', 's2']);
    assert.equal((await call('GET', '/slots?provider=dr%20ade')).body.slots.length, 0);
  });
  let b1;
  await check('book a slot -> 201 confirmed', async () => {
    const r = await call('POST', '/bookings', { body: { slot_id: 's1', name: '  Ada Obi ', email: ' ADA@Example.com ' } });
    assert.equal(r.status, 201);
    b1 = r.body;
    assert.equal(b1.status, 'confirmed');
    assert.equal(b1.name, 'Ada Obi');
    assert.equal(b1.email, 'ada@example.com');
    assert.equal(b1.slot_id, 's1');
    assert.ok(b1.id && !Number.isNaN(Date.parse(b1.created_at)));
  });
  await check('booked slot shows available:false', async () => {
    const r = await call('GET', '/slots');
    assert.equal(r.body.slots.find((s) => s.id === 's1').available, false);
  });
  await check('get booking by id', async () => {
    const r = await call('GET', `/bookings/${b1.id}`);
    assert.equal(r.status, 200); assert.deepEqual(r.body, b1);
  });
  await check('unknown booking -> 404 {error}', async () => {
    const r = await call('GET', '/bookings/nope'); assert.equal(r.status, 404); assert.equal(typeof r.body.error, 'string');
  });
  await check('data persists across reset only when told (reset wipes bookings)', async () => {
    await reset();
    assert.equal((await call('GET', `/bookings/${b1.id}`)).status, 404);
  });

  console.log('\nLevel 2');
  await check('missing key -> 401 on every endpoint', async () => {
    for (const [m, p] of [['GET', '/slots'], ['POST', '/bookings'], ['GET', '/bookings?email=a@b.co'], ['GET', '/bookings/x'], ['DELETE', '/bookings/x'], ['POST', '/reset']]) {
      const r = await call(m, p, { key: null, body: m === 'POST' ? {} : undefined });
      assert.equal(r.status, 401, `${m} ${p}`); assert.equal(typeof r.body.error, 'string');
    }
  });
  await check('wrong key -> 401', async () => assert.equal((await call('GET', '/slots', { key: 'wrong' })).status, 401));
  const bad = [
    [{ name: 'A', email: 'a@b.co' }, 'missing slot_id'],
    [{ slot_id: '', name: 'A', email: 'a@b.co' }, 'empty slot_id'],
    [{ slot_id: 's1', email: 'a@b.co' }, 'missing name'],
    [{ slot_id: 's1', name: '   ', email: 'a@b.co' }, 'blank name'],
    [{ slot_id: 's1', name: 'A' }, 'missing email'],
    [{ slot_id: 's1', name: 'A', email: '' }, 'empty email'],
    [{ slot_id: 's1', name: 'A', email: 'not-an-email' }, 'invalid email'],
    [{ slot_id: 's1', name: 'A', email: 'a@b' }, 'email without tld'],
    [{ slot_id: 1, name: 'A', email: 'a@b.co' }, 'non-string slot_id'],
  ];
  for (const [body, label] of bad) {
    await check(`400 for ${label}`, async () => {
      const r = await call('POST', '/bookings', { body: { ...body, email: body.email === undefined ? undefined : body.email && `${label.replace(/\W/g, '')}${body.email}` } });
      assert.equal(r.status, 400); assert.equal(typeof r.body.error, 'string');
    });
  }
  await check('400 for malformed JSON', async () => assert.equal((await call('POST', '/bookings', { raw: '{bad' })).status, 400));
  await check('404 for unknown slot', async () => {
    const r = await call('POST', '/bookings', { body: { slot_id: 'zzz', name: 'A', email: 'nf@b.co' } });
    assert.equal(r.status, 404); assert.equal(typeof r.body.error, 'string');
  });
  await check('400 for slot that already started', async () => {
    const r = await call('POST', '/bookings', { body: { slot_id: 'past', name: 'A', email: 'past@b.co' } });
    assert.equal(r.status, 400);
  });

  console.log('\nLevel 3');
  await reset();
  await check('second booking of same slot -> 409', async () => {
    assert.equal((await call('POST', '/bookings', { body: { slot_id: 's2', name: 'A', email: 'one@b.co' } })).status, 201);
    const r = await call('POST', '/bookings', { body: { slot_id: 's2', name: 'B', email: 'two@b.co' } });
    assert.equal(r.status, 409); assert.equal(typeof r.body.error, 'string');
  });
  await check('50 simultaneous bookings for one slot -> exactly one 201', async () => {
    const rs = await Promise.all(Array.from({ length: 50 }, (_, i) =>
      call('POST', '/bookings', { body: { slot_id: 's3', name: `P${i}`, email: `race${i}@b.co` } })));
    const codes = rs.map((r) => r.status);
    assert.equal(codes.filter((c) => c === 201).length, 1, JSON.stringify(codes));
    assert.equal(codes.filter((c) => c === 409).length, 49);
  });
  await check('cancel -> 200 cancelled, slot freed, rebook works, double cancel 409', async () => {
    await reset();
    const b = (await call('POST', '/bookings', { body: { slot_id: 's1', name: 'A', email: 'c@b.co' } })).body;
    const d = await call('DELETE', `/bookings/${b.id}`);
    assert.equal(d.status, 200); assert.equal(d.body.status, 'cancelled'); assert.equal(d.body.id, b.id);
    assert.equal((await call('GET', `/bookings/${b.id}`)).body.status, 'cancelled');
    assert.equal((await call('GET', '/slots')).body.slots.find((s) => s.id === 's1').available, true);
    assert.equal((await call('DELETE', `/bookings/${b.id}`)).status, 409);
    assert.equal((await call('POST', '/bookings', { body: { slot_id: 's1', name: 'B', email: 'c2@b.co' } })).status, 201);
  });
  await check('cancel unknown -> 404', async () => assert.equal((await call('DELETE', '/bookings/nope')).status, 404));

  console.log('\nLevel 4');
  await reset();
  await check('same Idempotency-Key + same body -> same status & id, one booking', async () => {
    const body = { slot_id: 's1', name: 'Idem', email: 'idem@b.co' };
    const h = { 'Idempotency-Key': 'key-1' };
    const a = await call('POST', '/bookings', { body, headers: h });
    const b = await call('POST', '/bookings', { body, headers: h });
    assert.equal(a.status, 201); assert.equal(b.status, 201); assert.equal(a.body.id, b.body.id);
    const list = await call('GET', '/bookings?email=idem@b.co');
    assert.equal(list.body.bookings.length, 1);
  });
  await check('same key + different body -> 422', async () => {
    const r = await call('POST', '/bookings', { body: { slot_id: 's2', name: 'Idem', email: 'idem@b.co' }, headers: { 'Idempotency-Key': 'key-1' } });
    assert.equal(r.status, 422); assert.equal(typeof r.body.error, 'string');
  });
  await check('key order in body does not matter', async () => {
    const r = await call('POST', '/bookings', { raw: '{"email":"idem@b.co","name":"Idem","slot_id":"s1"}', headers: { 'Idempotency-Key': 'key-1' } });
    assert.equal(r.status, 201);
  });
  await check('20 simultaneous retries with one key -> one booking, all same id', async () => {
    const body = { slot_id: 's2', name: 'Burst', email: 'burst@b.co' };
    const rs = await Promise.all(Array.from({ length: 20 }, () => call('POST', '/bookings', { body, headers: { 'Idempotency-Key': 'burst-key' } })));
    assert.ok(rs.every((r) => r.status === 201), JSON.stringify(rs.map((r) => r.status)));
    assert.equal(new Set(rs.map((r) => r.body.id)).size, 1);
    assert.equal((await call('GET', '/bookings?email=burst@b.co')).body.bookings.length, 1);
  });
  await check('failed response is replayed too (409 stays 409)', async () => {
    const body = { slot_id: 's2', name: 'Late', email: 'late@b.co' };
    const a = await call('POST', '/bookings', { body, headers: { 'Idempotency-Key': 'late' } });
    const b = await call('POST', '/bookings', { body, headers: { 'Idempotency-Key': 'late' } });
    assert.equal(a.status, 409); assert.equal(b.status, 409);
  });
  await check('pagination: oldest first, cursor walk, null at end, email case-insensitive', async () => {
    await reset();
    const ids = [];
    // 23 bookings for one email. The rate limit (5/min) applies, so wait it out
    // when it kicks in (locally we clear the attempt log instead of waiting).
    for (let i = 0; i < 23; i++) {
      const r = await call('POST', '/bookings', { body: { slot_id: `p${i}`, name: 'Pager', email: 'pager0@b.co' } });
      if (r.status === 429) {
        if (process.env.DATABASE_URL && !process.env.BASE_URL) await require('../src/db').pool.query('DELETE FROM booking_attempts');
        else await new Promise((res) => setTimeout(res, Number(r.headers.get('retry-after')) * 1000));
        i--; continue;
      }
      assert.equal(r.status, 201); ids.push(r.body.id);
    }
    const seen = [];
    let cursor = null; let pages = 0;
    do {
      const q = new URLSearchParams({ email: 'PAGER0@B.CO', limit: '10' }); if (cursor) q.set('cursor', cursor);
      const r = await call('GET', '/bookings?' + q);
      assert.equal(r.status, 200);
      seen.push(...r.body.bookings.map((b) => b.id));
      cursor = r.body.next_cursor; pages++;
    } while (cursor);
    assert.equal(pages, 3); assert.deepEqual(seen, ids);
  });
  await check('default limit 10; exact multiple ends with next_cursor null', async () => {
    const r = await call('GET', '/bookings?email=pager0@b.co');
    assert.equal(r.body.bookings.length, 10); assert.equal(typeof r.body.next_cursor, 'string');
    const all = await call('GET', '/bookings?email=pager0@b.co&limit=23');
    assert.equal(all.body.bookings.length, 23); assert.equal(all.body.next_cursor, null);
    const none = await call('GET', '/bookings?email=nobody@b.co');
    assert.deepEqual(none.body, { bookings: [], next_cursor: null });
  });
  for (const l of ['0', '51', '-1', 'abc', '1.5', '']) {
    await check(`limit=${JSON.stringify(l)} -> 400`, async () => assert.equal((await call('GET', `/bookings?email=a@b.co&limit=${l}`)).status, 400));
  }
  await check('limit 1 and 50 allowed', async () => {
    assert.equal((await call('GET', '/bookings?email=a@b.co&limit=1')).status, 200);
    assert.equal((await call('GET', '/bookings?email=a@b.co&limit=50')).status, 200);
  });
  await check('garbage cursor -> 400', async () => assert.equal((await call('GET', '/bookings?email=a@b.co&cursor=%%%')).status, 400));

  console.log('\nLevel 5');
  await reset();
  await check('6th attempt in a minute -> 429 + Retry-After; failures count; other emails fine', async () => {
    const codes = [];
    codes.push((await call('POST', '/bookings', { body: { slot_id: 's1', name: 'Spam', email: 'spam@b.co' } })).status);
    for (let i = 0; i < 4; i++) codes.push((await call('POST', '/bookings', { body: { slot_id: 'zzz', name: 'Spam', email: 'SPAM@b.co' } })).status);
    assert.deepEqual(codes, [201, 404, 404, 404, 404]);
    const r = await call('POST', '/bookings', { body: { slot_id: 's2', name: 'Spam', email: 'spam@b.co' } });
    assert.equal(r.status, 429); assert.equal(typeof r.body.error, 'string');
    const ra = r.headers.get('retry-after');
    assert.match(ra, /^\d+$/); assert.ok(Number(ra) >= 1 && Number(ra) <= 60, ra);
    assert.equal((await call('POST', '/bookings', { body: { slot_id: 's2', name: 'Other', email: 'other@b.co' } })).status, 201);
  });
  await check('20 simultaneous attempts from one email -> at most 5 get through', async () => {
    const rs = await Promise.all(Array.from({ length: 20 }, (_, i) =>
      call('POST', '/bookings', { body: { slot_id: `p${i}`, name: 'Flood', email: 'flood@b.co' } })));
    const codes = rs.map((r) => r.status);
    assert.equal(codes.filter((c) => c === 201).length, 5, JSON.stringify(codes));
    assert.equal(codes.filter((c) => c === 429).length, 15);
  });

  console.log(`\n${passed} passed, ${failures.length} failed`);
  await cleanup();
  process.exit(failures.length ? 1 : 0);
})().catch(async (e) => { console.error(e); await cleanup().catch(() => {}); process.exit(1); });
