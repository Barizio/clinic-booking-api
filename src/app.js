const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { pool, init } = require('./db');

const API_KEY = process.env.API_KEY;
if (!API_KEY) throw new Error('API_KEY is not set');

const RATE_LIMIT = 5;          // attempts
const RATE_WINDOW_SEC = 60;    // per this many seconds, per email
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const app = express();
app.disable('x-powered-by');
app.set('etag', false);

// CORS, so the page (or anyone's checker) can call from another origin.
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'Content-Type, X-API-Key, Idempotency-Key');
  res.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.set('Access-Control-Expose-Headers', 'Retry-After');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// The web page itself is public; it asks the user for the API key.
app.use(express.static(path.join(__dirname, '..', 'public')));

const err = (res, status, message) => res.status(status).json({ error: message });

// Level 2: every API request needs the key (constant-time compare).
function requireKey(req, res, next) {
  const given = req.get('X-API-Key');
  if (typeof given !== 'string' || given.length === 0) return err(res, 401, 'missing or invalid API key');
  const a = Buffer.from(given);
  const b = Buffer.from(API_KEY);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return err(res, 401, 'missing or invalid API key');
  next();
}
app.use(requireKey);

app.use(express.json({ limit: '1mb' }));
app.use(async (req, res, next) => {
  try { await init(); next(); } catch (e) { next(e); }
});

// ---------- helpers ----------
const iso = (d) => new Date(d).toISOString();
const bookingOut = (r) => ({
  id: r.id, slot_id: r.slot_id, name: r.name, email: r.email, status: r.status, created_at: iso(r.created_at),
});
const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;
const isValidDate = (v) => typeof v === 'string' && !Number.isNaN(Date.parse(v));

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}
const hashBody = (body) => crypto.createHash('sha256').update(canonical(body ?? null)).digest('hex');

const encodeCursor = (seq) => Buffer.from(`seq:${seq}`).toString('base64url');
function decodeCursor(c) {
  const m = /^seq:(\d{1,18})$/.exec(Buffer.from(c, 'base64url').toString());
  return m ? m[1] : null;
}

// ---------- Level 1: reset ----------
app.post('/reset', async (req, res, next) => {
  const slots = req.body && req.body.slots;
  if (!Array.isArray(slots)) return err(res, 400, 'slots must be an array');
  const seen = new Set();
  for (const s of slots) {
    if (!s || !isNonEmptyString(s.id) || !isNonEmptyString(s.provider) || !isValidDate(s.start) || !isValidDate(s.end)) {
      return err(res, 400, 'each slot needs id, provider, start and end');
    }
    if (seen.has(s.id)) return err(res, 400, `duplicate slot id: ${s.id}`);
    seen.add(s.id);
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('LOCK TABLE slots, bookings, idempotency_keys, booking_attempts IN ACCESS EXCLUSIVE MODE');
    await client.query('DELETE FROM bookings');
    await client.query('DELETE FROM idempotency_keys');
    await client.query('DELETE FROM booking_attempts');
    await client.query('DELETE FROM slots');
    if (slots.length) {
      await client.query(
        `INSERT INTO slots (id, provider, start_at, end_at)
         SELECT * FROM unnest($1::text[], $2::text[], $3::timestamptz[], $4::timestamptz[])`,
        [slots.map((s) => s.id), slots.map((s) => s.provider), slots.map((s) => s.start), slots.map((s) => s.end)]
      );
    }
    await client.query('COMMIT');
    res.status(200).json({ ok: true, slots: slots.length });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    next(e);
  } finally {
    client.release();
  }
});

// ---------- Level 1: list slots ----------
app.get('/slots', async (req, res, next) => {
  try {
    const provider = typeof req.query.provider === 'string' ? req.query.provider : null;
    const { rows } = await pool.query(
      `SELECT s.id, s.provider, s.start_at, s.end_at,
              NOT EXISTS (SELECT 1 FROM bookings b WHERE b.slot_id = s.id AND b.status = 'confirmed') AS available
         FROM slots s
        WHERE ($1::text IS NULL OR s.provider = $1)
        ORDER BY s.start_at ASC, s.id ASC`,
      [provider]
    );
    res.json({
      slots: rows.map((r) => ({ id: r.id, provider: r.provider, start: iso(r.start_at), end: iso(r.end_at), available: r.available })),
    });
  } catch (e) { next(e); }
});

// ---------- Levels 1–5: create booking ----------
// Returns { status, body } so the result can be stored for idempotent replay.
async function createBooking(client, body) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const { slot_id } = b;
  if (!isNonEmptyString(slot_id)) return { status: 400, body: { error: 'slot_id is required' } };
  if (!isNonEmptyString(b.name)) return { status: 400, body: { error: 'name is required' } };
  if (!isNonEmptyString(b.email)) return { status: 400, body: { error: 'email is required' } };
  const name = b.name.trim();
  const email = b.email.trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return { status: 400, body: { error: 'email is not valid' } };

  const slot = await client.query('SELECT start_at FROM slots WHERE id = $1', [slot_id]);
  if (slot.rowCount === 0) return { status: 404, body: { error: 'slot not found' } };
  if (new Date(slot.rows[0].start_at).getTime() <= Date.now()) {
    return { status: 400, body: { error: 'slot has already started' } };
  }

  // Level 3: the partial unique index makes this atomic. Under any amount of
  // concurrency, exactly one INSERT wins; the rest get no row back -> 409.
  const ins = await client.query(
    `INSERT INTO bookings (id, slot_id, name, email, status)
     VALUES ($1, $2, $3, $4, 'confirmed')
     ON CONFLICT (slot_id) WHERE status = 'confirmed' DO NOTHING
     RETURNING *`,
    [crypto.randomUUID(), slot_id, name, email]
  );
  if (ins.rowCount === 0) return { status: 409, body: { error: 'slot already booked' } };
  return { status: 201, body: bookingOut(ins.rows[0]) };
}

