#!/usr/bin/env bash
# Install RTC Stream Monitor so it keeps itself up to date.
#
# Chrome only auto-updates extensions installed from the Web Store, and never
# an unpacked one. This gives an unpacked install the same effect in two parts:
# a launchd agent pulls this repository twice a day, and the extension restarts
# itself once per browser start to pick up whatever was pulled. So: updates land
# the next time you start Chrome.
#
#   ./scripts/install-agent.sh            # use this checkout
#   ./scripts/install-agent.sh --uninstall
set -euo pipefail

LABEL="com.mahmudcoding.rtc-stream-monitor.update"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG="$HOME/Library/Logs/rtc-stream-monitor-update.log"

if [ "${1:-}" = "--uninstall" ]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || launchctl unload "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
  echo "auto-update agent removed."
  exit 0
fi

command -v git >/dev/null || { echo "git is required" >&2; exit 1; }
git -C "$REPO_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1 || {
  echo "$REPO_DIR is not a git checkout — clone the repository first:" >&2
  echo "  git clone https://github.com/mahmudcoding/rtc-stream-monitor.git" >&2
  exit 1
}

mkdir -p "$(dirname "$PLIST")" "$(dirname "$LOG")"
cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>-lc</string>
    <!-- Fast-forward only: a local edit is never silently discarded. -->
    <string>cd '$REPO_DIR' &amp;&amp; git fetch --quiet origin &amp;&amp; git merge --ff-only --quiet origin/HEAD 2>/dev/null || git merge --ff-only --quiet '@{u}'</string>
  </array>
  <key>StartInterval</key><integer>43200</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
PLISTEOF

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null || launchctl load "$PLIST"

VERSION="$(node -e "console.log(require('$REPO_DIR/extension/manifest.json').version)" 2>/dev/null || echo '?')"
cat <<DONE

RTC Stream Monitor $VERSION — auto-update agent installed.

  pulls        twice a day, and at login
  from         $(git -C "$REPO_DIR" remote get-url origin 2>/dev/null || echo 'origin')
  into         $REPO_DIR
  log          $LOG

One-time step — load the extension in Chrome:

  1. open  chrome://extensions
  2. turn on  Developer mode
  3. Load unpacked  ->  $REPO_DIR/extension

From then on updates apply the next time you start Chrome.
Remove with:  $REPO_DIR/scripts/install-agent.sh --uninstall
DONE
