#!/usr/bin/env node
'use strict';

// Focused guards for stats math and ICE-path selection.  Both tests extract and
// execute the implementation from src/rtc-stream-monitor.js; no production
// algorithm is copied into this file.

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

function loadCollector() {
  const exports = {};
  const implementation = sliceSource(
    'function num(v)',
    '/* which direction does each track flow?'
  );
  new Function(
    'exports',
    implementation + '\nexports.collectFromPC = collectFromPC;'
  )(exports);
  return exports.collectFromPC;
}

function loadTick(parts, options) {
  options = options || {};
  const exports = {};
  // tick() calls pruneStreamState(); extract that production helper with it so
  // this harness follows source changes without replacing cleanup with a no-op.
  const implementation = sliceSource('function pruneStreamState(m)', 'function quality(m)');
  const entries = parts.map((part, i) => ({
    pc: Object.assign({ signalingState: 'stable' }, options.pc || {}),
    key: i + 1,
    part
  }));
  const collectFromPC = entry => Promise.resolve(entry.part);
  const history = [];
  const trackGroups = options.trackGroups || {};

  new Function(
    'exports',
    'PCS',
    'collectFromPC',
    'collectFromElements',
    'trackDirs',
    'receiverLevels',
    'HIST',
    'HIST_MAX',
    'STREAM_HIST',
    'TRACK_NAMES',
    'TRACK_GROUP',
    'LAST',
    'expanded',
    'IS_ZOOM_WEBCLIENT_REALM',
    'num',
    implementation + '\nexports.tick = tick;'
  )(
    exports,
    entries,
    collectFromPC,
    () => [],
    () => ({}),
    () => ({}),
    history,
    90,
    {},
    {},
    trackGroups,
    null,
    {},
    !!options.isZoom,
    v => typeof v === 'number' && Number.isFinite(v) ? v : null
  );
  exports.tick.history = history;
  exports.tick.trackGroups = trackGroups;
  return exports.tick;
}

function emptyPart(inbound) {
  return {
    inbound,
    outbound: [],
    dataChannels: [],
    transport: null,
    rtt: null,
    avail: null,
    localCand: null,
    remoteCand: null,
    state: 'connected',
    localAudio: null
  };
}

async function packetWeightedInboundLoss() {
  const tick = loadTick([
    emptyPart([
      // Busy video: 10 lost out of 1000 packets (1%).
      { id: 'busy-video', kbps: 2400, jitter: 8, lossLost: 10, lossTotal: 1000 },
      // Nearly idle layer: 1 lost out of 2 packets (50%).
      { id: 'idle-layer', kbps: 0, jitter: 2, lossLost: 1, lossTotal: 2 },
      // Missing deltas are intentionally excluded from the denominator.
      { id: 'new-stream', kbps: 0, jitter: null, lossLost: null, lossTotal: null }
    ])
  ]);

  const model = await tick();
  const expected = 11 / 1002 * 100;
  assert.ok(
    Math.abs(model.loss - expected) < 1e-12,
    'aggregate loss must be total lost packets / total observed packets'
  );
  assert.ok(model.loss < 2, 'an idle 50% layer must not dominate busy SFU video');
}

