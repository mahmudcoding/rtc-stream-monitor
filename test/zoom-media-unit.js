#!/usr/bin/env node
'use strict';

// Dependency-free guards for the narrow Zoom media-channel interpretation.
// The route guard and grouping helper are extracted from production source so
// these tests cannot pass against a hand-copied approximation.

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(
  path.resolve(__dirname, '../src/rtc-stream-monitor.js'),
  'utf8'
);

function sliceSource(startNeedle, endNeedle) {
  const start = source.indexOf(startNeedle);
  const end = source.indexOf(endNeedle, start + startNeedle.length);
  assert.ok(start >= 0, 'could not find source marker: ' + startNeedle);
  assert.ok(end > start, 'could not find source marker: ' + endNeedle);
  return source.slice(start, end);
}

const implementation = [
  sliceSource(
    'var IS_ZOOM_WEBCLIENT_REALM = ',
    '\n\n  function register(pc)'
  ),
  sliceSource('function num(v)', '\n\n  function collectFromPC(entry, now)'),
  sliceSource('function groupedZoomMediaChannels(m)', '\n\n  function tick()')
].join('\n');

function grouper(urlText) {
  const exports = {};
  const url = new URL(urlText);
  new Function(
    'exports',
    'location',
    'URLSearchParams',
    implementation + '\nexports.group = groupedZoomMediaChannels;'
  )(
    exports,
    {
      protocol: url.protocol,
      hostname: url.hostname,
      pathname: url.pathname,
      search: url.search,
      href: url.href
    },
    URLSearchParams
  );
  return exports.group;
}

function channel(label, overrides) {
  return Object.assign({
    id: 'dc-' + label,
    pcKey: 1,
    label,
    state: 'open',
    inKbps: 40,
    outKbps: 20,
    raw: { bytesReceived: 5000, bytesSent: 2500 }
  }, overrides || {});
}

function model(dataChannels, overrides) {
  return Object.assign({
    inbound: [],
    outbound: [],
    dataChannels: dataChannels || []
  }, overrides || {});
}

function rows(url, dataChannels, overrides) {
  return grouper(url)(model(dataChannels, overrides));
}

const AUDIO = 'ZoomWebclientAudioDataChannel';
const VIDEO = 'ZoomWebclientVideoDataChannel';
const WC = 'https://app.zoom.us/wc/5467856297/start?fromPWA=1';

function exactWcGroups() {
  const grouped = rows(WC, [
    channel(VIDEO, { pcKey: 2, inKbps: 700, outKbps: 300 }),
    channel(AUDIO, { pcKey: 1, inKbps: 52, outKbps: 48 })
  ]);
  assert.deepEqual(grouped.map(row => row.kind), ['audio', 'video']);
  assert.deepEqual(
    grouped.map(row => ({
      id: row.id,
      kind: row.kind,
      inKbps: row.inKbps,
      outKbps: row.outKbps,
      sourceCount: row.sourceCount,
      pcKeys: row.pcKeys
    })),
    [
      {
        id: 'zoom-channel-audio', kind: 'audio', inKbps: 52, outKbps: 48,
        sourceCount: 1, pcKeys: [1]
      },
      {
        id: 'zoom-channel-video', kind: 'video', inKbps: 700, outKbps: 300,
        sourceCount: 1, pcKeys: [2]
      }
    ]
  );
}

function routeGuards() {
  const exact = [channel(AUDIO)];
  assert.equal(rows('file:///tmp/harness.html?mode=zoom-dc', exact).length, 0,
    'file fixture must never activate Zoom interpretation');
  assert.equal(rows('https://zoom.us.evil.example/wc/5467856297/start', exact).length, 0,
    'Zoom lookalike hostname must fail closed');
  assert.equal(rows('https://app.zoom.us/j/5467856297', exact).length, 0,
    'ordinary non-webclient route must fail closed');
  assert.equal(rows('https://app.zoom.us/5467856297/start?from=web', exact).length, 0,
    'stripped route without from=pwa must fail closed');
  assert.equal(rows('https://app.zoom.us/meeting-5467856297/start?from=pwa', exact).length, 0,
    'non-numeric stripped route must fail closed');
  assert.equal(rows('https://app.zoom.us/5467856297/start?from=pwa', exact).length, 1,
    'the real stripped PWA media-frame route remains supported');
}

function exactLabelsOnly() {
  const grouped = rows(WC, [
    channel(AUDIO),
    channel(VIDEO),
    channel('ZoomWebclientControlDataChannel', { inKbps: 999, outKbps: 999 }),
    channel('ZoomWebclientChatDataChannel', { inKbps: 999, outKbps: 999 }),
    channel('zoomwebclientaudiodatachannel', { inKbps: 999, outKbps: 999 }),
    channel('video', { inKbps: 999, outKbps: 999 })
  ]);
  assert.deepEqual(grouped.map(row => row.kind), ['audio', 'video']);
  assert.equal(grouped[0].inKbps, 40, 'unknown/control labels cannot inflate audio');
  assert.equal(grouped[1].inKbps, 40, 'unknown/control labels cannot inflate video');
  assert.equal(rows(WC, [channel('ZoomWebclientControlDataChannel')]).length, 0,
    'control-only traffic must not produce a media estimate');
}

function zeroRtpOnly() {
  const exact = [channel(AUDIO)];
  assert.equal(rows(WC, exact, { inbound: [{ id: 'rtp-in' }] }).length, 0,
    'hybrid inbound RTP + DataChannel mode must use RTP rows');
  assert.equal(rows(WC, exact, { outbound: [{ id: 'rtp-out' }] }).length, 0,
    'hybrid outbound RTP + DataChannel mode must use RTP rows');
}

