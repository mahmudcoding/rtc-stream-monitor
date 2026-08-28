const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const MONITOR = fs.readFileSync('../src/rtc-stream-monitor.js', 'utf8');
const EARLY_CAPTURE = fs.readFileSync('../src/rtc-early-capture.js', 'utf8');
const HARNESS_HTML = fs.readFileSync('./harness.html', 'utf8');
const HARNESS = 'file://' + path.resolve('./harness.html');

const ok = (c) => (c ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m');
let failures = 0, checks = 0;
function check(name, cond, detail) {
  checks++;
  if (!cond) failures++;
  console.log('  ' + ok(cond) + '  ' + name + (detail !== undefined ? '  → ' + detail : ''));
}

// Everything below runs inside the page, against the live shadow DOM.
const probe = async (skipDump) => {
  const host = document.getElementById('rtc-stream-monitor-host');
  if (!host) return { host: false };
  const r = host.shadowRoot;
  const txt = (sel) => { const e = r.querySelector(sel); return e ? e.textContent.trim() : null; };
  const m = window.__rtcStreamMonitor__ && window.__rtcStreamMonitor__.model;
  const streamById = {};
  if (m) m.inbound.concat(m.outbound).forEach(s => { streamById[s.id] = s; });
  const cards = [...r.querySelectorAll('.card[data-sid]')].map(c => ({
    sid: c.getAttribute('data-sid'),
    dir: streamById[c.getAttribute('data-sid')] && streamById[c.getAttribute('data-sid')].dir,
    kind: streamById[c.getAttribute('data-sid')] && streamById[c.getAttribute('data-sid')].kind,
    track: streamById[c.getAttribute('data-sid')] && streamById[c.getAttribute('data-sid')].track,
    mid: streamById[c.getAttribute('data-sid')] && streamById[c.getAttribute('data-sid')].raw &&
      streamById[c.getAttribute('data-sid')].raw.mid,
    title: c.querySelector('[data-u=ttl]') ? c.querySelector('[data-u=ttl]').textContent.trim() : null,
    bps: c.querySelector('[data-u=bps]') ? c.querySelector('[data-u=bps]').textContent.trim() : null,
    meta: c.querySelector('[data-u=meta]') ? c.querySelector('[data-u=meta]').textContent.trim() : null
  }));
  const dcs = [...r.querySelectorAll('.card[data-dc]')].map(c => ({
    title: c.querySelector('[data-u=dcttl]').textContent.trim(),
    bps: c.querySelector('[data-u=dcbps]').textContent.trim(),
    meta: c.querySelector('[data-u=dcmeta]').textContent.trim()
  }));
  const zoomMediaChannels = [...r.querySelectorAll('[data-zoom-channel]')].map(c => ({
    kind: c.getAttribute('data-zoom-channel'),
    title: c.querySelector('.cttl') ? c.querySelector('.cttl').textContent.trim() : null,
    bps: c.querySelector('[data-u=zoom-rates]')
      ? c.querySelector('[data-u=zoom-rates]').textContent.replace(/\s+/g, ' ').trim()
      : null,
    meta: c.querySelector('[data-u=zoom-meta]')
      ? c.querySelector('[data-u=zoom-meta]').textContent
          .replace(/\s*·\s*/g, ' · ').replace(/\s+/g, ' ').trim()
      : null,
    text: c.textContent.replace(/\s+/g, ' ').trim()
  }));
  const body = r.querySelector('#body');
  const secs = [...r.querySelectorAll('.sech')].map(s => s.textContent.trim());
  const dump = !skipDump && window.__rtcStreamMonitor__
    ? JSON.parse(await window.__rtcStreamMonitor__.dump())
    : null;
  const dumpDataChannels = dump
    ? dump.peerConnections.reduce((count, pc) => count +
        (pc.stats || []).filter(stat => stat.type === 'data-channel').length, 0)
    : 0;
  return {
    host: true, url: location.href,
    rtt: txt('[data-u=rtt]'), quality: txt('[data-u=qbars]'),
    down: txt('[data-u=down]'), up: txt('[data-u=up]'),
    loss: txt('[data-u=loss]'), jitter: txt('[data-u=jit]'),
    sections: secs, cards, dcs, zoomMediaChannels, dumpDataChannels,
    allTraffic: /all traffic/i.test((r.querySelector('.tiles') || {}).textContent || ''),
    notes: [...r.querySelectorAll('.note')].map(n => n.textContent.replace(/\s+/g, ' ').trim().slice(0, 110)),
    transport: txt('[data-u=transport]'),
    mediaStreamIds: [...document.querySelectorAll('video,audio')]
      .map(el => el.srcObject && el.srcObject.id).filter(Boolean),
    meetFixture: window.__meetFixture || null,
    meetTileCount: document.querySelectorAll('.tile').length,
    scroll: { clientH: body.clientHeight, scrollH: body.scrollHeight },
    quietPills: [...r.querySelectorAll('.qtog')].map(b => b.textContent.trim()),
    model: m ? { pcs: m.pcs, nIn: m.inbound.length, nOut: m.outbound.length,
                 quiet: m.quietStreams || 0,
                 down: m.down === null ? null : Math.round(m.down),
                 up: m.up === null ? null : Math.round(m.up),
                 tIn: m.tIn, tOut: m.tOut,
                 viaTransport: !!m.viaTransport, dcs: m.dataChannels.length,
                 zoomMediaChannels: (m.zoomMediaChannels || []).map(row => ({
                   id: row.id, kind: row.kind, inKbps: row.inKbps,
                   outKbps: row.outKbps, sourceCount: row.sourceCount,
                   pcKeys: row.pcKeys
                 })),
                 rawInTrackIds: m.inbound.map(s => s.raw && s.raw.trackIdentifier || null) } : null
  };
};

async function scenario(browser, mode, settle, originHost, originPath) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e.message)));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  if (originHost) {
    if (originHost === true) originHost = 'meet.google.com';
    await page.route('https://' + originHost + '/**', route => route.fulfill({
      status: 200, contentType: 'text/html', body: HARNESS_HTML
    }));
    await page.goto('https://' + originHost +
      (originPath || ('/test-fixture?mode=' + encodeURIComponent(mode))));
  } else {
    await page.goto(HARNESS + '?mode=' + mode);
  }
  await page.waitForFunction(() => window.__harnessReady === true, { timeout: 30000 });
  await page.evaluate(MONITOR);                 // inject exactly what the extension injects
  await page.waitForTimeout(settle || 6000);    // let rate deltas accumulate
  const res = await page.evaluate(probe);
  res.errors = errors;
  await page.screenshot({ path: './shot-' + mode + '.png' });
  await ctx.close();
  return res;
}

/* Probes the panel before and after a participant's tile is unmounted, which is
   what a virtualised grid does whenever somebody scrolls out of view. */
async function tileChurnScenario(browser) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e.message)));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.goto(HARNESS + '?mode=tile-churn');
  await page.waitForFunction(() => window.__harnessReady === true, { timeout: 30000 });
  await page.evaluate(MONITOR);
  await page.waitForTimeout(6000);

  const before = await page.evaluate(probe, true);
  await page.evaluate(() => window.__tiles.unmount('virtual'));
  await page.waitForTimeout(4000);
  const after = await page.evaluate(probe, true);

  // Camera off: the self-preview element goes and the named self tile remains,
  // and the outgoing video encoding is deactivated without renegotiation.
  await page.evaluate(() => window.__tiles.dropSelfMedia());
  await page.evaluate(() => window.__tiles.cameraOff('plain'));
  await page.waitForTimeout(5000);
  const camOff = await page.evaluate(probe, true);
  camOff.localElements = await page.evaluate(() => {
    const m = window.__rtcStreamMonitor__.model;
    return (m.elements || []).filter(e => e.local).length;
  });

  // The switched-off stream left the default view; the section header's
  // quiet toggle must bring it back, marker and all.
  const clickQuietToggle = () => page.evaluate(() => {
    const b = document.getElementById('rtc-stream-monitor-host')
      .shadowRoot.querySelector('.qtog');
    if (b) b.click();
    return !!b;
  });
  await clickQuietToggle();
  await page.waitForTimeout(1500);
  const camOffRevealed = await page.evaluate(probe, true);
  await page.screenshot({ path: './shot-tile-churn.png' });
  await clickQuietToggle();          // back to the default active-only view

  // Camera back on: no renegotiation, bytes flow again, and the card must
  // return to the default view on its own.
  await page.evaluate(() => window.__tiles.cameraOn('plain'));
  await page.waitForTimeout(3500);
  const camBack = await page.evaluate(probe, true);

  await ctx.close();
  return { errors, before, after, camOff, camOffRevealed, camBack };
}

