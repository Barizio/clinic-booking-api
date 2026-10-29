// Replace all slots with fresh demo slots via the API (wipes bookings).
//   BASE_URL=https://your-app.vercel.app API_KEY=... node scripts/seed.js
const BASE = process.env.BASE_URL, KEY = process.env.API_KEY;
if (!BASE || !KEY) { console.error('Set BASE_URL and API_KEY'); process.exit(1); }
const providers = ['Dr Ade', 'Dr Bello', 'Dr Chukwu'];
const slots = []; let n = 1;
const day0 = new Date(); day0.setUTCHours(0, 0, 0, 0);
for (let d = 1; d <= 14; d++) {
  const date = new Date(day0.getTime() + d * 86400000);
  if ([0, 6].includes(date.getUTCDay())) continue; // weekdays only
  for (const provider of providers) for (let i = 0; i < 6; i++) {
    const start = new Date(date.getTime() + (8 * 60 + i * 30) * 60000); // 08:00 UTC = 09:00 Lagos
    slots.push({ id: `s${n++}`, provider, start: start.toISOString().replace('.000', ''), end: new Date(start.getTime() + 1800000).toISOString().replace('.000', '') });
  }
}
fetch(new URL('/reset', BASE), { method: 'POST', headers: { 'X-API-Key': KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ slots }) })
  .then(async (r) => { console.log(r.status, await r.text()); process.exit(r.ok ? 0 : 1); });
