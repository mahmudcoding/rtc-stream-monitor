// Click the toolbar button -> inject (or toggle) the monitor in the page's MAIN world.
// MAIN world is required: the monitor hooks RTCPeerConnection, which lives on the page's window.
//
// Two injection paths, tried in order:
//
//   1. chrome.scripting.executeScript({world:'MAIN'}) — the normal path. No
//      banner, works on nearly every site.
//
//   2. chrome.debugger + Runtime.evaluate — for pages that send
//      `require-trusted-types-for 'script'`. Google Meet is the case that forced
//      this: Chrome refuses to inject a main-world script there at all, as a
//      content script AND via executeScript, while an isolated-world content
//      script still runs. CDP evaluation is not subject to the page's CSP, so it
//      gets through. Non-Meet pages use a one-shot attach/evaluate/detach. Meet
//      keeps the attachment (and Chrome's debugging banner) for document-start
//      injection plus the heap harvest needed to discover its connections.
//
// The monitor itself still needs its Trusted Types policy (see `trust()` in
// monitor.js) — getting the code into the page does not exempt the DOM writes it
// then performs.

const CDP_VERSION = '1.3';

// Probing tells us two different things at once: whether the main world is
// reachable here at all, and whether the monitor is already running in it. A
// sentinel string separates "ran and reported false" from "never ran".
async function probeMainWorld(tabId) {
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: () => {
        const type = typeof window.__rtcStreamMonitor__;
        if (type !== 'object') return 'rtcmon:' + type;
        const host = document.getElementById('rtc-stream-monitor-host');
        const panel = host && host.shadowRoot && host.shadowRoot.getElementById('panel');
        const visible = !!(host && panel &&
          getComputedStyle(host).display !== 'none' &&
          getComputedStyle(panel).display !== 'none');
        return 'rtcmon:object:' + (visible ? 'visible' : 'hidden');
      }
    });
    const v = res && res.result;
    if (typeof v === 'string' && v.indexOf('rtcmon:') === 0) {
      return {
        mainWorldUsable: true,
        running: v.indexOf('rtcmon:object') === 0,
        visible: v === 'rtcmon:object:visible' ? true
          : (v === 'rtcmon:object:hidden' ? false : null)
      };
    }
  } catch (e) {
    // falls through to "refused"
  }
  return { mainWorldUsable: false, running: null, visible: null };
}

async function injectViaScripting(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    files: ['monitor.js'],
    world: 'MAIN'
  });
}

const MEET_URL = /^https:\/\/meet\.google\.com(?:\/|$)/;
const MEET_PRELOAD_PATTERNS = ['https://meet.google.com/*'];
const HARVEST_INTERVAL_MS = 5000;
const HARVEST_MAX_MS = Infinity; // tests replace this with a finite window
const MEET_RECOVERY_DELAYS_MS = [0, 50, 100, 250, 500, 1000];

/* A Meet tab is a persistent debugger session, rather than a one-shot fallback.
   The registration and Runtime.queryObjects both disappear when we detach, so
   keep all of their lifecycle state together and never start two heap polls for
   the same tab. */
const meetSessions = new Map(); // tabId -> session
const debuggerSuppressed = new Set(); // user explicitly dismissed Chrome's banner
/* tabId -> { token, reloadIssued, promise }.  Keeping the pending recovery in
   the registry before its first yield is important: tabs.onUpdated and a
   toolbar click can otherwise create a competing generation while Chrome is
   still publishing Meet's replacement renderer. */
const meetRecoveries = new Map();
let nextMeetSessionId = 1;

function newMeetSession(tabId) {
  return {
    tabId,
    id: nextMeetSessionId++,
    attached: false,
    preloadArmed: false,
    preloadPromise: null,
    scriptIdentifiers: new Set(),
    awaitingReload: false,
    reloadIssued: false,
    ensurePromise: null,
    harvestPromise: null,
    monitorConfirmed: false,
    stopped: false
  };
}

function isCurrentMeetSession(session) {
  return !!session && !session.stopped &&
    meetSessions.get(session.tabId) === session &&
    !debuggerSuppressed.has(session.tabId);
}

async function meetLocationIsCurrent(session) {
  if (!isCurrentMeetSession(session)) return false;
  let url = '';
  try { url = (await chrome.tabs.get(session.tabId)).url || ''; } catch (e) { /* fall back below */ }
  if (!isCurrentMeetSession(session)) return false;
  if (!url && session.attached) url = await debuggerUrl(session.tabId);
  return isCurrentMeetSession(session) && MEET_URL.test(url);
}

async function detachStaleMeetAttachment(session) {
  session.attached = false;
  /* A newer generation may already own the target; never let stale completion
     tear that session down. With no replacement session, the attachment can
     only belong to this abandoned generation. */
  if (meetSessions.has(session.tabId)) return;
  try { await chrome.debugger.detach({ tabId: session.tabId }); } catch (e) { /* already gone */ }
}

