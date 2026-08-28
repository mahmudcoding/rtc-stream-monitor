#!/usr/bin/env node
'use strict';

// Dependency-free contract tests for the tiny document_start capture shim.
// These execute the production file itself in isolated VM realms so constructor
// semantics, host/path guards and the handoff protocol cannot drift unnoticed.

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SHIM = fs.readFileSync(
  path.resolve(__dirname, '../src/rtc-early-capture.js'),
  'utf8'
);
const NS = '__rtcStreamMonitorEarlyCapture__';
const EVENT = 'rtc-stream-monitor:peerconnection';

function realm(urlText) {
  const url = new URL(urlText);
  const listeners = new Map();
  let serial = 0;

  class NativePeerConnection {
    constructor(config, constraints) {
      this.serial = ++serial;
      this.config = config;
      this.constraints = constraints;
      this.constructedAs = new.target;
    }
    getStats() { return Promise.resolve(new Map()); }
    static describe() { return 'native-static'; }
  }
  Object.defineProperty(NativePeerConnection, 'token', {
    configurable: false,
    enumerable: false,
    writable: false,
    value: 731
  });

  class FakeCustomEvent {
    constructor(type, init) {
      this.type = type;
      this.detail = init && init.detail;
    }
  }

  const window = {
    location: {
      protocol: url.protocol,
      hostname: url.hostname,
      pathname: url.pathname,
      search: url.search,
      href: url.href
    },
    RTCPeerConnection: NativePeerConnection,
    webkitRTCPeerConnection: NativePeerConnection,
    CustomEvent: FakeCustomEvent,
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(listener);
    },
    dispatchEvent(event) {
      (listeners.get(event.type) || []).slice().forEach(listener => listener.call(window, event));
      return true;
    }
  };
  window.window = window;
  window.self = window;

  const context = vm.createContext({
    window,
    location: window.location,
    CustomEvent: FakeCustomEvent,
    URLSearchParams,
    console: { log() {}, warn() {}, error() {} }
  });
  return { context, window, NativePeerConnection, listeners };
}

function run(target) {
  vm.runInContext(SHIM, target.context, { filename: 'src/rtc-early-capture.js' });
}

function validRealmContract() {
  const target = realm('https://app.zoom.us/wc/meeting-123');
  const Native = target.NativePeerConnection;
  run(target);

  const Wrapped = target.window.RTCPeerConnection;
  assert.notEqual(Wrapped, Native, 'valid Zoom web-client realm is wrapped');
  assert.equal(target.window.webkitRTCPeerConnection, Wrapped, 'webkit alias uses the same wrapper');
  assert.equal(Wrapped.prototype, Native.prototype, 'native prototype identity is preserved');
  assert.equal(Wrapped.describe(), 'native-static', 'inherited native static method remains callable');
  assert.equal(Wrapped.token, 731, 'non-enumerable native static value remains visible');

  const config = { iceServers: [{ urls: 'stun:unit.invalid' }] };
  const constraints = { optional: [{ unit: true }] };
  const first = new Wrapped(config, constraints);
  assert.equal(first.config, config, 'first constructor argument is forwarded by identity');
  assert.equal(first.constraints, constraints, 'second constructor argument is forwarded by identity');
  assert.ok(first instanceof Native, 'constructed object remains a native instance');
  assert.ok(first instanceof Wrapped, 'constructed object remains an instance of the wrapper');
  class DerivedPeerConnection extends Wrapped {}
  const derived = new DerivedPeerConnection({ encodedInsertableStreams: true });
  assert.ok(derived instanceof DerivedPeerConnection, 'subclass new.target semantics are preserved');
  assert.equal(derived.constructedAs, DerivedPeerConnection, 'native constructor receives the derived new.target');

  const capture = target.window[NS];
  assert.equal(capture.version, 1, 'capture protocol version is explicit');
  assert.deepEqual(
    Array.from(capture.connections),
    [first, derived],
    'connections made before subscription are stashed in construction order'
  );

  const delivered = [];
  target.window.addEventListener(EVENT, event => delivered.push(event.detail));
  const second = new Wrapped({ bundlePolicy: 'max-bundle' });
  assert.deepEqual(delivered, [second], 'future connection is delivered through the subscription event');
  assert.deepEqual(
    Array.from(capture.connections),
    [first, derived, second],
    'future connection is also retained for a monitor injected between events'
  );

  const wrapperBeforeRerun = target.window.RTCPeerConnection;
  run(target);
  assert.equal(target.window.RTCPeerConnection, wrapperBeforeRerun, 'rerunning the shim never wraps twice');
  assert.equal(target.window[NS], capture, 'rerunning the shim preserves the original stash');
  const third = new target.window.RTCPeerConnection();
  assert.deepEqual(delivered, [second, third], 'idempotent rerun does not duplicate event delivery');
  assert.deepEqual(
    Array.from(capture.connections),
    [first, derived, second, third],
    'idempotent stash has no duplicates'
  );
}

function hostAndPathGuards() {
  const valid = [
    'https://zoom.us/wc',
    'https://app.zoom.us/wc/123',
    'https://zoom.com/wc/',
    'https://eu01.zoom.com/wc/meeting',
    // Zoom's PWA shell strips the /wc prefix when it creates the real media
    // iframe.  `from=pwa` is the distinguishing contract; without it these
    // ordinary-looking meeting paths must not get a document-start hook.
    'https://app.zoom.us/5467856297/start?from=pwa',
    'https://zoom.us/123456789/join?pwd=unit&from=pwa',
    'https://eu01.zoom.com/12345678901/start?from=pwa&lang=en'
  ];
  for (const url of valid) {
    const target = realm(url);
    run(target);
    assert.ok(target.window[NS], url + ' activates early capture');
    assert.notEqual(target.window.RTCPeerConnection, target.NativePeerConnection, url + ' wraps constructor');
  }

  const invalid = [
    'http://app.zoom.us/wc/123',
    'https://zoom.us/j/123',
    'https://zoom.us/wclient/123',
    'https://app.zoom.us/5467856297/start',
    'https://app.zoom.us/5467856297/start?from=web',
    'https://app.zoom.us/meeting-123/start?from=pwa',
    'https://app.zoom.us/5467856297/launch?from=pwa',
    'https://app.zoom.us/5467856297/start/extra?from=pwa',
    'https://app.zoom.us/5467856297/start?xfrom=pwa',
    'https://zoom.us.evil.example/wc/123',
    'https://zoom.us.evil.example/5467856297/start?from=pwa',
    'https://notzoom.us/wc/123',
    'https://notzoom.us/5467856297/start?from=pwa',
    'https://zoom.example/wc/123'
  ];
  for (const url of invalid) {
    const target = realm(url);
    run(target);
    assert.equal(target.window[NS], undefined, url + ' does not create a stash');
    assert.equal(
      target.window.RTCPeerConnection,
      target.NativePeerConnection,
      url + ' leaves the page constructor untouched'
    );
  }
}

validRealmContract();
hostAndPathGuards();
console.log('zoom-capture-unit: all checks passed');
