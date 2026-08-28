# Test harness

Real WebRTC, real encoded media, real peer connections — not mocks.

    NODE_PATH=$(npm root -g) node run.js

Requires `playwright` and a Chromium binary; edit `executablePath` in `run.js` and
`names.js` for your environment.

The 1.6.7 full suite passes **113/113 checks across 22 isolated browser runs**, reported
under **17 scenario groups**.

## Scenarios (`harness.html?mode=...`)

- `rtp`   — 5 participants, loopback pc1→pc2, names in `aria-label` only (Meet-style).
            Some labels carry a `, muted` suffix to test cleanup.
- `guest` — 3 participants, one with a role badge glued to the name in the DOM.
- `airion-ssrc` — Airion-style two-person call whose inbound stats omit
                   `trackIdentifier`; remote Guest audio is detached from its tile.
- `airion-multiparty` — Airion-style Test5 + Guest call with separately owned detached
                        audio and in-tile video, using browser-generated MediaStream IDs.
- `meet-audio-rank` — Meet-origin virtual-slot fixture with two detached audio mids 3/4
                      and two exactly named video mids 10/11 on one PeerConnection.
                      Each slot has a distinct MediaStream and track. Audio is paired by
                      numeric mid rank and must carry the explicit `(likely)` marker.
- `meet-audio-cross-pc` — equal-looking audio/video sets split across PeerConnections;
                          approximate pairing must never cross the connection boundary.
- `meet-audio-multi-audio` / `meet-audio-multi-video` — unequal slot-count guards;
                          every unmatched audio remains SSRC-labelled.
- `meet-audio-missing-mid` / `meet-audio-duplicate-mid` — incomplete or conflicting
                          numeric rank sets fail closed.
- `meet-audio-missing-track` / `meet-audio-duplicate-track` — incomplete or conflicting
                          track-owner sets fail closed.
- `meet-audio-duplicate-name` — two distinct named video slots resolving to the same
                                display name are ambiguous (for example camera + share)
                                and must remain SSRC-labelled.
- `meet-audio-conflicting-exact` — an exact audio-element name that contradicts its
                                   rank-paired video invalidates approximation for the
                                   whole slot set; exact attribution itself stays unmarked.
- The ranked fixture is also repeated on a Meet-lookalike hostname. Approximate naming
  is permitted only on the exact `meet.google.com` host.
- `zoom-early-nested` — same-origin Zoom `/wc/<id>/start` shell plus the PWA bundle's
                         stripped `/<id>/start?from=pwa` media-frame variant.
                         The child constructs two PeerConnections before `monitor.js`;
                         the document-start shim must stash and hand them to the child
                         monitor. Exactly that child panel is visible, while the empty
                         outer shell remains hidden.
- `airion-offgrid` — Aloqa caps its tile grid, so most participants in a large call have
              no tile. Two remote participants, only one rendered as a tile; both send
              microphone media through detached sinks. The people panel lists both as
              `participant-row`s carrying the owner id in React props and the name in the
              avatar's aria-label (its text is only the initials). Both cards must be
              named and none may fall back to an SSRC label.
- `tile-churn` — the DOM a name is read from comes and goes while the stream does not.
              Four participants: one whose tile stays (control), one whose tile is
              unmounted mid-call via `window.__tiles.unmount('virtual')` (what a
              virtualised grid does when somebody scrolls out of view), one whose audio
              plays through an unnamed body-level sink re-wrapped into its own
              MediaStream so only the sender's msid grouping still ties it to the named
              video, and one whose media is never attached to any element at all. The
              first three must be named; the fourth must stay SSRC-labelled, because
              nothing in the page says whose it is. `window.__tiles.dropSelfMedia()` then
              removes the self-preview element while leaving the named self tile — what
              turning the camera off does on a real call — and outgoing cards must keep
              their names without the self tile ever naming an incoming one.
- `departure` — SFU-shaped call: one PeerConnection carries three named participants,
              so dropping one leaves the others' transceivers untouched. Chrome keeps the
              departed participant's frozen `inbound-rtp`/`outbound-rtp` stats, which must
              stop being cards. `window.__departure` also exposes `mute` (enabled=false)
              and `stall` (sender `track.stop()` with no signalling) — both are quiet but
              still in the call, and the stalled one sits at a genuine 0 kb/s, so both must
              KEEP their cards. `leaveAll` then empties the call: no cards, no empty
              Sending/Receiving section, and keepalive transport bytes must not be
              reported as tunnelled media.