async function authoritativeSelectedCandidatePair() {
  const collectFromPC = loadCollector();
  const stats = [
    // Put the transport first and stale pairs later to make iteration order
    // adversarial. The transport reference must remain authoritative.
    {
      id: 'transport-1',
      type: 'transport',
      selectedCandidatePairId: 'pair-current',
      bytesReceived: 5000,
      bytesSent: 3000,
      dtlsState: 'connected'
    },
    {
      id: 'pair-stale-selected',
      type: 'candidate-pair',
      state: 'succeeded',
      selected: true,
      nominated: true,
      currentRoundTripTime: 0.9,
      availableOutgoingBitrate: 100000,
      localCandidateId: 'local-stale',
      remoteCandidateId: 'remote-stale'
    },
    {
      id: 'pair-stale-nominated',
      type: 'candidate-pair',
      state: 'succeeded',
      nominated: true,
      currentRoundTripTime: 0.7,
      availableOutgoingBitrate: 200000,
      localCandidateId: 'local-stale',
      remoteCandidateId: 'remote-stale'
    },
    {
      id: 'pair-current',
      type: 'candidate-pair',
      state: 'succeeded',
      currentRoundTripTime: 0.025,
      availableOutgoingBitrate: 5000000,
      localCandidateId: 'local-current',
      remoteCandidateId: 'remote-current'
    },
    { id: 'local-stale', type: 'local-candidate', candidateType: 'host', protocol: 'udp' },
    { id: 'remote-stale', type: 'remote-candidate', candidateType: 'host', protocol: 'udp' },
    {
      id: 'local-current',
      type: 'local-candidate',
      candidateType: 'relay',
      protocol: 'tcp',
      networkType: 'wifi',
      relayProtocol: 'tls'
    },
    { id: 'remote-current', type: 'remote-candidate', candidateType: 'relay', protocol: 'tcp' }
  ];
  const entry = {
    pc: {
      connectionState: 'connected',
      getStats: async () => stats
    },
    prev: new Map(),
    t: 0
  };

  const result = await collectFromPC(entry, 1000);
  assert.equal(result.rtt, 25, 'RTT comes from transport.selectedCandidatePairId');
  assert.equal(result.avail, 5000, 'available bitrate comes from the selected pair');
  assert.deepEqual(
    result.localCand,
    { type: 'relay', proto: 'tcp', net: 'wifi', relay: 'tls' },
    'local path ignores stale selected/nominated pairs'
  );
  assert.deepEqual(
    result.remoteCand,
    { type: 'relay', proto: 'tcp' },
    'remote path ignores stale selected/nominated pairs'
  );
}

async function zoomTransportNullAndResetSemantics() {
  const collectFromPC = loadCollector();
  const firstEntry = {
    key: 41,
    pc: { connectionState: 'connected', getStats: async () => [
      {
        id: 'transport-first', type: 'transport',
        bytesReceived: 9000, bytesSent: 7000, dtlsState: 'connected'
      },
      {
        id: 'audio-first', type: 'data-channel',
        label: 'ZoomWebclientAudioDataChannel', state: 'open',
        bytesReceived: 5000, bytesSent: 2500
      }
    ] },
    prev: new Map(),
    t: 0
  };
  const firstPart = await collectFromPC(firstEntry, 1000);
  assert.equal(firstPart.transport.inKbps, null, 'first transport receive rate is unknown');
  assert.equal(firstPart.transport.outKbps, null, 'first transport send rate is unknown');

  const firstTick = loadTick([firstPart], { isZoom: true });
  const firstModel = await firstTick();
  assert.equal(firstModel.viaTransport, true,
    'exact active Zoom cumulative channel bytes keep first sample in transport mode');
  assert.equal(firstModel.down, null, 'unknown first receive rate remains null for hero `—`');
  assert.equal(firstModel.up, null, 'unknown first send rate remains null for hero `—`');
  assert.equal(firstTick.history[0].down, null, 'unknown receive rate stays null in history');
  assert.equal(firstTick.history[0].up, null, 'unknown send rate stays null in history');

  const resetEntry = {
    key: 42,
    pc: { connectionState: 'connected', getStats: async () => [
      {
        id: 'transport-reset', type: 'transport',
        bytesReceived: 11000, bytesSent: 500, dtlsState: 'connected'
      }
    ] },
    prev: new Map([['transport-reset', {
      id: 'transport-reset', type: 'transport', bytesReceived: 10000, bytesSent: 1000
    }]]),
    t: 1000
  };
  const resetPart = await collectFromPC(resetEntry, 2000);
  assert.equal(resetPart.transport.inKbps, 8, 'positive transport direction remains measurable');
  assert.equal(resetPart.transport.outKbps, null, 'negative/reset direction becomes unknown');
  const resetTick = loadTick([resetPart], { isZoom: true });
  const resetModel = await resetTick();
  assert.equal(resetModel.viaTransport, true, 'one valid transport direction enables fallback');
  assert.equal(resetModel.down, 8, 'known receive direction is preserved');
  assert.equal(resetModel.up, null, 'reset send direction remains null, never coerced to zero');
  assert.equal(resetTick.history[0].up, null, 'reset send direction cannot pollute history');

  const allResetEntry = {
    key: 43,
    pc: { connectionState: 'connected', getStats: async () => [
      { id: 'transport-all-reset', type: 'transport', bytesReceived: 10, bytesSent: 20 }
    ] },
    prev: new Map([['transport-all-reset', {
      id: 'transport-all-reset', type: 'transport', bytesReceived: 100, bytesSent: 200
    }]]),
    t: 1000
  };
  const allResetPart = await collectFromPC(allResetEntry, 2000);
  assert.equal(allResetPart.transport.inKbps, null);
  assert.equal(allResetPart.transport.outKbps, null);
  const allResetModel = await loadTick([allResetPart], { isZoom: true })();
  assert.equal(allResetModel.viaTransport, false,
    'negative transport deltas alone never enable transport mode');
}

