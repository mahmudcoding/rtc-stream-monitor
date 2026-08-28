#!/usr/bin/env node
'use strict';

// Guards for the auto-update path. Like background-unit.js this executes the
// real extension/background.js in a sandbox, so the assertions cover the code
// that actually ships rather than a copy.

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SOURCE = fs.readFileSync(path.resolve(__dirname, '../extension/background.js'), 'utf8');

function load({ manifestVersion = '1.7.0', feed = null, store = {}, hasStorage = true,
                hasAlarms = true, hasFetch = true } = {}) {
  const calls = { reload: 0, badge: [], title: [], alarms: [], fetched: [] };
  const listeners = {};
  const slot = (name) => ({ addListener: fn => { listeners[name] = fn; } });
  const storage = {
    local: {
      async get(key) { return key in store ? { [key]: store[key] } : {}; },
      async set(obj) { Object.assign(store, obj); },
      async remove(key) { delete store[key]; }
    }
  };
  const chrome = {
    runtime: {
      getManifest: () => ({ version: manifestVersion }),
      getURL: f => 'chrome-extension://unit/' + f,
      onStartup: slot('startup'),
      onSuspend: slot('suspend'),
      reload() { calls.reload++; }
    },
    tabs: { onUpdated: slot('tabUpdated'), onRemoved: slot('tabRemoved'), async get() { return {}; } },
    action: {
      onClicked: slot('clicked'),
      setBadgeText: v => calls.badge.push(v),
      setBadgeBackgroundColor: () => {},
      setTitle: v => calls.title.push(v)
    },
    scripting: { async executeScript() { return []; } },
    debugger: { onDetach: slot('detach'), async getTargets() { return []; } }
  };
  if (hasStorage) chrome.storage = storage;
  if (hasAlarms) {
    chrome.alarms = {
      create: (name, opts) => calls.alarms.push({ name, opts }),
      onAlarm: slot('alarm')
    };
  }
  const sandbox = { chrome, console, setTimeout, clearTimeout, Date, URL, JSON, Promise };
  if (hasFetch) {
    sandbox.fetch = async (url) => {
      calls.fetched.push(url);
      if (feed === null) throw new Error('offline');
      if (feed === 404) return { ok: false, status: 404, async json() { return {}; } };
      return { ok: true, status: 200, async json() { return feed; } };
    };
  }
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox, { filename: 'background.js' });
  return { sandbox, calls, listeners, store };
}

async function versionComparison() {
  const { sandbox } = load();
  const newer = sandbox.isNewerVersion;
  assert.equal(newer('1.7.1', '1.7.0'), true);
  assert.equal(newer('1.8.0', '1.7.9'), true);
  // The reason this is not a string compare: "1.7.10" must beat "1.7.9".
  assert.equal(newer('1.7.10', '1.7.9'), true);
  assert.equal(newer('1.7.0', '1.7.0'), false, 'the same version is not an update');
  assert.equal(newer('1.6.9', '1.7.0'), false, 'older is never an update');
  for (const bad of [null, undefined, '', 'v1.7.1', '1.7', '1.7.1-beta', 'latest', '1.a.0']) {
    assert.equal(newer(bad, '1.7.0'), false, 'unparseable claims nothing: ' + bad);
  }
}

async function badgesOnlyOnARealUpdate() {
  const up = load({ feed: { tag_name: 'v1.8.0' } });
  assert.equal(await up.sandbox.checkForUpdate(), '1.8.0');
  // vm objects carry the sandbox realm's prototype, so compare values not shapes.
  assert.equal(up.calls.badge.length, 1, 'a newer release badges the toolbar');
  assert.equal(up.calls.badge[0].text, '↑');
  assert.match(up.calls.title[0].title, /1\.8\.0 is available \(running 1\.7\.0\)/);

  const same = load({ feed: { tag_name: 'v1.7.0' } });
  assert.equal(await same.sandbox.checkForUpdate(), null);
  assert.equal(same.calls.badge.length, 0, 'the current version never badges');

  const older = load({ feed: { tag_name: 'v1.6.0' } });
  assert.equal(await older.sandbox.checkForUpdate(), null, 'a rollback is not an update');
}

async function unreachableFeedFailsClosed() {
  // A private repository answers 404, and an offline browser throws. Neither
  // may badge, and neither may throw out of the check.
  for (const feed of [404, null]) {
    const env = load({ feed });
    assert.equal(await env.sandbox.checkForUpdate(), null);
    assert.equal(env.calls.badge.length, 0);
  }
  const noFetch = load({ hasFetch: false });
  assert.equal(await noFetch.sandbox.publishedVersion(), null, 'no fetch: no claim, no throw');

  // Garbage in the feed must not become a version.
  for (const body of [{}, { tag_name: 'nightly' }, { tag_name: null }, []]) {
    const env = load({ feed: body });
    assert.equal(await env.sandbox.checkForUpdate(), null, JSON.stringify(body));
  }
}

async function startupReloadHappensOnceNotInALoop() {
  const env = load();
  // First browser start after the agent pulled: restart to pick the files up.
  assert.equal(await env.sandbox.reloadForPulledUpdate(), true);
  assert.equal(env.calls.reload, 1);
  assert.equal(env.store.rtcmonPendingReload, true, 'the flag survives the restart');
  // The worker comes back with the flag set: this start IS the reload, so stop.
  assert.equal(await env.sandbox.reloadForPulledUpdate(), false);
  assert.equal(env.calls.reload, 1, 'exactly one reload, never a restart loop');
  assert.equal(env.store.rtcmonPendingReload, undefined, 'and the flag is cleared');
  // The following browser start is a fresh chance to pick up a new pull.
  assert.equal(await env.sandbox.reloadForPulledUpdate(), true);
  assert.equal(env.calls.reload, 2);
}

async function startupReloadNeedsStorage() {
  // Without chrome.storage there is no loop guard, so it must not reload at all.
  const env = load({ hasStorage: false });
  assert.equal(await env.sandbox.reloadForPulledUpdate(), false);
  assert.equal(env.calls.reload, 0, 'no guard means no reload — never risk a loop');
}

async function schedulingIsRegistered() {
  const env = load();
  assert.equal(env.calls.alarms.length, 1, 'one recurring check is scheduled');
  assert.equal(env.calls.alarms[0].name, 'rtcmon-update-check');
  assert.ok(env.calls.alarms[0].opts.periodInMinutes >= 60, 'and it is not a busy loop');
  assert.ok(typeof env.listeners.startup === 'function', 'browser start is handled');
  // A Chrome without alarms must still load the worker.
  assert.doesNotThrow(() => load({ hasAlarms: false }));
}

(async () => {
  await versionComparison();
  console.log('PASS version comparison is numeric and fails closed');
  await badgesOnlyOnARealUpdate();
  console.log('PASS the badge appears only for a genuinely newer release');
  await unreachableFeedFailsClosed();
  console.log('PASS private/offline/garbage feeds claim nothing');
  await startupReloadHappensOnceNotInALoop();
  console.log('PASS startup reload happens once, never in a loop');
  await startupReloadNeedsStorage();
  console.log('PASS no storage guard means no reload');
  await schedulingIsRegistered();
  console.log('PASS update checks are scheduled and survive a missing alarms API');
  console.log('update-unit: all checks passed');
})().catch(error => {
  console.error('update-unit: FAIL');
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
