#!/usr/bin/env node
'use strict';

// Zoom must always use the ordinary scripting path. In particular, its early
// content script must not make the release build look like DEV_AUTOINJECT and
// no Zoom flow may borrow Meet's persistent debugger/preload/heap machinery.

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const BACKGROUND = fs.readFileSync(
  path.resolve(__dirname, '../extension/background.js'),
  'utf8'
).replace('const HARVEST_MAX_MS = Infinity;', 'const HARVEST_MAX_MS = 1000;');
const RELEASE_MANIFEST = require(path.resolve(__dirname, '../extension/manifest.json'));
const DEV_MANIFEST = require(path.resolve(__dirname, '../extension-dev/manifest.json'));

function eventSlot() {
  const listeners = [];
  return {
    listeners,
    addListener(listener) { listeners.push(listener); },
    emit(...args) { return Promise.all(listeners.map(listener => listener(...args))); }
  };
}

function environment(manifest, initialUrl) {
  const calls = { scripting: [], attach: [], detach: [], debugger: [], reload: [], badge: [] };
  const events = {
    action: eventSlot(),
    updated: eventSlot(),
    removed: eventSlot(),
    debuggerDetach: eventSlot()
  };
  const urls = new Map([[17, initialUrl]]);
  let monitorRunning = false;
  let monitorVisible = false;

  const chrome = {
    runtime: {
      getManifest() { return manifest; },
      getURL(file) { return 'chrome-extension://zoom-unit/' + file; }
    },
    tabs: {
      onUpdated: events.updated,
      onRemoved: events.removed,
      async get(tabId) { return { id: tabId, url: urls.get(tabId) || '' }; },
      reload(tabId) { calls.reload.push(tabId); }
    },
    action: {
      onClicked: events.action,
      setBadgeText(value) { calls.badge.push({ type: 'text', value }); },
      setBadgeBackgroundColor(value) { calls.badge.push({ type: 'color', value }); }
    },
    scripting: {
      async executeScript(options) {
        calls.scripting.push(options);
        if (options.world === 'ISOLATED') return [];
        if (options.world === 'MAIN' && options.func) {
          const suffix = monitorRunning
            ? 'object:' + (monitorVisible ? 'visible' : 'hidden')
            : 'undefined';
          return [{ result: 'rtcmon:' + suffix }];
        }
        if (options.world === 'MAIN' && options.files) {
          monitorRunning = true;
          monitorVisible = true;
          return [];
        }
        return [];
      }
    },
    debugger: {
      onDetach: events.debuggerDetach,
      async getTargets() { return []; },
      async attach(target, version) { calls.attach.push({ target, version }); },
      async detach(target) { calls.detach.push(target); },
      async sendCommand(target, method, params) {
        calls.debugger.push({ target, method, params });
        return {};
      }
    }
  };

  const errors = [];
  vm.runInNewContext(BACKGROUND, {
    chrome,
    URL,
    AbortController,
    setTimeout,
    clearTimeout,
    fetch: async () => ({ text: async () => '/* mocked monitor */' }),
    console: {
      log() {}, warn() {},
      error(...args) { errors.push(args.map(String).join(' ')); }
    }
  }, { filename: 'extension/background.js' });

  return { calls, events, urls, errors };
}

function fileInjections(env) {
  return env.calls.scripting.filter(call =>
    call.world === 'MAIN' && Array.isArray(call.files) && call.files.includes('monitor.js')
  );
}

function assertNoMeetMachinery(env, label) {
  assert.equal(env.calls.attach.length, 0, label + ' never attaches chrome.debugger');
  assert.equal(env.calls.detach.length, 0, label + ' has no debugger to detach');
  assert.equal(env.calls.reload.length, 0, label + ' never reloads the Zoom call');
  assert.equal(
    env.calls.debugger.filter(call => call.method === 'Page.addScriptToEvaluateOnNewDocument').length,
    0,
    label + ' never registers a Meet preload'
  );
  assert.equal(
    env.calls.debugger.filter(call => call.method === 'Runtime.queryObjects').length,
    0,
    label + ' never performs Meet heap harvesting'
  );
}

async function releaseEarlyScriptIsNotDevAutoInject() {
  const url = 'https://app.zoom.us/wc/5467856297/start';
  const env = environment(RELEASE_MANIFEST, url);
  await env.events.updated.emit(17, { status: 'complete' }, { id: 17, url });
  assert.equal(fileInjections(env).length, 0, 'release Zoom completion does not auto-inject monitor.js');
  assert.equal(env.calls.scripting.length, 0, 'release Zoom completion performs no background probe');
  assertNoMeetMachinery(env, 'release completion');
  assert.equal(env.errors.length, 0, 'release completion logs no errors');
}

async function releaseToolbarUsesOrdinaryPath() {
  const url = 'https://app.zoom.us/wc/5467856297/start';
  const env = environment(RELEASE_MANIFEST, url);
  await env.events.action.emit({ id: 17, url });
  const injections = fileInjections(env);
  assert.equal(injections.length, 1, 'release toolbar click injects monitor.js once');
  assert.equal(injections[0].target.tabId, 17, 'release injection targets the clicked Zoom tab');
  assert.equal(injections[0].target.allFrames, true, 'release injection reaches the Zoom media iframe');
  assertNoMeetMachinery(env, 'release toolbar');
  assert.equal(env.errors.length, 0, 'release toolbar logs no errors');
}

async function devZoomUsesRegularAutoInjection() {
  const url = 'https://app.zoom.us/wc/5467856297/start';
  const env = environment(DEV_MANIFEST, url);
  await env.events.updated.emit(17, { status: 'complete' }, { id: 17, url });
  const injections = fileInjections(env);
  assert.equal(injections.length, 1, 'dev Zoom completion injects monitor.js once');
  assert.equal(injections[0].target.allFrames, true, 'dev regular path reaches Zoom child frames');
  assertNoMeetMachinery(env, 'dev auto-injection');
  assert.equal(env.errors.length, 0, 'dev auto-injection logs no errors');
}

async function exactHostRouting() {
  const valid = [
    'https://zoom.us/wc',
    'https://app.zoom.us/wc/123',
    'https://zoom.com/wc/',
    'https://eu01.zoom.com/wc/meeting'
  ];
  for (const url of valid) {
    const env = environment(DEV_MANIFEST, url);
    await env.events.updated.emit(17, { status: 'complete' }, { id: 17, url });
    assert.equal(fileInjections(env).length, 1, url + ' follows regular dev injection');
    assertNoMeetMachinery(env, url);
  }

  const lookalikes = [
    'http://app.zoom.us/wc/123',
    'https://zoom.us.evil.example/wc/123',
    'https://notzoom.us/wc/123',
    'https://zoom.example/wc/123'
  ];
  for (const url of lookalikes) {
    const env = environment(DEV_MANIFEST, url);
    await env.events.updated.emit(17, { status: 'complete' }, { id: 17, url });
    assert.equal(fileInjections(env).length, 0, url + ' is not a supported dev host');
    assert.equal(env.calls.scripting.length, 0, url + ' is never probed');
    assertNoMeetMachinery(env, url);
  }
}

(async () => {
  await releaseEarlyScriptIsNotDevAutoInject();
  await releaseToolbarUsesOrdinaryPath();
  await devZoomUsesRegularAutoInjection();
  await exactHostRouting();
  console.log('zoom-background-unit: all checks passed');
})().catch(error => {
  console.error('zoom-background-unit: FAIL');
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
