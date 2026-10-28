#!/bin/bash
# Runs mac/build/Engelbart.app's self-test (SelfTest.swift) on a scratch data root and returns its exit status. For the
# cloud runner (mac/scripts/cloud-test.sh); do not run it on Hudson's Mac (testing happens in the cloud).
#   mac/scripts/selftest.sh <out dir> [drive script.json]
# Writes <out>/window-<n>.png, <out>/windows.json, <out>/drive-report.json (with a script), <out>/stderr.log. Everything
# the app writes goes under <out>: ENGELBART_ROOT_DIR, ENGELBART_HOME_DIR and ENGELBART_USER_DATA_DIR point there, so it
# never reads or writes the runner's real folders. Extra ENGELBART_* variables pass through (ENGELBART_SHELL_DEMO,
# ENGELBART_SHELL_SETTINGS, ENGELBART_TEST_MODE…). Build the bundle first: ENGELBART_DEVELOPER=1 mac/scripts/bundle.sh
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
MAC="$(dirname "$HERE")"
OUT="${1:?usage: selftest.sh <out dir> [drive.json]}"
DRIVE="${2:-}"
APP="$MAC/build/Engelbart.app"
mkdir -p "$OUT/root" "$OUT/home" "$OUT/userdata"
OUT="$(cd "$OUT" && pwd)"

env_args=(ENGELBART_ROOT_DIR="$OUT/root" ENGELBART_HOME_DIR="$OUT/home" ENGELBART_USER_DATA_DIR="$OUT/userdata"
          ENGELBART_TOOLS=off ENGELBART_WEB_PDFS=off ENGELBART_SNAPSHOT="$OUT")
if [ -n "$DRIVE" ]; then env_args+=(ENGELBART_DRIVE="$(cd "$(dirname "$DRIVE")" && pwd)/$(basename "$DRIVE")"); fi

env "${env_args[@]}" "$APP/Contents/MacOS/Engelbart" >"$OUT/stdout.log" 2>"$OUT/stderr.log" &
PID=$!
# The app quits by itself; a hung run is stopped after a minute.
( sleep "${ENGELBART_SELFTEST_KILL:-60}"; kill "$PID" 2>/dev/null ) &
WATCH=$!
set +e
wait "$PID"
STATUS=$?
set -e
kill "$WATCH" 2>/dev/null || true
echo "self-test exit $STATUS; pictures in $OUT"
exit "$STATUS"
