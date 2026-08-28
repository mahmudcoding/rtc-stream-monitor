# RTC Stream Monitor — project handoff

**Read this file first.** It is the complete context for a new session. Everything
below happened in a prior conversation; nothing here needs to be rediscovered.

---

## 1. What this is

A zero-dependency JavaScript overlay that inspects **every audio and video stream a
browser is sending and receiving** on compatible WebRTC pages, and renders it as a
live, draggable dark panel in the top-right of the page. Google Meet support requires
the packaged Chrome extension's persistent debugger capture path; the standalone
launcher and bookmarklet cannot capture Meet.

It was built for Mahmud, who asked: *"I want to know full details about all audio
video streams I am receiving and sending."* It started as a one-off injection into a
live call and grew into a packaged Chrome extension.

Current version: **1.7.1**. The default view shows **only active streams**: a card
whose stream is provably carrying no media right now — three consecutive proven-zero
samples, or a sender the app itself switched off — leaves the default view, and the
section header counts it (`+2 quiet`) with a one-click toggle that reveals the quiet
cards complete with their `camera off` / `microphone off` / `idle` / `quiet` markers.
Nothing is removed: the model, JSON dump, history and name memory keep every quiet
stream, an unknown rate is never treated as quiet, and one byte on the wire brings the
card back instantly. A stream card is *removed* only once the transceiver proves its
media ended, so a participant who left the call no longer lingers as a frozen 0 kb/s
stream. A card also keeps
the participant name it proved once the tile it read that name from is unmounted, and
detached audio takes the name proved for its own video, so cards stop falling back to
`Video · 6273` mid-call. Media rendered inside open shadow roots is discovered too,
the panel remembers where you dragged and resized it per site, and drag/resize work
by touch. It retains the
live-validated Aloqa/Airion and Meet paths, including the narrow Meet-only `(likely)`
approximation for detached inbound-audio names. Zoom capture still uses a tiny MAIN-world shim at `document_start` in the inner
PWA meeting frame, without `chrome.debugger`. In Zoom's live-validated DataChannel mode,
only the exact audio/video media labels may produce one meeting-wide Audio row and one
meeting-wide Video row, each marked `(estimated)` and showing both receive and send
directions. They are channel estimates, not participant or RTP streams, and make no
participant, codec, loss, jitter, resolution or fps claim. Unknown first-sample rates
remain `—`, proven zero-rate directions read `idle`, reset/inactive evidence stays
hidden, transport-only quality remains neutral `Connected`, and raw DataChannel cards
remain hidden. Aloqa/Airion's exact LiveKit/React mapping and Meet's
debugger/queryObjects path are unchanged.

### What the panel shows

| Region | Content |
|---|---|
| Hero | Round-trip time in ms, quality rating (Excellent/Good/Fair/Poor) with a 4-bar icon, ICE path (direct LAN / direct STUN / TURN relay) |
| Stat tiles | Receiving bitrate, Sending bitrate, Packet loss, Jitter — loss and jitter carry a status word (ok / elevated / high) |
| Chart | 90-second throughput, two series (blue = received, orange = sent), hover crosshair + tooltip, arrow-key navigation, and a `table` toggle for a text equivalent |
| Sending / Receiving | One card per **active** RTP stream: participant name, codec, resolution, fps, bitrate + sparkline, packet loss, jitter, dropped frames, freeze count. Audio cards show a live level meter. `▾` expands to the complete raw stats dump. Streams provably carrying no media are hidden behind a `+N quiet` toggle in the section header — never silently, and never on an unknown rate |
| Zoom media channels | On an exact Zoom web-client route with zero RTP, one meeting-wide Audio channel and one meeting-wide Video channel `(estimated)` row from the exact Web Client media DataChannel labels. Each says `all participants`; duplicate labels say `N channels combined`; ↓/↑ preserve both channel directions rather than representing participant streams. Unknown first-sample rates stay `—`, proven zero rates read `idle`, reset/inactive evidence stays hidden, and transport-only quality is neutral `Connected` |
| Transport | Local/remote candidate types, network type, uplink bandwidth estimate, total bytes on the wire, DTLS state |
| Warnings | Encoder quality limitation (bandwidth vs CPU), with an explanation of what to do |

Data-channel stats are collected internally for transport-only apps and the copied JSON
dump. Raw channel names, cards and message counts are never rendered. Only the two exact
Zoom media labels may produce the meeting-wide kind-level estimates described above;
unknown/control labels, unused channels, counter resets, RTP hybrids and non-Zoom
evidence fail closed. A positive cumulative counter can prove a real first sample while
its unknown delta remains `—`; a zero delta becomes `idle` only after prior activity is
proven.

Header controls: `⧉` copies a full JSON stats dump to the clipboard, `—` minimises,
`✕` removes. Drag the header to move, drag the bottom-left corner to resize.

Console API: `window.__rtcStreamMonitor__` →
`{ adopt(), rescan(), dump(), stop(), model, version }`. Re-running the script
toggles the panel when the same version is already running; a NEWER version stops
the stale instance and starts in its place (see 1.7.0 notes).

---

## 2. Files in this folder

```
src/rtc-stream-monitor.js      THE SOURCE OF TRUTH. Readable, commented.
                               Everything else is generated from this file.

extension/                     Unpacked Chrome extension (MV3). Load this directly via
                               chrome://extensions → Developer mode → Load unpacked.
  manifest.json                v1.7.1, permissions: scripting + activeTab +
                               debugger + alarms + storage (the last two drive
                               the auto-update check; see section 5b)
  background.js                Normal MAIN-world injection plus the persistent Meet
                               debugger/preload/queryObjects lifecycle
  rtc-early-capture.js         Zoom-only document-start constructor capture shim
  monitor.js                   copy of src/rtc-stream-monitor.js
  icons/icon128.png

dist/
  stream-monitor-extension.zip Zipped extension, what was delivered to the user
  rtc-stream-monitor.min.js    esbuild-minified bundle
  stream-monitor-launcher.html Standalone launcher page for compatible sites such as
                               Airion (not Meet): copy button + bookmarklet.
  make-launcher.js             Regenerates the launcher from src + min

scripts/
  release.mjs                  Cut a release: bump every version marker, rebuild,
                               run the suites, tag, publish the zip to GitHub
  install-agent.sh             Install (or --uninstall) the launchd agent that
                               keeps an unpacked checkout auto-updating

NEW-SESSION-PROMPT.md          Paste-in opener for a fresh session: current state,
                               what is deliberate, and what to pick up next

extension-dev/                 Dev-only auto-inject build. Same monitor.js, but a
                               manifest with content_scripts (world MAIN) on the
                               live-test hosts, so no toolbar click is needed.
                               Chrome no longer honours --load-extension, so this
                               must be added via Load unpacked and reloaded from
                               chrome://extensions after every build (Chrome caches
                               unpacked files). Codex can do this with Computer Use.
  probe-isolated.js            Diagnostic: stamps data-rtcmon-isolated on <html>
                               from the ISOLATED world, which distinguishes "no
                               content script here" from "MAIN world refused"

test/
  harness.html                 Real WebRTC test page. RTP, guest, exact Airion,
                               guarded Meet-slot, DataChannel, participant
                               departure, tile churn, camera off/on and
                               shadow-DOM fixture modes
  run.js                       Playwright suite, 132 checks across 27 browser runs
                               reported under 21 scenario groups
  names.js                     Focused probe: dumps card titles per section
  net.js                       Checks sandbox egress to meeting services
  names-unit.js                81 dependency-free name-resolution assertions,
                               including Airion EN/RU/UZ labels and Meet fallbacks
  background-unit.js           18 dependency-free extension lifecycle scenarios
  stats-unit.js                12 dependency-free scenarios: loss / ICE / transport /
                               quality, stream-liveness, counter resets, jitter-zero,
                               msid-group healing and quiet hysteresis
  zoom-media-unit.js           Zoom route, label, activity, reset, grouping and UI
                               wording guards
  launcher-unit.js             Guards the Meet extension-only support boundary
  update-unit.js               6 auto-update scenarios: numeric version compare,
                               badge only on a real update, private/offline/garbage
                               feeds claiming nothing, once-per-start reload
  cdp.js                       Zero-dependency CDP driver for a THROWAWAY Chrome
                               (own --user-data-dir, fake capture devices). Used
                               to put a real second participant into a call
  serve.js                     Loopback file server. Kept for reference; Chrome
                               151 gates public->loopback behind the
                               local-network-access permission, so pages cannot
                               actually fetch from it (see section 7)

screenshots/                   Rendered output from the test suite and launcher page
```