/* Chrome keeps an inbound-rtp stat in the report after the far end drops a
   participant and renegotiates the m-line to `inactive`; the counter freezes and
   the card reads 0 kb/s forever. Verified against Chrome 151: `removeTrack` +
   renegotiation leaves currentDirection `inactive` with the receiver track still
   `live`, while a muted or stalled sender keeps `recvonly`. Only the first is
   removable, so these guard both directions of that judgement. */
function makeTransceiver(mid, kind, overrides) {
  return Object.assign({
    mid,
    stopped: false,
    direction: 'sendrecv',
    currentDirection: 'sendrecv',
    receiver: { track: { id: 'recv-' + mid, kind, readyState: 'live', muted: false } },
    sender: { track: { id: 'send-' + mid, kind, readyState: 'live' } }
  }, overrides || {});
}

function statsEntry(transceivers, stats, prev) {
  return {
    key: 7,
    pc: {
      connectionState: 'connected',
      getStats: async () => stats,
      getTransceivers: () => transceivers,
      getReceivers: () => transceivers.map(t => t.receiver)
    },
    prev: prev || new Map(),
    t: 1000
  };
}

function rtpPair(mid, bytesIn, bytesOut) {
  return [
    { id: 'in-' + mid, type: 'inbound-rtp', kind: 'audio', mid, ssrc: 1000 + Number(mid),
      trackIdentifier: 'recv-' + mid, bytesReceived: bytesIn },
    { id: 'out-' + mid, type: 'outbound-rtp', kind: 'audio', mid, ssrc: 2000 + Number(mid),
      trackIdentifier: 'send-' + mid, bytesSent: bytesOut }
  ];
}

async function endedStreamsLeaveTheList() {
  const collectFromPC = loadCollector();

  // mid 0 departed (renegotiated to `inactive`, counters frozen);
  // mid 1 is present but silent — a muted mic, or an SFU pausing a hidden tile.
  const transceivers = [
    makeTransceiver('0', 'audio', { currentDirection: 'inactive' }),
    makeTransceiver('1', 'audio')
  ];
  const stats = rtpPair('0', 5000, 5000).concat(rtpPair('1', 5000, 5000));
  const prev = new Map(stats.map(s => [s.id, s]));   // identical counters: zero delta everywhere
  const part = await collectFromPC(statsEntry(transceivers, stats, prev), 2000);

  assert.equal(part.inbound.length, 2, 'the collector reports every stat and flags rather than drops');
  const flag = dir => part[dir].reduce((acc, s) => (acc[s.mid] = !!s.ended, acc), {});
  assert.deepEqual(flag('inbound'), { 0: true, 1: false },
    'only a transceiver with no negotiated receive direction ends an inbound stream');
  assert.deepEqual(flag('outbound'), { 0: true, 1: false },
    'only a transceiver with no negotiated send direction ends an outbound stream');

  const model = await loadTick([part])();
  assert.deepEqual(model.inbound.map(s => s.mid), ['1'], 'the departed inbound card is gone');
  assert.deepEqual(model.outbound.map(s => s.mid), ['1'], 'the departed outbound card is gone');
  assert.equal(model.endedStreams, 2, 'the dump records how many cards were hidden');
  assert.equal(model.rtpStats, 4, 'the raw stat count survives filtering');
}