/* Injecting into the *running* page is not enough on Meet. By the time we get
   there Meet has already constructed its RTCPeerConnection, its prototype is
   frozen, and its instances live in Closure-compiled closures. The preload is
   useful for the monitor UI and future page code; Runtime.queryObjects below is
   still what discovers Meet's otherwise unreachable connections. */
let _sourceCache = null;
async function monitorSource() {
  if (!_sourceCache) _sourceCache = await (await fetch(chrome.runtime.getURL('monitor.js'))).text();
  return _sourceCache;
}

async function isAttached(tabId) {
  try {
    const targets = await chrome.debugger.getTargets();
    return targets.some(t => t.tabId === tabId && t.attached);
  } catch (e) {
    return false;
  }
}

function meetGuardedSource(source) {
  /* Current CDP has no URL filter for preloads. Even when the optional
     urlPatterns parameter is unavailable, this guard makes the registration a
     no-op in every non-Meet frame until navigation cleanup can detach us. */
  return 'if (location.protocol === "https:" && location.hostname === "meet.google.com") {\n' +
    source + '\n}';
}

async function armEarlyHook(session, source) {
  const tabId = session.tabId;
  if (!isCurrentMeetSession(session)) return { cancelled: true };
  await chrome.debugger.sendCommand({ tabId }, 'Page.enable', {});
  if (!isCurrentMeetSession(session)) return { cancelled: true };
  if (!(await meetLocationIsCurrent(session))) return { cancelled: true };
  const guardedSource = meetGuardedSource(source);
  const registration = (async () => {
    try {
      /* Some CDP implementations may grow a URL filter before the stable
         protocol does. Prefer it, but retain the source guard in either case. */
      return await chrome.debugger.sendCommand(
        { tabId },
        'Page.addScriptToEvaluateOnNewDocument',
        { source: guardedSource, urlPatterns: MEET_PRELOAD_PATTERNS }
      );
    } catch (e) {
      const message = (e && e.message) || String(e);
      if (!/invalid parameters|unknown parameter|urlPatterns|unexpected/i.test(message)) throw e;
      if (!isCurrentMeetSession(session) || !(await meetLocationIsCurrent(session))) {
        return { cancelled: true };
      }
      return await chrome.debugger.sendCommand(
        { tabId },
        'Page.addScriptToEvaluateOnNewDocument',
        { source: guardedSource }
      );
    }
  })();
  session.preloadPromise = registration;
  let result;
  try {
    result = await registration;
  } finally {
    if (session.preloadPromise === registration) session.preloadPromise = null;
  }
  /* Record the identifier before checking generation. cleanupMeetSession waits
     for this registration, so navigation cannot strand an in-flight preload. */
  if (result && result.identifier) session.scriptIdentifiers.add(result.identifier);
  if (!isCurrentMeetSession(session) || (result && result.cancelled)) return { cancelled: true };
  session.preloadArmed = true;
  return { identifier: result && result.identifier };
}

/* Meet's RTCPeerConnection instances are unreachable from page script: the
   constructor and its prototype methods are non-writable AND non-configurable,
   and the instances live in Closure-compiled closures, so no discovery strategy
   in monitor.js can see them at any injection time. DevTools' queryObjects()
   reads live instances straight off the heap, and it is available to us because
   we are attached — this is the one capability the debugger path buys that page
   script can never have. Requires includeCommandLineAPI. */
function staleHarvestError() {
  const error = new Error('stale Meet harvest generation');
  error.rtcMonitorCancelled = true;
  return error;
}

