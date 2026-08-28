#!/usr/bin/env node
// Produce the Chrome Web Store image assets from the real screenshots in
// screenshots/, using macOS `sips` only — no image dependencies.
//
// The store is strict about exact pixel sizes, so every screenshot is fitted
// inside the target and padded on the project's own surface colour rather than
// stretched: a stretched panel screenshot of a measurement tool looks wrong in
// a way that matters here.
//
//   node scripts/store-assets.mjs
import { execFileSync } from 'node:child_process'
import { mkdirSync, existsSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const root = fileURLToPath(new URL('..', import.meta.url))
const out = join(root, 'store/assets')
const SURFACE = '1A1A19'                     // the panel's own surface colour

const sips = (...args) => execFileSync('/usr/bin/sips', args, { encoding: 'utf8', stdio: 'pipe' })

if (!existsSync(join(root, 'screenshots'))) {
  console.error('screenshots/ is missing — run the browser suite first')
  process.exit(1)
}
mkdirSync(out, { recursive: true })

/* Order matters: the first screenshot is the one the store shows first, so
   lead with a real call full of named participant cards. */
const SHOTS = [
  // Lead with the widescreen shot: the whole panel is legible at 1280x800,
  // beside a real grid of named participants. The tall portrait captures fit
  // to only ~723px wide, so they read as thumbnails and belong further down.
  ['aloqa-offgrid-named.png', 'screenshot-1-named-participants.png'],
  ['aloqa-live-call.png', 'screenshot-2-live-call.png'],
  ['aloqa-camera-off.png', 'screenshot-3-camera-off.png'],
  ['test-rtp-scenario.png', 'screenshot-4-per-stream-detail.png'],
  ['launcher-page.png', 'screenshot-5-launcher.png']
]

function dimensions(file) {
  const info = sips('-g', 'pixelWidth', '-g', 'pixelHeight', file)
  return {
    w: Number(/pixelWidth: (\d+)/.exec(info)[1]),
    h: Number(/pixelHeight: (\d+)/.exec(info)[1])
  }
}

function fit(source, target, width, height) {
  /* Scale to fit INSIDE the box, then pad. sips' --resampleHeightWidthMax only
     bounds the larger side, so a tall screenshot came out taller than the box
     and the pad step silently cropped the panel off the top and bottom —
     compute the factor from both sides instead. */
  const { w, h } = dimensions(source)
  const scale = Math.min(width / w, height / h)
  const fitted = { w: Math.max(1, Math.round(w * scale)), h: Math.max(1, Math.round(h * scale)) }
  sips('-s', 'format', 'png', source, '--out', target)
  sips('-z', String(fitted.h), String(fitted.w), target)
  sips('-p', String(height), String(width), '--padColor', SURFACE, target)
  const got = dimensions(target)
  if (got.w !== width || got.h !== height) {
    throw new Error(`${target} came out ${got.w}x${got.h}, wanted ${width}x${height}`)
  }
  return `${got.w}x${got.h}  (fitted ${fitted.w}x${fitted.h} from ${w}x${h})`
}

let made = 0
for (const [from, to] of SHOTS) {
  const source = join(root, 'screenshots', from)
  if (!existsSync(source)) { console.log('  skip (missing) ' + from); continue }
  const target = join(out, to)
  console.log('  ' + to + '  ' + fit(source, target, 1280, 800))
  made++
}

// Small promo tile, required even for an unlisted listing.
const promoSource = join(root, 'screenshots', 'aloqa-offgrid-named.png')
if (existsSync(promoSource)) {
  const target = join(out, 'promo-tile-440x280.png')
  console.log('  ' + 'promo-tile-440x280.png' + '  ' + fit(promoSource, target, 440, 280))
  made++
}

console.log(`\n${made} asset(s) in store/assets — upload these with dist/stream-monitor-extension.zip`)