async function quietStreamsSurviveWithoutProof() {
  const collectFromPC = loadCollector();

  /* Every shape of "0 kb/s but nobody proved it left". None may be removed.
     `dirs` names the directions the transceiver actually still negotiates, so
     a recvonly m-line is only asked about the stream it can really carry. */
  const cases = [
    { label: 'sendrecv, silent', dirs: 'io', trx: makeTransceiver('0', 'audio') },
    { label: 'recvonly, receiving nothing right now', dirs: 'i',
      trx: makeTransceiver('1', 'audio', { currentDirection: 'recvonly' }) },
    { label: 'unnegotiated (null currentDirection)', dirs: 'io',
      trx: makeTransceiver('2', 'audio', { currentDirection: null }) },
    { label: 'muted receive track', dirs: 'io',
      trx: makeTransceiver('3', 'audio', {
        receiver: { track: { id: 'recv-3', kind: 'audio', readyState: 'live', muted: true } }
      }) },
    { label: 'camera off — replaceTrack(null) leaves no sender track', dirs: 'io',
      trx: makeTransceiver('4', 'audio', { sender: { track: null } }) },
    { label: 'local direction wish only; never negotiated', dirs: 'io',
      trx: makeTransceiver('5', 'audio', { direction: 'inactive', currentDirection: 'sendrecv' }) },
    { label: 'sendonly, sending silence', dirs: 'o',
      trx: makeTransceiver('6', 'audio', { currentDirection: 'sendonly' }) }
  ];
  const transceivers = cases.map(c => c.trx);
  const stats = cases.reduce((all, c) => all.concat(
    rtpPair(c.trx.mid, 5000, 5000).filter(s =>
      c.dirs.indexOf(s.type === 'inbound-rtp' ? 'i' : 'o') >= 0)), []);
  const prev = new Map(stats.map(s => [s.id, s]));
  const part = await collectFromPC(statsEntry(transceivers, stats, prev), 2000);

  part.inbound.concat(part.outbound).forEach(s => {
    const label = cases.find(c => c.trx.mid === s.mid).label;
    assert.equal(s.ended, false, 'a quiet stream must survive: ' + label + ' (' + s.dir + ')');
  });
  const model = await loadTick([part])();
  assert.equal(model.inbound.length + model.outbound.length, stats.length,
    'no quiet stream is removed without positive evidence');
  assert.equal(model.endedStreams, 0);
}

async function unmatchableAndMovingStreamsFailClosed() {
  const collectFromPC = loadCollector();

  // A stat that lost its mid still resolves by track id; one that resolves by
  // nothing at all is unknown, and unknown is never a licence to delete.
  const byTrack = makeTransceiver('9', 'audio', { currentDirection: 'inactive' });
  const stats = [
    { id: 'in-no-mid', type: 'inbound-rtp', kind: 'audio', ssrc: 41,
      trackIdentifier: 'recv-9', bytesReceived: 5000 },
    { id: 'in-orphan', type: 'inbound-rtp', kind: 'audio', ssrc: 42,
      trackIdentifier: 'nobody-owns-this', bytesReceived: 5000 },
    // Still moving bytes while a renegotiation reads back `inactive`: traffic wins.
    { id: 'in-moving', type: 'inbound-rtp', kind: 'audio', mid: '9', ssrc: 43,
      trackIdentifier: 'recv-9', bytesReceived: 90000 }
  ];
  const prev = new Map([
    ['in-no-mid', { id: 'in-no-mid', bytesReceived: 5000 }],
    ['in-orphan', { id: 'in-orphan', bytesReceived: 5000 }],
    ['in-moving', { id: 'in-moving', bytesReceived: 5000 }]
  ]);
  const part = await collectFromPC(statsEntry([byTrack], stats, prev), 2000);
  const ended = part.inbound.reduce((acc, s) => (acc[s.id] = s.ended, acc), {});
  assert.equal(ended['in-no-mid'], true, 'a mid-less stat still matches its transceiver by track');
  assert.equal(ended['in-orphan'], false, 'a stat matching no transceiver is never called dead');
  assert.equal(ended['in-moving'], false, 'bytes on the wire outrank a stale direction read');
}

async function endedStreamsDoNotFakeTunnelledMedia() {
  const collectFromPC = loadCollector();

  // Everyone left. RTCP and STUN keepalives keep transport bytes non-zero, and
  // reading the *filtered* stream count here would call that someone's media.
  const transceivers = [makeTransceiver('0', 'audio', { currentDirection: 'inactive' })];
  const stats = rtpPair('0', 5000, 5000).concat([
    { id: 'transport-1', type: 'transport', bytesReceived: 3000, bytesSent: 3000,
      dtlsState: 'connected' }
  ]);
  const prev = new Map([
    ['in-0', { id: 'in-0', bytesReceived: 5000 }],
    ['out-0', { id: 'out-0', bytesSent: 5000 }],
    ['transport-1', { id: 'transport-1', bytesReceived: 1000, bytesSent: 1000 }]
  ]);
  const part = await collectFromPC(statsEntry(transceivers, stats, prev), 2000);
  assert.ok(part.transport.inKbps > 0, 'keepalive traffic is real transport traffic');

  const model = await loadTick([part])();
  assert.equal(model.inbound.length + model.outbound.length, 0, 'every card is gone');
  assert.equal(model.viaTransport, false,
    'a call whose participants all left has ended RTP, not tunnelled media');
  assert.equal(model.zoomMediaChannels.length, 0, 'and no estimated Zoom rows appear');

  // Contrast: a report that never carried RTP at all is the real fallback case.
  const dcPart = Object.assign({}, part, { inbound: [], outbound: [] });
  const dcModel = await loadTick([dcPart])();
  assert.equal(dcModel.viaTransport, true, 'genuine zero-RTP transport fallback still works');
}

function transportOnlyQualityIsNeutral() {
  const implementation = sliceSource('function quality(m)', '/* ================================================================== *\n   * 4 — FORMATTERS');
  const exports = {};
  new Function('exports', 'C', implementation + '\nexports.quality = quality;')(
    exports,
    { muted: 'muted', good: 'good', warn: 'warn', crit: 'crit' }
  );
  assert.equal(
    exports.quality({ pcs: 1, viaTransport: true, rtt: 10, loss: null, jitter: null }).label,
    'Connected',
    'transport-only RTT is connectivity evidence, not Excellent media quality'
  );
  assert.equal(
    exports.quality({ pcs: 1, viaTransport: false, rtt: 10, loss: 0, jitter: 0 }).label,
    'Excellent',
    'RTP quality thresholds remain unchanged'
  );
}

async function counterResetsAreUnknownNotZero() {
  const collectFromPC = loadCollector();
  const prev = new Map([
    ['in-1', { id: 'in-1', bytesReceived: 5000000, packetsLost: 0, packetsReceived: 4000 }],
    ['out-1', { id: 'out-1', bytesSent: 3000000 }]
  ]);
  const stats = [
    { id: 'in-1', type: 'inbound-rtp', kind: 'video', ssrc: 71,
      bytesReceived: 1000, packetsLost: 0, packetsReceived: 10 },
    { id: 'out-1', type: 'outbound-rtp', kind: 'video', ssrc: 72, bytesSent: 500 }
  ];
  const entry = {
    key: 9,
    pc: { connectionState: 'connected', getStats: async () => stats },
    prev,
    t: 1000
  };
  const part = await collectFromPC(entry, 2000);
  // The transport path already nulled resets; the per-stream path rendered
  // them as a proven "0 kbps" and summed the negative into the totals.
  assert.equal(part.inbound[0].kbps, null, 'reset inbound counter is unknown, not zero');
  assert.equal(part.outbound[0].kbps, null, 'reset outbound counter is unknown, not zero');
}

async function provenZeroJitterStaysZero() {
  const zero = await loadTick([
    emptyPart([{ id: 'a', kbps: 100, jitter: 0, lossLost: null, lossTotal: null }])
  ])();
  assert.equal(zero.jitter, 0, 'a measured 0 ms jitter is a zero, not no-evidence');
  const none = await loadTick([
    emptyPart([{ id: 'b', kbps: 100, jitter: null, lossLost: null, lossTotal: null }])
  ])();
  assert.equal(none.jitter, null, 'no jitter stat at all is still the em dash');
}

