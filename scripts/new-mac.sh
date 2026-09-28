#!/bin/sh
# A second Engelbart, beside the one you use, as a new Mac would see it (2026-09-28). Nothing running is quit.
#
#   npm run new-mac                  # rebuild, then open a fresh copy: onboarding, the setup dialog, signed out of GitHub
#   npm run new-mac -- --real-tools  # the same, but the setup dialog sees the tools this Mac really has
#   npm run new-mac -- --no-build
#
# Its Engelbart home is ~/.engelbart/test/.new-mac/root (not ~/.engelbart), and its Electron profile (window state,
# browser cookies, remembered sidebar folds) is ~/.engelbart/test/.new-mac/electron. Both are wiped at every start, so
# each run is a first launch. Your home directory is still yours: file pickers see it, and "Create a folder for me"
# makes ~/<project> there. Git is the one that comes with Engelbart (as in the app people download, on a Mac without
# Apple's developer tools), Claude Code and Codex look missing, and their installs are pretend (nothing is written
# to any config.json); @bart and Build cannot run in the copy. There is no test mode in it, as in the app people
# download (ENGELBART_TEST_MODE=off, src/main/developer.cjs). Close it like any window (⌘Q in it).
set -eu
cd "$(dirname "$0")/.."
DEMO="$HOME/.engelbart/test/.new-mac"
BIN="$PWD/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
LOG="$HOME/Library/Logs/Engelbart-new-mac.log"
BUILD=1
FAKE='{"git":"bundled","claude":"missing","codex":"missing"}'
for arg in "$@"; do
  case "$arg" in
    --no-build) BUILD=0 ;;
    --real-tools) FAKE='' ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

if pgrep -f "user-data-dir=$DEMO/electron" >/dev/null 2>&1; then
  echo "the new-Mac copy is already open; quit it (⌘Q in its window) and run this again" >&2
  exit 1
fi
if [ "$BUILD" = 1 ]; then npm run build; fi

rm -rf "$DEMO" # inside ~/.engelbart/test: throwaway by definition
mkdir -p "$DEMO/root" "$DEMO/electron" "$(dirname "$LOG")"

# An agent session's private variables must not ride into the app; neither may a scripted run's home.
unset CLAUDECODE CLAUDE_CODE_ENTRYPOINT CLAUDE_CODE_SESSION_ID CLAUDE_CODE_CHILD_SESSION CLAUDE_CODE_EXECPATH CLAUDE_CODE_MESSAGING_SOCKET CLAUDE_CODE_MESSAGING_TOKEN CLAUDE_CODE_SESSION_ATTENDED CLAUDE_PID CLAUDE_EFFORT ENGELBART_HOME_DIR ENGELBART_CONFIRM_ALL ENGELBART_TOOLS ENGELBART_TOOLS_FAKE 2>/dev/null || true
export ENGELBART_ROOT_DIR="$DEMO/root"
export ENGELBART_TEST_MODE=off
if [ -n "$FAKE" ]; then export ENGELBART_TOOLS_FAKE="$FAKE"; fi

nohup "$BIN" . --user-data-dir="$DEMO/electron" >"$LOG" 2>&1 </dev/null &
echo "opened a new-Mac copy of Engelbart beside yours (log: $LOG)"
echo "its data: $DEMO (wiped at the next run)"
