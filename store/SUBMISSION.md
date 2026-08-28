# Chrome Web Store submission kit

Everything here is ready to paste. What only you can do: register as a Chrome
Web Store developer (one-time **$5 USD**, your Google account, accept the
developer agreement) at https://chrome.google.com/webstore/devconsole

**Why bother:** a Web Store listing is the only way other people get a one-click
install and *silent automatic updates*. Chrome refuses to install extensions
from anywhere else on Mac and Windows, and never auto-updates an unpacked one —
and the extension itself deliberately ships no update machinery. Publish once,
and every `node scripts/release.mjs` afterwards reaches everyone within hours.

Choose **Unlisted** visibility unless you want it in public search: unlisted
installs normally for anyone with the link, but does not appear in the store.

## Upload

Package: `dist/stream-monitor-extension.zip` (built by `./build.sh`,
`manifest.json` at the archive root, which the store requires).

## Listing copy

**Name**
```
RTC Stream Monitor
```

**Summary** (132 char limit)
```
See every audio and video stream your browser sends and receives on a call: bitrate, codec, resolution, loss, jitter, per person.
```

**Description**
```
RTC Stream Monitor puts a live, draggable panel on any WebRTC call page and
shows you exactly what your browser is sending and receiving.

WHAT YOU SEE
• Round-trip time, quality rating, and the ICE path actually in use
  (direct LAN, direct STUN, or TURN relay)
• Receiving and sending bitrate, packet loss and jitter, each with a plain
  status word rather than a bare number
• A 90-second throughput chart with a hover crosshair, keyboard navigation,
  and a text-table equivalent
• One card per active stream: participant name, codec, resolution, frame rate,
  bitrate with its own sparkline, packet loss, jitter, dropped frames, freezes.
  Audio cards carry a live level meter.
• Transport detail: candidate types, network type, uplink estimate, bytes on
  the wire, DTLS state
• A warning when your encoder is being limited by bandwidth or CPU

ONLY ACTIVE STREAMS
Streams that are provably carrying no media right now — a muted microphone, a
camera switched off, a participant the SFU has paused — drop out of the default
view behind a "+N quiet" toggle, so what is on screen is what is actually
flowing. Nothing is hidden silently and nothing is guessed: an unknown rate is
never treated as inactive, and a single byte on the wire brings a card straight
back.

BUILT TO BE TRUE
Every figure comes from the browser's own WebRTC statistics. Where the data
cannot prove something — whose stream this is, whether a quiet stream has ended
— the panel says so or stays silent rather than guessing. Approximations are
labelled as approximations.

WORKS ON
Google Meet, Zoom's web client, and standard WebRTC applications. Click the
toolbar button on a call to show or hide the panel.

PRIVACY
Everything runs locally in your browser. The extension reads WebRTC statistics
and the page's own participant labels to name streams. It makes no network
requests of its own at all: no call data leaves your machine, there is no
analytics, no account, and no telemetry.
```

**Category:** Developer Tools
**Language:** English

## Permission justifications

The store asks for a justification per permission. These are accurate — keep
them that way.

**`activeTab`**
```
The monitor is injected into the page you are on only when you click the
toolbar button. activeTab scopes that to the tab you explicitly acted on,
rather than requesting access to every site.
```

**`scripting`**
```
Required to inject the monitor overlay into the page's main world. The overlay
must run in the page's own JavaScript context because it reads
RTCPeerConnection statistics, which are not reachable from an isolated content
script.
```

**`debugger`**
```
Required for Google Meet only. Meet defines RTCPeerConnection and its prototype
methods as non-writable and non-configurable and keeps its connection objects
inside Closure-compiled closures, so no page script can reach them at any
injection time. The DevTools protocol's Runtime.queryObjects returns those live
objects from the heap, which is the only way to report Meet call statistics.
The attachment is made only after the user clicks the toolbar button on a Meet
tab, and is released when the tab closes or navigates away. It is not used on
any other site.
```

**`host_permissions` — zoom.us / zoom.com meeting routes**
```
Zoom's web client creates its peer connections inside a same-origin child frame
before an ordinary injection can observe them, so a tiny capture shim must run
at document_start on the meeting route. It creates no UI and only records the
connection objects for the monitor to read statistics from.
```

**Single purpose statement**
```
Display live WebRTC audio and video stream statistics for the call in the
current tab.
```

**Data usage disclosures:** tick nothing. The extension collects no user data,
sells nothing, and transfers nothing to third parties. It qualifies for all
three certification checkboxes.

## Store assets still to produce

- **Screenshots, 1280×800**, at least one, up to five. `screenshots/` already
  has real panel captures; they need padding to exactly 1280×800.
- **Small promo tile, 440×280** (required for unlisted too).
- Icon is already in the package (`icons/icon128.png`).

`node scripts/store-assets.mjs` generates both from the existing screenshots.