async function announcedGroupsSurviveThePreMediaWindow() {
  // msid groups can be announced in the SDP before their media flows — at a
  // join, or when a renegotiation adds a participant. A tick in that window
  // wiped the mapping and the SDP-text cache blocked re-parsing for the rest
  // of the call, which silently killed detached-audio naming.
  const sdp = 'v=0\r\nm=audio 9 X\r\na=msid:streamS trackA\r\n' +
    'm=video 9 X\r\na=msid:streamS trackV\r\n';
  const part = emptyPart([]);   // SDP set, media not started
  const tick = loadTick([part], { pc: { remoteDescription: { sdp } } });
  await tick();
  assert.deepEqual(Object.keys(tick.trackGroups), [],
    'a group with no live track is pruned (names must not outlive people)');
  part.inbound = [{ id: 'in-a', kind: 'audio', dir: 'in', track: 'trackA',
    kbps: 40, jitter: null, lossLost: null, lossTotal: null }];
  await tick();
  assert.equal(tick.trackGroups['trackA'], '1:streamS',
    'the cleared SDP cache lets the next tick re-harvest the announced group');
  assert.equal(tick.trackGroups['trackV'], '1:streamS',
    'the sibling in the same live group is harvested with it');
}

async function quietNeedsProofAndReversesInstantly() {
  const part = emptyPart([{ id: 'in-q', kind: 'video', dir: 'in', track: 't-q',
    kbps: 0, jitter: null, lossLost: null, lossTotal: null }]);
  const tick = loadTick([part]);
  let m = await tick();
  assert.equal(m.inbound[0].quiet, false, 'one proven-zero sample is not proof');
  m = await tick();
  assert.equal(m.inbound[0].quiet, false, 'two proven-zero samples are not proof');
  m = await tick();
  assert.equal(m.inbound[0].quiet, true, 'three consecutive proven zeros are');
  assert.equal(m.quietStreams, 1, 'the model counts what the panel hides');
  part.inbound[0].kbps = null;
  m = await tick();
  assert.equal(m.inbound[0].quiet, true,
    'an unknown sample holds the standing verdict — it proves nothing either way');
  part.inbound[0].kbps = 12;
  m = await tick();
  assert.equal(m.inbound[0].quiet, false, 'bytes on the wire return the card immediately');
  assert.equal(m.quietStreams, 0);
  // A first-sample unknown rate must not read as quiet: nothing is proven yet.
  const unknown = await loadTick([
    emptyPart([{ id: 'in-u', kind: 'audio', dir: 'in', track: 't-u',
      kbps: null, jitter: null, lossLost: null, lossTotal: null }])
  ])();
  assert.equal(unknown.inbound[0].quiet, false, 'unknown is visible, never hidden');
  // The app switching a sender off is positive proof with no waiting period.
  const offPart = emptyPart([]);
  offPart.outbound = [{ id: 'out-q', kind: 'video', dir: 'out', track: 't-o',
    kbps: 0, senderOff: true, jitter: null }];
  const off = await loadTick([offPart])();
  assert.equal(off.outbound[0].quiet, true, 'a switched-off sender is proof at once');
}

(async () => {
  await packetWeightedInboundLoss();
  console.log('PASS packet-weighted inbound aggregate loss');
  await authoritativeSelectedCandidatePair();
  console.log('PASS transport-selected candidate pair is authoritative');
  await zoomTransportNullAndResetSemantics();
  console.log('PASS Zoom transport null/reset semantics');
  transportOnlyQualityIsNeutral();
  console.log('PASS transport-only quality is neutral');
  await endedStreamsLeaveTheList();
  console.log('PASS ended streams leave the list');
  await quietStreamsSurviveWithoutProof();
  console.log('PASS quiet streams survive without proof of death');
  await unmatchableAndMovingStreamsFailClosed();
  console.log('PASS unmatchable and still-moving streams fail closed');
  await endedStreamsDoNotFakeTunnelledMedia();
  console.log('PASS ended streams do not fake tunnelled media');
  await counterResetsAreUnknownNotZero();
  console.log('PASS counter resets are unknown, not zero');
  await provenZeroJitterStaysZero();
  console.log('PASS proven zero jitter stays zero');
  await announcedGroupsSurviveThePreMediaWindow();
  console.log('PASS announced msid groups survive the pre-media window');
  await quietNeedsProofAndReversesInstantly();
  console.log('PASS quiet needs proof and reverses instantly');
  console.log('stats-unit: all checks passed');
})().catch(error => {
  console.error('stats-unit: FAIL');
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