function activityGuards() {
  assert.equal(rows(WC, [channel(AUDIO, { state: 'closed' })]).length, 0,
    'closed exact-label channel is stale, not active media');
  assert.equal(rows(WC, [channel(AUDIO, {
    inKbps: 0, outKbps: 0, raw: { bytesReceived: 0, bytesSent: 0 }
  })]).length, 0, 'never-used zero channel stays hidden');
  assert.equal(rows(WC, [channel(AUDIO, {
    inKbps: null, outKbps: null, raw: { bytesReceived: 0, bytesSent: 0 }
  })]).length, 0, 'first sample without cumulative activity stays hidden');
  assert.equal(rows(WC, [channel(AUDIO, {
    inKbps: -50, outKbps: -25, raw: { bytesReceived: 5000, bytesSent: 2500 }
  })]).length, 0, 'counter reset cannot create negative-rate media');

  const firstActive = rows(WC, [channel(AUDIO, {
    inKbps: null, outKbps: null,
    raw: { bytesReceived: 5000, bytesSent: 2500 }
  })]);
  assert.equal(firstActive.length, 1,
    'positive cumulative bytes keep the active first sample observable');
  assert.equal(firstActive[0].inKbps, null);
  assert.equal(firstActive[0].outKbps, null);

  assert.equal(rows(WC, [channel(AUDIO, {
    state: undefined, inKbps: null, outKbps: null,
    raw: { bytesReceived: 5000, bytesSent: 2500 }
  })]).length, 0,
  'missing state cannot use cumulative-only first-sample evidence');
  assert.equal(rows(WC, [channel(AUDIO, {
    state: undefined, inKbps: 0, outKbps: 0,
    raw: { bytesReceived: 5000, bytesSent: 2500 }
  })]).length, 0,
  'missing state cannot use cumulative bytes to claim idle activity');
  const missingStatePositive = rows(WC, [channel(AUDIO, {
    state: undefined, inKbps: 7, outKbps: null,
    raw: { bytesReceived: 0, bytesSent: 0 }
  })]);
  assert.equal(missingStatePositive.length, 1,
    'missing state may use a positive current delta as direct activity evidence');
  assert.equal(missingStatePositive[0].inKbps, 7);
  assert.equal(missingStatePositive[0].outKbps, null);
}

function duplicateAggregation() {
  const grouped = rows(WC, [
    channel(AUDIO, {
      id: 'audio-a', pcKey: 11, inKbps: 12, outKbps: 8,
      raw: { bytesReceived: 1500, bytesSent: 1000 }
    }),
    channel(AUDIO, {
      id: 'audio-b', pcKey: 12, inKbps: 30, outKbps: 14,
      raw: { bytesReceived: 3750, bytesSent: 1750 }
    }),
    channel(AUDIO, {
      id: 'audio-c', pcKey: 12, inKbps: -500, outKbps: -500,
      raw: { bytesReceived: 0, bytesSent: 0 }
    })
  ]);
  assert.equal(grouped.length, 1, 'duplicate exact labels collapse to one kind row');
  assert.equal(grouped[0].inKbps, 42, 'valid receive rates sum; reset delta cannot cancel them');
  assert.equal(grouped[0].outKbps, 22, 'valid send rates sum; reset delta cannot cancel them');
  assert.equal(grouped[0].sourceCount, 2, 'reset-only sources are excluded from the estimate');
  assert.deepEqual(grouped[0].pcKeys, [11, 12], 'PC provenance is unique and stable');
}

function uiWordingAndUnknownRates() {
  const uiImplementation = sliceSource(
    'function updateZoomMediaChannel(channel)',
    '\n\n  function update(m)'
  );
  const rates = { innerHTML: '' };
  const meta = { innerHTML: '' };
  const card = {
    title: '',
    querySelector(selector) {
      if (selector === '[data-u=zoom-rates]') return rates;
      if (selector === '[data-u=zoom-meta]') return meta;
      return null;
    }
  };
  const root = { querySelector: () => card };
  const exports = {};
  new Function(
    'exports', 'root', 'CSS', 'trust', 'C', 'fmtRate', 'SEP',
    uiImplementation + '\nexports.update = updateZoomMediaChannel;'
  )(
    exports,
    root,
    { escape: value => String(value) },
    value => value,
    { inb: 'blue', out: 'orange' },
    value => value === null || value === undefined ? '—' : value + ' kbps',
    ' · '
  );
  exports.update({ kind: 'audio', inKbps: null, outKbps: 0, sourceCount: 2 });
  assert.match(rates.innerHTML, /↓<\/span> —/, 'unknown direction renders an em dash');
  assert.match(rates.innerHTML, /↑<\/span> idle/, 'proven zero current rate renders idle');
  assert.equal(meta.innerHTML, 'all participants · 2 channels combined');
  assert.doesNotMatch(meta.innerHTML, /source/i, 'UI never calls DataChannels participant sources');
  assert.match(card.title, /not a participant-level RTP stream/);
}

exactWcGroups();
console.log('PASS exact Zoom /wc audio/video groups');
routeGuards();
console.log('PASS exact Zoom host and web-client route guards');
exactLabelsOnly();
console.log('PASS exact media labels only');
zeroRtpOnly();
console.log('PASS RTP/DataChannel hybrid fails closed');
activityGuards();
console.log('PASS inactive, zero and reset guards');
duplicateAggregation();
console.log('PASS duplicate labels aggregate with source provenance');
uiWordingAndUnknownRates();
console.log('PASS Zoom channel UI wording and unknown/idle rates');
console.log('zoom-media-unit: all checks passed');