async function harvestConnections(session) {
  const tabId = session.tabId;
  const send = async (method, params) => {
    if (!isCurrentMeetSession(session)) throw staleHarvestError();
    const result = await chrome.debugger.sendCommand({ tabId }, method, params || {});
    /* target_closed can arrive while a protocol command is in flight.  Do not
       let the old loop continue against the replacement renderer (or interpret
       its result as the user closing the new monitor). */
    if (!isCurrentMeetSession(session)) throw staleHarvestError();
    return result;
  };
  await send('Runtime.enable');

  /* `queryObjects(Ctor)` is a DevTools console convenience and is not exposed to
     a plain CDP client — asking for it gets "queryObjects is not defined" even
     with includeCommandLineAPI. The protocol's own Runtime.queryObjects is the
     real one: give it a prototype handle and it returns every live object with
     that prototype, straight from the heap. */
  const proto = await send('Runtime.evaluate', {
    expression: 'window.RTCPeerConnection && window.RTCPeerConnection.prototype'
  });
  const protoId = proto && proto.result && proto.result.objectId;
  if (!protoId) return { error: 'no RTCPeerConnection.prototype handle' };

  let arrayId = null;
  try {
    const q = await send('Runtime.queryObjects', { prototypeObjectId: protoId });
    arrayId = q && q.objects && q.objects.objectId;
    if (!arrayId) return { error: 'queryObjects returned no handle' };

    // Hand the live instances to the monitor from inside the page.
    const call = await send('Runtime.callFunctionOn', {
      objectId: arrayId,
      returnByValue: true,
      functionDeclaration: 'function () {' +
        '  var api = window.__rtcStreamMonitor__;' +
        '  if (!api || typeof api.adopt !== "function") return { error: "monitor not present" };' +
        '  return { seen: this.length, adopted: api.adopt(this), pcs: (api.model || {}).pcs || 0 };' +
        '}'
    });
    return call && call.result ? call.result.value : null;
  } finally {
    /* Object handles belong to one renderer.  Releasing them on a replacement
       target is at best meaningless and at worst lets stale work touch the new
       generation, so only release while this session is still current. */
    if (isCurrentMeetSession(session)) {
      if (arrayId) {
        try {
          await chrome.debugger.sendCommand(
            { tabId }, 'Runtime.releaseObject', { objectId: arrayId }
          );
        } catch (e) {}
      }
      try {
        await chrome.debugger.sendCommand(
          { tabId }, 'Runtime.releaseObject', { objectId: protoId }
        );
      } catch (e) {}
    }
  }
}

/* Only one debugger client may hold a tab. Anything else that attaches — DevTools,
   or another extension driving the page over CDP — silently evicts us, and the
   next command fails with "not attached". Reclaim the session and carry on
   rather than abandoning the harvest. */
async function harvestOnce(session) {
  const tabId = session.tabId;
  if (!isCurrentMeetSession(session)) return { cancelled: true };
  try {
    return await harvestConnections(session);
  } catch (e) {
    if (!isCurrentMeetSession(session) || (e && e.rtcMonitorCancelled)) {
      return { cancelled: true };
    }
    const msg = (e && e.message) || String(e);
    if (!/not attached/i.test(msg)) throw e;
    /* onDetach can arrive while Runtime.queryObjects is in flight. Never turn a
       user cancellation into an immediate re-attach on the next command. */
    if (!isCurrentMeetSession(session)) return { cancelled: true };
    try {
      await chrome.debugger.attach({ tabId }, CDP_VERSION);
      session.attached = true;
    } catch (e2) {
      return { error: 'evicted, cannot re-attach: ' + ((e2 && e2.message) || e2) };
    }
    session.scriptIdentifiers.clear();
    try { await armEarlyHook(session, await monitorSource()); } catch (e3) { /* best effort */ }
    if (!isCurrentMeetSession(session)) return { cancelled: true };
    return await harvestConnections(session);
  }
}

/* The user usually joins after the page settles, and Meet can replace its
   RTCPeerConnection during a call. Poll for the whole bounded window: a first
   capture is progress, not a reason to permanently abandon later instances. */
async function harvestLoop(session) {
  const tabId = session.tabId;
  const deadline = HARVEST_MAX_MS === Infinity ? Infinity : Date.now() + HARVEST_MAX_MS;
  let last = null;
  while (Date.now() < deadline && isCurrentMeetSession(session)) {
    try {
      const out = await harvestOnce(session);
      if (out && out.cancelled) break;
      if (session.monitorConfirmed && out && out.error === 'monitor not present') {
        /* The page API existed and was later removed by Close/api.stop(). Treat
           that as an intentional stop: dev auto-inject must not reopen it on
           the next completion event. An explicit toolbar click clears this. */
        debuggerSuppressed.add(tabId);
        await cleanupMeetSession(tabId);
        break;
      }
      last = out;
      await devStamp(tabId, out && out.pcs > 0
        ? ('CAPTURED ' + out.pcs + ' connection(s) via queryObjects')
        : (out && out.error ? ('harvest: ' + out.error)
          : ('harvest: seen ' + (out && out.seen) + ', none adopted yet')));
    } catch (e) {
      if (!isCurrentMeetSession(session)) break;
      await devStamp(tabId, 'harvest threw: ' + ((e && e.message) || e));
    }
    if (Date.now() < deadline && isCurrentMeetSession(session)) {
      await new Promise(r => setTimeout(r, HARVEST_INTERVAL_MS));
    }
  }
  return last;
}

function startHarvest(session) {
  if (!isCurrentMeetSession(session)) return Promise.resolve(null);
  if (session.harvestPromise) return session.harvestPromise;
  session.harvestPromise = harvestLoop(session).finally(() => {
    if (meetSessions.get(session.tabId) === session) session.harvestPromise = null;
  });
  return session.harvestPromise;
}