/* Walks one SFU-shaped call through a departure and back out again, probing the
   live panel at each step.  `steps` drives the harness between probes. */
async function departureScenario(browser) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e.message)));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.goto(HARNESS + '?mode=departure');
  await page.waitForFunction(() => window.__harnessReady === true, { timeout: 30000 });
  await page.evaluate(MONITOR);
  await page.waitForTimeout(6000);

  const shot = async (label) => {
    const res = await page.evaluate(probe, true);
    res.ended = await page.evaluate(() => {
      const m = window.__rtcStreamMonitor__ && window.__rtcStreamMonitor__.model;
      return m ? { hidden: m.endedStreams, rawStats: m.rtpStats } : null;
    });
    res.label = label;
    return res;
  };

  const before = await shot('all present');
  // Ada leaves. Grace turns her camera and mic off; Alan's sender simply stops
  // with no signalling. Both of those are still in the call.
  await page.evaluate(() => window.__departure.leave(0));
  await page.evaluate(() => { window.__departure.mute(1); window.__departure.stall(2); });
  await page.waitForTimeout(6000);
  const afterOne = await shot('one left, two quiet');

  // The stalled cards are quiet-hidden by now; reveal them for the 0 kb/s probe.
  await page.evaluate(() => {
    const b = document.getElementById('rtc-stream-monitor-host')
      .shadowRoot.querySelector('.qtog');
    if (b) b.click();
  });
  await page.waitForTimeout(1500);
  const afterOneRevealed = await shot('one left, quiet revealed');
  await page.evaluate(() => {
    const b = document.getElementById('rtc-stream-monitor-host')
      .shadowRoot.querySelector('.qtog');
    if (b) b.click();
  });

  await page.evaluate(() => window.__departure.leaveAll());
  await page.waitForTimeout(6000);
  const afterAll = await shot('everyone left');

  await page.screenshot({ path: './shot-departure.png' });
  await ctx.close();
  return { errors, before, afterOne, afterOneRevealed, afterAll };
}

async function zoomDataChannelScenario(browser) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e.message)));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.route('https://app.zoom.us/**', route => route.fulfill({
    status: 200, contentType: 'text/html', body: HARNESS_HTML
  }));
  await page.goto(
    'https://app.zoom.us/wc/5467856297/start?fromPWA=1&mode=zoom-dc'
  );
  await page.waitForFunction(() => window.__harnessReady === true, { timeout: 30000 });
  await page.evaluate(() => {
    const pc = window.__pcs[0];
    const nativeGetStats = pc.getStats.bind(pc);
    let calls = 0, released = false;
    const blocked = [];
    Object.defineProperty(pc, 'getStats', { configurable: true, value: function () {
      calls++;
      if (calls === 1 || released) return nativeGetStats();
      return new Promise((resolve, reject) => {
        blocked.push(() => nativeGetStats().then(resolve, reject));
      });
    }});
    window.__releaseZoomStats = () => {
      released = true;
      blocked.splice(0).forEach(resume => resume());
    };
  });
  await page.evaluate(MONITOR);
  await page.waitForFunction(() => {
    const api = window.__rtcStreamMonitor__;
    return api && api.model && api.model.zoomMediaChannels &&
      api.model.zoomMediaChannels.length === 2;
  }, { timeout: 15000 });

  // The first getStats report has cumulative byte evidence but no previous
  // counters. Preserve this sample before the next one-second tick so unknown
  // rates remain visibly unknown instead of becoming a false 0 kbps.
  const first = await page.evaluate(probe, true);
  await page.evaluate(() => window.__releaseZoomStats());
  await page.waitForTimeout(6500);
  const settled = await page.evaluate(probe);
  await page.screenshot({ path: './shot-zoom-dc.png' });
  await ctx.close();
  return { errors, first, settled };
}

async function lifecycleScenario(browser) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(HARNESS + '?mode=guest');
  await page.waitForFunction(() => window.__harnessReady === true, { timeout: 30000 });
  await page.evaluate(() => { window.__originalMonitorGetStats = RTCPeerConnection.prototype.getStats; });
  await page.evaluate(MONITOR);
  await page.waitForTimeout(1600);
  const before = await page.evaluate(async () => {
    const root = document.getElementById('rtc-stream-monitor-host').shadowRoot;
    const card = root.querySelector('.card[data-sid]');
    const oldId = card && card.getAttribute('data-sid');
    if (card) card.querySelector('.chev').click();
    const dump = JSON.parse(await window.__rtcStreamMonitor__.dump());
    return {
      t: window.__rtcStreamMonitor__.model.t,
      pcs: dump.peerConnections.length,
      oldId,
      historyKeys: dump.streamState.historyKeys,
      expandedKeys: dump.streamState.expandedKeys,
      hooked: RTCPeerConnection.prototype.getStats !== window.__originalMonitorGetStats
    };
  });
  await page.evaluate(() => {
    document.getElementById('rtc-stream-monitor-host').shadowRoot.querySelector('#bmin').click();
    window.__pcs.forEach(pc => pc.close());
  });
  await page.waitForTimeout(2200);
  const after = await page.evaluate(async () => {
    const dump = JSON.parse(await window.__rtcStreamMonitor__.dump());
    return {
      t: window.__rtcStreamMonitor__.model.t,
      pcs: dump.peerConnections.length,
      historyKeys: dump.streamState.historyKeys,
      expandedKeys: dump.streamState.expandedKeys
    };
  });
  const restored = await page.evaluate(() => {
    window.__rtcStreamMonitor__.stop();
    return RTCPeerConnection.prototype.getStats === window.__originalMonitorGetStats;
  });
  await ctx.close();
  return { before, after, restored };
}

/* An extension reload does not replace a script already injected into a
   long-lived tab, and the injected monitor's re-run path used to just toggle
   whatever instance was already there — so the toolbar kept driving stale
   code until the page itself reloaded. A newer version must replace the old
   instance; the same version must keep toggling. */
async function versionUpgradeScenario(browser) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e.message)));
  await page.goto(HARNESS + '?mode=guest');
  await page.waitForFunction(() => window.__harnessReady === true, { timeout: 30000 });
  const OLD = MONITOR.replace(/var VERSION = '[^']+'/, "var VERSION = '0.0.1-stale'");
  if (OLD === MONITOR) throw new Error('VERSION marker not found in monitor source');
  await page.evaluate(OLD);
  await page.waitForTimeout(2500);
  const stale = await page.evaluate(() => ({
    version: window.__rtcStreamMonitor__.version,
    pcs: window.__rtcStreamMonitor__.model ? window.__rtcStreamMonitor__.model.pcs : 0
  }));
  await page.evaluate(MONITOR);          // the toolbar click after an upgrade
  await page.waitForTimeout(2500);
  const upgraded = await page.evaluate(() => {
    const host = document.getElementById('rtc-stream-monitor-host');
    return {
      version: window.__rtcStreamMonitor__.version,
      pcs: window.__rtcStreamMonitor__.model ? window.__rtcStreamMonitor__.model.pcs : 0,
      hosts: document.querySelectorAll('#rtc-stream-monitor-host').length,
      visible: !!(host && getComputedStyle(host.shadowRoot.getElementById('panel')).display !== 'none')
    };
  });
  await page.evaluate(MONITOR);          // same version again: plain toggle
  const toggledOff = await page.evaluate(() => {
    const host = document.getElementById('rtc-stream-monitor-host');
    return getComputedStyle(host.shadowRoot.getElementById('panel')).display === 'none';
  });
  await page.evaluate(MONITOR);
  const toggledBack = await page.evaluate(() => {
    const host = document.getElementById('rtc-stream-monitor-host');
    return getComputedStyle(host.shadowRoot.getElementById('panel')).display !== 'none';
  });
  await ctx.close();
  return { errors, stale, upgraded, toggledOff, toggledBack };
}

