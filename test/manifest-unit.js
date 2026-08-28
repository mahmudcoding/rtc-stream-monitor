#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const path = require('path');

const release = require(path.resolve(__dirname, '../extension/manifest.json'));
const dev = require(path.resolve(__dirname, '../extension-dev/manifest.json'));

const ZOOM_MATCHES = [
  'https://zoom.us/wc',
  'https://zoom.us/wc/*',
  'https://zoom.us/*/start*',
  'https://zoom.us/*/join*',
  'https://*.zoom.us/wc',
  'https://*.zoom.us/wc/*',
  'https://*.zoom.us/*/start*',
  'https://*.zoom.us/*/join*',
  'https://zoom.com/wc',
  'https://zoom.com/wc/*',
  'https://zoom.com/*/start*',
  'https://zoom.com/*/join*',
  'https://*.zoom.com/wc',
  'https://*.zoom.com/wc/*',
  'https://*.zoom.com/*/start*',
  'https://*.zoom.com/*/join*'
].sort();
const REGULAR_MATCHES = [
  'https://airion-cargo.store/*',
  'https://*.airion-cargo.store/*',      // staging.airion-cargo.store is the live test surface
  'https://airion-cargo.online/*',
  'https://*.airion-cargo.online/*',
  'https://meet.google.com/*',
  ...ZOOM_MATCHES
].sort();

function sorted(values) { return [...(values || [])].sort(); }
function scripts(manifest) { return manifest.content_scripts || []; }
function withFile(manifest, file) {
  return scripts(manifest).filter(item => (item.js || []).includes(file));
}

function assertEarlyOnly(item, label) {
  assert.deepEqual(item.js, ['rtc-early-capture.js'], label + ' has only the capture shim');
  assert.equal(item.run_at, 'document_start', label + ' runs at document_start');
  assert.equal(item.world, 'MAIN', label + ' runs in the page MAIN world');
  assert.equal(item.all_frames, true, label + ' covers Zoom media child frames');
  assert.deepEqual(sorted(item.matches), ZOOM_MATCHES, label + ' is scoped only to Zoom hosts');
}

assert.equal(scripts(release).length, 1, 'release declares only the early Zoom capture registration');
assertEarlyOnly(scripts(release)[0], 'release early registration');
assert.equal(withFile(release, 'monitor.js').length, 0, 'release never auto-injects the monitor');
assert.equal(withFile(release, 'probe-isolated.js').length, 0, 'release never installs dev diagnostics');

assert.equal(withFile(dev, 'rtc-early-capture.js').length, 1, 'dev contains one early capture registration');
assertEarlyOnly(withFile(dev, 'rtc-early-capture.js')[0], 'dev early registration');

const devMonitor = withFile(dev, 'monitor.js');
assert.equal(devMonitor.length, 1, 'dev keeps one regular monitor auto-injection');
assert.equal(devMonitor[0].run_at, 'document_end', 'dev monitor remains regular document_end injection');
assert.equal(devMonitor[0].world, 'MAIN', 'dev monitor remains in MAIN world');
assert.equal(devMonitor[0].all_frames, true, 'dev monitor reaches Zoom media child frames');
assert.deepEqual(sorted(devMonitor[0].matches), REGULAR_MATCHES, 'dev monitor retains Aloqa, Meet and Zoom');

const devProbe = withFile(dev, 'probe-isolated.js');
assert.equal(devProbe.length, 1, 'dev keeps one screenshot-safe diagnostic probe');
assert.equal(devProbe[0].run_at, 'document_end', 'dev probe remains regular document_end injection');
assert.equal(devProbe[0].all_frames, false, 'dev probe remains top-frame-only');
assert.deepEqual(sorted(devProbe[0].matches), REGULAR_MATCHES, 'dev probe retains Aloqa, Meet and Zoom');

for (const [label, manifest] of [['release', release], ['dev', dev]]) {
  assert.deepEqual(
    sorted((manifest.host_permissions || []).filter(pattern => /zoom\.(?:us|com)/.test(pattern))),
    ZOOM_MATCHES,
    label + ' requests the exact Zoom host set'
  );
}

console.log('manifest-unit: all checks passed');