async function ensureMonitorPresent(session, source) {
  const tabId = session.tabId;
  /* Unlike the toolbar toggle path, lifecycle recovery must be idempotent: the
     post-reload completion event must not hide the monitor installed by the
     document-start hook. */
  if (!isCurrentMeetSession(session) || !(await meetLocationIsCurrent(session))) {
    return { cancelled: true };
  }
  const evaled = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
    expression: 'if (location.protocol === "https:" && location.hostname === "meet.google.com" && ' +
      'typeof window.__rtcStreamMonitor__ !== "object") {\n' + source + '\n}',
    userGesture: true,
    returnByValue: true
  });
  if (!isCurrentMeetSession(session)) return { cancelled: true };
  if (evaled && evaled.exceptionDetails) {
    const d = evaled.exceptionDetails;
    throw new Error((d.exception && d.exception.description) || d.text || 'Runtime.evaluate failed');
  }
  if (!(await meetLocationIsCurrent(session))) return { cancelled: true };
  const check = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
    expression: 'typeof window.__rtcStreamMonitor__ === "object"',
    returnByValue: true
  });
  if (!isCurrentMeetSession(session)) return { cancelled: true };
  return { ok: !!(check && check.result && check.result.value === true) };
}

async function cancelledMeetEnsure(session) {
  /* A URL change can invalidate work while a CDP command is in flight. If this
     generation is still registered, normal cleanup owns its scripts/detach. If
     navigation already removed it, only detach an attachment we had marked as
     ours; never disturb a newer generation on the same tab. */
  if (isCurrentMeetSession(session)) await cleanupMeetSession(session.tabId);
  else if (session.attached) await detachStaleMeetAttachment(session);
  return { session, cancelled: true };
}

async function ensureMeetSessionWork(session) {
  const tabId = session.tabId;
  try {
    if (!isCurrentMeetSession(session)) return { session, cancelled: true };
    if (!(await meetLocationIsCurrent(session))) {
      if (isCurrentMeetSession(session)) await cleanupMeetSession(tabId);
      return { session, cancelled: true };
    }

    if (!session.attached) {
      const targetAttached = await isAttached(tabId);
      if (!isCurrentMeetSession(session)) return { session, cancelled: true };
      if (!(await meetLocationIsCurrent(session))) {
        if (isCurrentMeetSession(session)) await cleanupMeetSession(tabId);
        return { session, cancelled: true };
      }

      if (targetAttached) {
        /* getTargets() reports target state, not ownership. A harmless command
           must succeed before this generation treats the debugger as ours. */
        await chrome.debugger.sendCommand({ tabId }, 'Page.enable', {});
        if (!isCurrentMeetSession(session)) {
          await detachStaleMeetAttachment(session);
          return { session, cancelled: true };
        }
      } else {
        await chrome.debugger.attach({ tabId }, CDP_VERSION);
        if (!isCurrentMeetSession(session)) {
          await detachStaleMeetAttachment(session);
          return { session, cancelled: true };
        }
      }
      session.attached = true;
    }

    if (!(await meetLocationIsCurrent(session))) {
      if (isCurrentMeetSession(session)) await cleanupMeetSession(tabId);
      return { session, cancelled: true };
    }
    const source = await monitorSource();
    if (!isCurrentMeetSession(session)) return { session, cancelled: true };
    if (!(await meetLocationIsCurrent(session))) {
      if (isCurrentMeetSession(session)) await cleanupMeetSession(tabId);
      return { session, cancelled: true };
    }

    let newlyArmed = false;
    if (!session.preloadArmed) {
      const armed = await armEarlyHook(session, source);
      if (!armed || armed.cancelled || !isCurrentMeetSession(session)) {
        return await cancelledMeetEnsure(session);
      }
      newlyArmed = true;
    }
    const monitor = await ensureMonitorPresent(session, source);
    if (!monitor || monitor.cancelled || !isCurrentMeetSession(session)) {
      return await cancelledMeetEnsure(session);
    }
    if (monitor.ok) session.monitorConfirmed = true;
    return { session, newlyArmed, ok: monitor.ok };
  } catch (e) {
    if (!isCurrentMeetSession(session)) {
      await detachStaleMeetAttachment(session);
      return { session, cancelled: true };
    }
    /* A target_closed recovery owns multiple bounded ensure attempts. Preserve
       that recovery token while retiring only this failed attempt/session. */
    const preserveRecovery = !!session.recovery &&
      meetRecoveries.get(tabId) === session.recovery;
    await cleanupMeetSession(tabId, preserveRecovery);
    throw e;
  }
}

async function ensureMeetSession(tabId) {
  let session = meetSessions.get(tabId);
  if (!session) {
    session = newMeetSession(tabId);
    meetSessions.set(tabId, session);
  }
  if (debuggerSuppressed.has(tabId)) return { session, suppressed: true };
  if (session.ensurePromise) return session.ensurePromise;

  const pending = ensureMeetSessionWork(session);
  session.ensurePromise = pending;
  try {
    return await pending;
  } finally {
    if (session.ensurePromise === pending) session.ensurePromise = null;
  }
}

