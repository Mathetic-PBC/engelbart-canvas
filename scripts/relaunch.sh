#!/bin/sh
# Restart Engelbart deterministically: quit every running copy started from this checkout,
# rebuild, launch, and confirm it is up. Always uses the real data root (~/.engelbart).
#
#   npm run relaunch                 # rebuild + repackage, then open release/…/Engelbart.app (~40 s)
#   npm run relaunch -- --dev        # rebuild, then run `electron .` in the background (~5 s, same ~/.engelbart)
#   npm run relaunch -- --no-build   # skip the rebuild / repackage step
#
# Both forms read and write ~/.engelbart. Only scripted test runs should ever set
# ENGELBART_HOME_DIR; this script clears it so a stray shell export cannot point the app elsewhere.
set -eu
cd "$(dirname "$0")/.."
REPO="$PWD"
APP="$REPO/release/Engelbart-darwin-arm64/Engelbart.app"
PACKAGED="$APP/Contents/MacOS/Engelbart"
DEV_BIN="$REPO/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
LOG="$HOME/Library/Logs/Engelbart-dev.log"
DEV=0
BUILD=1
for arg in "$@"; do
  case "$arg" in
    --dev) DEV=1 ;;
    --no-build) BUILD=0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done
unset ENGELBART_HOME_DIR ENGELBART_CONFIRM_ALL

quit() { # $1: full-command-line pattern
  if ! pgrep -f "$1" >/dev/null 2>&1; then return 0; fi
  echo "quitting $(pgrep -f "$1" | tr '\n' ' ')"
  pkill -f "$1" || true
  i=0
  while pgrep -f "$1" >/dev/null 2>&1; do
    i=$((i + 1))
    if [ "$i" -ge 20 ]; then echo "force-quitting"; pkill -9 -f "$1" || true; sleep 1; break; fi
    sleep 0.5
  done
}

quit "$PACKAGED"
quit "$DEV_BIN"

if [ "$DEV" = 1 ]; then
  [ "$BUILD" = 1 ] && npm run build
  mkdir -p "$(dirname "$LOG")"
  nohup npx electron . >"$LOG" 2>&1 &
  PATTERN="$DEV_BIN"
  WHAT="electron . (log: $LOG)"
else
  [ "$BUILD" = 1 ] && npm run package
  [ -x "$PACKAGED" ] || { echo "no packaged app at $APP — run without --no-build" >&2; exit 1; }
  open "$APP"
  PATTERN="$PACKAGED"
  WHAT="$APP"
fi

i=0
while ! pgrep -f "$PATTERN" >/dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -ge 40 ]; then echo "Engelbart did not start" >&2; exit 1; fi
  sleep 0.5
done
MODE=$(sed -n 's/.*"testMode": *\([a-z]*\).*/\1/p' "$HOME/.engelbart/config.json" 2>/dev/null || true)
echo "Engelbart is running: $WHAT"
echo "data root: ~/.engelbart (test mode: ${MODE:-unknown}; test data under ~/.engelbart/test)"
