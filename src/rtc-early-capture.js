/*
 * RTC Stream Monitor -- Zoom document-start peer-connection capture.
 *
 * This file intentionally does not create UI.  It runs in the page's MAIN
 * world before Zoom's web client and keeps the connections for monitor.js to
 * adopt later.  Keep the host/path guard in addition to the manifest matches:
 * it makes a copied or programmatically injected build a no-op everywhere
 * except an actual Zoom web-client realm.
 */
(function () {
  'use strict';

  var KEY = '__rtcStreamMonitorEarlyCapture__';
  var EVENT = 'rtc-stream-monitor:peerconnection';

  function isZoomWebClientRealm() {
    try {
      if (location.protocol !== 'https:' ||
          !/(^|\.)zoom\.(?:us|com)$/i.test(location.hostname)) return false;

      /* Zoom Workplace's PWA shell lives under /wc.  The live call kept that
         prefix in its same-origin media frame, while the current PWA bundle
         also contains a route that strips it and appends from=pwa, yielding
         /<meeting-number>/(start|join).  Accept both verified shapes.  The
         query requirement keeps ordinary Zoom landing routes out even though
         Chrome match patterns cannot express numeric path segments. */
      if (location.pathname === '/wc' ||
          location.pathname.indexOf('/wc/') === 0) return true;
      return /^\/\d+\/(?:start|join)\/?$/.test(location.pathname) &&
        new URLSearchParams(location.search).get('from') === 'pwa';
    } catch (e) {
      return false;
    }
  }

  if (!isZoomWebClientRealm()) return;
  if (window[KEY] && window[KEY].version === 1 &&
      Array.isArray(window[KEY].connections)) return;

  var seen = new WeakSet();
  var state = { version: 1, connections: [] };
  try { window[KEY] = state; } catch (e) { return; }
  if (window[KEY] !== state) return;

  function capture(pc) {
    if (!pc || seen.has(pc)) return pc;
    seen.add(pc);
    state.connections.push(pc);
    try {
      window.dispatchEvent(new CustomEvent(EVENT, { detail: pc }));
    } catch (e) { /* the later stash drain is the reliable fallback */ }
    return pc;
  }

  function wrap(Native) {
    if (typeof Native !== 'function') return Native;
    try {
      return new Proxy(Native, {
        construct: function (target, args, newTarget) {
          return capture(Reflect.construct(target, args, newTarget));
        }
      });
    } catch (e) {
      /* Proxy is available in every supported Chrome.  This fallback keeps a
         usable constructor if an embedding environment disables it. */
      function EarlyCapturedRTCPeerConnection() {
        var args = Array.prototype.slice.call(arguments);
        var pc = new (Function.prototype.bind.apply(Native, [null].concat(args)))();
        return capture(pc);
      }
      EarlyCapturedRTCPeerConnection.prototype = Native.prototype;
      try { Object.setPrototypeOf(EarlyCapturedRTCPeerConnection, Native); } catch (ignored) {}
      return EarlyCapturedRTCPeerConnection;
    }
  }

  var NativeRTCPC = window.RTCPeerConnection;
  var NativeWebkitPC = window.webkitRTCPeerConnection;
  var WrappedRTCPC = wrap(NativeRTCPC);
  var WrappedWebkitPC = NativeWebkitPC === NativeRTCPC
    ? WrappedRTCPC : wrap(NativeWebkitPC);

  try {
    if (WrappedRTCPC && window.RTCPeerConnection === NativeRTCPC) {
      window.RTCPeerConnection = WrappedRTCPC;
    }
  } catch (e) {}
  try {
    if (WrappedWebkitPC && window.webkitRTCPeerConnection === NativeWebkitPC) {
      window.webkitRTCPeerConnection = WrappedWebkitPC;
    }
  } catch (e) {}
})();