async function reloadNewlyArmedMeet(result) {
  const session = result && result.session;
  if (!result || result.cancelled || !result.newlyArmed ||
      !isCurrentMeetSession(session) || session.reloadIssued) return false;
  /* Set the guard before any await: concurrent action/onUpdated callers can
     share one ensure result, but exactly one of them may own the reload. */
  session.reloadIssued = true;
  session.awaitingReload = true;
  if (!(await meetLocationIsCurrent(session)) || !isCurrentMeetSession(session)) {
    session.awaitingReload = false;
    return false;
  }
  await devStamp(session.tabId, 'early hook armed, reloading once');
  if (!(await meetLocationIsCurrent(session)) || !isCurrentMeetSession(session)) {
    session.awaitingReload = false;
    return false;
  }
  chrome.tabs.reload(session.tabId);
  return true;
}

async function cleanupMeetSession(tabId, preserveRecovery) {
  if (!preserveRecovery) meetRecoveries.delete(tabId);
  const session = meetSessions.get(tabId);
  if (!session) return;
  meetSessions.delete(tabId);
  session.stopped = true;
  if (session.preloadPromise) {
    try { await session.preloadPromise; } catch (e) { /* registration failed */ }
  }
  const identifiers = Array.from(session.scriptIdentifiers);
  session.preloadArmed = false;
  session.scriptIdentifiers.clear();
  if (!session.attached) return;
  for (const identifier of identifiers) {
    try {
      await chrome.debugger.sendCommand(
        { tabId },
        'Page.removeScriptToEvaluateOnNewDocument',
        { identifier }
      );
    } catch (e) { /* target may already be gone */ }
  }
  try { await chrome.debugger.detach({ tabId }); } catch (e) { /* already detached */ }
  session.attached = false;
}

async function debuggerUrl(tabId) {
  try {
    const out = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
      expression: 'location.href',
      returnByValue: true
    });
    return (out && out.result && out.result.value) || '';
  } catch (e) {
    return '';
  }
}

chrome.tabs.onRemoved.addListener(async (tabId) => {
  meetRecoveries.delete(tabId);
  debuggerSuppressed.delete(tabId);
  await cleanupMeetSession(tabId);
});

function currentMeetRecovery(tabId, recovery) {
  return meetRecoveries.get(tabId) === recovery &&
    !debuggerSuppressed.has(tabId);
}

async function recoverMeetTarget(tabId, recovery) {
  /* A renderer replacement is briefly unavailable on some Meet transitions.
     Retry a small bounded window, but only while this exact recovery still owns
     the tab. Navigation, removal, explicit debugger cancellation and a newer
     target_closed generation all invalidate it synchronously. */
  let lastError = null;
  for (const delay of MEET_RECOVERY_DELAYS_MS) {
    await new Promise(resolve => setTimeout(resolve, delay));
    if (!currentMeetRecovery(tabId, recovery)) return { cancelled: true };

    let tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch (e) {
      lastError = e;
      continue;
    }
    if (!currentMeetRecovery(tabId, recovery)) return { cancelled: true };
    const url = (tab && tab.url) || '';
    if (url && !MEET_URL.test(url)) {
      meetRecoveries.delete(tabId);
      return { cancelled: true };
    }
    if (!url) continue;

    const session = newMeetSession(tabId);
    session.reloadIssued = recovery.reloadIssued;
    session.recovery = recovery;
    meetSessions.set(tabId, session);
    try {
      const result = await ensureMeetSession(tabId);
      if (!currentMeetRecovery(tabId, recovery) || result.suppressed || result.cancelled ||
          !isCurrentMeetSession(result.session) || !(await meetLocationIsCurrent(result.session))) {
        /* Navigation can win after ensure attached successfully but before this
           final check. Release only this recovery generation; never touch a
           replacement session that a newer target_closed token may own. */
        if (meetSessions.get(tabId) === result.session) await cleanupMeetSession(tabId);
        return { session: result.session, cancelled: true };
      }
      meetRecoveries.delete(tabId);
      delete result.session.recovery;
      badge(tabId, result.ok ? 'dbg' : 'err', result.ok ? '#d95926' : '#d03b3b');
      /* This is a renderer replacement inside the already armed Meet tab. The
         current document is injected idempotently above; never disrupt Return
         by issuing the one-time initial reload again. */
      startHarvest(result.session);
      return result;
    } catch (e) {
      lastError = e;
      if (meetSessions.get(tabId) === session) {
        await cleanupMeetSession(tabId, true);
      }
      if (!currentMeetRecovery(tabId, recovery)) return { cancelled: true };
    }
  }

  if (currentMeetRecovery(tabId, recovery)) meetRecoveries.delete(tabId);
  const message = (lastError && lastError.message) || String(lastError || 'replacement target unavailable');
  await devStamp(tabId, 'target recovery FAILED: ' + message);
  console.error('[RTC Stream Monitor] Meet target recovery failed:', message);
  return { cancelled: true, error: message };
}

async function joinMeetRecovery(tabId) {
  const recovery = meetRecoveries.get(tabId);
  if (!recovery) return false;
  /* onDetach assigns promise in the same synchronous turn in which it inserts
     the recovery record. The defensive branch makes this safe if that ordering
     is ever refactored. */
  if (recovery.promise) {
    try { await recovery.promise; } catch (e) { /* recovery reports its own error */ }
  }
  return true;
}

chrome.debugger.onDetach.addListener((src, reason) => {
  if (!src || src.tabId === undefined) return;
  const tabId = src.tabId;
  const session = meetSessions.get(tabId);
  if (/cancel(?:ed|led)_by_user|user/i.test(reason || '')) {
    meetRecoveries.delete(tabId);
    debuggerSuppressed.add(tabId);
    if (session) {
      meetSessions.delete(tabId);
      session.stopped = true;
      session.attached = false;
      session.preloadArmed = false;
      session.scriptIdentifiers.clear();
    }
    return;
  }
  if (reason === 'target_closed' && session && !debuggerSuppressed.has(tabId)) {
    /* Invalidate the old generation synchronously before the recovery yields.
       Its harvest loop can no longer reattach or stamp into the new renderer. */
    meetSessions.delete(tabId);
    session.stopped = true;
    session.attached = false;
    session.preloadArmed = false;
    session.scriptIdentifiers.clear();
    const recovery = { token: {}, reloadIssued: session.reloadIssued, promise: null };
    meetRecoveries.set(tabId, recovery);
    recovery.promise = recoverMeetTarget(tabId, recovery);
    recovery.promise.catch(() => {});
    return;
  }
  if (session) {
    meetRecoveries.delete(tabId);
    meetSessions.delete(tabId);
    session.stopped = true;
    session.attached = false;
    session.preloadArmed = false;
    session.scriptIdentifiers.clear();
  }
});

/* onSuspend is best effort by definition, but initiating cleanup here avoids
   leaving a preload/debugger session behind during a normal extension stop. */
if (chrome.runtime.onSuspend) {
  chrome.runtime.onSuspend.addListener(() => {
    for (const tabId of Array.from(meetSessions.keys())) {
      cleanupMeetSession(tabId).catch(() => {});
    }
  });
}

// One-shot debugger fallback for non-Meet pages. Meet uses the persistent
// session above because its heap harvest cannot survive a detach.
async function injectViaDebugger(tabId) {
  const source = await monitorSource();
  const alreadyAttached = await isAttached(tabId);
  if (!alreadyAttached) await chrome.debugger.attach({ tabId }, CDP_VERSION);
  try {
    const evaled = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
      expression: source,
      userGesture: true,
      returnByValue: true
    });
    if (evaled && evaled.exceptionDetails) {
      const d = evaled.exceptionDetails;
      throw new Error((d.exception && d.exception.description) || d.text || 'Runtime.evaluate failed');
    }
    // Verify through the same attached session — executeScript cannot see the
    // main world on exactly the pages that need this path.
    const check = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
      expression: 'typeof window.__rtcStreamMonitor__ === "object"',
      returnByValue: true
    });
    return !!(check && check.result && check.result.value === true);
  } finally {
    if (!alreadyAttached) { try { await chrome.debugger.detach({ tabId }); } catch (e) {} }
  }
}

async function probeViaDebugger(tabId) {
  const out = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
    expression: '(() => {' +
      'var running = typeof window.__rtcStreamMonitor__ === "object";' +
      'var host = document.getElementById("rtc-stream-monitor-host");' +
      'var panel = host && host.shadowRoot && host.shadowRoot.getElementById("panel");' +
      'var visible = !!(host && panel && getComputedStyle(host).display !== "none" && ' +
        'getComputedStyle(panel).display !== "none");' +
      'return { running: running, visible: visible };' +
    '})()',
    returnByValue: true
  });
  return (out && out.result && out.result.value) || { running: false, visible: false };
}

function badge(tabId, text, color) {
  if (tabId === undefined) return;
  chrome.action.setBadgeText({ text, tabId });
  if (color) chrome.action.setBadgeBackgroundColor({ color, tabId });
}

/* Both builds now declare Zoom's small document-start capture shim. Only the
   dev manifest declares monitor.js itself as a content script, so use that
   explicit signal for auto-injection. The release build must never attach a
   debugger or open the full monitor without a toolbar click. */
