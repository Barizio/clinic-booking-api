# Clinic Booking API

The API and web page for Koya Cohort 4, Task 1. It follows the spec at https://koyaacademy.com/assessment-api (`/assessment-api/openapi.json`).

- **Stack:** Node 18+, Express 5, PostgreSQL (`pg`). It runs on Vercel serverless with Neon Postgres, or as a plain Node server on Render, Railway, or similar.
- **Web page:** served at `/`. You paste the API key once, then see slots by day, book one, and see the confirmation. You can also cancel a booking and look up your bookings by email (paged).
- **Tests:** `npm test` runs 43 end-to-end checks across all 5 levels against a throwaway local Postgres.

## How each level is met

| Level | Requirement | How |
|---|---|---|
| 1 | Reset, list slots, book, look up | `POST /reset`, `GET /slots` (earliest first, `available` flag, `?provider=` exact match), `POST /bookings` → 201, `GET /bookings/:id` |
| 2 | API key and validation | `X-API-Key` is checked with a constant-time compare, and every API route returns 401 without it. Bookings return 400 for a missing, empty, or non-string field, a bad email, an already-started slot, or bad JSON, and 404 for an unknown slot. `name` and `email` are trimmed, and `email` is lower-cased. |
| 3 | No double booking, cancel | A **partial unique index** `ON bookings(slot_id) WHERE status='confirmed'` plus `INSERT … ON CONFLICT DO NOTHING`. The database guarantees one winner under any concurrency; the test fires 50 at once. `DELETE` returns 200 cancelled, 404, or 409 if already cancelled, and frees the slot. |
| 4 | Idempotency, pagination | `Idempotency-Key` takes a transaction advisory lock per key, so concurrent retries wait. The stored status and body are replayed, and the body is compared by a canonical hash, so key order doesn't matter. A different body returns 422. `GET /bookings?email=&limit=&cursor=` is oldest first with an opaque `next_cursor` (null on the last page). `limit` must be an integer from 1 to 50, anything else is 400. |
| 5 | Anti-spam | Each email gets a sliding window of 5 attempts per 60 s, kept in Postgres, so it works across serverless instances. Failed attempts count, and each email is serialised with an advisory lock. The 6th attempt returns 429 with `Retry-After` in whole seconds. Other emails are not affected. Idempotent replays don't count as new attempts. |

Other behaviour:
- All errors look like `{"error": "..."}`.
- CORS is open.
- `/reset` also clears idempotency keys and rate-limit history.
- On the very first boot the app seeds demo slots once, so the page isn't empty.

## Run locally

```bash
npm install
npm test                       # all levels, with a throwaway local Postgres
cp .env.example .env           # then set DATABASE_URL and API_KEY
node --env-file=.env server.js # http://localhost:3000
```

## Deploy (Vercel + Neon, both free)

1. **Neon:** create a project at neon.tech and copy the **pooled** connection string (the host contains `-pooler`).
2. **GitHub:** push this folder to a new repo.
3. **Vercel:** import the repo with Framework Preset set to **Other** and no build command. Add these environment variables:
   - `DATABASE_URL` = the Neon pooled string
   - `API_KEY` = a long random string (`openssl rand -hex 24`)
4. Deploy. The tables are created automatically on the first request.
5. Verify against the live URL (**this wipes data**):
   ```bash
   BASE_URL=https://<app>.vercel.app API_KEY=<key> npm test
   ```
   Then load fresh demo slots for the next two weeks:
   ```bash
   BASE_URL=https://<app>.vercel.app API_KEY=<key> npm run seed
   ```
6. Submit the https URL and the API key. After that, **don't redeploy or change anything** until Koya contacts you.

**Alternative (Render):** create a Web Service with build command `npm install` and start command `npm start`, and use the same two env vars. Note that Render's free tier sleeps after 15 minutes idle, and the first request can take about 50 s. That's why Vercel is the default here.
