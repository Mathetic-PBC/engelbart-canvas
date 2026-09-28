#!/bin/sh
# Restart Engelbart deterministically: quit every running copy started from this checkout,
# rebuild, launch, and confirm it is up. Always uses the real data root (~/.engelbart).
#
#   npm run relaunch                 # quit, rebuild + repackage, open release/…/Engelbart.app (~40 s)
#   npm run relaunch -- --dev        # quit, rebuild, run `electron .` in the background (~5 s, same ~/.engelbart)
#   npm run relaunch -- --no-build   # quit and reopen only
#   npm run relaunch -- --dry-run    # say what would happen, touch nothing
#   npm run relaunch -- --new-mac    # --dev, pretending Claude Code and Codex are not installed and Git is Engelbart's own: the setup dialog
#                                    # shows as on a new Mac; installs are pretend (2.5 s) and nothing is written to
#                                    # config.json. Agents cannot run in this mode: relaunch without it afterwards.
#
# It can be run from a terminal INSIDE Engelbart (for instance from a Claude Code session there).
# Quitting Engelbart closes that terminal and everything in it, this script included, so in that
# case the work continues in a detached copy that survives the terminal. Progress goes to
# ~/Library/Logs/Engelbart-relaunch.log; resume an agent session afterwards with `claude -r`.
#
# Both forms read and write ~/.engelbart. Only scripted test runs should ever set
# ENGELBART_HOME_DIR; this script clears it so a stray shell export cannot point the app elsewhere.
# Both keep test mode: the package is a developer build (ENGELBART_DEVELOPER=1, src/main/developer.cjs).
# A package built any other way, which is what ships, has no test mode.
set -eu
cd "$(dirname "$0")/.."
REPO="$PWD"
# `npm run package` (scripts/package-mac.mjs) builds for the architecture node runs as.
if [ "$(node -p process.arch 2>/dev/null)" = arm64 ]; then APP="$REPO/release/mac-arm64/Engelbart.app"; else APP="$REPO/release/mac/Engelbart.app"; fi
PACKAGED="$APP/Contents/MacOS/Engelbart"
OLD_PACKAGED="$REPO/release/Engelbart-darwin-arm64/Engelbart.app/Contents/MacOS/Engelbart" # electron-packager's, before 2026-09-28
DEV_BIN="$REPO/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
DEV_LOG="$HOME/Library/Logs/Engelbart-dev.log"
RELAUNCH_LOG="$HOME/Library/Logs/Engelbart-relaunch.log"
DEV=0
BUILD=1
DRY=0
NEWMAC=0
for arg in "$@"; do
  case "$arg" in
    --dev) DEV=1 ;;
    --no-build) BUILD=0 ;;
    --dry-run) DRY=1 ;;
    --new-mac) DEV=1; NEWMAC=1 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done
unset ENGELBART_HOME_DIR ENGELBART_CONFIRM_ALL
unset ENGELBART_TOOLS_FAKE
if [ "$NEWMAC" = 1 ]; then export ENGELBART_TOOLS_FAKE='{"git":"bundled","claude":"missing","codex":"missing"}'; fi

# Is one of this shell's ancestors an Engelbart started from this checkout?
inside_engelbart() {
  pid=$$
  while [ -n "$pid" ] && [ "$pid" != "0" ] && [ "$pid" != "1" ]; do
    command=$(ps -o command= -p "$pid" 2>/dev/null || true)
    case "$command" in
      "$PACKAGED"*|"$OLD_PACKAGED"*|"$DEV_BIN"*) return 0 ;;
    esac
    pid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ' || true)
  done
  return 1
}

# pgrep/pkill leave out their own ancestors unless told otherwise (-a); inside Engelbart the app
# IS an ancestor, and skipping it made an earlier version of this script report "did not start".
running() { pgrep -a -f "$1" 2>/dev/null | grep -v "^$$\$" || true; }