/* Hovers the throughput chart with a real pointer, then lets a participant
   join mid-hover. The signature change rebuilds the skeleton, which destroys
   the hovered element — the chart must come back, not die with its flag. */
async function chartHoverScenario(browser) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e.message)));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.goto(HARNESS + '?mode=rtp');
  await page.waitForFunction(() => window.__harnessReady === true, { timeout: 30000 });
  await page.evaluate(MONITOR);
  await page.waitForTimeout(4000);   // the chart needs at least two samples

  const chartState = () => page.evaluate(() => {
    const r = document.getElementById('rtc-stream-monitor-host').shadowRoot;
    const slot = r.querySelector('[data-u=chart]');
    const tt = r.querySelector('#tt');
    return {
      hasChw: !!r.querySelector('#chw'),
      slotEmpty: !slot || slot.innerHTML.trim() === '',
      tooltip: tt ? tt.style.display : null
    };
  });
  const before = await chartState();
  const box = await page.evaluate(() => {
    const r = document.getElementById('rtc-stream-monitor-host').shadowRoot;
    const b = r.querySelector('#chw').getBoundingClientRect();
    return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
  });
  await page.mouse.move(box.x, box.y);
  await page.waitForTimeout(400);
  const hovering = await chartState();

  // A participant joins while the pointer stays on the chart.
  await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 320; canvas.height = 180;
    const cx = canvas.getContext('2d');
    setInterval(() => { cx.fillStyle = '#3987e5'; cx.fillRect(0, 0, 320, 180); }, 100);
    const stream = canvas.captureStream(10);
    const a = new RTCPeerConnection(), b = new RTCPeerConnection();
    window.__hoverJoinPCs = [a, b];
    stream.getTracks().forEach(t => a.addTrack(t, stream));
    a.onicecandidate = e => e.candidate && b.addIceCandidate(e.candidate);
    b.onicecandidate = e => e.candidate && a.addIceCandidate(e.candidate);
    const offer = await a.createOffer(); await a.setLocalDescription(offer);
    await b.setRemoteDescription(offer);
    const answer = await b.createAnswer(); await b.setLocalDescription(answer);
    await a.setRemoteDescription(answer);
  });
  await page.waitForTimeout(4000);   // several ticks: the rebuild lands mid-hover
  const during = await chartState();
  await page.mouse.move(5, 5);
  await page.waitForTimeout(2500);
  const after = await chartState();
  await ctx.close();
  return { errors, before, hovering, during, after };
}

/* Minimising must be paint-only. A participant who joins and whose tile
   churns away entirely while the panel is minimised must still be remembered:
   name-proving lives in the model phase, not the render path. */
async function minimisedNamesScenario(browser) {
  const run = async (minimised) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(HARNESS + '?mode=rtp');
    await page.waitForFunction(() => window.__harnessReady === true, { timeout: 30000 });
    await page.evaluate(MONITOR);
    await page.waitForTimeout(2500);
    const clickMin = () => page.evaluate(() => {
      document.getElementById('rtc-stream-monitor-host')
        .shadowRoot.getElementById('bmin').click();
    });
    if (minimised) { await clickMin(); await page.waitForTimeout(300); }

    // "Late Larry" joins: loopback PC plus a labelled tile rendering his track.
    await page.evaluate(async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 320; canvas.height = 180;
      const cx = canvas.getContext('2d');
      setInterval(() => { cx.fillStyle = '#d95926'; cx.fillRect(0, 0, 320, 180); }, 100);
      const stream = canvas.captureStream(10);
      const a = new RTCPeerConnection(), b = new RTCPeerConnection();
      window.__larryPCs = [a, b];
      stream.getTracks().forEach(t => a.addTrack(t, stream));
      b.ontrack = (e) => {
        const tile = document.createElement('div');
        tile.setAttribute('aria-label', 'Late Larry');
        const v = document.createElement('video');
        v.autoplay = true; v.muted = true;
        v.srcObject = new MediaStream([e.track]);
        tile.appendChild(v);
        document.body.appendChild(tile);
        window.__larryTile = tile;
        window.__larryTrack = e.track.id;
      };
      a.onicecandidate = e => e.candidate && b.addIceCandidate(e.candidate);
      b.onicecandidate = e => e.candidate && a.addIceCandidate(e.candidate);
      const offer = await a.createOffer(); await a.setLocalDescription(offer);
      await b.setRemoteDescription(offer);
      const answer = await b.createAnswer(); await b.setLocalDescription(answer);
      await a.setRemoteDescription(answer);
    });
    await page.waitForTimeout(3500);   // ticks pass with Larry's tile on screen
    await page.evaluate(() => { window.__larryTile.remove(); });
    await page.waitForTimeout(2000);
    if (minimised) { await clickMin(); await page.waitForTimeout(1500); }

    const title = await page.evaluate(() => {
      const r = document.getElementById('rtc-stream-monitor-host').shadowRoot;
      const m = window.__rtcStreamMonitor__.model;
      const larry = m.inbound.filter(s => s.track === window.__larryTrack)[0];
      if (!larry) return '(stream not found)';
      const card = r.querySelector('.card[data-sid="' + CSS.escape(larry.id) + '"]');
      return card ? card.querySelector('[data-u=ttl]').textContent.trim() : '(card not found)';
    });
    await ctx.close();
    return title;
  };
  return { control: await run(false), minimised: await run(true) };
}

async function zoomEarlyNestedScenario(browser) {
  const ctx = await browser.newContext();
  // Context init scripts run before every frame's page script, matching a MAIN
  // world document_start content script without loading an extension fixture.
  await ctx.addInitScript(EARLY_CAPTURE);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e.message)));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.route('https://app.zoom.us/**', route => route.fulfill({
    status: 200, contentType: 'text/html', body: HARNESS_HTML
  }));
  await page.goto('https://app.zoom.us/wc/5467856297/start?mode=zoom-early-nested');
  await page.waitForFunction(() => window.__harnessReady === true, { timeout: 30000 });
  const child = page.frames().find(frame => /\/5467856297\/start\?/.test(frame.url()) &&
    new URL(frame.url()).searchParams.get('from') === 'pwa');
  if (!child) throw new Error('Zoom media child frame was not created');
  await child.waitForFunction(() => window.__harnessReady === true, { timeout: 30000 });
  const before = await child.evaluate(() => window.__zoomEarlyFixture);

  // The extension targets all frames. The empty outer realm must stay hidden;
  // the child must drain the stash and reveal the one useful monitor.
  for (const frame of page.frames()) await frame.evaluate(MONITOR);
  await child.waitForFunction(() =>
    window.__rtcStreamMonitor__ && window.__rtcStreamMonitor__.model &&
      window.__rtcStreamMonitor__.model.pcs >= 2,
    { timeout: 15000 }
  );
  await page.waitForTimeout(2200);
  const childProbe = await child.evaluate(probe);
  const frames = [];
  for (const frame of page.frames()) {
    frames.push(await frame.evaluate(() => {
      const host = document.getElementById('rtc-stream-monitor-host');
      const visible = !!(host && getComputedStyle(host).display !== 'none' &&
        host.shadowRoot && host.shadowRoot.getElementById('panel') &&
        getComputedStyle(host.shadowRoot.getElementById('panel')).display !== 'none');
      return {
        path: location.pathname,
        hasApi: typeof window.__rtcStreamMonitor__ === 'object',
        hasHost: !!host,
        visible,
        pcs: window.__rtcStreamMonitor__ && window.__rtcStreamMonitor__.model
          ? window.__rtcStreamMonitor__.model.pcs : 0
      };
    }));
  }
  await page.screenshot({ path: './shot-zoom-early-nested.png' });
  await ctx.close();
  return { errors, before, child: childProbe, frames };
}