const DEV_AUTOINJECT = (chrome.runtime.getManifest().content_scripts || []).some(entry =>
  (entry.js || []).includes('monitor.js')
);
// Aloqa's real test surface is staging.airion-cargo.store (the apex redirects
// there when signed in), so the dev build must auto-inject on subdomains too.
const DEV_AUTOINJECT_HOSTS = /^https:\/\/(?:(?:(?:(?:[^./]+\.)*airion-cargo\.(?:store|online))|meet\.google\.com)(?:\/|$)|(?:[^./]+\.)*zoom\.(?:us|com)\/wc(?:\/|[?#]|$))/;

/* Dev diagnostics. The background's decisions are invisible from the page, and
   on exactly the pages this code exists for the main world cannot be reached to
   report them — so stamp progress from the ISOLATED world instead, where a
   content script demonstrably does run. */
async function devStamp(tabId, text) {
  if (!DEV_AUTOINJECT) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: 'ISOLATED',
      func: (t) => {
        document.documentElement.setAttribute('data-rtcmon-bg', t);
        /* Also render it on screen. Reading the attribute back requires CDP, and
           on these pages CDP is the contended resource we are debugging — any
           inspection evicts the extension's own debugger session. A visible
           badge can be read from a screenshot instead, with nothing attached.
           Isolated world shares the DOM, so this needs no main-world access. */
        var id = 'rtcmon-dev-badge';
        var el = document.getElementById(id);
        if (!el) {
          el = document.createElement('div');
          el.id = id;
          el.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:2147483647;' +
            'max-width:60vw;padding:6px 10px;border-radius:8px;' +
            'background:rgba(217,89,38,.95);color:#fff;font:12px/1.35 ui-monospace,Menlo,monospace;' +
            'pointer-events:none;white-space:pre-wrap';
          (document.body || document.documentElement).appendChild(el);
        }
        el.textContent = 'rtcmon bg: ' + t;
      },
      args: [String(text)]
    });
  } catch (e) { /* nothing to report to */ }
}

async function tabUrl(tabId, info, tab) {
  let url = (info && info.url) || (tab && tab.url) || '';
  if (!url) {
    try { url = (await chrome.tabs.get(tabId)).url || ''; } catch (e) { url = ''; }
  }
  /* The release manifest relies on activeTab, whose URL visibility may end on
     navigation. Our own debugger can still tell us that a tracked Meet tab has
     left the origin so it can be cleaned up promptly. */
  if (!url && meetSessions.has(tabId)) url = await debuggerUrl(tabId);
  return url;
}

async function handleMeetComplete(tabId) {
  if (debuggerSuppressed.has(tabId)) return;
  /* target_closed recovery owns reinjection and harvest startup. Completion
     events that arrive while Chrome publishes the renderer must join it, not
     create a competing session or repeat the initial reload. */
  if (await joinMeetRecovery(tabId)) return;
  const existing = meetSessions.get(tabId);
  if (!existing && !DEV_AUTOINJECT) return;
  if (existing && existing.awaitingReload) existing.awaitingReload = false;

  try {
    const result = await ensureMeetSession(tabId);
    if (result.suppressed || result.cancelled || !isCurrentMeetSession(result.session)) return;
    badge(tabId, result.ok ? 'dbg' : 'err', result.ok ? '#d95926' : '#d03b3b');
    if (result.newlyArmed) {
      await reloadNewlyArmedMeet(result);
      return;
    }
    await devStamp(tabId, result.ok
      ? 'debugger injection OK (early hook active)'
      : 'debugger ran but monitor did not start');
    startHarvest(result.session);
  } catch (e) {
    const message = (e && e.message) || String(e);
    await devStamp(tabId, 'debugger FAILED: ' + message);
    console.error('[RTC Stream Monitor] Meet debugger injection failed:', message);
    badge(tabId, 'err', '#d03b3b');
  }
}

async function autoInjectRegular(tabId) {
  await devStamp(tabId, 'matched host, probing');
  const probe = await probeMainWorld(tabId);
  if (probe.running) {
    await devStamp(tabId, 'already running');
    badge(tabId, probe.visible === false ? 'off' : 'on', '#3987e5');
    return;
  }
  if (probe.mainWorldUsable) {
    await devStamp(tabId, 'main world reachable, trying executeScript(files)');
    try { await injectViaScripting(tabId); } catch (e) {
      await devStamp(tabId, 'executeScript(files) threw: ' + ((e && e.message) || e));
    }
    const after = await probeMainWorld(tabId);
    if (after.running) {
      await devStamp(tabId, 'executeScript(files) WORKED');
      badge(tabId, after.visible === false ? 'off' : 'on', '#3987e5');
      return;
    }
    await devStamp(tabId, 'executeScript(files) did not take, trying one-shot debugger');
  }
  try {
    const ok = await injectViaDebugger(tabId);
    badge(tabId, ok ? 'dbg' : 'err', ok ? '#d95926' : '#d03b3b');
    await devStamp(tabId, ok ? 'one-shot debugger injection OK' : 'debugger ran but monitor did not start');
  } catch (e) {
    const message = (e && e.message) || String(e);
    await devStamp(tabId, 'debugger FAILED: ' + message);
    console.error('[RTC Stream Monitor] auto debugger injection failed:', message);
  }
}