---

## 3. Architecture of `src/rtc-stream-monitor.js`

Single IIFE, no build step required to run. Re-running it toggles the panel
(`window.__rtcStreamMonitor__` guard at the top).

### Section 1 — Peer connection capture

The hard problem: the app's `RTCPeerConnection` objects usually live in closures the
script can't reach, and the call is often **already running** when the user clicks.
Four strategies run together:

1. **Constructor wrap.** `window.RTCPeerConnection` is replaced with a wrapper that
   registers every new instance. Catches everything if injected before the call starts.
2. **Prototype hooks.** `getStats`, `getSenders`, `addIceCandidate`, `setRemoteDescription`
   etc. plus the `connectionState` / `iceConnectionState` getters are patched to register
   `this`. Catches live connections as soon as the app touches them.
3. **Deep scan.** BFS over `window` (depth 5, 15k nodes), and if that finds nothing, over
   React/Vue fiber trees harvested from `__reactContainer$` / `__reactFiber$` /
   `__vue_app__` keys (depth 7, 45k nodes), looking for `instanceof RTCPeerConnection`.
4. **Debugger heap adoption (Meet).** Both release and dev builds keep one persistent
   `chrome.debugger` session per armed Meet tab, install a guarded document-start
   preload, and use protocol-level `Runtime.queryObjects` to pass otherwise unreachable
   connections into `adopt()`. A serialized poll runs for the tab session, so a later
   or replacement connection is captured too. The one required reload is guarded
   against concurrent completion events; close, navigation, cancellation and extension
   suspension remove preload registrations and detach cleanly.
5. **Document-start stash (Zoom).** Zoom's `/wc/...` PWA shell embeds the real meeting
   in a same-origin `/<meeting-number>/(start|join)?from=pwa` frame. A Zoom-only shim
   wraps that frame's constructor at `document_start`, records instances made before
   `monitor.js`, and emits future instances. Empty outer-shell panels remain hidden.

Strategy 3 worked on the historical Airion live call. Strategy 4 is required by Meet,
whose constructor/prototype are frozen and whose instances stay outside page-script reach.
Strategy 5 is required by Zoom because its two live peer connections are created in the
inner PWA frame before a normal document-end injection can observe them. Zoom uses the
ordinary scripting path: it does not reload the page, attach a debugger, or query the heap.
The standalone launcher and bookmarklet can only run the page script, so they work on
compatible sites such as `airion-cargo.store` but not on Meet. Use the Chrome extension
for Meet.

### Section 2 — Stats collection

`pc.getStats()` every 1000 ms per connection. Previous report is kept per connection so
rates are computed as deltas. Handles `inbound-rtp`, `outbound-rtp`, `remote-inbound-rtp`
(gives RTT and loss the far end reports about our outbound), `candidate-pair`, `codec`,
`media-source`, `transport`, `data-channel`.

Aggregate inbound loss is packet-weighted, so an idle SFU layer cannot dominate busy
video. ICE details follow `transport.selectedCandidatePairId`; a selected/nominated pair
is only a fallback when the transport does not expose that authoritative ID.

Also reads the DOM: every `<video>`/`<audio>` element's `srcObject` tracks give device
labels, capture settings, and `getVideoPlaybackQuality()` for rendered fps and dropped
frames. This layer works even before any peer connection is captured.

Remote audio levels come from `receiver.getSynchronizationSources()` when available,
falling back to `inbound-rtp.audioLevel`.

### Section 3–4 — Model and formatting

Aggregates all connections into one model per tick, computes quality rating from
RTT + loss + jitter thresholds, keeps 90 samples of history for the chart and 40 per
stream for sparklines.

### Section 5–7 — UI

Rendered into a **shadow DOM** (`mode: 'open'`) so the host page's CSS can't touch it and
vice versa. Two-tier rendering:

- `buildSkeleton()` runs only when the *structure* changes (a stream appears/disappears,
  the table toggle flips). Guarded by a `signature()` string.
- `update()` runs every tick and writes values into `[data-u=...]` slots in place.

This matters: a full `innerHTML` replace at 1 Hz would destroy scroll position, text
selection, and hover state every second.

Minimising suppresses paint only; stats collection and Meet adoption continue. Closed
peer connections and their stream/card history are pruned, and `stop()` removes global
mouse/wheel listeners and restores only prototype hooks still owned by the monitor.

### Design system

Colours follow a validated dark palette on surface `#1a1a19`. Categorical slot 1 (blue
`#3987e5`) always means **incoming**, slot 2 (orange `#d95926`) always means **outgoing** —
never reassigned by rank. Status colours (`#0ca30c` good, `#fab219` warning, `#d03b3b`
critical) are reserved for state and always ship with an icon or word, never colour alone.
Marks: 2 px lines, 4 px end dots with a 2 px surface ring, area fills at 10 % opacity,
hairline solid axes. One hero figure per view (the RTT). `tabular-nums` only in columns,
never on the big number.

---

## 4. Bugs found and fixed — do not regress these

Each of these was a real defect discovered against live or simulated traffic.

| # | Symptom | Root cause | Fix |
|---|---|---|---|
| 1 | Panel body wouldn't scroll; content below the fold unreachable | Flex child defaults to `min-height: auto`, so it grew to fit content and got clipped by the parent's `overflow: hidden` | `min-height: 0` on `.bd` (+ `overscroll-behavior: contain`) |
| 2 | Still wouldn't scroll after fix 1 | **The call app registers a global `wheel` handler and calls `preventDefault()` on every event** (for participant-grid paging). The browser never scrolled anything | Own `wheel` listener on `window` (capture, non-passive) + on the panel. Finds the nearest scrollable element in `composedPath()` and moves `scrollTop` manually |
| 3 | Guest names read "qwerGuest" | A role badge element sits inside the tile, so `textContent` concatenated it onto the name | Strip a role word glued to the end of a name without a space |
| 4 | All stream cards read "Video" on apps other than the user's | Name detection only scraped visible text; most apps put the name in `aria-label` | Check `aria-label` and participant-name data attributes on the tile/nested nodes first, reject controls and generic UI labels, then fall back to nearby text |
| 5 | **Sending cards never got a name, on any app** | Chrome does not expose `trackIdentifier` on `outbound-rtp`; it lives on the linked `media-source` stat | Follow `s.mediaSourceId` → `media-source.trackIdentifier` |
| 6 | Zoom web showed connected peer connections but no media breakdown — looked broken | In the live Zoom Web App call, both captured connections exposed the exact `ZoomWebclientAudioDataChannel` / `ZoomWebclientVideoDataChannel` labels and aggregate transport counters, with no `inbound-rtp` or `outbound-rtp` rows to map to people | Keep transport as the authoritative wire total. On an exact Zoom web-client route only, group those two exact active labels into audio/video `(estimated)` all-participant subtotals with both directions and source count. Keep raw DataChannel stats dump-only and never invent per-person, codec, loss, jitter or frame claims |
| 7 | Embedded calls (Meet/Jitsi in an iframe) invisible | Script only injected into the top frame | `allFrames: true`; sub-frames start hidden and remove themselves if they find no media within ~7 s |
| 8 | Panel throws on its first paint on any site sending `require-trusted-types-for 'script'` | The renderer is built on `innerHTML` — 12 assignment sites against a single `createElement`. Trusted Types rejects every one | `trust()` helper registering a `trustedTypes` policy named `rtc-stream-monitor`, cached on `window` so the toggle path doesn't hit the duplicate-name error. Falls back to the page's default policy, then to the raw string |
| 9 | **Bug 5 was never actually fixed.** Every local card read `Your video`, not `Test2 (you)` | `NAME_JUNK` matched only *single* words, so the two-word control label `Your video` passed as a person's name — and attributes are checked before tile text, so it won every time | `NAME_JUNK_WORD` + `allJunkWords()`: reject any label built only from media/status words. Also made the glued-badge stripper case-insensitive, so `Guest TesterGuest` → `Guest Tester` |
| 12 | Every card on Meet fell back to its SSRC, and Meet's three simulcast encodings read as three dead video streams | The container guard from bug 10 counted *elements*, but Meet paints one participant into two `<video>`s sharing a track plus an empty placeholder — so the climb stopped inside the tile. Meet also sets no `rid`, and its tile text is the name doubled with an icon ligature glued on | Guard now compares **track identity**, not element count, and skips track-less placeholders; `dedupeDoubled()` recovers "Mahmud Nosirov" from "Mahmud NosirovMahmud Nosirovdevices"; icon ligatures (`more_vert`) are rejected; encodings sharing a track are numbered `layer n/N` and quiet ones marked `idle` |
| 11 | The whole monitor died on Google Meet before any of it ran | The prototype-hook loop assigned `NativePC.prototype[m] = ...` directly. Meet defines those methods non-writable, so the first one threw `Cannot assign to read only property 'getStats'` — and because that block sits near the top of the IIFE, one throw took everything down | Each hook is attempted individually inside try/catch and via `defineProperty`, honouring the existing descriptor. A method that cannot be hooked costs one capture route, not the tool |
| 10 | After fixing 9 the resolver returned `Excellent connection`, then `Call participants` | It climbs ancestors taking any `aria-label`, so grid and badge labels leak in. The 40-char text guard does not catch a grid either — two short names (`Guest TesterGuestTest2 (you)`) are only 28 characters | Structural stop: break as soon as an ancestor holds more than one of the starting element's own kind (`video`/`audio`). A tile holds one, the grid holds several |

### 1.6.1 hardening

- Meet support is now symmetric in release and dev: one persistent debugger session,
  one reload after arming, serialized setup, session-long replacement polling, toolbar
  toggling over the owned session, and complete cleanup on close/navigation/cancel.
- Airion names prefer its stable `participant-tile` / `participant-name` hooks and reject
  localized grid, media, status and action labels in English, Russian, Uzbek Latin and
  Uzbek Cyrillic. Meet local-video fallback accepts a unique repeated person-like name
  while excluding controls such as Crop.
- Aggregate loss is packet-weighted and the selected ICE pair follows the transport's
  authoritative ID. Collection continues while minimised; closed PCs, stale stream
  history and expanded-card state are pruned; `stop()` restores owned hooks/listeners.

### 1.6.2 Airion inbound-name fix

- Airion's authoritative `[data-testid="participant-name"]` field may now legitimately
  resolve to the literal display name `Guest`; generic role badges named Guest remain
  rejected everywhere else.
- Detached LiveKit audio sinks are linked to participant identities through a bounded,
  Airion-specific React-fiber walk. The mapping accepts only known stream-key shapes,
  exact `srcObject` ownership and one unambiguous identity-to-name result, so malformed,
  stale or conflicting state fails back to the SSRC label instead of cross-attributing a
  stream.
- Inbound RTP rows that omit `trackIdentifier` recover the receiver track through the
  transceiver `mid`, then synchronization-source SSRC. Two-person and multiparty
  regressions cover separate Guest/Test5 audio and video ownership without encoding an
  owner into `MediaStream.id`.

### 1.6.3 focused panel

- The Data Channels heading and per-channel cards are no longer rendered.
- Data-channel statistics remain in the internal model and copied JSON dump, and still
  power the transport fallback for applications that carry media outside RTP.

### 1.6.4 Meet inbound-audio approximation

- Meet's page-exposed DOM, SDP and standard WebRTC stats do not expose an authoritative
  participant identity for its detached inbound-audio virtual slots. Exact mapping
  would require identity metadata outside those current public page surfaces.
- On the exact `meet.google.com` host only, the monitor may pair inbound audio with
  exactly named inbound video **within the same PeerConnection**. Both slot sets must be
  complete, equal-sized and unambiguous, with unique tracks and numeric mids; each set
  is sorted by mid and paired by rank.
- Every approximate result is visibly marked `(likely)`. Missing or duplicate tracks or
  mids, duplicate/conflicting names, count mismatches, contradictory exact attribution,
  cross-PC evidence and lookalike hosts all fail closed to `Audio · <ssrc>`.
- Airion remains on its existing exact LiveKit/React owner mapping. Airion names are
  never marked `(likely)`, and its two-person and multiparty regression paths are
  unchanged.

### 1.6.5 Zoom inner-frame capture

- Zoom Workplace renders the meeting in a same-origin inner frame. The live call kept
  the outer shell's `/wc/<numeric meeting ID>/(start|join)` route, while the current PWA
  bundle also contains a stripped `/<numeric meeting ID>/(start|join)?from=pwa` variant.
  The manifest covers both route shapes; the page-world guard requires an exact Zoom
  host and, for the stripped variant, a numeric route plus the `from=pwa` marker.
- A zero-UI `rtc-early-capture.js` shim runs at `document_start` in every matching frame,
  stashes closure-private peer connections and notifies the later monitor. The empty
  outer `/wc` shell waits hidden, so only the media frame paints a panel.
- Live validation captured **2 connected peer connections** in the inner frame. Their
  audio/video traffic was DataChannel/transport-only and exposed the exact labels
  `ZoomWebclientAudioDataChannel` and `ZoomWebclientVideoDataChannel`. These support two
  grouped all-participant channel estimates, but there are still no RTP stream cards or
  defensible per-person/codec/loss/frame claims. Zoom does not use Meet's debugger
  banner, reload, heap query or persistent attachment.
- The real-Chrome suite includes the PWA route split, closure-private early connection
  fixture, generic DataChannel fail-closed case, and exact `/wc` bidirectional Zoom
  media-label case. It passes **85/85 checks across 19 isolated browser runs**.

### 1.6.6 Zoom media-channel truthfulness

- On an exact Zoom web-client route with zero RTP, the two exact live DataChannel labels
  produce exactly one meeting-wide Audio channel row and one meeting-wide Video channel
  row. Both are visibly `(estimated)`, retain receive and send directions, and combine
  duplicate channels without treating them as participants.
- These rows are DataChannel evidence, not participant or RTP streams. They never claim
  a participant name, RTP track, codec, loss, jitter, resolution or fps. Raw DataChannel
  cards remain hidden; the underlying channel stats stay available in the copied JSON.
- A first active sample with cumulative bytes keeps unknown rates as `—`; a proven
  zero-rate direction reads `idle`; unused, stale, missing-state-without-current-traffic
  and counter-reset evidence does not create or distort a row. Transport-only quality is
  the neutral state `Connected`, never Excellent/Good/Fair/Poor.
- Aloqa/Airion and Google Meet capture and naming paths are unchanged. The full browser
  regression remains **85/85 checks across 19 isolated browser runs**, reported under
  **14 scenario groups**; `zoom-media-unit.js` separately guards the exact labels,
  routes, activity/null/reset semantics, hybrid-RTP exclusion, aggregation and UI copy.

### 1.6.7 Streams that ended stop being cards

- Chrome keeps an `inbound-rtp` (and `outbound-rtp`) stat in the report after the far
  end drops a participant and renegotiates that m-line to `inactive`. The byte counter
  freezes, so the card sat at 0 kb/s forever and a person who had left the call still
  looked present. Those cards are now removed.
- Removal needs positive proof from the transceiver — `stopped`, `currentDirection`
  `stopped`/`inactive`, no receive direction for an inbound stream, no send direction
  for an outbound one, or an ended receive track. Everything else keeps its card.
- **0 kb/s is not proof.** A muted microphone, a camera switched off with
  `replaceTrack(null)`, an SFU pausing a hidden tile, an unused simulcast layer, a
  sender that stopped without signalling, and anything before the first negotiation
  completes all read as quiet, not gone. So does a stat that matches no transceiver,
  and any stream still moving bytes while a renegotiation reads back `inactive`:
  unknown never licenses deletion.
- The transport fallback counts the stats the report actually carried, not the
  survivors. A call whose participants have all left has ended RTP, not tunnelled
  media, so RTCP and STUN keepalive bytes can no longer masquerade as someone's audio
  and video. Element cards are likewise confined to the pre-join, no-PeerConnection
  case, so an emptied call leaves no placeholder nothing ever fills in.
- The copied JSON reports `streams_ended` alongside the raw stats, so a card that
  vanished is still explainable.

- A card keeps the participant name it has proved. The name was re-derived from a live
  DOM element every second, so the moment a tile left the document — grid
  virtualisation, pagination, a re-render landing between two ticks — an identified
  participant fell back to `Video · 6273` and flickered back a second later, though the
  stream never changed. A name proved by an exact track match is now remembered for that
  track and outranks every heuristic; it is dropped when the participant's media is gone.
- Audio played through a detached sink takes the name proved for its own video. Which
  tracks belong to one participant is stated by the sender as `a=msid:<stream> <track>`
  in the session description, which — unlike the `track` event — can still be read when
  the monitor is injected into a call already in progress. Two different names inside one
  group claim nothing.
- An outgoing card takes its name from the page's own self tile when nothing else can
  name it. Measured on a live Aloqa call: joining with the camera off — the common case
  there — leaves **no local media element at all**, because nobody plays their own
  microphone back, so the outgoing card had nothing to link to and read `Audio · 5143`.
  The self tile is on screen throughout, and an app marking a tile as the local one is a
  statement of identity, not proximity. Exactly one such tile resolving to exactly one
  name, or nothing; outgoing streams only, and never remembered per track.
- A camera or microphone switched off says so. Apps deactivate the encoding rather than
  renegotiating, so the transceiver stays `sendonly` and the stream is paused, not gone —
  it carries media again the moment the device comes back, with no renegotiation and no
  new card. Removing it would flicker on every toggle, and a bare `0 kbps` explained
  nothing, so the card now carries a `camera off` / `microphone off` marker. One live
  Aloqa call produced **both** shapes for the same camera button — once the encoding
  deactivated (`outbound-rtp.active === false`) with the track still attached, once the
  encoding left active and the sender's track reading disabled/ended — so the marker
  takes either, and a sender with no track at all. Verified live in both directions.
- Participants the grid is not showing are named from the people panel. Aloqa caps its
  tile grid and paginates it, so in a large call most participants have no tile at all —
  measured live: 40 participants, 16 tiles, and the three people actually speaking owned
  none of them. Their microphones still arrive, through detached sinks with no
  participant DOM of their own, so a tile-only name map left those cards reading
  `Audio · 3308`. Each `participant-row` carries the owner id in its React props and the
  name in its avatar's `aria-label` — the avatar's *text* is only the initials, so
  reading text there yields `B8` instead of `Bot 8`. A rendered tile is the participant's
  own media and still overrules a list row that disagrees; a row proving no owner id
  names nobody.
- Nothing is invented. Media attached to no element anywhere stays SSRC-labelled, and
  remembered and borrowed names are recorded only from exact track matches, never from
  the local-preview heuristic or Meet's `(likely)` approximation. The tooltip says which
  of the two it was.
- Browser regressions are **113/113 checks across 22 isolated browser runs** under
  **17 scenario groups**. The `departure` scenario walks a real renegotiated call through
  one participant leaving while a muted and a stalled participant keep their cards, then
  through an emptied call; `tile-churn` unmounts a participant's tile mid-call and holds
  the detached-audio and never-attached cases against it.

### 1.7.0 active-only view, and the audited defect list

- **Only active streams are shown by default.** Hiding is inference, so it follows the
  same rule as everything else: positive evidence only. A stream is `quiet` when its
  rate is *proven* zero for three consecutive samples (one zero, a keyframe gap or a
  momentary stall must not flap a card), or when the app itself switched the sender
  off (`outbound-rtp.active === false`, a disabled/ended sender track, or
  `replaceTrack(null)`). An unknown rate proves nothing and stays visible; bytes on
  the wire override everything and return the card instantly. Hidden is not gone: the
  section header shows `+N quiet`, one click reveals the cards with their markers
  (`camera off`, `microphone off`, `idle`, or a plain `quiet` when nothing else
  explains the silence), and the model, JSON dump (`streams_quiet`), sparkline history
  and remembered names all keep quiet streams whole. `ended` remains the only thing
  that removes a stream. Meet's perpetually idle simulcast layers are the visible
  win: they now sit behind the quiet toggle instead of reading as three dead videos.