(async () => {
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM || (process.platform === 'darwin'
      ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
      : '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'),
    args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
           '--autoplay-policy=no-user-gesture-required']
  });

  const onlyZoom = process.env.RTC_MONITOR_ONLY === 'zoom-dc';
  if (!onlyZoom) {

  console.log('\n\x1b[1m1. RTP scenario — Meet-style DOM, 5 participants\x1b[0m');
  const a = await scenario(browser, 'rtp');
  check('no page errors', a.errors.length === 0, a.errors.slice(0, 2).join(' | ') || 'none');
  check('panel rendered', a.host === true);
  check('found peer connections', a.model && a.model.pcs > 0, a.model && a.model.pcs);
  check('inbound streams detected', a.model && a.model.nIn > 0, a.model && a.model.nIn);
  check('outbound streams detected', a.model && a.model.nOut > 0, a.model && a.model.nOut);
  check('receiving bitrate is non-zero', a.model && a.model.down > 0, a.down);
  check('sending bitrate is non-zero', a.model && a.model.up > 0, a.up);
  check('RTT rendered', a.rtt && a.rtt !== '—', a.rtt + ' ms');
  const named = a.cards.filter(c => /Ada|Grace|Alan|Katherine|Linus|Rosalind/.test(c.title || ''));
  check('names read from aria-label', named.length > 0, named.length + '/' + a.cards.length +
        ' → ' + a.cards.slice(0, 4).map(c => c.title).join(', '));
  check('", muted" suffix stripped from a11y label',
        !a.cards.some(c => /muted/i.test(c.title || '')),
        a.cards.map(c => c.title).join(' | ').slice(0, 90));
  check('codec + resolution in card meta', a.cards.some(c => /VP8|VP9|H264|OPUS/i.test(c.meta || '')),
        (a.cards[0] && a.cards[0].meta || '').slice(0, 70));
  check('body is scrollable when content overflows',
        a.scroll.scrollH > a.scroll.clientH, a.scroll.scrollH + ' > ' + a.scroll.clientH);

  console.log('\n\x1b[1m2. Guest-badge scenario — name glued to a role badge\x1b[0m');
  const g = await scenario(browser, 'guest');
  check('no page errors', g.errors.length === 0, g.errors.slice(0, 2).join(' | ') || 'none');
  check('badge text not absorbed into name',
        !g.cards.some(c => /Lovelace Guest|HopperGuest|Guest$/.test(c.title || '')),
        g.cards.map(c => c.title).join(' | ').slice(0, 90));

  console.log('\n\x1b[1m3. Airion two-person call — SSRC-only inbound Guest tracks\x1b[0m');
  const airion = await scenario(browser, 'airion-ssrc');
  check('no page errors', airion.errors.length === 0,
        airion.errors.slice(0, 2).join(' | ') || 'none');
  check('one incoming audio and one incoming video detected',
        airion.model && airion.model.nIn === 2, airion.model && airion.model.nIn);
  check('fixture exposes inbound RTP stats without trackIdentifier',
        airion.model && airion.model.rawInTrackIds.every(id => id === null),
        airion.model && JSON.stringify(airion.model.rawInTrackIds));
  check('fixture keeps browser-generated MediaStream ids',
        airion.mediaStreamIds.length >= 3 && airion.mediaStreamIds.every(id => !/^PA_.+\|/.test(id)),
        JSON.stringify(airion.mediaStreamIds));
  const airionInbound = airion.cards.filter(c => c.dir === 'in');
  const airionGuestCards = airionInbound.filter(c => c.title === 'Guest');
  check('SSRC-only incoming audio/video resolve through exact Airion owner metadata',
        airionGuestCards.length === 2,
        airionInbound.map(c => c.kind + ':' + c.title).join(' | '));
  check('incoming cards do not fall back to raw Audio/Video SSRC suffixes',
        !airion.cards.some(c => c.dir === 'in' && /^(?:Audio|Video) · \d{4}$/.test(c.title || '')),
        airionInbound.map(c => c.kind + ':' + c.title).join(' | '));
  check('exact Airion names are never marked approximate',
        airionInbound.every(c => !/\s\(likely\)$/.test(c.title || '')),
        airionInbound.map(c => c.title).join(' | '));

  console.log('\n\x1b[1m4. Airion multi-party — owner-scoped detached A/V attribution\x1b[0m');
  const airionMulti = await scenario(browser, 'airion-multiparty');
  check('no page errors', airionMulti.errors.length === 0,
        airionMulti.errors.slice(0, 2).join(' | ') || 'none');
  check('four SSRC-only incoming streams detected',
        airionMulti.model && airionMulti.model.nIn === 4,
        airionMulti.model && airionMulti.model.nIn);
  check('multi-party fixture omits every raw inbound trackIdentifier',
        airionMulti.model && airionMulti.model.rawInTrackIds.every(id => id === null),
        airionMulti.model && JSON.stringify(airionMulti.model.rawInTrackIds));
  check('multi-party fixture does not smuggle ownership through MediaStream.id',
        airionMulti.mediaStreamIds.length >= 5 && airionMulti.mediaStreamIds.every(id => !/^PA_.+\|/.test(id)),
        JSON.stringify(airionMulti.mediaStreamIds));
  const multiInbound = airionMulti.cards.filter(c => c.dir === 'in');
  const kindsFor = name => multiInbound.filter(c => c.title === name).map(c => c.kind).sort().join(',');
  check('Test5 owns exactly its incoming audio and video',
        kindsFor('Test5') === 'audio,video',
        multiInbound.map(c => c.kind + ':' + c.title).join(' | '));
  check('Guest owns exactly its incoming audio and video',
        kindsFor('Guest') === 'audio,video',
        multiInbound.map(c => c.kind + ':' + c.title).join(' | '));
  check('no multi-party inbound card is cross-attributed or left as SSRC',
        multiInbound.length === 4 && multiInbound.every(c => c.title === 'Test5' || c.title === 'Guest'),
        multiInbound.map(c => c.kind + ':' + c.title).join(' | '));
  check('Airion multi-party exact attribution remains unmarked',
        multiInbound.every(c => !/\s\(likely\)$/.test(c.title || '')),
        multiInbound.map(c => c.title).join(' | '));

  console.log('\n\x1b[1m5. Meet virtual slots — explicit approximate mid-rank pairing\x1b[0m');
  const meetRank = await scenario(browser, 'meet-audio-rank', 6000, true);
  check('no page errors', meetRank.errors.length === 0,
        meetRank.errors.slice(0, 2).join(' | ') || 'none');
  const rankInbound = meetRank.cards.filter(c => c.dir === 'in');
  const rankAudio = rankInbound.filter(c => c.kind === 'audio').sort((a, b) => Number(a.mid) - Number(b.mid));
  const rankVideo = rankInbound.filter(c => c.kind === 'video').sort((a, b) => Number(a.mid) - Number(b.mid));
  const rankGroups = meetRank.meetFixture && meetRank.meetFixture.mediaGroups || [];
  check('fixture has distinct virtual streams and live Meet mids 3/4 vs 10/11',
        rankGroups.length === 4 && rankGroups.every(group => group.streamId && group.trackIds.length === 1) &&
          new Set(rankGroups.map(group => group.streamId)).size === 4 &&
          rankAudio.map(c => c.mid).join(',') === '3,4' && rankVideo.map(c => c.mid).join(',') === '10,11',
        rankInbound.map(c => c.kind + ':' + c.mid + ':' + c.title).join(' | '));
  check('all ranked tracks and mids are non-empty and unique',
        rankInbound.every(c => c.track && c.mid !== null && c.mid !== undefined && c.mid !== '') &&
          new Set(rankInbound.map(c => c.track)).size === 4 &&
          new Set(rankInbound.map(c => c.kind + ':' + c.mid)).size === 4,
        rankInbound.map(c => c.kind + ':' + c.mid + ':' + c.track).join(' | '));
  check('audio names are paired by numeric mid rank and visibly marked approximate',
        rankAudio.map(c => c.title).join('|') ===
          rankVideo.map(c => c.title + ' (likely)').join('|'),
        rankAudio.map(c => c.mid + ':' + c.title).join(' | '));
  check('exact video names remain unmarked',
        rankVideo.length === 2 &&
          new Set(rankVideo.map(c => c.title)).size === 2 &&
          rankVideo.every(c => /^(?:Ada Lovelace|Grace Hopper)$/.test(c.title || '')),
        rankVideo.map(c => c.mid + ':' + c.title).join(' | '));

  console.log('\n\x1b[1m6. Meet split PCs — rank pairing never crosses a connection\x1b[0m');
  const meetCrossPc = await scenario(browser, 'meet-audio-cross-pc', 6000, true);
  const crossAudio = meetCrossPc.cards.filter(c => c.dir === 'in' && c.kind === 'audio');
  check('different-PC audio remains SSRC-labelled',
        crossAudio.length === 1 && /^Audio · \d{4}$/.test(crossAudio[0].title || ''),
        crossAudio.map(c => c.mid + ':' + c.title).join(' | '));

  console.log('\n\x1b[1m7. Meet count mismatch — extra audio slot fails closed\x1b[0m');
  const meetMultiAudio = await scenario(browser, 'meet-audio-multi-audio', 6000, true);
  const multiAudioCards = meetMultiAudio.cards.filter(c => c.dir === 'in' && c.kind === 'audio');
  check('2 audio / 1 named video mismatch leaves every audio as SSRC',
        multiAudioCards.length === 2 && multiAudioCards.every(c => /^Audio · \d{4}$/.test(c.title || '')),
        multiAudioCards.map(c => c.mid + ':' + c.title).join(' | '));

  console.log('\n\x1b[1m8. Meet count mismatch — camera-off/extra video slot fails closed\x1b[0m');
  const meetMultiVideo = await scenario(browser, 'meet-audio-multi-video', 6000, true);
  const multiVideoAudio = meetMultiVideo.cards.filter(c => c.dir === 'in' && c.kind === 'audio');
  check('1 audio / 2 named video mismatch leaves audio as SSRC',
        multiVideoAudio.length === 1 && /^Audio · \d{4}$/.test(multiVideoAudio[0].title || ''),
        multiVideoAudio.map(c => c.mid + ':' + c.title).join(' | '));

  console.log('\n\x1b[1m9. Meet missing/duplicate mids — invalid rank sets fail closed\x1b[0m');
  const meetMissingMid = await scenario(browser, 'meet-audio-missing-mid', 6000, true);
  const missingMidAudio = meetMissingMid.cards.filter(c => c.dir === 'in' && c.kind === 'audio');
  check('missing audio mid rejects the whole approximate pairing set',
        missingMidAudio.length === 2 && missingMidAudio.every(c => /^Audio · \d{4}$/.test(c.title || '')),
        missingMidAudio.map(c => String(c.mid) + ':' + c.title).join(' | '));
  const meetDuplicateMid = await scenario(browser, 'meet-audio-duplicate-mid', 6000, true);
  const duplicateMidAudio = meetDuplicateMid.cards.filter(c => c.dir === 'in' && c.kind === 'audio');
  check('duplicate audio mid rejects the whole approximate pairing set',
        duplicateMidAudio.length === 2 && duplicateMidAudio.every(c => /^Audio · \d{4}$/.test(c.title || '')),
        duplicateMidAudio.map(c => String(c.mid) + ':' + c.title).join(' | '));

  console.log('\n\x1b[1m10. Meet missing/duplicate tracks — invalid owner sets fail closed\x1b[0m');
  const meetMissingTrack = await scenario(browser, 'meet-audio-missing-track', 6000, true);
  const missingTrackAudio = meetMissingTrack.cards.filter(c => c.dir === 'in' && c.kind === 'audio');
  check('missing audio track rejects the whole approximate pairing set',
        missingTrackAudio.length === 2 && missingTrackAudio.every(c => /^Audio · \d{4}$/.test(c.title || '')),
        missingTrackAudio.map(c => String(c.track) + ':' + c.title).join(' | '));
  const meetDuplicateTrack = await scenario(browser, 'meet-audio-duplicate-track', 6000, true);
  const duplicateTrackAudio = meetDuplicateTrack.cards.filter(c => c.dir === 'in' && c.kind === 'audio');
  check('duplicate audio track rejects the whole approximate pairing set',
        duplicateTrackAudio.length === 2 && duplicateTrackAudio.every(c => /^Audio · \d{4}$/.test(c.title || '')),
        duplicateTrackAudio.map(c => String(c.track) + ':' + c.title).join(' | '));
  const meetDuplicateName = await scenario(browser, 'meet-audio-duplicate-name', 6000, true);
  const duplicateNameAudio = meetDuplicateName.cards.filter(c => c.dir === 'in' && c.kind === 'audio');
  check('duplicate exact video owner names reject the whole approximate pairing set',
        duplicateNameAudio.length === 2 &&
          duplicateNameAudio.every(c => /^Audio · \d{4}$/.test(c.title || '')),
        duplicateNameAudio.map(c => String(c.mid) + ':' + c.title).join(' | '));
  const meetConflictingExact = await scenario(browser, 'meet-audio-conflicting-exact', 6000, true);
  const conflictingExactAudio = meetConflictingExact.cards.filter(c => c.dir === 'in' && c.kind === 'audio');
  check('a contradictory exact audio owner rejects approximation for the whole set',
        conflictingExactAudio.length === 2 &&
          conflictingExactAudio.filter(c => c.title === 'Conflicting Owner').length === 1 &&
          conflictingExactAudio.filter(c => /^Audio · \d{4}$/.test(c.title || '')).length === 1 &&
          conflictingExactAudio.every(c => !/\s\(likely\)$/.test(c.title || '')),
        conflictingExactAudio.map(c => String(c.mid) + ':' + c.title).join(' | '));

  const meetLookalike = await scenario(browser, 'meet-audio-rank', 6000, 'meet.google.example');
  const lookalikeAudio = meetLookalike.cards.filter(c => c.dir === 'in' && c.kind === 'audio');
  check('Meet-looking page on another hostname never enables approximate pairing',
        lookalikeAudio.length === 2 && lookalikeAudio.every(c => /^Audio · \d{4}$/.test(c.title || '')),
        lookalikeAudio.map(c => c.mid + ':' + c.title).join(' | '));

  console.log('\n\x1b[1m11. Zoom document-start capture — nested media frame\x1b[0m');
  const zoomEarly = await zoomEarlyNestedScenario(browser);
  check('no Zoom fixture page errors', zoomEarly.errors.length === 0,
        zoomEarly.errors.slice(0, 2).join(' | ') || 'none');
  check('Zoom child created its PCs before monitor injection',
        zoomEarly.before && zoomEarly.before.createdBeforeMonitor === true,
        JSON.stringify(zoomEarly.before));
  check('document-start shim stashed both pre-monitor PCs',
        zoomEarly.before && zoomEarly.before.stashedBeforeMonitor === 2,
        JSON.stringify(zoomEarly.before));
  check('child monitor adopted the pre-existing connections',
        zoomEarly.child.model && zoomEarly.child.model.pcs >= 2,
        zoomEarly.child.model && zoomEarly.child.model.pcs);
  check('child monitor panel is rendered', zoomEarly.child.host === true);
  const visibleZoomFrames = zoomEarly.frames.filter(frame => frame.visible);
  check('only the Zoom media child shows a visible monitor panel',
        visibleZoomFrames.length === 1 && visibleZoomFrames[0].path === '/5467856297/start',
        zoomEarly.frames.map(frame => frame.path + ':visible=' + frame.visible + ':pcs=' + frame.pcs).join(' | '));
  const zoomOuter = zoomEarly.frames.find(frame => frame.path === '/wc/5467856297/start');
  check('outer Zoom shell never shows a duplicate empty panel',
        zoomOuter && zoomOuter.visible === false && zoomOuter.pcs === 0,
        zoomOuter && JSON.stringify(zoomOuter));

  console.log('\n\x1b[1m12. DataChannel scenario — Zoom-style, no RTP tracks\x1b[0m');
  const d = await scenario(browser, 'dc', 8000);
  check('no page errors', d.errors.length === 0, d.errors.slice(0, 2).join(' | ') || 'none');
  check('panel rendered', d.host === true);
  check('found peer connections', d.model && d.model.pcs > 0, d.model && d.model.pcs);
  check('zero RTP streams (as expected)', d.model && d.model.nIn === 0 && d.model.nOut === 0,
        'in ' + (d.model && d.model.nIn) + ' / out ' + (d.model && d.model.nOut));
  check('fell back to transport totals', d.model && d.model.viaTransport === true);
  check('throughput still reported', d.model && (d.model.down > 0 || d.model.up > 0),
        '↓ ' + d.down + '  ↑ ' + d.up);
  check('data channels retained in the internal model', d.model && d.model.dcs > 0,
        d.model && d.model.dcs);
  check('data channels retained in the JSON dump', d.dumpDataChannels > 0,
        d.dumpDataChannels);
  check('data-channel cards are not rendered', d.dcs.length === 0, d.dcs.length);
  check('Data channels section is not rendered',
        !d.sections.some(section => /^data channels\b/i.test(section)),
        d.sections.join(' | '));
  check('generic/file DataChannel page gets no Zoom media estimates',
        d.zoomMediaChannels.length === 0 &&
          !(d.model && d.model.zoomMediaChannels.length),
        JSON.stringify(d.zoomMediaChannels));
  check('explanatory note shown', d.notes.some(n => /data channel/i.test(n)),
        (d.notes[0] || '').slice(0, 80));
  check('"all traffic" label on tiles', d.allTraffic === true);
  }

  console.log('\n\x1b[1m13. Zoom /wc DataChannels — exact media-label estimates\x1b[0m');
  const zoomDcRun = await zoomDataChannelScenario(browser);
  const zoomFirst = zoomDcRun.first, zoomDc = zoomDcRun.settled;
  check('no exact Zoom DataChannel fixture errors', zoomDcRun.errors.length === 0,
        zoomDcRun.errors.slice(0, 2).join(' | ') || 'none');
  check('fixture runs on the exact Zoom /wc route',
        /^https:\/\/app\.zoom\.us\/wc\/5467856297\/start\?/.test(zoomDc.url || ''),
        zoomDc.url);
  check('first sample keeps unknown hero and channel rates as em dashes',
        zoomFirst.model && zoomFirst.model.down === null && zoomFirst.model.up === null &&
          zoomFirst.down === '—' && zoomFirst.up === '—' &&
          zoomFirst.zoomMediaChannels.length === 2 &&
          zoomFirst.zoomMediaChannels.every(row => row.bps === '↓ — · ↑ —'),
        'hero ↓ ' + zoomFirst.down + ' ↑ ' + zoomFirst.up + ' / ' +
          zoomFirst.zoomMediaChannels.map(row => row.bps).join(' | '));
  check('transport-only Zoom quality is neutral Connected',
        /\bConnected\b/.test(zoomFirst.quality || '') &&
          /\bConnected\b/.test(zoomDc.quality || '') &&
          !/Excellent|Good|Fair|Poor/.test((zoomFirst.quality || '') + ' ' + (zoomDc.quality || '')),
        'first=' + zoomFirst.quality + ' settled=' + zoomDc.quality);
  check('exact /wc fixture remains transport-only',
        zoomDc.model && zoomDc.model.pcs === 1 && zoomDc.model.viaTransport === true &&
          zoomDc.model.nIn === 0 && zoomDc.model.nOut === 0,
        zoomDc.model && JSON.stringify(zoomDc.model));
  const zoomKinds = zoomDc.model
    ? zoomDc.model.zoomMediaChannels.map(row => row.kind).sort().join(',')
    : '';
  check('exact live labels produce one estimated audio and video group',
        zoomDc.model && zoomDc.model.zoomMediaChannels.length === 2 &&
          zoomKinds === 'audio,video',
        zoomKinds || 'none');
  check('both channel groups preserve non-zero receive and send rates',
        zoomDc.model && zoomDc.model.zoomMediaChannels.every(row =>
          row.inKbps > 0 && row.outKbps > 0),
        zoomDc.model && JSON.stringify(zoomDc.model.zoomMediaChannels));
  check('duplicate exact labels retain source and PC provenance',
        zoomDc.model && zoomDc.model.zoomMediaChannels.every(row =>
          row.sourceCount === 2 && Array.isArray(row.pcKeys) && row.pcKeys.length === 1),
        zoomDc.model && JSON.stringify(zoomDc.model.zoomMediaChannels));
  check('two estimated channel rows render with both directional rates',
        zoomDc.zoomMediaChannels.length === 2 &&
          zoomDc.zoomMediaChannels.every(row =>
            /^↓ .+ · ↑ .+$/.test(row.bps || '') &&
            !/↓ 0 kbps/.test(row.bps || '') &&
            !/↑ 0 kbps/.test(row.bps || '')),
        zoomDc.zoomMediaChannels.map(row => row.kind + ':' + row.bps).join(' | '));
  check('estimated rows make only kind-level, all-participant claims',
        zoomDc.zoomMediaChannels.map(row => row.title).sort().join('|') ===
          'Audio channel (estimated)|Video channel (estimated)' &&
          zoomDc.zoomMediaChannels.every(row => row.meta === 'all participants · 2 channels combined') &&
          zoomDc.zoomMediaChannels.every(row =>
            !/Mahmud|Guest|OPUS|VP8|VP9|H264|codec|ZoomWebclient/i.test(row.text || '')),
        zoomDc.zoomMediaChannels.map(row => row.title + ' / ' + row.meta).join(' | '));
  check('no RTP or raw DataChannel cards render beside estimates',
        zoomDc.cards.length === 0 && zoomDc.dcs.length === 0 &&
          !zoomDc.sections.some(section => /^data channels\b/i.test(section)),
        'rtp=' + zoomDc.cards.length + ' dc=' + zoomDc.dcs.length +
          ' sections=' + zoomDc.sections.join(' | '));
  check('raw exact channels stay available in the JSON dump',
        zoomDc.dumpDataChannels === 4, zoomDc.dumpDataChannels);
  check('aggregate transport totals remain the hero rates',
        zoomDc.model && Math.round(zoomDc.model.tIn) === zoomDc.model.down &&
          Math.round(zoomDc.model.tOut) === zoomDc.model.up,
        zoomDc.model && ('↓ ' + zoomDc.model.down + '/' + zoomDc.model.tIn +
          ' ↑ ' + zoomDc.model.up + '/' + zoomDc.model.tOut));

  if (onlyZoom) {
    await browser.close();
    console.log('\n' + (failures === 0
      ? '\x1b[32m\x1b[1mAll ' + checks + ' focused Zoom checks passed.\x1b[0m'
      : '\x1b[31m\x1b[1m' + failures + ' focused Zoom check(s) failed.\x1b[0m') + '\n');
    process.exitCode = failures ? 1 : 0;
    return;
  }

  console.log('\n\x1b[1m14. Off-grid participants — the people panel names them\x1b[0m');
  const off = await scenario(browser, 'airion-offgrid');
  const offIn = off.cards.filter(c => c.dir === 'in');
  const offTitle = k => offIn.filter(c => c.kind === k).map(c => c.title).sort().join(', ');
  check('no page errors', off.errors.length === 0, off.errors.slice(0, 2).join(' | ') || 'none');
  // Two remote participants, but only one of them is rendered as a tile
  // (meetTileCount also counts the local self tile).
  check('only one of the two participants is on the grid',
        off.meetTileCount === 2, off.meetTileCount + ' tiles incl. self');
  // The one with a tile is named the way it always was.
  check('the on-grid participant is named from their tile',
        offTitle('audio').indexOf('On Grid') >= 0, offTitle('audio') || 'none');
  // The whole point: no tile and no participant DOM of its own — only a row in
  // the people panel — and their microphone still gets their name.
  check('the off-grid participant is named from the people panel',
        offTitle('audio') === 'Off Grid, On Grid', offTitle('audio') || 'none');
  check('no receiving card falls back to an SSRC label',
        offIn.filter(c => /^(Audio|Video) · \d{4}$/.test(c.title)).length === 0,
        offIn.map(c => c.title).join(' | '));

  console.log('\n\x1b[1m15. Tile churn — a name survives its tile, but is never invented\x1b[0m');
  const churn = await tileChurnScenario(browser);
  const inCards = r => r.cards.filter(c => c.dir === 'in');
  const titlesFor = (r, name) => inCards(r).filter(c => c.title === name).map(c => c.kind).sort();
  check('no page errors', churn.errors.length === 0, churn.errors.slice(0, 2).join(' | ') || 'none');
  check('a tile in the document names both its streams',
        titlesFor(churn.before, 'Ada Plain').join(',') === 'audio,video',
        titlesFor(churn.before, 'Ada Plain').join(',') || 'unnamed');
  // Audio played through a hidden sink has no tile of its own; only the sender's
  // msid grouping ties it to the video that does.
  check('detached audio takes the name proved for its own video',
        titlesFor(churn.before, 'Detached Dana').join(',') === 'audio,video',
        titlesFor(churn.before, 'Detached Dana').join(',') || 'unnamed');
  // The whole point of the guard: no DOM anywhere claims this media, so nothing
  // may be guessed from a neighbouring tile or the page's text.
  check('media attached to no element stays SSRC-labelled',
        titlesFor(churn.before, 'Never Nina').length === 0 &&
        inCards(churn.before).filter(c => /^(Audio|Video) · \d{4}$/.test(c.title)).length === 2,
        inCards(churn.before).filter(c => /·/.test(c.title)).map(c => c.title).join(' | ') || 'none');
  check('the unmounted tile really left the document',
        churn.after.meetTileCount === churn.before.meetTileCount - 1,
        churn.before.meetTileCount + ' tiles -> ' + churn.after.meetTileCount);
  check('a participant scrolled out of the grid keeps their name',
        titlesFor(churn.after, 'Vanishing Vera').join(',') === 'audio,video',
        titlesFor(churn.after, 'Vanishing Vera').join(',') || 'lost the name');
  // Measured on a live Aloqa call: joining with the camera off leaves no local
  // media element at all, so an outgoing card had nothing to read a name from.
  check('camera off really leaves no local media element',
        churn.camOff.localElements === 0, 'local elements: ' + churn.camOff.localElements);
  const outCards = r => r.cards.filter(c => c.dir === 'out');
  const ssrcLabelled = cs => cs.filter(c => /^(Audio|Video) · \d{4}$/.test(c.title));
  check('no outgoing card loses its name when the camera goes off',
        outCards(churn.camOff).length > 0 && ssrcLabelled(outCards(churn.camOff)).length === 0,
        ssrcLabelled(outCards(churn.camOff)).map(c => c.title).join(' | ') || 'all named');
  // The loopback harness sends every participant's media, so an outgoing stream
  // with its own named sibling keeps that name; the self tile is what rescues
  // the ones with no other evidence — which is the whole outgoing side on a
  // real call, where only one person is sending.
  check('an outgoing card with no other evidence takes the self tile\'s name',
        outCards(churn.camOff).some(c => c.title === 'Mahmud (you)'),
        outCards(churn.camOff).map(c => c.kind + ':' + c.title).join(' | '));
  // A deactivated encoding is a paused stream, not a dead one — but it is
  // provably inactive, so the default view hides it while the header counts
  // it, and the model keeps it whole.
  check('a switched-off camera leaves the default view but not the model',
        !churn.camOff.cards.some(c => /camera off/.test(c.meta || '')) &&
        churn.camOff.model.quiet >= 1 &&
        churn.camOff.quietPills.some(p => /^\+\d+ quiet$/.test(p)),
        'quiet=' + churn.camOff.model.quiet + ' pills=' + churn.camOff.quietPills.join(','));
  const offCards = churn.camOffRevealed.cards.filter(c => c.dir === 'out' && /camera off/.test(c.meta || ''));
  check('revealing quiet shows the card and says why',
        offCards.length === 1 && offCards[0].kind === 'video' && /^0(\.0+)? ?kbps$/i.test(offCards[0].bps),
        offCards.map(c => c.kind + ' ' + c.bps + ' — ' + c.meta).join(' | ') || 'no card carries the marker');
  check('only the switched-off stream is marked',
        churn.camOffRevealed.cards.filter(c => /camera off|microphone off/.test(c.meta || '')).length === 1,
        churn.camOffRevealed.cards.filter(c => /camera off|microphone off/.test(c.meta || ''))
          .map(c => c.dir + ':' + c.title).join(' | '));
  // Switching the camera back on renegotiates nothing; bytes prove activity
  // and the card must return to the default view by itself.
  check('a resumed stream returns to the default view immediately',
        churn.camBack.cards.some(c => c.dir === 'out' && c.kind === 'video' &&
          c.title === 'Ada Plain' && !/camera off/.test(c.meta || '')) &&
        churn.camBack.model.quiet === 0,
        'quiet=' + churn.camBack.model.quiet + ' → ' +
        churn.camBack.cards.filter(c => c.dir === 'out' && c.kind === 'video')
          .map(c => c.title + (/camera off/.test(c.meta || '') ? ' (off)' : '')).join(' | '));
  check('the self tile never names an incoming card',
        !churn.camOff.cards.filter(c => c.dir === 'in').some(c => c.title === 'Mahmud (you)'),
        churn.camOff.cards.filter(c => c.dir === 'in').map(c => c.title).join(' | '));
  check('unmounting one tile does not disturb the others',
        titlesFor(churn.after, 'Ada Plain').join(',') === 'audio,video' &&
        titlesFor(churn.after, 'Detached Dana').join(',') === 'audio,video',
        inCards(churn.after).map(c => c.title).join(' | '));

  console.log('\n\x1b[1m16. Departure — a participant who left stops being a card\x1b[0m');
  const dep = await departureScenario(browser);
  const inTitles = r => r.cards.filter(c => c.dir === 'in').map(c => c.title);
  const inRates = (r, name) => r.cards
    .filter(c => c.dir === 'in' && c.title === name).map(c => c.bps);
  check('no page errors', dep.errors.length === 0, dep.errors.slice(0, 2).join(' | ') || 'none');
  check('all three participants start with audio and video',
        dep.before.model.nIn === 6 && dep.before.model.nOut === 6 &&
        ['Ada Lovelace', 'Grace Hopper', 'Alan Turing']
          .every(n => inTitles(dep.before).filter(t => t === n).length === 2),
        inTitles(dep.before).sort().join(', '));
  check('nothing is hidden while everyone is present', dep.before.ended.hidden === 0,
        JSON.stringify(dep.before.ended));
  // The bug: Chrome keeps the departed participant's stat, frozen at 0 kb/s.
  check('Chrome still reports the departed stats', dep.afterOne.ended.hidden > 0,
        'raw ' + dep.afterOne.ended.rawStats + ' stats, ' + dep.afterOne.ended.hidden + ' hidden');
  check('the participant who left is gone from the list',
        dep.afterOne.model.nIn === 4 && dep.afterOne.model.nOut === 4,
        'in ' + dep.afterOne.model.nIn + ' / out ' + dep.afterOne.model.nOut);
  check('a muted participant keeps both cards',
        inTitles(dep.afterOne).filter(t => t === 'Grace Hopper').length === 2,
        inRates(dep.afterOne, 'Grace Hopper').join(' | ') || 'gone');
  // 0 kb/s is still not proof of DEATH — the stalled streams stay in the
  // model at full strength — but three proven-zero samples are proof of
  // INACTIVITY, so the default view hides them behind the header count.
  check('a stalled participant is quiet-hidden but never removed',
        inTitles(dep.afterOne).filter(t => t === 'Alan Turing').length === 0 &&
        dep.afterOne.model.nIn === 4 && dep.afterOne.model.quiet >= 2 &&
        dep.afterOne.quietPills.some(p => /^\+\d+ quiet$/.test(p)),
        'in=' + dep.afterOne.model.nIn + ' quiet=' + dep.afterOne.model.quiet +
        ' pills=' + dep.afterOne.quietPills.join(','));
  check('revealed quiet still shows the stalled cards at 0 kb/s',
        inTitles(dep.afterOneRevealed).filter(t => t === 'Alan Turing').length === 2 &&
        inRates(dep.afterOneRevealed, 'Alan Turing').every(b => /^0(\.0+)? ?kbps$/i.test(b)),
        inRates(dep.afterOneRevealed, 'Alan Turing').join(' | ') || 'gone');
  check('every card is gone once everyone has left',
        dep.afterAll.model.nIn === 0 && dep.afterAll.model.nOut === 0 &&
        dep.afterAll.cards.length === 0,
        dep.afterAll.cards.map(c => c.title).join(', ') || 'no cards');
  check('no empty Sending or Receiving section is left behind',
        !dep.afterAll.sections.some(s => /Sending|Receiving/.test(s)),
        dep.afterAll.sections.join(' | '));
  // Keepalive bytes keep the transport non-zero: an emptied call must not be
  // mistaken for an app that tunnels its media through DataChannels.
  check('an emptied call is never reported as tunnelled media',
        dep.afterAll.model.viaTransport === false &&
        !dep.afterAll.notes.some(n => /tunnels media/i.test(n)),
        'viaTransport=' + dep.afterAll.model.viaTransport +
        ' notes=' + (dep.afterAll.notes.join(' | ') || 'none'));

  console.log('\n\x1b[1m17. Lifecycle — minimise, prune, stop and restart safety\x1b[0m');
  const life = await lifecycleScenario(browser);
  check('prototype hook installed', life.before.hooked === true);
  check('stats keep collecting while minimised', life.after.t > life.before.t,
        life.before.t + ' -> ' + life.after.t);
  check('closed peer connections pruned', life.before.pcs > 0 && life.after.pcs === 0,
        life.before.pcs + ' -> ' + life.after.pcs);
  check('stream history existed before close', life.before.oldId && life.before.historyKeys.includes(life.before.oldId),
        life.before.oldId || 'no stream card');
  check('expanded state existed before close', life.before.oldId && life.before.expandedKeys.includes(life.before.oldId),
        life.before.expandedKeys.join(', ') || 'none');
  check('stale stream history pruned', life.before.oldId && !life.after.historyKeys.includes(life.before.oldId),
        life.after.historyKeys.join(', ') || 'none');
  check('stale expanded state pruned', life.before.oldId && !life.after.expandedKeys.includes(life.before.oldId),
        life.after.expandedKeys.join(', ') || 'none');
  check('prototype hook restored by stop()', life.restored === true);

  console.log('\n\x1b[1m18. Chart hover — a mid-hover rebuild must not kill the chart\x1b[0m');
  const hover = await chartHoverScenario(browser);
  check('no page errors', hover.errors.length === 0, hover.errors.slice(0, 2).join(' | ') || 'none');
  check('chart rendered before the hover',
        hover.before.hasChw && !hover.before.slotEmpty, JSON.stringify(hover.before));
  check('a real pointer hover engages the crosshair tooltip',
        hover.hovering.tooltip === 'block', 'tooltip display=' + hover.hovering.tooltip);
  check('a participant joining mid-hover rebuilds without losing the chart',
        hover.during.hasChw && !hover.during.slotEmpty, JSON.stringify(hover.during));
  check('the chart stays live after the pointer leaves',
        hover.after.hasChw && !hover.after.slotEmpty && hover.after.tooltip !== 'block',
        JSON.stringify(hover.after));

  console.log('\n\x1b[1m19. Minimised naming — minimise is paint-only, names still proven\x1b[0m');
  const minNames = await minimisedNamesScenario(browser);
  check('control: a churned tile\'s name survives (never minimised)',
        minNames.control === 'Late Larry', minNames.control);
  check('a participant seen only while minimised is still remembered',
        minNames.minimised === 'Late Larry', minNames.minimised);

  console.log('\n\x1b[1m20. Version upgrade — a newer injection replaces a stale instance\x1b[0m');
  const up = await versionUpgradeScenario(browser);
  check('no page errors', up.errors.length === 0, up.errors.slice(0, 2).join(' | ') || 'none');
  check('the stale instance ran and captured the call',
        up.stale.version === '0.0.1-stale' && up.stale.pcs > 0,
        JSON.stringify(up.stale));
  check('a newer injection replaces the stale instance instead of toggling it',
        up.upgraded.version !== '0.0.1-stale' && up.upgraded.pcs > 0 &&
        up.upgraded.hosts === 1 && up.upgraded.visible === true,
        JSON.stringify(up.upgraded));
  check('re-running the same version still toggles',
        up.toggledOff === true && up.toggledBack === true,
        'off=' + up.toggledOff + ' back=' + up.toggledBack);

  console.log('\n\x1b[1m21. Shadow DOM — media and names inside open shadow roots\x1b[0m');
  const sh = await scenario(browser, 'shadow-dom');
  const shIn = sh.cards.filter(c => c.dir === 'in');
  const shTitles = name => shIn.filter(c => c.title === name).map(c => c.kind).sort().join(',');
  check('no page errors', sh.errors.length === 0, sh.errors.slice(0, 2).join(' | ') || 'none');
  check('streams rendered only inside shadow roots still get cards',
        sh.model && sh.model.nIn === 4 && shIn.length === 4,
        'model in=' + (sh.model && sh.model.nIn) + ' cards in=' + shIn.length);
  check('tiles inside shadow roots name their streams',
        shTitles('Shadow Sam') === 'audio,video' && shTitles('Shadow Sue') === 'audio,video',
        shIn.map(c => c.kind + ':' + c.title).join(' | '));
  check('no shadow stream falls back to an SSRC label',
        !shIn.some(c => /^(Audio|Video) · \d{4}$/.test(c.title || '')),
        shIn.map(c => c.title).join(' | '));
  // Loopback artifact: msid keeps the sender's track id, so each outbound card
  // exact-matches the remote shadow tile carrying that id. The point here is
  // only that the name crossed the shadow boundary rather than falling to SSRC.
  check('outbound cards are named across the shadow boundary',
        sh.cards.filter(c => c.dir === 'out').length > 0 &&
        sh.cards.filter(c => c.dir === 'out')
          .every(c => /^(Shadow (Sam|Sue)|Mahmud \(you\))$/.test(c.title || '')),
        sh.cards.filter(c => c.dir === 'out').map(c => c.kind + ':' + c.title).join(' | '));

  await browser.close();
  console.log('\n' + (failures === 0
    ? '\x1b[32m\x1b[1mAll ' + checks + ' checks passed.\x1b[0m'
    : '\x1b[31m\x1b[1m' + failures + ' check(s) failed.\x1b[0m') + '\n');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });
