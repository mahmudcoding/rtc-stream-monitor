const fs = require('fs');
const src = fs.readFileSync('../src/rtc-stream-monitor.js', 'utf8');
const min = fs.readFileSync('rtc-stream-monitor.min.js', 'utf8');
const bm = 'javascript:' + encodeURIComponent(min);
const j = s => JSON.stringify(s);

const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>RTC Stream Monitor — launcher</title>
<style>
  :root{
    color-scheme:dark;
    --surface:#1a1a19; --plane:#0d0d0d; --ink:#fff; --ink2:#c3c2b7; --muted:#898781;
    --grid:#2c2c2a; --axis:#383835; --border:rgba(255,255,255,.10);
    --blue:#3987e5; --orange:#d95926; --good:#0ca30c;
  }
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:var(--plane);color:var(--ink);
    font:15px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;
    padding:48px 24px 80px;display:flex;justify-content:center}
  .wrap{width:100%;max-width:760px}
  h1{font-size:30px;font-weight:600;letter-spacing:-.7px;margin-bottom:6px}
  .sub{color:var(--muted);margin-bottom:34px;font-size:14px}
  .card{background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:22px 24px;margin-bottom:16px}
  .step{display:flex;gap:14px;align-items:flex-start}
  .num{flex:0 0 26px;height:26px;border-radius:50%;background:rgba(57,135,229,.16);color:var(--blue);
    display:grid;place-items:center;font-size:13px;font-weight:600;margin-top:1px}
  h2{font-size:16px;font-weight:600;margin-bottom:5px}
  p{color:var(--ink2);font-size:14px}
  p.dim{color:var(--muted);font-size:13px;margin-top:7px}
  kbd{background:#232322;border:1px solid var(--border);border-bottom-width:2px;border-radius:5px;
    padding:1px 6px;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--ink)}
  button.go{margin-top:14px;background:var(--blue);color:#fff;border:0;border-radius:9px;
    padding:11px 20px;font:600 14px/1 inherit;cursor:pointer;transition:.15s}
  button.go:hover{background:#4d95ea}
  button.go.ok{background:var(--good)}
  .bm{display:inline-block;margin-top:14px;background:transparent;border:1px dashed var(--axis);
    border-radius:9px;padding:10px 18px;color:var(--ink);text-decoration:none;font-weight:600;font-size:14px;cursor:grab}
  .bm:hover{border-color:var(--blue);color:var(--blue)}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:1px;background:var(--border);
    border:1px solid var(--border);border-radius:12px;overflow:hidden;margin:30px 0 10px}
  .cell{background:var(--surface);padding:14px 16px}
  .cell .l{color:var(--muted);font-size:11px;display:flex;align-items:center;gap:6px}
  .cell .v{font-size:14px;font-weight:600;margin-top:3px}
  .dot{width:7px;height:7px;border-radius:50%;display:inline-block}
  ul{margin:8px 0 0 18px;color:var(--ink2);font-size:14px}
  li{margin-bottom:4px}
  .sech{color:var(--ink2);font-size:11px;font-weight:600;letter-spacing:.5px;text-transform:uppercase;
    margin:34px 0 10px;display:flex;align-items:center;gap:10px}
  .sech .sp{flex:1;height:1px;background:var(--grid)}
  code{font:12.5px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--ink2);
    background:#232322;border-radius:5px;padding:1px 6px}
  footer{color:var(--muted);font-size:12.5px;margin-top:34px}
</style></head><body><div class="wrap">

<h1>RTC Stream Monitor</h1>
<div class="sub">Live inspector for audio and video streams on compatible WebRTC pages. Google Meet requires the Chrome extension.</div>

<div class="card"><div class="step">
  <span class="num">!</span>
  <div style="flex:1">
    <h2>Using Google Meet? Use the Chrome extension</h2>
    <p>The console script and bookmarklet cannot capture Google Meet's hidden peer connections. Load RTC Stream Monitor as a Chrome extension and use its toolbar button instead.</p>
    <p class="dim">This launcher is for other compatible WebRTC pages, including <code>airion-cargo.store</code>.</p>
  </div>