/* This listener is installed in both builds. In release it only services a
   Meet tab that the user explicitly armed from the toolbar; in dev it also
   starts supported hosts automatically. */
chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  const url = await tabUrl(tabId, info, tab);
  const tracked = meetSessions.has(tabId);
  const recovering = meetRecoveries.has(tabId);
  if ((tracked || recovering) && url && !MEET_URL.test(url)) {
    meetRecoveries.delete(tabId);
    await cleanupMeetSession(tabId);
    return;
  }
  if (info.status !== 'complete') return;

  if ((tracked && !url) || MEET_URL.test(url)) {
    await handleMeetComplete(tabId);
    return;
  }
  if (DEV_AUTOINJECT && DEV_AUTOINJECT_HOSTS.test(url)) {
    await autoInjectRegular(tabId);
  }
});

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id || !/^https?:/.test(tab.url || '')) {
    badge(tab.id, '!', '#d03b3b');
    return;
  }
  const tabId = tab.id;

  if (MEET_URL.test(tab.url || '')) {
    /* A fresh explicit click is the only action allowed to reverse the user's
       dismissal of Chrome's debugger banner. */
    debuggerSuppressed.delete(tabId);
    /* Treat a click during renderer replacement as a request to keep the
       monitor armed. Recovery performs the idempotent injection; toggling or
       starting another session here would duplicate its preload/reload. */
    if (await joinMeetRecovery(tabId)) return;
    const existing = meetSessions.get(tabId);
    if (existing && isCurrentMeetSession(existing)) {
      try {
        const before = await probeViaDebugger(tabId);
        if (before.running) {
          await injectViaDebugger(tabId); // attached session: toggles, does not detach
          const after = await probeViaDebugger(tabId);
          badge(tabId, after.running && after.visible ? 'on' : 'off', '#3987e5');
          return;
        }
      } catch (e) {
        console.error('[RTC Stream Monitor] Meet toggle failed:', (e && e.message) || e);
        badge(tabId, 'err', '#d03b3b');
        return;
      }
    }
    try {
      const result = await ensureMeetSession(tabId);
      if (result.suppressed || result.cancelled || !isCurrentMeetSession(result.session)) return;
      badge(tabId, result.ok ? 'dbg' : 'err', result.ok ? '#d95926' : '#d03b3b');
      if (result.newlyArmed) {
        await reloadNewlyArmedMeet(result);
      } else {
        startHarvest(result.session);
      }
    } catch (e) {
      console.error('[RTC Stream Monitor] Meet debugger injection failed:', (e && e.message) || e);
      badge(tabId, 'err', '#d03b3b');
    }
    return;
  }

  const before = await probeMainWorld(tabId);

  if (before.mainWorldUsable) {
    try {
      await injectViaScripting(tabId);            // starts it, or toggles it off
    } catch (e) {
      console.error('[RTC Stream Monitor] executeScript path failed:', e);
    }
    /* allFrames injection can start the top-frame monitor and then reject for a
       child frame. Always inspect the resulting state, even after an exception,
       before CDP evaluation could accidentally toggle the successful start off. */
    const after = await probeMainWorld(tabId);
    if (before.running) {                         // this click meant "turn it off"
      badge(tabId, after.running && after.visible !== false ? 'on' : 'off', '#3987e5');
      return;
    }
    if (after.running) { badge(tabId, after.visible === false ? 'off' : 'on', '#3987e5'); return; }
    // Meant to start it and the file injection did not take. Being able to
    // evaluate a `func` here does not mean a script file can be injected —
    // keep going rather than reporting a successful no-op.
  }

  // Either the main world is refused outright, or file injection silently did
  // nothing. Both are the Trusted Types case — fall back to the debugger.
  try {
    const ok = await injectViaDebugger(tabId);
    badge(tabId, ok ? 'dbg' : 'err', ok ? '#d95926' : '#d03b3b');
    if (!ok) console.error('[RTC Stream Monitor] debugger injection ran but the monitor did not start');
  } catch (e) {
    // The usual cause is DevTools already being open on this tab: only one
    // debugger client is allowed per target.
    console.error('[RTC Stream Monitor] debugger injection failed:', e && e.message ? e.message : e);
    badge(tabId, 'err', '#d03b3b');
  }
});