- A deep-analysis audit of 1.6.7 confirmed and fixed five bugs, each now guarded by a
  regression test:
  1. **Hovering the chart during a skeleton rebuild killed the chart forever.** The
     rebuild destroyed the hovered element, `mouseleave` can never fire on a removed
     node, so `hoveringChart` stuck true and `update()` never painted the chart again.
     `buildSkeleton()` now resets the flag; a real-pointer browser test hovers through
     a participant joining.
  2. **Minimising was not paint-only.** Remembered names (`TRACK_NAMES`) were written
     inside `updateCard()` — render path — so a participant whose tile appeared and
     churned away while the panel was minimised could never be remembered. Name-proving
     now happens in `tick()`, the model phase.
  3. **msid groups announced before media flowed were wiped and never re-harvested.**
     `pruneStreamState` deleted a group with no live tracks in the same tick
     `harvestTrackGroups` parsed it, and the SDP-text cache then blocked re-parsing for
     the rest of the call — silently killing generic detached-audio naming (masked on
     Aloqa/Meet by their app-specific paths). Pruning a group now also drops the SDP
     cache, so the next tick re-harvests and the wipe heals.
  4. **Per-stream counter resets rendered as a proven `0 kbps`.** The transport and
     Zoom-channel paths already nulled negative deltas; inbound/outbound RTP did not,
     so a reset showed "0 kbps", summed a negative into the totals, and polluted the
     sparkline. Negative per-stream deltas are now `null` (unknown), unknown samples
     are skipped from sparkline history instead of recorded as zeros, and the
     throughput chart draws null history samples as gaps, not dips to the axis.
  5. **`run()` had no re-entry guard**, so `adopt()` racing the sub-frame wait loop
     leaked a second 1 Hz collection interval; `adopt()` also now unhides a waiting
     hidden sub-frame monitor.
- Smaller corrections riding along: a proven 0 ms aggregate jitter renders as `0.0 ms`
  instead of the no-evidence em dash; the chart tooltip reads the exact samples the
  frozen curve was drawn from, so hover values always match the line; rate deltas use
  `performance.now()` (monotonic) so an NTP step or suspend/resume cannot fabricate
  one tick of wrong rates; the Zoom media-channel rows use a neutral icon colour
  (they carry both directions, and status colours stay reserved); drag/resize use
  pointer events (touch works) and the panel position/size persist per origin,
  clamped to the viewport — on Meet the panel no longer respawns over the Join
  button after every reload.
- Name resolution and element stats now see **open shadow roots**: media discovery
  sweeps them (budgeted, and only when the page actually has shadow roots), the
  ancestor climb crosses shadow boundaries through the host element, and the
  foreign-media grid guard looks inside shadow components so the climb still stops at
  the tile. Closed roots remain unreachable and their streams honestly keep SSRC
  labels.
- **A newer injection replaces a stale running instance.** Re-running the script
  used to be a blind toggle, and an extension reload does not swap a script already
  injected into a long-lived tab — so the toolbar kept toggling hours-old code, which
  is exactly how a 13-hour call tab ended up showing pre-1.6.7 behaviour while the
  folder said 1.7.0. The script now carries `VERSION`: same version toggles as
  before, an older instance is stopped (panel removed, hooks restored) and the new
  one starts in its place. `build.sh` fails if the source VERSION and the manifest
  version ever diverge, and the startup console line prints the running version.
- Browser regressions are **132/132 checks across 27 isolated browser runs** under
  **21 scenario groups**: `tile-churn` now walks camera off → quiet-hidden → revealed
  with its marker → camera on → back in the default view; `departure` proves a stalled
  participant is quiet-hidden but never removed and comes back at 0 kb/s when
  revealed; `chart-hover` hovers with a real pointer through a participant joining;
  `minimised-names` proves a participant seen only while minimised is still
  remembered; `shadow-dom` renders every tile inside an open shadow root;
  `version-upgrade` proves a newer injection replaces a stale instance while the
  same version still toggles. The dependency-free stats suite grew to **12
  scenarios**, adding counter-reset, jitter-zero, msid-group-healing and
  quiet-hysteresis guards.

### A testing lesson worth keeping

The first version of `test/harness.html` sent **one shared MediaStream** to every peer.
WebRTC preserves the sender's track ID across the wire (msid), so all remote tracks had
identical IDs, every card matched the first tile, and the suite reported PASS while
showing the same name six times. `harness.html` now clones tracks per participant. If you
add scenarios, keep track IDs distinct or the name tests are meaningless.

---

## 5. How to build and test

```bash
./build.sh                       # rebuild everything from src/
node test/names-unit.js          # 81/81 name-resolution assertions
node test/background-unit.js     # 18 extension lifecycle scenarios
node test/stats-unit.js          # 12 stats scenarios: loss/ICE/quality, ended vs
                                 #   quiet, counter resets, jitter-zero, msid heal
node test/zoom-media-unit.js     # Zoom route/label/activity/grouping guards
node test/manifest-unit.js       # release/dev manifest contracts
node test/launcher-unit.js       # launcher support-boundary copy
node test/update-unit.js         # 6 auto-update scenarios
```

`build.sh` minifies, syncs `extension/monitor.js` **and** `extension-dev/monitor.js`
and `extension-dev/background.js`, regenerates the launcher, and re-zips. Forgetting
the dev copies is how you end up debugging code that is not the code running.

```bash
# the full Playwright suite (needs playwright + a chromium binary)
cd test && NODE_PATH=$(npm root -g) node run.js
```

`run.js` launches Chromium with `--use-fake-device-for-media-stream`, spins up real peer
connections with real encoded media, and injects the monitor exactly as the extension
does. It passes **132/132 checks across 27 isolated browser runs**, reported under 21
groups: Meet-style RTP, guest-badge DOM, exact Airion two-person/multiparty attribution,
Meet same-PC rank pairing plus cross-PC/count/mid/track/name/host fail-closed guards,
Zoom inner-PWA-frame document-start capture, generic DataChannel fail-closed behavior,
exact `/wc` Zoom media-label estimates, participant departure, tile churn with quiet
hide/reveal/resume, lifecycle cleanup, chart-hover survival through a mid-hover
rebuild, minimised name-proving, and shadow-DOM media discovery. The dependency-free
suites also
pass: names **81/81**, background **18/18 scenarios**, stats **12/12 scenarios**, plus the
`zoom-media-unit.js` media-channel guards, manifest contracts and launcher boundary
checks. These suites pass against the final 1.7.1 source.

`run.js` and `names.js` pick the browser from `$CHROMIUM`, defaulting to
`/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` on macOS and
`/opt/pw-browsers/chromium-1194/chrome-linux/chrome` elsewhere. Install Playwright
without a browser download (`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm i playwright`)
and point `NODE_PATH` at it.

---

## 5b. Releasing, distributing and auto-updating

