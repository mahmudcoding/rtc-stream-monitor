#!/usr/bin/env node
'use strict';

// Regression coverage for the service worker's Google Meet path.
//
// This deliberately executes extension/background.js as a script instead of
// copying helpers out of it.  The assertions therefore cover the event wiring
// and the Chrome API protocol calls that the installed extension actually uses.

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const BACKGROUND = fs.readFileSync(
  path.resolve(__dirname, '../extension/background.js'),
  'utf8'
).replace('const HARVEST_MAX_MS = Infinity;', 'const HARVEST_MAX_MS = 20000;');
const MONITOR_SOURCE = '/* mocked rtc-stream-monitor source */';
const MEET_URL = 'https://meet.google.com/abc-defg-hij';

function eventSlot() {
  const listeners = [];
  return {
    listeners,
    addListener(listener) { listeners.push(listener); },
    emit(...args) { return Promise.all(listeners.map(listener => listener(...args))); }
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function createEnvironment({ dev }) {
  const calls = {
    attachAttempts: [],
    attach: [],
    detach: [],
    debugger: [],
    reload: [],
    scripting: [],
    badgeText: [],
    badgeColor: []
  };
  const events = {
    actionClicked: eventSlot(),
    tabUpdated: eventSlot(),
    tabRemoved: eventSlot(),
    debuggerDetach: eventSlot()
  };
  const urls = new Map([[17, MEET_URL]]);
  const attached = new Set();
  const activePreloads = new Set();
  let nextPreloadId = 1;
  let rendererGeneration = 1;
  let attachFailures = 0;
  let now = 0;
  let nextTimerId = 1;
  const timers = new Set();
  let blockedQuery = null;
  const blockedCommands = new Map();
  let querySerial = 0;
  const adoptResults = [];
  let mainWorldMonitorVisible = null;
  let partialFileInjection = false;
  let navigateAfterMonitorCheck = null;

  class FakeDate extends Date {
    static now() { return now; }
  }

  function fakeSetTimeout(callback, delay) {
    const id = nextTimerId++;
    timers.add(id);
    now += Number(delay) || 0;
    Promise.resolve().then(() => {
      if (!timers.delete(id)) return;
      callback();
    });
    return id;
  }

  function fakeClearTimeout(id) {
    timers.delete(id);
  }

  const chrome = {
    runtime: {
      getManifest() {
        return dev ? {
          content_scripts: [{ matches: ['https://meet.google.com/*'], js: ['monitor.js'] }]
        } : {};
      },
      getURL(file) { return 'chrome-extension://unit-test/' + file; }
    },
    tabs: {
      onUpdated: events.tabUpdated,
      onRemoved: events.tabRemoved,
      async get(tabId) { return { id: tabId, url: urls.get(tabId) || '' }; },
      reload(tabId) { calls.reload.push(tabId); }
    },
    action: {
      onClicked: events.actionClicked,
      setBadgeText(value) { calls.badgeText.push(value); },
      setBadgeBackgroundColor(value) { calls.badgeColor.push(value); }
    },
    scripting: {
      async executeScript(options) {
        calls.scripting.push(options);
        if (options.world === 'MAIN' && options.func) {
          return [{ result: mainWorldMonitorVisible === null
            ? 'rtcmon:undefined'
            : 'rtcmon:object:' + (mainWorldMonitorVisible ? 'visible' : 'hidden') }];
        }
        if (options.world === 'MAIN' && options.files && partialFileInjection) {
          partialFileInjection = false;
          mainWorldMonitorVisible = true;
          throw new Error('child frame rejected after top-frame injection');
        }
        return [];
      }
    },
    debugger: {
      onDetach: events.debuggerDetach,
      async getTargets() {
        return [...attached].map(tabId => ({ tabId, attached: true }));
      },
      async attach(target, version) {
        calls.attachAttempts.push({ target, version });
        if (attachFailures > 0) {
          attachFailures--;
          throw new Error('No target with given id found');
        }
        if (attached.has(target.tabId)) throw new Error('Another debugger is already attached');
        calls.attach.push({ target, version });
        attached.add(target.tabId);
      },
      async detach(target) {
        calls.detach.push(target);
        attached.delete(target.tabId);
        activePreloads.clear();
      },
      async sendCommand(target, method, params = {}) {
        calls.debugger.push({ target, method, params });
        if (!attached.has(target.tabId)) {
          throw new Error('Debugger is not attached to the tab with id: ' + target.tabId);
        }
        const commandGate = blockedCommands.get(method);
        if (commandGate) {
          blockedCommands.delete(method);
          await commandGate.promise;
        }
        switch (method) {
          case 'Page.addScriptToEvaluateOnNewDocument':
            const identifier = 'meet-hook-' + target.tabId + '-' + nextPreloadId++;
            activePreloads.add(identifier);
            return { identifier };
          case 'Page.removeScriptToEvaluateOnNewDocument':
            activePreloads.delete(params.identifier);
            return {};
          case 'Runtime.evaluate':
            if (/RTCPeerConnection[^;]*prototype/.test(params.expression || '')) {
              return { result: { objectId: 'prototype-' + target.tabId + '-g' + rendererGeneration } };
            }
            if (/return \{ running: running, visible: visible \}/.test(params.expression || '')) {
              return { result: { value: {
                running: mainWorldMonitorVisible !== null,
                visible: mainWorldMonitorVisible === true
              } } };
            }
            if (/location\.protocol === "https:"/.test(params.expression || '') &&
                /__rtcStreamMonitor__/.test(params.expression || '')) {
              mainWorldMonitorVisible = true;
              return { result: { value: undefined } };
            }
            if (params.expression === MONITOR_SOURCE) {
              mainWorldMonitorVisible = mainWorldMonitorVisible === null
                ? true : !mainWorldMonitorVisible;
              return { result: { value: undefined } };
            }
            if (params.expression === 'typeof window.__rtcStreamMonitor__ === "object"' &&
                navigateAfterMonitorCheck) {
              urls.set(target.tabId, navigateAfterMonitorCheck);
              navigateAfterMonitorCheck = null;
              return { result: { value: mainWorldMonitorVisible !== null } };
            }
            if (/typeof window\.__rtcStreamMonitor__/.test(params.expression || '')) {
              return { result: { value: mainWorldMonitorVisible !== null } };
            }
            return { result: { value: undefined } };
          case 'Runtime.queryObjects': {
            querySerial++;
            if (blockedQuery) {
              const gate = blockedQuery;
              blockedQuery = null;
              await gate.promise;
            }
            return { objects: { objectId: 'connections-g' + rendererGeneration + '-' + querySerial } };
          }
          case 'Runtime.callFunctionOn':
            return { result: { value: adoptResults.length
              ? adoptResults.shift()
              : (mainWorldMonitorVisible === null
                ? { error: 'monitor not present' }
                : { seen: 1, adopted: 1, pcs: 1 }) } };
          default:
            return {};
        }
      }
    }
  };

  const errors = [];
  const context = {
    chrome,
    Date: FakeDate,
    URL,
    AbortController,
    setTimeout: fakeSetTimeout,
    clearTimeout: fakeClearTimeout,
    fetch: async () => ({ text: async () => MONITOR_SOURCE }),
    console: {
      log() {},
      warn() {},
      error(...args) { errors.push(args.map(String).join(' ')); }
    }
  };
  vm.runInNewContext(BACKGROUND, context, { filename: 'extension/background.js' });

  return {
    calls,
    errors,
    events,
    urls,
    attached,
    activePreloads,
    timers,
    blockNextQuery() {
      const gate = deferred();
      blockedQuery = gate;
      return gate;
    },
    blockNextCommand(method) {
      const gate = deferred();
      blockedCommands.set(method, gate);
      return gate;
    },
    failNextAttaches(count = 1) {
      attachFailures += count;
    },
    replaceRenderer() {
      rendererGeneration++;
      attached.delete(17);
      activePreloads.clear();
      mainWorldMonitorVisible = null;
    },
    monitorPresent() {
      return mainWorldMonitorVisible !== null;
    },
    makeNextFileInjectionPartiallySucceed() {
      partialFileInjection = true;
    },
    queueAdoptResults(...results) {
      adoptResults.push(...results);
    },
    navigateAfterNextMonitorCheck(url) {
      navigateAfterMonitorCheck = url;
    }
  };
}

function commands(env, method) {
  return env.calls.debugger.filter(call => call.method === method);
}

async function waitFor(predicate, description, turns = 2000) {
  for (let i = 0; i < turns; i++) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error('timed out waiting for ' + description);
}

async function drain(env) {
  await waitFor(() => env.timers.size === 0, 'fake timers to drain', 5000);
  // Let continuations after the final timer finish.
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

function assertEarlyHook(env) {
  assert.equal(env.calls.attach.length, 1, 'Meet attaches one debugger session');
  assert.equal(env.calls.attach[0].version, '1.3');
  assert.equal(commands(env, 'Page.enable').length, 1, 'Page domain is enabled');
  const registrations = commands(env, 'Page.addScriptToEvaluateOnNewDocument');
  assert.equal(registrations.length, 1, 'document-start monitor is registered once');
  assert.ok(
    registrations[0].params.source.includes(MONITOR_SOURCE),
    'registered document-start source contains the monitor bundle'
  );
  assert.ok(
    JSON.stringify(registrations[0].params.urlPatterns || []).includes('meet.google.com') ||
      /meet\.google\.com/.test(registrations[0].params.source),
    'document-start registration is scoped to Google Meet'
  );
  assert.equal(env.calls.reload.length, 1, 'newly armed Meet tab reloads exactly once');
  assert.equal(env.calls.detach.length, 0, 'Meet debugger stays attached for heap harvest');
}

async function startPostReloadHarvest(env) {
  const queriesBefore = commands(env, 'Runtime.queryObjects').length;
  const gate = env.blockNextQuery();
  const listener = env.events.tabUpdated.listeners[0];
  assert.ok(listener, 'tabs.onUpdated listener is installed');

  const first = Promise.resolve(listener(17, { status: 'complete' }, { id: 17, url: MEET_URL }));
  await waitFor(() => commands(env, 'Runtime.queryObjects').length === 1, 'first heap query');

  // A duplicate completion event while polling must join/reuse the existing
  // loop rather than creating a second Runtime.queryObjects stream.
  const duplicate = Promise.resolve(listener(17, { status: 'complete' }, { id: 17, url: MEET_URL }));
  for (let i = 0; i < 30; i++) await Promise.resolve();
  assert.equal(
    commands(env, 'Runtime.queryObjects').length,
    1,
    'only one harvest loop runs per tab'
  );

  gate.resolve();
  await Promise.all([first, duplicate]);
  await waitFor(
    () => commands(env, 'Runtime.queryObjects').length >= queriesBefore + 4 &&
      commands(env, 'Runtime.releaseObject').length >=
        commands(env, 'Runtime.queryObjects').length * 2 &&
      env.timers.size === 0,
    'bounded harvest and handle cleanup to finish',
    5000
  );
  await drain(env);
}

async function releaseToolbarLifecycle() {
  const env = createEnvironment({ dev: false });
  const clicked = env.events.actionClicked.listeners[0];
  assert.ok(clicked, 'toolbar listener is installed');

  await clicked({ id: 17, url: MEET_URL });
  assertEarlyHook(env);
  assert.equal(
    commands(env, 'Runtime.queryObjects').length,
    0,
    'toolbar arm waits for the post-reload document before harvesting'
  );

  await startPostReloadHarvest(env);
  assert.equal(env.calls.reload.length, 1, 'post-reload completion does not reload again');
  assert.ok(
    commands(env, 'Runtime.queryObjects').length > 1,
    'harvest keeps polling after the first captured connection'
  );
  assert.ok(
    commands(env, 'Runtime.callFunctionOn').every(call =>
      /__rtcStreamMonitor__/.test(call.params.functionDeclaration || '') &&
      /\.adopt\(/.test(call.params.functionDeclaration || '')
    ),
    'every heap result is handed to monitor.adopt()'
  );
  assert.ok(
    commands(env, 'Runtime.releaseObject').length >=
      commands(env, 'Runtime.queryObjects').length * 2,
    'prototype and result handles are released on every poll'
  );

  env.urls.set(17, 'https://example.com/after-meet');
  await env.events.tabUpdated.emit(
    17,
    { status: 'complete', url: 'https://example.com/after-meet' },
    { id: 17, url: 'https://example.com/after-meet' }
  );
  assert.equal(
    commands(env, 'Page.removeScriptToEvaluateOnNewDocument').length,
    1,
    'leaving Meet unregisters the document-start hook'
  );
  assert.equal(
    commands(env, 'Page.removeScriptToEvaluateOnNewDocument')[0].params.identifier,
    'meet-hook-17-1',
    'cleanup uses the registration identifier returned by Chrome'
  );
  assert.equal(env.calls.detach.length, 1, 'leaving Meet detaches one debugger session');
  assert.equal(env.calls.detach[0].tabId, 17, 'the Meet tab is the detached target');

  env.urls.set(17, MEET_URL);
  await clicked({ id: 17, url: MEET_URL });
  assert.equal(env.calls.reload.length, 2, 'a later explicit Meet session can be armed');
  await env.events.tabRemoved.emit(17, { windowId: 4, isWindowClosing: false });
  assert.equal(
    commands(env, 'Page.removeScriptToEvaluateOnNewDocument').length,
    2,
    'closing the tab unregisters its document-start hook'
  );
  assert.equal(env.calls.detach.length, 2, 'closing the tab releases its debugger session');
  assert.equal(env.calls.detach[1].tabId, 17, 'tab removal cleans the correct target');
  assert.equal(env.errors.length, 0, 'release flow logs no background errors');
}

async function devAutoInjectLifecycle() {
  const env = createEnvironment({ dev: true });

  await env.events.tabUpdated.emit(17, { status: 'complete' }, { id: 17, url: MEET_URL });
  assertEarlyHook(env);

  await startPostReloadHarvest(env);
  assert.equal(env.calls.reload.length, 1, 'dev completion path also reloads only once');
  assert.ok(
    commands(env, 'Runtime.queryObjects').length > 1,
    'dev harvest polls for replacement peer connections after capture'
  );

  const visibleStamps = env.calls.scripting
    .filter(call => call.world === 'ISOLATED')
    .flatMap(call => call.args || [])
    .map(String);
  assert.ok(
    visibleStamps.some(text => /CAPTURED 1 connection/.test(text)),
    'dev build exposes successful harvest in the screenshot-safe status badge'
  );

  assert.equal(env.errors.length, 0, 'dev flow logs no background errors');
}

async function meetSecondToolbarClickUsesDebuggerToggle() {
  const env = createEnvironment({ dev: false });
  const clicked = env.events.actionClicked.listeners[0];

  await clicked({ id: 17, url: MEET_URL });
  assertEarlyHook(env);
  const scriptingProbesBefore = env.calls.scripting.filter(call =>
    call.world === 'MAIN' && call.func
  ).length;
  const debuggerProbesBefore = commands(env, 'Runtime.evaluate').filter(call =>
    /return \{ running: running, visible: visible \}/.test(call.params.expression || '')
  ).length;

  await clicked({ id: 17, url: MEET_URL });

  assert.equal(
    env.calls.scripting.filter(call => call.world === 'MAIN' && call.func).length,
    scriptingProbesBefore,
    'tracked Meet toggle never probes through chrome.scripting'
  );
  assert.equal(
    commands(env, 'Runtime.evaluate').filter(call =>
      /return \{ running: running, visible: visible \}/.test(call.params.expression || '')
    ).length,
    debuggerProbesBefore + 2,
    'tracked Meet toggle reads state before and after through CDP'
  );
  assert.equal(env.calls.badgeText.at(-1).text, 'off', 'second Meet click hides the monitor');
  assert.equal(env.calls.reload.length, 1, 'Meet visibility toggle does not reload the call');
}

async function explicitDebuggerCancel() {
  const env = createEnvironment({ dev: true });
  const updated = env.events.tabUpdated.listeners[0];
  const clicked = env.events.actionClicked.listeners[0];

  await updated(17, { status: 'complete' }, { id: 17, url: MEET_URL });
  assertEarlyHook(env);

  const gate = env.blockNextQuery();
  // Do not await: the first protocol query intentionally remains in flight
  // while the user cancels Chrome's debugger session.
  void updated(17, { status: 'complete' }, { id: 17, url: MEET_URL });
  await waitFor(() => commands(env, 'Runtime.queryObjects').length === 1, 'blocked heap query');

  env.attached.delete(17);
  await env.events.debuggerDetach.emit({ tabId: 17 }, 'canceled_by_user');
  gate.resolve();
  for (let i = 0; i < 100; i++) await Promise.resolve();
  await drain(env);

  const queriesAfterCancel = commands(env, 'Runtime.queryObjects').length;
  assert.equal(env.calls.attach.length, 1, 'cancel does not let the harvest auto-reattach');
  assert.equal(queriesAfterCancel, 1, 'cancel stops the pending harvest loop');

  await updated(17, { status: 'complete' }, { id: 17, url: MEET_URL });
  for (let i = 0; i < 30; i++) await Promise.resolve();
  assert.equal(env.calls.attach.length, 1, 'page completion respects explicit debugger cancel');
  assert.equal(env.calls.reload.length, 1, 'page completion after cancel does not reload');
  assert.equal(
    commands(env, 'Runtime.queryObjects').length,
    queriesAfterCancel,
    'page completion after cancel does not restart harvesting'
  );

  await clicked({ id: 17, url: MEET_URL });
  assert.equal(env.calls.attach.length, 2, 'a new explicit toolbar click clears cancel suppression');
  assert.equal(env.calls.reload.length, 2, 'explicit re-arm performs one fresh reload');
  assert.equal(
    commands(env, 'Page.addScriptToEvaluateOnNewDocument').length,
    2,
    'explicit re-arm installs a fresh Meet document-start hook'
  );
}

async function staleMeetEnsureCannotReloadAfterNavigation() {
  const env = createEnvironment({ dev: true });
  const updated = env.events.tabUpdated.listeners[0];
  const attachGate = env.blockNextCommand('Page.enable');

  const starting = Promise.resolve(
    updated(17, { status: 'complete' }, { id: 17, url: MEET_URL })
  );
  await waitFor(() => commands(env, 'Page.enable').length === 1, 'blocked Meet ensure');

  env.urls.set(17, 'https://example.com/left-during-ensure');
  const leaving = Promise.resolve(updated(
    17,
    { status: 'complete', url: 'https://example.com/left-during-ensure' },
    { id: 17, url: 'https://example.com/left-during-ensure' }
  ));
  attachGate.resolve();
  await Promise.all([starting, leaving]);

  assert.equal(env.calls.reload.length, 0, 'stale Meet ensure never reloads the new origin');
  assert.equal(
    commands(env, 'Page.addScriptToEvaluateOnNewDocument').length,
    0,
    'stale Meet ensure never registers a preload after navigation'
  );
  assert.equal(env.calls.detach.length, 1, 'navigation race releases its debugger attachment');
}

async function partialRegularInjectionDoesNotToggleViaDebugger() {
  const env = createEnvironment({ dev: false });
  const clicked = env.events.actionClicked.listeners[0];
  env.urls.set(17, 'https://airion-cargo.store/call');
  env.makeNextFileInjectionPartiallySucceed();

  await clicked({ id: 17, url: 'https://airion-cargo.store/call' });

  assert.equal(env.calls.attach.length, 0, 'partial scripting success skips debugger fallback');
  assert.equal(
    commands(env, 'Runtime.evaluate').length,
    0,
    'partial scripting success is not evaluated again and toggled off'
  );
  assert.equal(env.calls.badgeText.at(-1).text, 'on', 'partial success reports monitor on');
}

async function closedMeetMonitorCleansPersistentSession() {
  const env = createEnvironment({ dev: true });
  const updated = env.events.tabUpdated.listeners[0];
  await updated(17, { status: 'complete' }, { id: 17, url: MEET_URL });

  // Close/api.stop can happen immediately after post-reload injection, before
  // any successful heap adoption. monitorConfirmed alone must make the first
  // "monitor not present" result terminal.
  env.queueAdoptResults({ error: 'monitor not present' });
  await updated(17, { status: 'complete' }, { id: 17, url: MEET_URL });
  await waitFor(() => env.calls.detach.length === 1, 'closed monitor cleanup');

  assert.equal(
    commands(env, 'Page.removeScriptToEvaluateOnNewDocument').length,
    1,
    'closing a confirmed Meet monitor removes its preload'
  );
  const attachCount = env.calls.attach.length;
  await updated(17, { status: 'complete' }, { id: 17, url: MEET_URL });
  assert.equal(env.calls.attach.length, attachCount, 'dev completion does not reopen a closed monitor');
}

async function meetReturnRecoversAfterFinalUpdateThenTargetClosed({ dev }) {
  const env = createEnvironment({ dev });
  const updated = env.events.tabUpdated.listeners[0];
  const clicked = env.events.actionClicked.listeners[0];

  if (dev) await updated(17, { status: 'complete' }, { id: 17, url: MEET_URL });
  else await clicked({ id: 17, url: MEET_URL });
  await startPostReloadHarvest(env);
  const reloadsBefore = env.calls.reload.length;
  const queriesBefore = commands(env, 'Runtime.queryObjects').length;

  /* Meet Return publishes its final complete event first, then replaces the
     renderer and emits target_closed. There is intentionally no later update. */
  await updated(17, { status: 'complete' }, { id: 17, url: MEET_URL });
  env.replaceRenderer();
  await env.events.debuggerDetach.emit({ tabId: 17 }, 'target_closed');
  await waitFor(() => env.calls.attach.length === 2, 'replacement renderer attach');
  await waitFor(
    () => commands(env, 'Page.addScriptToEvaluateOnNewDocument').length === 2,
    'replacement renderer preload'
  );
  await waitFor(
    () => commands(env, 'Runtime.queryObjects').length > queriesBefore,
    'replacement renderer heap harvest'
  );

  assert.equal(env.calls.reload.length, reloadsBefore, 'Meet Return recovery never reloads twice');
  assert.equal(env.calls.attach.length, 2, 'Meet Return owns one fresh renderer attachment');
  assert.equal(
    commands(env, 'Page.addScriptToEvaluateOnNewDocument').length,
    2,
    'Meet Return installs one preload on the replacement renderer'
  );
  assert.equal(env.monitorPresent(), true, 'replacement document is actually reinjected');
  assert.equal(env.activePreloads.size, 1, 'only the replacement renderer preload remains active');
  await env.events.tabRemoved.emit(17, { windowId: 4, isWindowClosing: false });
  await drain(env);
}

async function meetReturnRetriesTransientReplacementTarget() {
  const env = createEnvironment({ dev: false });
  const clicked = env.events.actionClicked.listeners[0];
  await clicked({ id: 17, url: MEET_URL });
  await startPostReloadHarvest(env);
  const reloadsBefore = env.calls.reload.length;
  const queriesBefore = commands(env, 'Runtime.queryObjects').length;

  env.replaceRenderer();
  env.failNextAttaches(1);
  await env.events.debuggerDetach.emit({ tabId: 17 }, 'target_closed');
  await waitFor(() => env.calls.attachAttempts.length === 3, 'replacement attach retry');
  await waitFor(
    () => commands(env, 'Runtime.queryObjects').length > queriesBefore,
    'capture after transient replacement failure',
    5000
  );

  assert.equal(env.calls.attach.length, 2, 'only one replacement attachment succeeds');
  assert.equal(
    commands(env, 'Page.addScriptToEvaluateOnNewDocument').length,
    2,
    'transient pre-attach failure leaves one replacement preload'
  );
  assert.equal(env.activePreloads.size, 1, 'retry leaves no duplicate active preload');
  assert.equal(env.monitorPresent(), true, 'retry reinjects the replacement document');
  assert.equal(env.calls.reload.length, reloadsBefore, 'retry preserves the one-reload guard');
  await env.events.tabRemoved.emit(17, { windowId: 4, isWindowClosing: false });
  await drain(env);
}

async function recoveryCoalescesConcurrentEntrypoints({ dev }) {
  const env = createEnvironment({ dev });
  const updated = env.events.tabUpdated.listeners[0];
  const clicked = env.events.actionClicked.listeners[0];
  if (dev) await updated(17, { status: 'complete' }, { id: 17, url: MEET_URL });
  else await clicked({ id: 17, url: MEET_URL });
  await startPostReloadHarvest(env);

  const reloadsBefore = env.calls.reload.length;
  const queriesBefore = commands(env, 'Runtime.queryObjects').length;
  const pageEnableBefore = commands(env, 'Page.enable').length;
  const gate = env.blockNextCommand('Page.enable');
  env.replaceRenderer();
  await env.events.debuggerDetach.emit({ tabId: 17 }, 'target_closed');
  await waitFor(
    () => commands(env, 'Page.enable').length > pageEnableBefore,
    'blocked replacement Page.enable'
  );

  /* These are the two real event orders seen around Meet Return: a completion
     after target_closed and a user click while the replacement target settles. */
  const completion = Promise.resolve(
    updated(17, { status: 'complete' }, { id: 17, url: MEET_URL })
  );
  const action = Promise.resolve(clicked({ id: 17, url: MEET_URL }));
  for (let i = 0; i < 20; i++) await Promise.resolve();
  assert.equal(env.calls.attach.length, 2, 'concurrent entrypoints do not attach again');
  assert.equal(env.calls.reload.length, reloadsBefore, 'concurrent entrypoints cannot reload twice');

  gate.resolve();
  await Promise.all([completion, action]);
  await waitFor(
    () => commands(env, 'Runtime.queryObjects').length > queriesBefore,
    'coalesced recovery capture',
    5000
  );
  assert.equal(env.calls.attach.length, 2, 'one replacement debugger client remains');
  assert.equal(
    commands(env, 'Page.addScriptToEvaluateOnNewDocument').length,
    2,
    'completion and action share one replacement preload'
  );
  assert.equal(env.activePreloads.size, 1, 'coalesced recovery has no leaked preload');
  assert.equal(env.calls.reload.length, reloadsBefore, 'coalesced recovery never reloads Return');
  await env.events.tabRemoved.emit(17, { windowId: 4, isWindowClosing: false });
  await drain(env);
}

async function recoveryAbortsDuringInflightWork(mode) {
  const env = createEnvironment({ dev: true });
  const updated = env.events.tabUpdated.listeners[0];
  await updated(17, { status: 'complete' }, { id: 17, url: MEET_URL });
  await startPostReloadHarvest(env);
  const queriesBefore = commands(env, 'Runtime.queryObjects').length;
  const pageEnableBefore = commands(env, 'Page.enable').length;
  const gate = env.blockNextCommand('Page.enable');
  env.replaceRenderer();
  await env.events.debuggerDetach.emit({ tabId: 17 }, 'target_closed');
  await waitFor(
    () => commands(env, 'Page.enable').length > pageEnableBefore,
    mode + ' blocked replacement ensure'
  );

  let abort;
  if (mode === 'cancel') {
    env.attached.delete(17);
    abort = env.events.debuggerDetach.emit({ tabId: 17 }, 'canceled_by_user');
  } else if (mode === 'navigate') {
    env.urls.set(17, 'https://example.com/left-during-recovery');
    abort = env.events.tabUpdated.emit(
      17,
      { status: 'complete', url: 'https://example.com/left-during-recovery' },
      { id: 17, url: 'https://example.com/left-during-recovery' }
    );
  } else {
    abort = env.events.tabRemoved.emit(17, { windowId: 4, isWindowClosing: false });
  }
  gate.resolve();
  await abort;
  await drain(env);

  assert.equal(env.activePreloads.size, 0, mode + ' leaves no recovery preload');
  assert.equal(
    commands(env, 'Runtime.queryObjects').length,
    queriesBefore,
    mode + ' prevents replacement harvest'
  );
  assert.equal(env.calls.reload.length, 1, mode + ' never repeats the initial reload');
  if (mode === 'cancel') {
    const attaches = env.calls.attach.length;
    await updated(17, { status: 'complete' }, { id: 17, url: MEET_URL });
    assert.equal(env.calls.attach.length, attaches, 'cancel suppression prevents auto-reopen');
  } else {
    assert.equal(env.attached.has(17), false, mode + ' releases the debugger');
  }
}

async function staleHarvestCannotCloseRecoveredSession() {
  const env = createEnvironment({ dev: true });
  const updated = env.events.tabUpdated.listeners[0];
  await updated(17, { status: 'complete' }, { id: 17, url: MEET_URL });
  await startPostReloadHarvest(env);

  const oldCalls = commands(env, 'Runtime.callFunctionOn').length;
  const staleGate = env.blockNextCommand('Runtime.callFunctionOn');
  const oldCompletion = Promise.resolve(
    updated(17, { status: 'complete' }, { id: 17, url: MEET_URL })
  );
  await waitFor(
    () => commands(env, 'Runtime.callFunctionOn').length > oldCalls,
    'stale harvest call blocked'
  );

  const queriesBefore = commands(env, 'Runtime.queryObjects').length;
  env.replaceRenderer();
  await env.events.debuggerDetach.emit({ tabId: 17 }, 'target_closed');
  await waitFor(
    () => commands(env, 'Runtime.queryObjects').length > queriesBefore,
    'recovered generation capture while old call is blocked',
    5000
  );
  staleGate.resolve();
  await oldCompletion;
  await drain(env);

  assert.equal(env.calls.detach.length, 0, 'stale monitor-not-present result cannot detach recovery');
  assert.equal(env.attached.has(17), true, 'recovered session remains attached');
  assert.equal(env.activePreloads.size, 1, 'recovered preload remains active');

  await env.events.tabRemoved.emit(17, { windowId: 4, isWindowClosing: false });
}

async function recoveredMonitorCloseIsTerminal() {
  const env = createEnvironment({ dev: true });
  const updated = env.events.tabUpdated.listeners[0];
  await updated(17, { status: 'complete' }, { id: 17, url: MEET_URL });
  await startPostReloadHarvest(env);

  env.replaceRenderer();
  env.queueAdoptResults({ error: 'monitor not present' });
  await env.events.debuggerDetach.emit({ tabId: 17 }, 'target_closed');
  await waitFor(() => env.calls.detach.length === 1, 'recovered monitor Close cleanup', 5000);
  assert.equal(env.activePreloads.size, 0, 'real Close removes the recovered preload');
  assert.equal(env.attached.has(17), false, 'real Close detaches recovered debugger');
  const attaches = env.calls.attach.length;
  await updated(17, { status: 'complete' }, { id: 17, url: MEET_URL });
  assert.equal(env.calls.attach.length, attaches, 'real Close suppression prevents auto-reopen');
}

async function meetReturnRecoveryCleansNavigationAfterEnsure() {
  const env = createEnvironment({ dev: false });
  const updated = env.events.tabUpdated.listeners[0];
  const clicked = env.events.actionClicked.listeners[0];

  await clicked({ id: 17, url: MEET_URL });
  await startPostReloadHarvest(env);
  const reloadsBefore = env.calls.reload.length;
  env.navigateAfterNextMonitorCheck('https://example.com/left-after-recovery-ensure');
  env.attached.delete(17);
  await env.events.debuggerDetach.emit({ tabId: 17 }, 'target_closed');

  await waitFor(() => env.calls.attach.length === 2, 'navigation-race recovery attach');
  await waitFor(() => env.calls.detach.length === 1, 'navigation-race recovery cleanup');
  assert.equal(
    commands(env, 'Page.removeScriptToEvaluateOnNewDocument').length,
    1,
    'navigation after recovery ensure removes the fresh renderer preload'
  );
  assert.equal(env.calls.detach[0].tabId, 17, 'navigation releases the fresh renderer debugger');
  assert.equal(env.calls.reload.length, reloadsBefore, 'navigation race never reloads a non-Meet page');
  await updated(
    17,
    { status: 'complete', url: 'https://example.com/left-after-recovery-ensure' },
    { id: 17, url: 'https://example.com/left-after-recovery-ensure' }
  );
  await drain(env);
}

(async () => {
  await releaseToolbarLifecycle();
  console.log('PASS background release Meet toolbar lifecycle');
  await devAutoInjectLifecycle();
  console.log('PASS background dev Meet loop lifecycle');
  await meetSecondToolbarClickUsesDebuggerToggle();
  console.log('PASS background Meet CDP toolbar toggle');
  await explicitDebuggerCancel();
  console.log('PASS background explicit debugger cancel lifecycle');
  await staleMeetEnsureCannotReloadAfterNavigation();
  console.log('PASS background stale Meet ensure navigation race');
  await partialRegularInjectionDoesNotToggleViaDebugger();
  console.log('PASS background partial regular injection');
  await closedMeetMonitorCleansPersistentSession();
  console.log('PASS background closed Meet monitor cleanup');
  await meetReturnRecoversAfterFinalUpdateThenTargetClosed({ dev: false });
  console.log('PASS background release Meet Return target recovery');
  await meetReturnRecoversAfterFinalUpdateThenTargetClosed({ dev: true });
  console.log('PASS background dev Meet Return target recovery');
  await meetReturnRetriesTransientReplacementTarget();
  console.log('PASS background Meet Return transient target retry');
  await recoveryCoalescesConcurrentEntrypoints({ dev: false });
  console.log('PASS background release recovery/action/update coalescing');
  await recoveryCoalescesConcurrentEntrypoints({ dev: true });
  console.log('PASS background dev recovery/action/update coalescing');
  await recoveryAbortsDuringInflightWork('cancel');
  console.log('PASS background recovery cancellation');
  await recoveryAbortsDuringInflightWork('navigate');
  console.log('PASS background recovery navigation cleanup');
  await recoveryAbortsDuringInflightWork('remove');
  console.log('PASS background recovery tab-removal cleanup');
  await staleHarvestCannotCloseRecoveredSession();
  console.log('PASS background stale-harvest generation isolation');
  await recoveredMonitorCloseIsTerminal();
  console.log('PASS background recovered monitor Close cleanup');
  await meetReturnRecoveryCleansNavigationAfterEnsure();
  console.log('PASS background Meet Return post-ensure navigation cleanup');
  console.log('background-unit: all checks passed');
})().catch(error => {
  console.error('background-unit: FAIL');
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
