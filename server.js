// Plain Node server (local dev, Render, Railway, etc.)
const app = require('./src/app');
const port = Number(process.env.PORT || 3000);
app.listen(port, () => console.log(`Clinic booking API listening on :${port}`));