</div></div>

<div class="card"><div class="step">
  <span class="num">1</span>
  <div style="flex:1">
    <h2>Open a compatible WebRTC call</h2>
    <p>Join the call first, then come back here. The monitor finds connections that are already running.</p>
  </div>
</div></div>

<div class="card"><div class="step">
  <span class="num">2</span>
  <div style="flex:1">
    <h2>Copy the script</h2>
    <p>One click — the whole monitor goes to your clipboard.</p>
    <button class="go" id="copy">Copy script to clipboard</button>
    <p class="dim">Or drag this to your bookmarks bar and click it on a compatible call:
      &nbsp;<a class="bm" href=${j(bm)}>▶ Stream Monitor</a></p>
  </div>
</div></div>

<div class="card"><div class="step">
  <span class="num">3</span>
  <div style="flex:1">
    <h2>Paste it into the console</h2>
    <p>On the call tab press <kbd>F12</kbd> (or <kbd>⌥⌘I</kbd> on Mac), open <b>Console</b>, paste, hit <kbd>Enter</kbd>.
       The panel appears top-right.</p>
    <p class="dim">First time only: Chrome may ask you to type <code>allow pasting</code> before it accepts a pasted script.</p>
  </div>
</div></div>

<div class="sech">What you get<span class="sp"></span></div>
<div class="grid">
  <div class="cell"><div class="l">Headline</div><div class="v">Round-trip time + quality rating</div></div>
  <div class="cell"><div class="l">Path</div><div class="v">Direct, STUN or TURN relay</div></div>
  <div class="cell"><div class="l"><span class="dot" style="background:var(--blue)"></span>Receiving</div><div class="v">Live bitrate, 90-second chart</div></div>
  <div class="cell"><div class="l"><span class="dot" style="background:var(--orange)"></span>Sending</div><div class="v">Live bitrate, 90-second chart</div></div>
  <div class="cell"><div class="l">Health</div><div class="v">Packet loss &amp; jitter, rated</div></div>
  <div class="cell"><div class="l">Warnings</div><div class="v">Bandwidth- or CPU-limited encoder</div></div>
</div>

<p style="color:var(--ink2);font-size:14px;margin-top:18px">Per stream, one card each:</p>
<ul>
  <li>Participant name, codec (VP9 / H264 / AV1 / Opus), resolution and frame rate</li>
  <li>Bitrate with its own sparkline; live level meter for audio</li>
  <li>Packet loss, jitter, dropped frames, freeze count</li>
  <li>Click <b>▾</b> on any card for the complete raw stats dump — every field the browser exposes</li>
</ul>

<div class="sech">Controls<span class="sp"></span></div>
<ul>
  <li>Drag the header to move it; drag the bottom-left corner to resize</li>
  <li><b>⧉</b> copies a full JSON snapshot of every stat — good for sharing a bad call</li>
  <li><b>table</b> toggles the chart to a readable table; hover or arrow-key the chart for exact values</li>
  <li>Console API: <code>__rtcStreamMonitor__.stop()</code>, <code>.rescan()</code>, <code>.dump()</code></li>
</ul>

<footer>Runs entirely in your browser. Reads WebRTC statistics only — no data leaves the page.</footer>

<script>
const SRC = ${j(src)};
const b = document.getElementById('copy');
b.onclick = () => navigator.clipboard.writeText(SRC).then(() => {
  b.textContent = '✓ Copied — now paste it in the console';
  b.classList.add('ok');
  setTimeout(() => { b.textContent = 'Copy script to clipboard'; b.classList.remove('ok'); }, 3000);
});
</script>
</div></body></html>`;
fs.writeFileSync('stream-monitor-launcher.html', html);
console.log('written', html.length, 'bytes; bookmarklet', bm.length);