app.post('/bookings', async (req, res, next) => {
  const idemKey = req.get('Idempotency-Key');
  const useIdem = typeof idemKey === 'string' && idemKey.length > 0;
  const rawEmail = req.body && typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Level 4: one request per key at a time; replay stored result.
    if (useIdem) {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('idem:' || $1, 0))", [idemKey]);
      const prev = await client.query('SELECT request_hash, status_code, response FROM idempotency_keys WHERE key = $1', [idemKey]);
      if (prev.rowCount) {
        await client.query('COMMIT');
        const p = prev.rows[0];
        if (p.request_hash !== hashBody(req.body)) {
          return err(res, 422, 'Idempotency-Key was already used with a different request body');
        }
        res.set('Idempotent-Replayed', 'true');
        return res.status(p.status_code).json(p.response);
      }
    }

    // Level 5: max 5 attempts per email per 60s, failed ones included.
    if (rawEmail) {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('rate:' || $1, 0))", [rawEmail]);
      const recent = await client.query(
        `SELECT count(*)::int AS n,
                min(at) AS oldest,
                clock_timestamp() AS now
           FROM booking_attempts
          WHERE email = $1 AND at > clock_timestamp() - make_interval(secs => $2)`,
        [rawEmail, RATE_WINDOW_SEC]
      );
      const { n, oldest, now } = recent.rows[0];
      if (n >= RATE_LIMIT) {
        await client.query('COMMIT');
        const waitMs = new Date(oldest).getTime() + RATE_WINDOW_SEC * 1000 - new Date(now).getTime();
        res.set('Retry-After', String(Math.max(1, Math.ceil(waitMs / 1000))));
        return err(res, 429, 'too many booking attempts for this email, try again later');
      }
      await client.query('INSERT INTO booking_attempts (email) VALUES ($1)', [rawEmail]);
      // Housekeeping: drop this email's attempts that are outside the window.
      await client.query(
        "DELETE FROM booking_attempts WHERE email = $1 AND at < clock_timestamp() - make_interval(secs => $2)",
        [rawEmail, RATE_WINDOW_SEC]
      );
    }

    const result = await createBooking(client, req.body);

    if (useIdem) {
      await client.query(
        'INSERT INTO idempotency_keys (key, request_hash, status_code, response) VALUES ($1, $2, $3, $4)',
        [idemKey, hashBody(req.body), result.status, JSON.stringify(result.body)]
      );
    }
    await client.query('COMMIT');
    res.status(result.status).json(result.body);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    next(e);
  } finally {
    client.release();
  }
});

// ---------- Level 4: list a person's bookings ----------
app.get('/bookings', async (req, res, next) => {
  try {
    const { email, limit, cursor } = req.query;
    if (!isNonEmptyString(email)) return err(res, 400, 'email is required');

    let lim = 10;
    if (limit !== undefined) {
      if (typeof limit !== 'string' || !/^\d+$/.test(limit)) return err(res, 400, 'limit must be an integer from 1 to 50');
      lim = Number(limit);
      if (lim < 1 || lim > 50) return err(res, 400, 'limit must be an integer from 1 to 50');
    }

    let after = '0';
    if (cursor !== undefined && cursor !== '') {
      if (typeof cursor !== 'string') return err(res, 400, 'invalid cursor');
      const seq = decodeCursor(cursor);
      if (seq === null) return err(res, 400, 'invalid cursor');
      after = seq;
    }

    const { rows } = await pool.query(
      `SELECT * FROM bookings WHERE email = $1 AND seq > $2::bigint ORDER BY seq ASC LIMIT $3`,
      [email.trim().toLowerCase(), after, lim + 1]
    );
    const page = rows.slice(0, lim);
    const next_cursor = rows.length > lim ? encodeCursor(page[page.length - 1].seq) : null;
    res.json({ bookings: page.map(bookingOut), next_cursor });
  } catch (e) { next(e); }
});

// ---------- Level 1: get a booking ----------
app.get('/bookings/:id', async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT * FROM bookings WHERE id = $1', [req.params.id]);
    if (!rows.length) return err(res, 404, 'booking not found');
    res.json(bookingOut(rows[0]));
  } catch (e) { next(e); }
});

// ---------- Level 3: cancel ----------
app.delete('/bookings/:id', async (req, res, next) => {
  try {
    const upd = await pool.query(
      `UPDATE bookings SET status = 'cancelled' WHERE id = $1 AND status = 'confirmed' RETURNING *`,
      [req.params.id]
    );
    if (upd.rowCount) return res.json(bookingOut(upd.rows[0]));
    const exists = await pool.query('SELECT 1 FROM bookings WHERE id = $1', [req.params.id]);
    if (!exists.rowCount) return err(res, 404, 'booking not found');
    return err(res, 409, 'booking already cancelled');
  } catch (e) { next(e); }
});

// ---------- fallbacks ----------
app.use((req, res) => err(res, 404, 'not found'));

// eslint-disable-next-line no-unused-vars
app.use((e, req, res, next) => {
  if (e && (e.type === 'entity.parse.failed' || e instanceof SyntaxError)) return err(res, 400, 'request body must be valid JSON');
  if (e && e.type === 'entity.too.large') return err(res, 413, 'request body too large');
  console.error(e);
  err(res, 500, 'internal server error');
});

module.exports = app;
