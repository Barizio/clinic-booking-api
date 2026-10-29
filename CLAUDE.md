# Handoff for Claude Code

This project is built and tested: `npm test` passes 43/43 locally. The remaining job is **deployment**.

Goal: deploy to Vercel with Neon Postgres, verify the live URL, seed demo slots, and give the user the URL and API key to submit.

Steps:
1. `npm install && npm test`. Confirm it is green before touching anything.
2. Create a GitHub repo and push. Use `gh repo create clinic-booking-api --private --source=. --push`, or public if the user prefers.
3. Neon:
   - Use the Neon CLI (`npx neonctl`) or ask the user to create a project in the dashboard.
   - Get the **pooled** connection string.
4. Vercel:
   - Run `npx vercel link`.
   - Set the env vars for production with `npx vercel env add DATABASE_URL production` and `npx vercel env add API_KEY production`.
   - Generate the key with `openssl rand -hex 24`. Never commit it or print it in logs.
   - Run `npx vercel --prod`.
5. Verify: `BASE_URL=<prod url> API_KEY=<key> npm test` must be 43/43. If anything fails on Vercel but passes locally, check body parsing and cold-start first.
6. Run `BASE_URL=<prod url> API_KEY=<key> npm run seed` to load fresh demo slots.
7. Open `<prod url>/` and check the page loads and booking works.
8. Tell the user the URL and the key to submit.

Rules:
- Follow the spec in README.md and https://koyaacademy.com/assessment-api exactly.
- After submission, the deployment must not change.
- Keep the Neon pooled URL. The code uses only transaction-scoped advisory locks, so it is pooler-safe.
