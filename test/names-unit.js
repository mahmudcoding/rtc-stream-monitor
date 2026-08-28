#!/usr/bin/env node
// Unit guard for the participant-name cleaner.
//
// Live testing on airion-cargo.store found every local card titled "Your video"
// — the aria-label Aloqa puts on the local <video>. NAME_JUNK only matched
// single words, so a two-word control label passed as a person's name, and
// because attributes are checked before tile text it beat the real name
// ("Test2 (you)") sitting one level up.
//
// This extracts the real cleaner out of src/ and asserts it, so the rule can't
// regress without a failing test.
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.resolve(__dirname, '../src/rtc-stream-monitor.js'), 'utf8');
const start = src.indexOf('var NAME_ATTRS');
const end = src.indexOf('function receiverLevels');
if (start < 0 || end < 0) { console.error('FAIL: could not locate the name cleaner in src/'); process.exit(1); }

const sandbox = {};
new Function('exports', src.slice(start, end) +
  '\nexports.cleanName = cleanName; exports.participantName = participantName;' +
  ' exports.nameFromDescendants = nameFromDescendants;' +
  ' exports.documentParticipantName = documentParticipantName;' +
  ' exports.airionNamesByIdentity = airionNamesByIdentity;' +
  ' exports.participantFromAudioStreamKey = participantFromAudioStreamKey;' +
  ' exports.airionDetachedMediaName = airionDetachedMediaName;' +
  ' exports.mediaElementParticipantName = mediaElementParticipantName;')(sandbox);
const cleanName = sandbox.cleanName;

const REJECT = [
  'Your video', 'your video', 'My camera', 'Self view', 'Screen share',
  'Local video preview', 'video', 'Audio', 'Camera', 'participant',
  'Your screen share', 'remote video', 'the stream', '00:14', '42%',
  // all observed live on airion-cargo.store
  'Participant video', 'Excellent connection', 'Poor connection',
  'Guest', 'Raised hand', 'Speaking',
  'Call participants', 'Call participantsCall participants', 'Participant actions for Test2',
  'Участники звонка', 'Ваше видео', 'Видео участника', 'Действия участника Test2',
  // Google Meet pre-join aria-labels: capture state, never participant identity
  'Предварительный просмотр видео включен', 'Предварительный просмотр видео выключен',
  'Предварительный просмотр видео включён', 'Предпросмотр камеры: выключена',
  'Video preview enabled', 'Camera preview is off',
  'Qoʻngʻiroq qatnashchilari', 'Sizning videongiz', 'Qatnashchi videosi',
  'Test2 ishtirokchi amallari', 'Қўнғироқ қатнашчилари', 'Сизнинг видеонгиз',
  'Қатнашчи видеоси', 'Test2 иштирокчи амаллари',
  // material icon ligatures, which render as text inside Meet's tiles
  'more_vert', 'frame_person', 'visual_effects', 'mic_off'
];
const KEEP = [
  ['Test2 (you)', 'Test2 (you)'],
  ['Test2 (вы)', 'Test2 (вы)'],
  ['Test2 (siz)', 'Test2 (siz)'],
  ['Test2 (сиз)', 'Test2 (сиз)'],
  ['Mahmud Nosirov', 'Mahmud Nosirov'],
  ['Виктор Просмотров', 'Виктор Просмотров'], // reject the complete preview phrase, not Russian words
  ['qwerGuest', 'qwer'],
  ['Mahmud, muted', 'Mahmud'],
  ['Anna (presenting)', 'Anna'],
  ['Ruslan Staging', 'Ruslan Staging'],
  ['Video Rodriguez', 'Video Rodriguez'],   // real surname-ish: not all-junk
  ['Cameron', 'Cameron'],                   // must not be eaten by /camera/
  ['Guest TesterGUEST', 'Guest Tester'],    // live: caps badge glued to the name
  ['Mark Strong', 'Mark Strong'],           // "strong" is a junk word, the name is not
  // live on Google Meet: name rendered twice with an icon ligature glued on
  ['Mahmud NosirovMahmud Nosirovdevices', 'Mahmud Nosirov'],
  ['AnnaAnna', 'Anna'],
  ['Bob', 'Bob'],                           // too short to be mistaken for a doubling
  ['Ann Lee', 'Ann Lee']
];