- `dc`    — generic file-origin peer connections carrying ~600 kbps over arbitrary
            `audio` / `video` DataChannels with zero RTP tracks. Guards transport
            fallback and JSON-dump collection while requiring that neither raw
            DataChannel cards nor Zoom-specific estimated rows render.
- `zoom-dc` — exact `https://app.zoom.us/wc/<id>/start` fixture using the live labels
              `ZoomWebclientAudioDataChannel` and
              `ZoomWebclientVideoDataChannel`. Duplicate channels move bytes in both
              directions. The panel must group them into exactly one meeting-wide Audio
              and one meeting-wide Video row, mark both `(estimated)`, show
              `all participants · 2 channels combined`, retain ↓ receive and ↑ send
              rates plus PC provenance, and keep aggregate transport unchanged. An
              active true first sample must show `—`; a proven zero-rate direction must
              show `idle`; inactive/null-without-evidence and reset-only channels must
              stay hidden. Quality must stay neutral `Connected`. It must not invent an
              RTP card, participant name, codec, loss, jitter, resolution or fps.

The Zoom fixtures cover both the PWA bundle's stripped inner-frame route, including its
missing `/wc` prefix and mandatory `from=pwa` marker, and an exact `/wc/<id>/start`
DataChannel realm. The live 2026-08-14 call captured **2 connected peer connections**
and the exact audio/video DataChannel labels above. Those labels justify two estimated,
meeting-wide channel rows with both directions, not participants or RTP media claims.
Raw DataChannel cards remain hidden and their stats stay dump-only; aggregate transport
remains authoritative. The empty outer shell stayed hidden and Zoom used no debugger
attachment or reload. Aloqa/Airion and Meet behavior is unchanged by this Zoom-only
presentation.

`zoom-media-unit.js` exercises the fail-closed boundary without a browser: file and
lookalike origins, unsupported/non-numeric routes, unknown/control/case-variant labels,
RTP + DataChannel hybrids, inactive/zero/reset counters, cumulative-byte evidence for an
active null-rate first sample, truthful `—` versus `idle` UI wording, and duplicate-label
aggregation with channel/PeerConnection provenance. The supported stripped
`/<numeric id>/(start|join)?from=pwa` media-frame route remains a positive guard
alongside `/wc`.

Meet's page-exposed DOM, SDP and standard WebRTC stats do not provide an authoritative
audio-slot-to-participant identity for these detached virtual streams. The monitor
therefore uses a deliberately narrow approximation only on `meet.google.com`: within
one PeerConnection, complete equal-sized audio and exactly named video slot sets must
have unique tracks and numeric mids; each set is sorted by mid and paired by rank. The
result is visibly suffixed `(likely)`. Missing, duplicate, conflicting, cross-PC or
unequal evidence fails closed to `Audio · <ssrc>`. Airion does not use this fallback;
its existing LiveKit/React owner mapping remains exact and unmarked.

## Critical invariant

Every participant must send **distinct** track IDs. WebRTC preserves the sender's track
ID across the wire, so reusing one MediaStream makes all remote tracks share an ID —
every card then matches the first tile and the name tests pass while being meaningless.
`rtpScenario` clones tracks per participant for exactly this reason. Keep it that way.
The Airion scenarios also keep browser-generated `MediaStream.id` values: identity must
come from the exact tile/audio contracts, never from a synthetic owner encoded in an ID.

## Other scripts

- `names.js` — dumps card titles grouped by section. Fastest way to eyeball name mapping.
- `net.js`   — checks whether the environment can reach meeting services at all.
- `names-unit.js` — **76/76** dependency-free name-resolution assertions.
- `background-unit.js` — **18/18** dependency-free extension-lifecycle scenarios.
- `zoom-capture-unit.js` — dependency-free production-shim semantics, idempotence,
                           stash/event handoff, and exact Zoom host/path guards.
- `zoom-media-unit.js` — dependency-free exact-label grouping, route/activity/hybrid
                         fail-closed guards, null/idle/reset UI truthfulness, and
                         duplicate-channel aggregation.
- `manifest-unit.js` — release early-only versus dev regular-auto-inject routing,
                       all-frame coverage, and exact host permissions.
- `zoom-background-unit.js` — release toolbar and dev auto-injection behavior with
                              zero Meet preload, heap query, reload, or persistent attach.
- `stats-unit.js` — **4/4** dependency-free loss / selected-ICE plus Zoom
                    null/reset transport and neutral-quality scenarios.
- `launcher-unit.js` — dependency-free guard for the Meet extension-only boundary.
