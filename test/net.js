const { chromium } = require('playwright');
const targets = ['https://meet.google.com/', 'https://teams.live.com/', 'https://app.zoom.us/wc',
                 'https://airion-cargo.store/'];
(async () => {
  const b = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox'] });
  const p = await b.newPage();
  for (const t of targets) {
    try {
      const r = await p.goto(t, { timeout: 15000, waitUntil: 'domcontentloaded' });
      console.log(String(r && r.status()).padEnd(6), t);
    } catch (e) {
      console.log('BLOCK '.padEnd(6), t, '→', String(e.message).split('\n')[0].slice(0, 60));
    }
  }
  await b.close();
})();
