#!/usr/bin/env bash
# Rebuild every artifact from src/rtc-stream-monitor.js
set -e
cd "$(dirname "$0")"
command -v esbuild >/dev/null || npm i -g esbuild
node --check src/rtc-stream-monitor.js
node --check src/rtc-early-capture.js
# The in-page VERSION drives the upgrade-replaces-stale-instance path; a
# mismatch with the manifest would make new builds toggle old panels again.
V="$(node -e "console.log(require('./extension/manifest.json').version)")"
grep -q "var VERSION = '$V'" src/rtc-stream-monitor.js || {
  echo "src VERSION does not match manifest version $V" >&2; exit 1; }
esbuild src/rtc-stream-monitor.js --minify --target=chrome100 \
        --outfile=dist/rtc-stream-monitor.min.js --log-level=warning
node --check dist/rtc-stream-monitor.min.js
cp src/rtc-stream-monitor.js extension/monitor.js
cp src/rtc-early-capture.js extension/rtc-early-capture.js
# Dev auto-inject build used for live testing — keep its copies in step, or a
# rebuild silently leaves the loaded extension running stale code.
# extension/background.js is canonical; only the manifests differ between them.
[ -d extension-dev ] && cp src/rtc-stream-monitor.js extension-dev/monitor.js
[ -d extension-dev ] && cp src/rtc-early-capture.js extension-dev/rtc-early-capture.js
[ -d extension-dev ] && cp extension/background.js extension-dev/background.js
( cd dist && node make-launcher.js )
rm -f dist/stream-monitor-extension.zip
# Chrome Web Store requires manifest.json at the archive root. Archive the
# directory contents, not the extension/ directory itself; the same ZIP remains
# convenient for local use after extracting it into any folder.
( cd extension && zip -r -q ../dist/stream-monitor-extension.zip . )
unzip -p dist/stream-monitor-extension.zip manifest.json >/dev/null
echo "built v$(node -e "console.log(require('./extension/manifest.json').version)")"
