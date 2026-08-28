#!/usr/bin/env node
// Minimal zero-dependency CDP driver for a THROWAWAY Chrome instance.
//
// Used to put a second real participant into a call so the monitor has inbound
// streams to render. It always runs against its own --user-data-dir, never the
// user's profile, and uses fake capture devices so it publishes real encoded
// media without touching the machine's camera or mic.
//
//   node test/cdp.js launch            start Chrome (background) on PORT
//   node test/cdp.js nav <url>         navigate the working page
//   node test/cdp.js eval '<js>'       evaluate in the working page, print result
//   node test/cdp.js shot <file.png>   screenshot the working page
//   node test/cdp.js kill              stop that Chrome
//
// PORT defaults to 9333; PROFILE defaults to a fixed scratch dir.

const { spawn, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = Number(process.env.PORT || 9333);
const PROFILE = process.env.PROFILE || path.join(os.tmpdir(), 'rtcmon-guest-profile');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const j = (u) => fetch(u).then(r => r.json());

async function httpJson(pathname, tries = 1) {
  for (let i = 0; i < tries; i++) {
    try { return await j(`http://127.0.0.1:${PORT}${pathname}`); }
    catch (e) { if (i === tries - 1) throw e; await new Promise(r => setTimeout(r, 1000)); }
  }
}

// One request/response round trip on a page target's websocket.
function send(wsUrl, method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const id = 1;
    const timer = setTimeout(() => { try { ws.close(); } catch (e) {} reject(new Error('CDP timeout: ' + method)); }, 30000);
    ws.onopen = () => ws.send(JSON.stringify({ id, method, params, sessionId }));
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== id) return;
      clearTimeout(timer);
      try { ws.close(); } catch (e) {}
      msg.error ? reject(new Error(method + ': ' + JSON.stringify(msg.error))) : resolve(msg.result);
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error('websocket error for ' + method)); };
  });
}

// The page we drive: prefer a real http(s) page over about:blank/devtools.
async function page() {
  const list = await httpJson('/json/list');
  const pages = list.filter(t => t.type === 'page' && t.webSocketDebuggerUrl);
  const real = pages.find(t => /^https?:/.test(t.url));
  const t = real || pages[0];
  if (!t) throw new Error('no page target; is Chrome running? try: node test/cdp.js launch');
  return t;
}

async function evaluate(expr) {
  const t = await page();
  const r = await send(t.webSocketDebuggerUrl, 'Runtime.evaluate', {
    expression: expr, awaitPromise: true, returnByValue: true, allowUnsafeEvalBlockedByCSP: true
  });
  if (r.exceptionDetails) return { error: r.exceptionDetails.exception?.description || r.exceptionDetails.text };
  return r.result?.value !== undefined ? r.result.value : r.result;
}

async function main() {
  const [cmd, arg] = process.argv.slice(2);

  if (cmd === 'launch') {
    fs.mkdirSync(PROFILE, { recursive: true });
    const child = spawn(CHROME, [
      `--user-data-dir=${PROFILE}`,
      `--remote-debugging-port=${PORT}`,
      '--no-first-run', '--no-default-browser-check',
      '--use-fake-device-for-media-stream',   // synthetic camera/mic: real encoded media, no hardware
      '--use-fake-ui-for-media-stream',       // auto-accept the permission prompt
      '--autoplay-policy=no-user-gesture-required',
      '--window-size=1100,850',
      'about:blank'
    ], { detached: true, stdio: 'ignore' });
    child.unref();
    const v = await httpJson('/json/version', 20);
    console.log('launched', v.Browser, 'on port', PORT, '\nprofile:', PROFILE);
    return;
  }

  if (cmd === 'kill') {
    try { execSync(`pkill -f "user-data-dir=${PROFILE}"`); } catch (e) {}
    console.log('killed guest chrome');
    return;
  }

  if (cmd === 'nav') {
    const t = await page();
    await send(t.webSocketDebuggerUrl, 'Page.navigate', { url: arg });
    console.log('navigating to', arg);
    return;
  }

  if (cmd === 'eval') {
    const out = await evaluate(arg);
    console.log(typeof out === 'string' ? out : JSON.stringify(out, null, 1));
    return;
  }

  if (cmd === 'shot') {
    const t = await page();
    const r = await send(t.webSocketDebuggerUrl, 'Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(arg, Buffer.from(r.data, 'base64'));
    console.log('wrote', arg);
    return;
  }

  console.log('usage: cdp.js launch|nav <url>|eval <js>|shot <file>|kill');
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
