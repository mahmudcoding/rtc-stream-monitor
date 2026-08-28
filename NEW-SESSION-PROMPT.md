# Paste this into the new session

Copy the block below as your first message. The project lives at
`/Users/mahmud/Projects/rtc-stream-monitor` on this machine.

---

I'm continuing work on **RTC Stream Monitor**, a Chrome extension at
`/Users/mahmud/Projects/rtc-stream-monitor`. **Read `README.md` first** — it has the
architecture, the fixed-regression history, the live-test history, and a section
"The loop you will actually be working in" that will save you a lot of time.

Short version: it's a zero-dependency overlay showing live stats for every audio and
video stream a browser sends and receives on compatible WebRTC pages.
`src/rtc-stream-monitor.js` is the source of truth; `./build.sh` regenerates everything
else. Version 1.7.1. Google Meet is extension-only because its connections require the
persistent debugger/queryObjects path; use the launcher or bookmarklet on compatible
pages such as Airion, not Meet.

**Current implementation and automated status (2026-08-28):**

- **Active-only default view (new in 1.7.0):** a stream provably carrying no media —
  three consecutive proven-zero rate samples, or a sender the app itself switched off —
  leaves the default view. The section header counts it (`+N quiet`) and a one-click
  toggle reveals the quiet cards with their `camera off` / `microphone off` / `idle` /
  `quiet` markers. Hiding is display-only: the model, JSON dump (`streams_quiet`),
  sparkline history and remembered names keep every quiet stream, an unknown rate is
  never treated as quiet, and one byte on the wire returns the card instantly. `ended`
  (transceiver-proven) remains the only thing that removes a stream from the model.
- **1.7.0 also fixed five audited 1.6.7 bugs**, each with a regression test: chart
  death after a skeleton rebuild landed mid-hover; minimise silently stopping
  name-proving (names are now proven in `tick()`, the model phase); the pre-media msid
  group wipe sticking for the whole call via the SDP-text cache; per-stream counter
  resets rendering as a proven `0 kbps` and polluting totals and sparklines; and a
  missing `run()` re-entry guard leaking a second collection loop. Riding along:
  proven 0 ms jitter renders as `0.0 ms`, hover tooltips read the frozen curve's own
  samples, rates use `performance.now()`, null history samples draw as chart gaps,
  Zoom channel rows use neutral icon colour, drag/resize use pointer events (touch
  works), panel position/size persist per origin, and media inside open shadow roots
  is discovered and named (closed roots fail closed to SSRC labels). A newer
  injection now REPLACES a stale running instance instead of toggling it (same
  version still toggles) — an extension reload does not swap a script already
  injected into a long-lived call tab, and that stale-toggle trap is exactly how a
  13-hour tab kept showing pre-1.6.7 behaviour; `build.sh` fails if the source
  VERSION and manifest diverge.
- **Google Meet:** release and dev builds use one persistent `chrome.debugger` session
  per armed tab; a guarded document-start preload plus protocol-level
  `Runtime.queryObjects` feeds live connections into `adopt()`. Detached inbound audio
  may be paired by numeric mid rank on the exact `meet.google.com` host only, always
  marked `(likely)`, failing closed on any incomplete/duplicate/conflicting evidence.
- **Airion/Aloqa naming:** stable `participant-tile` / `participant-name` hooks, the
  bounded fail-closed LiveKit/React fiber bridge for detached audio, people-panel rows
  for off-grid participants, msid-group borrowing for detached sinks, remembered
  per-track names that survive tile churn, and the self tile for otherwise
  evidence-less outgoing cards.
- **Zoom Web App:** document-start shim in the inner PWA frame stashes closure-private
  connections; the two exact media DataChannel labels produce one meeting-wide Audio
  and one Video row, both `(estimated)`, with fail-closed null/idle/reset semantics
  and neutral `Connected` quality. No debugger, reload or heap query on Zoom.
- Automated suites pass: `names-unit.js` **81/81**, `background-unit.js` **18
  scenarios**, `stats-unit.js` **12 scenarios** (loss/ICE/quality, ended-vs-quiet,
  counter resets, jitter-zero, msid-group healing, quiet hysteresis), plus the
  zoom-media, zoom-background, zoom-capture, manifest and launcher suites. The
  real-Chrome Playwright suite `run.js` passes **132/132 checks across 27 isolated
  browser runs** (**21 scenario groups**), now including chart-hover survival,
  minimised name-proving, quiet hide/reveal/resume, and shadow-DOM discovery.
  `run.js`/`names.js` auto-pick macOS Chrome; set `$CHROMIUM` to override, and run
  with `NODE_PATH` pointing at a Playwright install
  (`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm i playwright`).

**Live validation baseline:** 1.7.0 was validated live on staging Aloqa on
2026-08-28, via a callrig call (workspace `W4QAF1XTURESO01`, host + two call-bots
guests): muted self audio named through the self tile (`the page's own self tile`
tooltip), bot camera off → inbound card quiet-hidden within ~4 s and back instantly
on camera on, host camera off → outbound card quiet-hidden while the audio card
kept its name, an SFU pause (window hidden) hid both videos and fronting the window
brought them back, and Spotlight view named the 1920px high-res subscription
correctly. 1.6.x history: live-validated on Airion (two-party and 40-participant
calls), Meet (debugger capture, Leave → Return recovery, OPUS/AV1 telemetry) and
Zoom Web App (estimated channel rows, no banner).

**Distribution (new in 1.7.1):** the project is a public git repo at
`github.com/mahmudcoding/rtc-stream-monitor`. `node scripts/release.mjs <semver>`
cuts a release; `scripts/install-agent.sh` gives an unpacked checkout real
auto-update (launchd pulls twice daily, the extension restarts itself once per
browser start to pick it up). The twice-daily version check is live now that the
repo is public — it badges the toolbar `↑` and never installs anything — and
`releases/latest/download/stream-monitor-extension.zip` is a no-auth install
link that can be sent to anyone.
`store/SUBMISSION.md` plus `node scripts/store-assets.mjs` hold the complete
Chrome Web Store kit — the only route to silent auto-update for arbitrary users,
blocked solely on the one-time $5 registration.

**Not tested yet, in priority order:**

1. **Panel position/size persistence across the Meet reload loop**, and a Meet/Zoom
   smoke pass of 1.7.0 (Aloqa is done; Meet/Zoom paths are unchanged but unsmoked).
2. **A real call on `airion-cargo.online`** — the monitor injects there cleanly, but no
   call has been run; needs an account.
3. Whether simulcast layer tagging holds up on an app that *does* set `rid` (Meet does
   not, so layers are numbered by shared track id).

**How we work:** keep answers short and direct, and deliver changes as files rather than
pasting large blobs into the page. The dev extension is loaded unpacked from
`extension-dev/`; after `./build.sh`, use Computer Use to reload it in
`chrome://extensions`, then reload/rejoin the target page. Batch fixes into one reload.
On Meet, use screenshots/accessibility state only: a second CDP inspection evicts the
extension's own debugger session.
