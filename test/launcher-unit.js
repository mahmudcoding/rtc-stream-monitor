'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const generator = fs.readFileSync(path.join(root, 'dist', 'make-launcher.js'), 'utf8');
const monitor = fs.readFileSync(path.join(root, 'src', 'rtc-stream-monitor.js'), 'utf8');
const builtLauncher = fs.readFileSync(
  path.join(root, 'dist', 'stream-monitor-launcher.html'),
  'utf8'
);

assert.match(generator, /Google Meet requires the Chrome extension/);
assert.match(generator, /cannot capture Google Meet's hidden peer connections/);
assert.match(generator, /airion-cargo\.store/);
assert.doesNotMatch(generator, /Works on any WebRTC page|click it on any call/);

assert.match(monitor, /Google Meet requires the extension's persistent debugger capture path/);
assert.doesNotMatch(monitor, /Works on any WebRTC page/);

assert.match(builtLauncher, /Google Meet requires the Chrome extension/);
assert.match(builtLauncher, /cannot capture Google Meet's hidden peer connections/);
assert.match(builtLauncher, /airion-cargo\.store/);
assert.doesNotMatch(builtLauncher, /Works on any WebRTC page|click it on any call/);

console.log('PASS launcher support boundary: Meet is extension-only');
