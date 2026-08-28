const { chromium } = require('playwright');
const fs = require('fs');
const MONITOR = fs.readFileSync('../src/rtc-stream-monitor.js', 'utf8');
(async () => {
  const b = await chromium.launch({ executablePath: process.env.CHROMIUM || (process.platform === 'darwin'
      ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
      : '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'),
    args: ['--no-sandbox','--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream','--autoplay-policy=no-user-gesture-required'] });
  const p = await b.newPage();
  await p.goto('file://' + require('path').resolve('./harness.html') + '?mode=guest');
  await p.waitForFunction(() => window.__harnessReady === true, { timeout: 30000 });
  await p.evaluate(MONITOR);
  await p.waitForTimeout(6000);
  const out = await p.evaluate(() => {
    const r = document.getElementById('rtc-stream-monitor-host').shadowRoot;
    const sec = [];
    r.querySelectorAll('.sec').forEach(s => {
      const h = s.querySelector('.sech');
      if (!h) return;
      sec.push({ section: h.textContent.trim(),
        cards: [...s.querySelectorAll('.card[data-sid] [data-u=ttl]')].map(t => t.textContent.trim()) });
    });
    return sec;
  });
  console.log(JSON.stringify(out, null, 1));
  await b.close();
})();