let failed = 0;
for (const s of REJECT) {
  const got = cleanName(s);
  if (got !== null) { console.error(`FAIL reject ${JSON.stringify(s)} -> ${JSON.stringify(got)}`); failed++; }
}
for (const [input, want] of KEEP) {
  const got = cleanName(input);
  if (got !== want) { console.error(`FAIL keep   ${JSON.stringify(input)} -> ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); failed++; }
}

// Airion's stable tile/name hooks must win over its generic localized media,
// network-status and participant-action labels.
const airionName = { textContent: 'Test2 (you)', getAttribute: () => null };
const airionTile = { querySelector: s => s === '[data-testid="participant-name"]' ? airionName : null };
const airionVideo = {
  tagName: 'VIDEO', parentElement: null,
  closest: s => s === '[data-testid="participant-tile"]' ? airionTile : null
};
const airionGot = sandbox.participantName(airionVideo, false);
if (airionGot !== 'Test2 (you)') {
  console.error(`FAIL Airion tile hook -> ${JSON.stringify(airionGot)}`); failed++;
}

// "Guest" is normally too generic to trust when it comes from arbitrary text
// or an aria-label (it is very often only a role badge).  On Airion, however,
// data-testid="participant-name" is the product's authoritative display-name
// field and a guest may genuinely have the one-word display name "Guest".
// Keep the generic cleanName("Guest") rejection above, but require the stable
// Airion hook to preserve it as an identity.
const airionGuestName = { textContent: 'Guest', getAttribute: () => null };
const airionGuestTile = { querySelector: s => s === '[data-testid="participant-name"]' ? airionGuestName : null };
const airionGuestVideo = {
  tagName: 'VIDEO', parentElement: null,
  closest: s => s === '[data-testid="participant-tile"]' ? airionGuestTile : null
};
const airionGuestGot = sandbox.participantName(airionGuestVideo, false);
if (airionGuestGot !== 'Guest') {
  console.error(`FAIL Airion authoritative Guest name -> ${JSON.stringify(airionGuestGot)}`); failed++;
}

// Airion's detached audio is linked by exact React component contracts, not by
// MediaStream.id (track.attach(video) gives video a random stream id). Synthetic
// Fiber chains model the live ParticipantTile and RemoteAudioElement props.
function fiberNode(propsChain, host) {
  let fiber = null;
  for (let i = propsChain.length - 1; i >= 0; i--) fiber = { memoizedProps: propsChain[i], return: fiber };
  Object.defineProperty(host, '__reactFiber$test', { value: fiber });
  return host;
}
function identityTile(name, remoteParticipantId, participant) {
  const label = { textContent: name, getAttribute: () => null };
  return fiberNode([
    { remoteParticipantId }, { participant }
  ], { querySelector: s => s === '[data-testid="participant-name"]' ? label : null });
}
const guestIdentity = 'guest:G_AIRION_GUEST';
const test5Identity = 'U_AIRION_TEST5';
const guestIdentityTile = identityTile('Guest', guestIdentity, {
  user_id: 'G_AIRION_GUEST', is_guest: true
});
const test5IdentityTile = identityTile('Test5', test5Identity, {
  user_id: test5Identity, is_guest: false
});
const oldAirionDocument = global.document;
global.document = { querySelectorAll: () => [guestIdentityTile, test5IdentityTile] };
const airionNames = sandbox.airionNamesByIdentity();
global.document = oldAirionDocument;
if (airionNames[guestIdentity] !== 'Guest' || airionNames[test5Identity] !== 'Test5') {
  console.error(`FAIL Airion Fiber tile identities -> ${JSON.stringify(airionNames)}`); failed++;
}
function detachedAudio(streamKey) {
  const stream = {};
  return fiberNode([
    {}, { streamKey, stream }
  ], {
    srcObject: stream,
    getAttribute: attr => attr === 'data-testid' ? 'remote-audio-sink' : null
  });
}
const guestAudioGot = sandbox.airionDetachedMediaName(
  detachedAudio(`primary:${guestIdentity}:microphone:TR_guest`), airionNames
);
if (guestAudioGot !== 'Guest') {
  console.error(`FAIL Airion Guest detached audio -> ${JSON.stringify(guestAudioGot)}`); failed++;
}
const test5AudioGot = sandbox.airionDetachedMediaName(
  detachedAudio(`breakout:${test5Identity}:screen-audio:TR_test5`), airionNames
);
if (test5AudioGot !== 'Test5') {
  console.error(`FAIL Airion Test5 detached audio -> ${JSON.stringify(test5AudioGot)}`); failed++;
}
const auxiliaryGot = sandbox.participantFromAudioStreamKey(
  `auxiliary:${guestIdentity}:screen_share_audio:TR_aux`
);
if (auxiliaryGot !== guestIdentity) {
  console.error(`FAIL Airion auxiliary streamKey -> ${JSON.stringify(auxiliaryGot)}`); failed++;
}
const malformedAudioGot = sandbox.participantFromAudioStreamKey(
  `primary:${guestIdentity}:camera:TR_wrong`
);
if (malformedAudioGot !== null) {
  console.error(`FAIL Airion malformed streamKey -> ${JSON.stringify(malformedAudioGot)}`); failed++;
}
const unknownAudio = detachedAudio('primary:unknown-user:microphone:TR_unknown');
unknownAudio.parentElement = {
  textContent: 'Test2 (you)', parentElement: null, getAttribute: () => null,
  querySelectorAll: () => []
};
const unknownAudioGot = sandbox.mediaElementParticipantName(
  unknownAudio, false, 'audio', airionNames
);
if (unknownAudioGot !== null) {
  console.error(`FAIL Airion unknown audio must fail closed -> ${JSON.stringify(unknownAudioGot)}`); failed++;
}

function leaf(text, blocked) {
  return { textContent: text, children: [], closest: () => blocked ? {} : null };
}
function container(children) { return { querySelectorAll: () => children }; }
const meetGot = sandbox.nameFromDescendants(container([
  leaf('Кадрировать', true), leaf('Mahmud Nosirov'), leaf('Mahmud Nosirov')
]));
if (meetGot !== 'Mahmud Nosirov') {
  console.error(`FAIL Meet duplicated visible name -> ${JSON.stringify(meetGot)}`); failed++;
}
const cropGot = sandbox.nameFromDescendants(container([
  leaf('Кадрировать'), leaf('Кадрировать')
]));
if (cropGot !== null) {
  console.error(`FAIL Meet crop control -> ${JSON.stringify(cropGot)}`); failed++;
}

const meetParent = {};
const oldDocument = global.document;
global.document = { querySelectorAll: () => [
  Object.assign(leaf('Mahmud Nosirov'), { parentElement: meetParent }),
  Object.assign(leaf('Mahmud Nosirov'), { parentElement: meetParent }),
  Object.assign(leaf('Кадрировать'), { parentElement: meetParent })
] };
const previewVideo = {
  tagName: 'VIDEO', parentElement: null, srcObject: null,
  closest: () => null,
  getAttribute: name => name === 'aria-label' ? 'Предварительный просмотр видео включен' : null
};
const meetPreviewGot = sandbox.participantName(previewVideo, true);
if (meetPreviewGot !== 'Mahmud Nosirov') {
  console.error(`FAIL Meet Russian preview fallback -> ${JSON.stringify(meetPreviewGot)}`); failed++;
}
const meetDocumentGot = sandbox.documentParticipantName();
global.document = oldDocument;
if (meetDocumentGot !== 'Mahmud Nosirov') {
  console.error(`FAIL Meet document fallback -> ${JSON.stringify(meetDocumentGot)}`); failed++;
}

// --- the participants list names people the grid is not showing -----------
// Aloqa caps its tile grid and paginates (`participant-grid-cap-reason`,
// `participant-grid-next-page`), so in a large call most participants have no
// tile and a tile-only map left their audio reading "Audio · 3308". The people
// panel lists everyone: each `participant-row` carries the owner id in React
// props and the display name in its avatar's aria-label. Shapes measured live.
function participantRow(name, initials, userId, isGuest) {
  const avatar = { getAttribute: a => (a === 'aria-label' ? name : null) };
  const initialsLeaf = { children: [], textContent: initials };
  return fiberNode([{}, { row: { userId } }], {
    querySelector: sel =>
      sel === '[data-testid="participant-row-guest-badge"]' ? (isGuest ? {} : null) : null,
    querySelectorAll: sel => (sel === '[aria-label]' ? [avatar]
      : sel === 'span,div' ? [initialsLeaf] : [])
  });
}
const offGridRow = participantRow('Off Grid', 'OG', 'G_OFFGRID', true);
// Deliberately disagrees with the tile below, so "the tile wins" is actually
// exercised rather than being true by coincidence.
const listedTest5Row = participantRow('Stale Test5', 'T5', test5Identity, false);
const oldListDocument = global.document;
global.document = { querySelectorAll: sel =>
  sel === '[data-testid="participant-row"]' ? [offGridRow, listedTest5Row]
  : String(sel).indexOf('participant-tile') >= 0 ? [test5IdentityTile] : [] };
const listNames = sandbox.airionNamesByIdentity();
global.document = oldListDocument;

// The person with no tile is nameable purely from the list.
if (listNames['guest:G_OFFGRID'] !== 'Off Grid') {
  console.error(`FAIL participants-list off-grid name -> ${JSON.stringify(listNames)}`); failed++;
}
// The avatar's aria-label is the name; its text is only the initials.
if (listNames['guest:G_OFFGRID'] === 'OG') {
  console.error('FAIL participants-list picked avatar initials over the name'); failed++;
}
// A rendered tile is the participant's own media and overrules a list row that
// disagrees — neither dropping the id as a conflict nor keeping the stale name.
if (listNames[test5Identity] !== 'Test5') {
  console.error(`FAIL tile must win over its list row -> ${JSON.stringify(listNames)}`); failed++;
}
// And the whole point: detached audio for someone with no tile resolves.
const offGridAudio = sandbox.airionDetachedMediaName(
  detachedAudio('primary:guest:G_OFFGRID:microphone:TR_offgrid'), listNames
);
if (offGridAudio !== 'Off Grid') {
  console.error(`FAIL off-grid detached audio -> ${JSON.stringify(offGridAudio)}`); failed++;
}
// A row that proves no owner id names nobody, rather than guessing by position.
const anonymousRow = fiberNode([{}, {}], {
  querySelector: () => null, querySelectorAll: () => []
});
global.document = { querySelectorAll: sel =>
  sel === '[data-testid="participant-row"]' ? [anonymousRow] : [] };
const anonNames = sandbox.airionNamesByIdentity();
global.document = oldListDocument;
if (Object.keys(anonNames).length !== 0) {
  console.error(`FAIL row without an owner id must name nobody -> ${JSON.stringify(anonNames)}`); failed++;
}

const total = REJECT.length + KEEP.length + 17;
console.log(failed ? `names-unit: ${failed}/${total} FAILED` : `names-unit: ${total}/${total} passed`);
process.exit(failed ? 1 : 0);