The source lives at **github.com/mahmudcoding/rtc-stream-monitor** (public).

### Cutting a release

```bash
node scripts/release.mjs 1.7.1          # add --dry-run to rehearse
```

It bumps all three version markers together (`src` `VERSION` plus both
manifests — `build.sh` fails if they ever disagree), rebuilds, runs every
dependency-free suite and refuses to continue if one fails, commits, tags
`v1.7.1`, pushes, and publishes `stream-monitor-extension.zip` to GitHub
Releases. The real-Chrome suite is deliberately NOT run there; run
`test/run.js` yourself for anything beyond a docs-only release.

### How updates actually reach people

Chrome only auto-updates extensions **it installed from the Web Store**. An
unpacked install is never updated by Chrome, and — before 1.7.0 — reloading the
extension did not even replace a monitor already injected into an open call
tab. Three distribution paths, in increasing order of effort for the recipient:

| Path | Recipient effort | Updates |
|---|---|---|
| `dist/stream-monitor-launcher.html` (bookmarklet) | open a file, drag a bookmark | re-copy the file; no Meet support |
| [Unpacked zip](https://github.com/mahmudcoding/rtc-stream-monitor/releases/latest/download/stream-monitor-extension.zip) from GitHub Releases | extract + Load unpacked | manual, but the toolbar badges `↑` when a newer release exists |
| Unpacked clone + `scripts/install-agent.sh` | one command, then Load unpacked | **automatic**, applied at next Chrome start |
| Chrome Web Store, unlisted | one click | **automatic**, silent, no agent — needs the one-time $5 registration |

`scripts/install-agent.sh` installs a launchd agent that fast-forwards the
checkout twice a day and at login (`--uninstall` removes it). Chrome keeps
serving the files it loaded, so the extension restarts itself **once per browser
start** to pick them up — `chrome.runtime.reload()` re-reads an unpacked folder
exactly as the chrome://extensions reload button does. A stored flag makes that
once per start rather than a restart loop, and doing it at browser start means
no call is ever interrupted.

Independently, a twice-daily check against the GitHub Releases API badges the
toolbar `↑` with the available version. It never installs anything, and it fails
closed in every direction: a 404, an offline browser, an unparseable tag — none
of them badge. The repository is public, so this check is **live**: an
unauthenticated `GET /releases/latest` returns the current tag, and
`releases/latest/download/stream-monitor-extension.zip` is a working
no-auth install link anyone can be sent. Point `UPDATE_FEED_URL` at any static
`{"version":"x.y.z"}` if the feed ever needs to move.

Deliberately NOT done: fetching `monitor.js` from a URL at runtime. It would
give true payload auto-update with no reinstall, and it is remotely hosted code
— permanently disqualifying for a Web Store listing under MV3, and it would let
anyone who can write to that URL run code on every user's call pages with
`debugger` permission in scope. A tool whose value is that its numbers are true
does not get to take that trade.

---

## 6. Environment and context about the user

- **Mahmud**, timezone Asia/Tashkent (UTC+5). Uses a Mac (camera reports as
  "FaceTime HD Camera").
- His own call app is at `airion-cargo.store` — Uzbek-language UI ("Aloqa" = call).
  It is an **SFU**, VP9 video / Opus audio, ~8 participants, single peer connection
  carrying all streams, participant grid with pagination (which is why it blocks wheel
  events — see bug 2).
- Historical live baseline on that app: ~10 ms RTT, 4–6 Mbps down, 4 Mbps up, 0 % loss,
  direct STUN path, per-participant cards with names.
- He prefers short, direct answers and gets impatient with long tool calls. Large
  payload injections took minutes to type out and he interrupted them repeatedly —
  prefer delivering files over pasting big blobs into the page.

### The loop you will actually be working in

The dev build is loaded **unpacked** from `extension-dev/`, and Chrome caches an
unpacked extension's files. So every code batch needs:

> `./build.sh` → reload the extension (`chrome://extensions` → ↻) →
> reload the page → re-join the call

Codex can perform the Chrome UI steps with Computer Use. Do not inspect a Meet tab
through another CDP client: use screenshots/accessibility state so the extension keeps
ownership of its debugger session. Batch fixes to avoid unnecessary reload cycles.

### Things that cost hours in the previous session — don't rediscover them

- **Chrome 151 ignores `--load-extension`.** The flag is accepted and does
  nothing. Loading unpacked by hand is the only way in.
- **`chrome.debugger` is single-client.** The browser-automation tool's JS
  evaluation uses CDP too, so *inspecting the page evicts the extension's own
  debugger session* and produces "Debugger is not attached" that looks like an
  extension bug. On the debugger path, read the on-screen `#rtcmon-dev-badge`
  from a **screenshot** instead of evaluating JS.
- **Loopback fetch is dead.** Chrome gates public→localhost behind the
  `local-network-access` permission (state `"prompt"`), so a page cannot pull the
  bundle from a local server. `test/serve.js` is kept only as a record of this.
- **The safety layer will block** relaunching Chrome with a debug port, disabling
  browser security features, and probing for Trusted Types bypasses. Those are
  correct refusals — the supported extension path is the way through, not a
  workaround to be found.
- **The monitor's panel covers the top-right of the page**, which on Meet is
  exactly where the Join button and the admit prompt live. Minimise it (`—`) or
  hide `#rtc-stream-monitor-host` before clicking there.

---

## 7. Open items

**Current 1.7.1 status:** all automated suites pass, including the 132/132-check
real-Chrome harness across 27 isolated browser runs and 21 reported groups.
**Live-validated on staging Aloqa (2026-08-28)** via a callrig call with two
call-bots guests: muted self audio named from the self tile, bot camera off →
inbound card quiet-hidden in ~4 s and back instantly on camera on, host camera
off → outbound quiet-hidden with the audio card keeping its name, SFU pause
(hidden window) hiding both videos and fronting restoring them, and Spotlight
view naming the 1920px high-res subscription. Still to do: panel-position
persistence across the Meet reload loop, and a Meet/Zoom smoke pass. The
Meet-only approximate audio
fallback is marked `(likely)` and fails closed unless its complete same-PC numeric-mid
slot evidence is unambiguous. Airion's exact path is unchanged. The 1.6.3 extension was
loaded and live-validated on `airion-cargo.store` on
2026-08-14: one active peer connection produced six correctly named inbound cards —
audio and video for `Test5`, `Guest` and `Ahmadxon` — with no SSRC-name fallback or
cross-attribution. The live v1.6.3 panel rendered no Data Channels heading or cards. On Meet, the 1.6.1
clean reload armed the
document-start hook, auto-reloaded once, kept the debugger attachment, and reported
`CAPTURED 1 connection(s) via queryObjects`; the pre-join and joined panels both used
`Mahmud Nosirov`, with live OPUS/AV1 telemetry. A live Leave → Return → rejoin then
replaced Meet's renderer: the extension recovered its debugger/preload generation,
recaptured the replacement connection without a second page reload, and resumed the
same live telemetry. On Airion, the live panel also reported the two sending cards as
`Test2 (you)`, with three LiveKit data channels captured internally and transport
telemetry shown in the panel. The older
details below remain useful deeper-call evidence.

Zoom was live-validated on 2026-08-14 after reloading the dev extension. The outer
`/wc` shell stayed hidden and the inner PWA meeting frame captured **2 connected peer
connections** at document start. The panel showed Zoom's audio/video DataChannel labels
and aggregate transport traffic, with no RTP or per-person identity evidence. The
current code uses only those exact labels for two all-participant `(estimated)` channel
subtotals while retaining aggregate transport as the wire total. There was no debugger
banner, forced reload, heap query, or interference with the unchanged Airion and Meet
paths.

1. **Historical live testing, 2026-08-13/14.** Run against a real two-party call (host `Test2`
   plus a guest joined through the invite link from a throwaway CDP Chrome, see
   `test/cdp.js`).
   - **`airion-cargo.store` — works on 1.6.1.** RTT 6 ms, `direct · STUN · UDP`, correct
     bitrates both directions, loss/jitter with status words, and transport detail;
     the three LiveKit data channels were captured internally and
     are available in the JSON dump. Bug 5 confirmed fixed *after* bugs 9 and
     10: sending cards now read `Test2 (you)` and the remote card `Guest Tester`.
   - **`airion-cargo.online` — injects cleanly** (panel builds, `WrappedPC`
     hooked). No call was run there; no account was available at the time.
   - **Google Meet — works on 1.6.1 via `chrome.debugger`.** Confirmed live:
     1 connection, RTT 93 ms, `direct · STUN · UDP`, sending 61 kbps. Getting
     there needed four separate things, each of which looked like the answer on
     its own:
     1. **MAIN-world injection is refused** — as a `content_scripts` entry *and*
        via `chrome.scripting.executeScript(files)`, on a page sending
        `require-trusted-types-for 'script'`. The ISOLATED probe runs, so content
        scripts do reach the page. Note `executeScript({func})` still evaluates
        fine, so "the main world is reachable" must not be read as "a script file
        can be injected" — that mistake made the fallback silently skip itself.
     2. **CDP `Runtime.evaluate` gets through** where injection does not.
     3. **Meet freezes the WebRTC API**: `window.RTCPeerConnection` and
        `RTCPeerConnection.prototype.getStats` are both `writable:false,
        configurable:false`, and instances live in Closure-compiled closures. So
        the constructor wrap, the prototype hooks and the deep scan all fail
        there no matter how early the script runs. Injecting at document-start
        via `Page.addScriptToEvaluateOnNewDocument` is still worth doing, but it
        is not sufficient on its own.
     4. **`Runtime.queryObjects` is what actually captures the connection** —
        hand it `RTCPeerConnection.prototype` and it returns every live instance
        off the heap, which `adopt()` then takes. Use the *protocol method*: the
        DevTools console helper `queryObjects(Ctor)` is not exposed to a plain
        CDP client and fails with "queryObjects is not defined" even with
        `includeCommandLineAPI`.
     The cost is a persistent "Chrome is being debugged" banner, because the
     document-start registration and the heap query both need the attachment held
     open. Only the dev build attaches automatically; the shipped one does it on
     the toolbar click.
   - **Meet, verified on a real three-party call** (host tab, a second host tab,
     and a signed-out guest driven by `test/cdp.js` with fake capture devices):
     RTT 111 ms rated `Fair`, receiving 4.2 Mbps, sending 326 kbps, packet loss
     `ok`, jitter 131 ms correctly flagged `high`. Sending: OPUS 58 kbps plus VP9
     640×360@30 268 kbps and two idle simulcast layers. Receiving: two OPUS
     streams and VP9 1280×720@20 at 1.1 Mbps, VP8 360×640@5 at 610 kbps. 17 data
     channels resolved with their real names (`meet-p2p-signaling`,
     `media-director`, `audio-mesh`, …). The panel scrolled under a real wheel.
     So: bitrates, codecs, resolutions, fps, loss, jitter, transport, data
     channels and scrolling all work on Meet.
   - **Meet names.** The 1.6.1 build correctly avoided a
     false "Кадрировать" (Crop) label but often fell back to SSRC for the local
     stream. Version 1.6.1 now derives the local/sending name only when one unique
     person-like value is repeated in the document, while excluding controls and
     UI/status labels. The final live pre-join test exposed
     `Предварительный просмотр видео включен`; it is now rejected and both pre-join
     cards correctly resolve to `Mahmud Nosirov`. Version 1.6.4 adds the separate,
     explicitly approximate inbound-audio slot-rank fallback described above. Because
     current public page surfaces provide no authoritative cross-media identity, these
     names always carry `(likely)` and ambiguity remains SSRC-labelled.
   - **Teams web — not tested** (dropped from scope). One fact worth keeping: it
     *refuses* custom Trusted Types policies (`Policy "…" disallowed`), so the
     bug-8 fix would fall through to its default policy there.
   - **Zoom web — capture was live-validated on 1.6.5 without `chrome.debugger`; 1.6.6
     keeps that path.** The inner PWA frame produced two connected peer connections, the
     exact audio/video media DataChannel labels, and aggregate transport telemetry. No
     RTP rows were present. The monitor may therefore show one meeting-wide Audio row
     and one meeting-wide Video row, both `(estimated)` and preserving ↓/↑ channel
     directions, but no participant or RTP/codec/loss/jitter/resolution/fps details;
     raw DataChannel cards stay hidden and their stats remain in the JSON dump.
   - Still unverified on any app: simulcast layers as separate sending streams.

   Two limits of the harness, not of the monitor, worth knowing before retesting:
   - Before 1.6.2, remote **audio** fell back to `Audio · <ssrc>` because Aloqa renders
     it as a detached `<audio>` with no participant-tile ancestor. Version 1.6.2 resolves
     that sink through Airion's exact LiveKit/React identity contracts and deliberately
     fails back to the SSRC label when the association is absent or ambiguous.
   - On the Aloqa page the browser-automation tool could not deliver a physical
     wheel event (zero `wheel` events reached the page), so scrolling was
     verified there by mechanism only — content overflowed by 253 px and a
     dispatched wheel drove `scrollTop` 0→200 through the monitor's own handler.
     The same tool *did* deliver a real wheel on Meet, where the panel scrolled
     normally, so the scroll path itself is fine.
   - **Never debug the debugger path by inspecting the page.** Chrome allows one
     debugger client per tab, and the browser-automation tool's own JS evaluation
     runs over `chrome.debugger` too — so every inspection evicts the extension's
     session and breaks the exact mechanism under test, producing "Debugger is not
     attached" that looks like a bug in the extension. The background now
     reclaims its session, and prints its status into an on-screen badge
     (`#rtcmon-dev-badge`, dev build only) so progress can be read from a
     screenshot with nothing attached. Do that instead.
2. **Chrome Web Store publishing** was requested. Blocked on the user: it needs his
   Google account, a one-time $5 USD developer registration, and his acceptance of the
   developer agreement. Not something an assistant can do for him. The build now puts
   `manifest.json` at the root of `dist/stream-monitor-extension.zip`, as the store
   requires. A submission kit was offered (listing copy, 1280×800 screenshots, 440×280
   promo tile, per-permission justifications) but he never chose an option.
3. **Name detection is inherently best-effort.** It is DOM scraping. If an app renders
   names into a canvas or strips accessibility labels, cards fall back to `Video · 4501`
   (last 4 of the SSRC). Airion's detached-audio bridge is an app-specific exception,
   guarded by its stable LiveKit/React contracts. Meet's detached inbound-audio fallback
   is deliberately approximate and marked `(likely)`. The numeric stats never depend on
   names.

---

## 8. Version history

| Version | Change |
|---|---|
| 1.0.0 | Initial extension. Panel, stats, charts, per-stream cards |
| — | Scroll fix (flex `min-height: 0`), then the wheel-interception fix; guest badge stripping |
| 1.1.0 | `allFrames: true` + sub-frame handling for embedded calls |
| 1.2.0 | Name detection via `aria-label` and data attributes; a11y label cleanup; SSRC fallback in card titles |
| 1.3.0 | `transport` and `data-channel` stats; Zoom-style DataChannel fallback with explanatory note |
| 1.4.0 | Outbound track resolution via `mediaSourceId` — sending cards finally get names |
| 1.5.0 | First live run against a real call. Trusted Types policy so the panel can paint under `require-trusted-types-for`; name resolution rejects generic media/status labels and stops at the participant grid; `names-unit.js` guards both. Bug 5 now actually produces `Test2 (you)` |
| 1.6.0 | **Google Meet supported.** `chrome.debugger` fallback in background.js: CDP injection where main-world injection is refused, `Page.addScriptToEvaluateOnNewDocument` for document-start hooking, and `Runtime.queryObjects` to pull connections off the heap into the new `adopt()` API. Prototype hooks no longer die on a frozen prototype (bug 11) |
| 1.6.1 | Release/dev Meet lifecycle parity with persistent replacement polling and cleanup; Airion/Meet name hardening including Russian pre-join preview labels; packet-weighted loss and authoritative selected ICE; minimise/prune/stop lifecycle cleanup; expanded automated regression suites; live validation on Meet and Airion |
| 1.6.2 | Airion inbound-name recovery: authoritative literal Guest labels, bounded fail-closed detached LiveKit audio identity mapping, receiver mid/SSRC fallback when inbound stats omit `trackIdentifier`, and two-person/multiparty ownership regressions |
| 1.6.3 | Removes individual Data Channels cards from the panel while retaining their internal stats for transport fallback and JSON export; 47-check Chrome regression suite and live Airion verification |
| 1.6.4 | Adds a Meet-only, visibly `(likely)` inbound-audio approximation from complete equal-sized unambiguous same-PC numeric-mid slot sets; all uncertainty fails closed, Airion exact attribution remains unchanged, and the Chrome regression suite expands to 64/64 checks across 17 browser runs |
| 1.6.5 | Adds Zoom Web App support through a narrowly guarded document-start shim in the real inner PWA meeting frame; live validation captured two connected DataChannel-only peer connections with exact audio/video media labels. Those labels now drive only two visibly estimated all-participant channel subtotals while aggregate transport stays authoritative and RTP/person/codec claims remain absent; unknown/reset counters fail closed and quality stays neutral; Aloqa and Meet paths remain unchanged; Chrome regressions expand to 85/85 across 19 runs |
| 1.6.6 | Defines Zoom's exact media-channel presentation as one meeting-wide Audio and one meeting-wide Video DataChannel row, both `(estimated)` with receive and send rates. Null first-sample rates remain `—`, proven zero rates read `idle`, reset/inactive evidence stays hidden, and quality stays neutral `Connected`; raw DataChannel cards remain hidden and no participant/RTP/codec/loss/jitter/resolution/fps claim is made. Aloqa/Airion and Meet are unchanged; regression status is 85/85 checks across 19 isolated runs and 14 groups, plus `zoom-media-unit.js` guards |
| 1.6.7 | Removes stream cards whose transceiver proves the media ended, so a participant who left the call stops showing as a frozen 0 kb/s stream. Removal requires positive evidence (`stopped`, `currentDirection` `stopped`/`inactive`, no negotiated direction for that stream, or an ended receive track); a muted mic, a camera off via `replaceTrack(null)`, a paused SFU tile, an idle simulcast layer, an unsignalled stall, an unnegotiated or unmatchable stat, and any stream still moving bytes all keep their cards. Transport fallback now counts the stats the report carried rather than the survivors, so keepalive bytes on an emptied call are never reported as tunnelled media, and element cards stay confined to the pre-join case; the copied JSON reports `streams_ended`. Zoom, Aloqa/Airion and Meet paths are unchanged; regressions are 95/95 checks across 20 isolated runs and 16 groups, plus new `stats-unit.js` guards. Validated on a live Aloqa call. Also keeps the participant name a card has proved when the tile it was read from is unmounted, and gives detached audio the name proved for its own video via the session description's msid grouping, so cards stop falling back to `Video · 6273` mid-call. An outgoing card with no local media element — what a camera switched off leaves behind — takes the name from the page's own self tile. Media attached to no element at all stays SSRC-labelled. Also names participants the tile grid is not showing, from the people panel's rows. Validated end to end on live Aloqa calls, including a 40-participant one |
| 1.7.0 | **Active-only default view.** Streams provably carrying no media — three consecutive proven-zero samples, or a sender the app switched off — leave the default view behind a `+N quiet` header toggle that reveals them with their markers; unknown never hides, bytes return a card instantly, and the model/dump/history keep every quiet stream (`streams_quiet` in the JSON). Fixes five audited 1.6.7 bugs, each with a new regression test: chart death after a mid-hover rebuild, minimise silently stopping name-proving (names now proven in the model phase), pre-media msid-group wipe sticking via the SDP cache, per-stream counter resets rendering as proven `0 kbps` and polluting totals/sparklines, and the missing `run()` re-entry guard. Also: proven 0 ms jitter renders as `0.0 ms`, hover tooltips read the frozen curve's own samples, rates use a monotonic clock, null history samples draw as gaps, Zoom channel rows use neutral icon colour, drag/resize use pointer events (touch works), panel position/size persist per origin, open-shadow-root media is discovered and named, and a newer injection replaces a stale running instance instead of toggling it (same version still toggles; build.sh enforces src/manifest version agreement). Meet/Aloqa/Zoom capture paths unchanged; live-validated on staging Aloqa via callrig |
| 1.7.1 | Distribution and updates. `scripts/release.mjs` cuts a release (bumps `src` VERSION and both manifests together, rebuilds, gates on every dependency-free suite, tags, publishes the zip to GitHub Releases); `scripts/install-agent.sh` installs a launchd agent that fast-forwards an unpacked checkout twice daily, and the extension restarts itself once per browser start to pick it up, so an unpacked install auto-updates at the next Chrome start. A twice-daily version check badges the toolbar `↑`, failing closed on private/offline/garbage feeds. `store/` holds the complete Chrome Web Store submission kit — listing copy, per-permission justifications and generated 1280×800 / 440×280 assets — which is the only path to silent auto-update for arbitrary users. Adds `alarms` + `storage` permissions and the `api.github.com` host permission; new `test/update-unit.js` covers 6 scenarios |
