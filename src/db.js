const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is not set');

const needsSsl = !/localhost|127\.0\.0\.1/.test(connectionString) && !/sslmode=disable/.test(connectionString);

const pool = new Pool({
  connectionString,
  ssl: needsSsl ? { rejectUnauthorized: false } : false,
  max: Number(process.env.PG_POOL_MAX || 5),
});

const SCHEMA = `
CREATE TABLE IF NOT EXISTS slots (
  id         TEXT PRIMARY KEY,
  provider   TEXT NOT NULL,
  start_at   TIMESTAMPTZ NOT NULL,
  end_at     TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS bookings (
  seq        BIGSERIAL UNIQUE,
  id         TEXT PRIMARY KEY,
  slot_id    TEXT NOT NULL,
  name       TEXT NOT NULL,
  email      TEXT NOT NULL,
  status     TEXT NOT NULL CHECK (status IN ('confirmed','cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Level 3: the database itself guarantees one confirmed booking per slot.
CREATE UNIQUE INDEX IF NOT EXISTS one_confirmed_booking_per_slot
  ON bookings (slot_id) WHERE status = 'confirmed';

CREATE INDEX IF NOT EXISTS bookings_email_seq ON bookings (email, seq);

-- Level 4: stored responses for Idempotency-Key replays.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key          TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  status_code  INT  NOT NULL,
  response     JSONB NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Level 5: booking attempts per email (sliding 60s window).
CREATE TABLE IF NOT EXISTS booking_attempts (
  id         BIGSERIAL PRIMARY KEY,
  email      TEXT NOT NULL,
  at         TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS booking_attempts_email_at ON booking_attempts (email, at);

CREATE TABLE IF NOT EXISTS app_meta (k TEXT PRIMARY KEY);
`;

let ready;
function init() {
  if (!ready) {
    ready = (async () => {
      const client = await pool.connect();
      try {
        // Serialise schema creation across cold starts. Transaction-scoped lock,
        // so it is safe behind a transaction-mode pooler (e.g. Neon's).
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(424242)');
        await client.query(SCHEMA);
        // Seed demo slots once, on the very first boot only (never after a /reset).
        const first = await client.query("INSERT INTO app_meta (k) VALUES ('seeded') ON CONFLICT DO NOTHING RETURNING k");
        if (first.rowCount) await seedDemoSlots(client);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    })().catch((err) => { ready = null; throw err; });
  }
  return ready;
}

// Demo slots so the web page has something to show before /reset is ever called.
async function seedDemoSlots(client) {
  const providers = ['Dr Ade', 'Dr Bello'];
  const base = new Date();
  base.setUTCDate(base.getUTCDate() + 1);
  base.setUTCHours(9, 0, 0, 0);
  let n = 1;
  for (let day = 0; day < 3; day++) {
    for (const provider of providers) {
      for (let i = 0; i < 4; i++) {
        const start = new Date(base.getTime() + day * 86400000 + i * 30 * 60000);
        const end = new Date(start.getTime() + 30 * 60000);
        await client.query(
          'INSERT INTO slots (id, provider, start_at, end_at) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING',
          [`s${n++}`, provider, start, end]
        );
      }
    }
  }
}

module.exports = { pool, init };