quit() { # $1: full-command-line pattern
  [ -n "$(running "$1")" ] || return 0
  echo "quitting $(running "$1" | tr '\n' ' ')"
  pkill -a -f "$1" || true
  i=0
  while [ -n "$(running "$1")" ]; do
    i=$((i + 1))
    if [ "$i" -ge 20 ]; then echo "force-quitting"; pkill -9 -a -f "$1" || true; sleep 1; break; fi
    sleep 0.5
  done
}

if [ "$DRY" = 1 ]; then
  if inside_engelbart; then echo "this shell runs inside Engelbart: the restart would continue detached (log: $RELAUNCH_LOG) and this terminal would close"; else echo "this shell is outside Engelbart: the restart would run here"; fi
  echo "packaged copies running: $(running "$PACKAGED" | tr '\n' ' ')$(running "$OLD_PACKAGED" | tr '\n' ' ')"
  echo "dev copies running: $(running "$DEV_BIN" | tr '\n' ' ')"
  echo "would: quit them$( [ "$BUILD" = 1 ] && { [ "$DEV" = 1 ] && echo ', npm run build' || echo ', npm run package (a developer build)'; } ), then $( [ "$DEV" = 1 ] && echo 'run electron .' || echo "open $APP" )"
  exit 0
fi

if [ -z "${ENGELBART_RELAUNCH_DETACHED:-}" ] && inside_engelbart; then
  mkdir -p "$(dirname "$RELAUNCH_LOG")"
  echo "This terminal is inside Engelbart, so it will close when Engelbart quits."
  echo "The restart continues in the background; log: $RELAUNCH_LOG"
  echo "Resume a Claude Code session afterwards with: claude -r"
  ENGELBART_RELAUNCH_DETACHED=1 nohup sh "$0" "$@" >"$RELAUNCH_LOG" 2>&1 </dev/null &
  exit 0
fi
[ -n "${ENGELBART_RELAUNCH_DETACHED:-}" ] && { date; sleep 1; }

# An agent session's private variables must not ride into the app (and from there into its terminals).
unset CLAUDECODE CLAUDE_CODE_ENTRYPOINT CLAUDE_CODE_SESSION_ID CLAUDE_CODE_CHILD_SESSION CLAUDE_CODE_EXECPATH CLAUDE_CODE_MESSAGING_SOCKET CLAUDE_CODE_MESSAGING_TOKEN CLAUDE_CODE_SESSION_ATTENDED CLAUDE_PID CLAUDE_EFFORT 2>/dev/null || true

quit "$PACKAGED"
quit "$OLD_PACKAGED"
quit "$DEV_BIN"

if [ "$DEV" = 1 ]; then
  [ "$BUILD" = 1 ] && npm run build
  mkdir -p "$(dirname "$DEV_LOG")"
  nohup npx electron . >"$DEV_LOG" 2>&1 </dev/null &
  PATTERN="$DEV_BIN"
  WHAT="electron . (log: $DEV_LOG)"
else
  [ "$BUILD" = 1 ] && ENGELBART_DEVELOPER=1 npm run package
  [ -x "$PACKAGED" ] || { echo "no packaged app at $APP — run without --no-build" >&2; exit 1; }
  open "$APP"
  PATTERN="$PACKAGED"
  WHAT="$APP"
fi

i=0
while [ -z "$(running "$PATTERN")" ]; do
  i=$((i + 1))
  if [ "$i" -ge 40 ]; then echo "Engelbart did not start" >&2; exit 1; fi
  sleep 0.5
done
MODE=$(sed -n 's/.*"testMode": *\([a-z]*\).*/\1/p' "$HOME/.engelbart/config.json" 2>/dev/null || true)
echo "Engelbart is running: $WHAT"
echo "data root: ~/.engelbart (test mode: ${MODE:-unknown}; test data under ~/.engelbart/test)"
if [ "$NEWMAC" = 1 ]; then echo "pretending a new Mac: Git is the one built into Engelbart, Claude Code and Codex look missing (relaunch without --new-mac to use the real tools)"; fi
