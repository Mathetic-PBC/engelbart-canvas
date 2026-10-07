#!/bin/bash
# Installs Engelbart on a Mac, or updates it:
#
#   curl -fsSL __DOWNLOADS__install.sh | bash
#
# It downloads the newest version for this Mac from __DOWNLOADS__ (latest-mac.yml there names it
# and gives its checksum), checks it, and puts Engelbart.app in /Applications (in ~/Applications when
# /Applications cannot be written to), replacing the copy that is there. When the copy there is already that version it
# stops without downloading or changing anything (ENGELBART_FORCE=1 installs it again anyway). Projects, notes and
# settings live outside the app (~/.engelbart, ~/Library/Application Support/Engelbart) and are not touched.
#
# A file downloaded with curl is not marked as downloaded from the internet, so macOS opens this app
# without the warning a browser download of an app that is not notarized gets.
#
# The release script (scripts/release-site.mjs) writes the download folder into this file. Set by
# Engelbart when it updates itself (src/main/updates.cjs): ENGELBART_WAIT_PID (the running app, which
# this waits for once the new version is ready, for as long as it stays open: Later in the app means the next quit,
# however many hours away), ENGELBART_APP_PATH (where that app is), ENGELBART_READY_FILE (created at that moment, so
# the app can ask to restart), ENGELBART_REOPEN_FILE (the app creates it for Restart to Update: the new version is
# opened only if it is there once installed, and this removes it; a plain quit after Later installs it and opens
# nothing). Run by hand (no ENGELBART_WAIT_PID), it opens Engelbart afterwards as before. ENGELBART_INSTALL_DIR puts
# it in that folder instead; ENGELBART_NO_OPEN=1 leaves it closed afterwards either way.

set -euo pipefail

DOWNLOADS="${ENGELBART_DOWNLOADS:-__DOWNLOADS__}"
APP="Engelbart.app"
WAIT_PID="${ENGELBART_WAIT_PID:-}"
MIN_MACOS=13

work=""
ready=""
installed=""
cleanup() {
  if [ -n "$work" ]; then rm -rf "$work"; fi
  if [ -n "$WAIT_PID" ] && [ -n "${ENGELBART_REOPEN_FILE:-}" ]; then rm -f "$ENGELBART_REOPEN_FILE"; fi
}
trap cleanup EXIT

say() { printf '%s\n' "$*"; }
fail() {
  printf '\nEngelbart was not installed: %s\n' "$*" >&2
  # An update started from the app, which had been told to quit: the copy that was there opens again. (Before that,
  # the app is still open and reports the failure itself.)
  if [ -n "$WAIT_PID" ] && [ -n "$ready" ] && [ -z "$installed" ] && [ -n "${ENGELBART_APP_PATH:-}" ] && [ -d "$ENGELBART_APP_PATH" ]; then
    wait_for_exit 120 || true
    if should_open; then open "$ENGELBART_APP_PATH" || true; fi
  fi
  exit 1
}

# Returns once no Engelbart is running (or the one being updated has quit); non-zero after $1 seconds. Without $1 it
# waits as long as that takes.
wait_for_exit() {
  local limit=${1:-} waited=0
  while { [ -n "$WAIT_PID" ] && kill -0 "$WAIT_PID" 2>/dev/null; } || { [ -z "$WAIT_PID" ] && pgrep -xq -u "$(id -u)" Engelbart; }; do
    [ -n "$limit" ] && [ "$waited" -ge "$limit" ] && return 1
    sleep 1
    waited=$((waited + 1))
  done
  return 0
}

# Whether to open Engelbart now it is done. Run by the app (ENGELBART_WAIT_PID): only if it quit for Restart to Update,
# which leaves ENGELBART_REOPEN_FILE (taken here); by hand: always. ENGELBART_NO_OPEN=1: never.
should_open() {
  local asked=1
  if [ -n "$WAIT_PID" ]; then
    asked=""
    if [ -n "${ENGELBART_REOPEN_FILE:-}" ] && [ -f "$ENGELBART_REOPEN_FILE" ]; then asked=1; rm -f "$ENGELBART_REOPEN_FILE"; fi
  fi
  [ -n "$asked" ] && [ "${ENGELBART_NO_OPEN:-}" != 1 ]
}

# >>> linux (2026-10-07, docs/windows-port-log.md "Linux"): on Linux the same command installs the Linux app, with
# install-linux.sh from the same folder (scripts/install-linux.sh); nothing below runs there. On a Mac this is skipped.
if [ "$(uname -s)" = Linux ]; then
  linux_installer=$(curl -fsSL "${DOWNLOADS}install-linux.sh?t=$(date +%s)") || fail "could not reach ${DOWNLOADS} (is this computer online?)."
  ENGELBART_DOWNLOADS="$DOWNLOADS" exec bash -c "$linux_installer" install-linux.sh
fi
# <<< linux
[ "$(uname -s)" = Darwin ] || fail "this installer is for macOS."
version_now=$(sw_vers -productVersion)
[ "${version_now%%.*}" -ge "$MIN_MACOS" ] || fail "Engelbart needs macOS $MIN_MACOS (Ventura) or later; this Mac has $version_now."
# Apple silicon, even when this shell runs under Rosetta (then uname -m says x86_64).
if [ "$(sysctl -in hw.optional.arm64 2>/dev/null)" = 1 ]; then arch=arm64; kind="Apple silicon"; else arch=x64; kind="Intel"; fi

work=$(mktemp -d "${TMPDIR:-/tmp}/engelbart-install.XXXXXX")

# The query keeps a cache in front of the folder from answering with an older feed.
feed=$(curl -fsSL --retry 2 --connect-timeout 20 "${DOWNLOADS}latest-mac.yml?t=$(date +%s)") || fail "could not reach ${DOWNLOADS} (is this Mac online?)."
version=$(printf '%s\n' "$feed" | awk '$1 == "version:" { print $2; exit }' | tr -d "\"'\r")
zip="Engelbart-${version}-${arch}.zip"
sha512=$(printf '%s\n' "$feed" | awk -v want="$zip" '$1 == "-" && $2 == "url:" { url = $3 } $1 == "sha512:" && url == want { print $2; exit }' | tr -d "\"'\r")
[ -n "$version" ] && [ -n "$sha512" ] || fail "${DOWNLOADS}latest-mac.yml does not list ${zip}."

# Where it goes: where the app being updated is, unless that is a disk image or a read-only copy macOS made of it;
# else where Engelbart already is; else /Applications, or ~/Applications for an account that cannot write there.
writable_home() { case "$1" in /Volumes/*|*/AppTranslocation/*) return 1;; esac; [ -w "$1" ]; }
dest=""
if [ -n "${ENGELBART_INSTALL_DIR:-}" ]; then dest="$ENGELBART_INSTALL_DIR"; mkdir -p "$dest"
elif [ -n "${ENGELBART_APP_PATH:-}" ] && writable_home "$(dirname "$ENGELBART_APP_PATH")"; then dest=$(dirname "$ENGELBART_APP_PATH")
elif [ -d "/Applications/$APP" ] && [ -w /Applications ]; then dest=/Applications
elif [ -d "$HOME/Applications/$APP" ]; then dest="$HOME/Applications"
elif [ -w /Applications ]; then dest=/Applications
else dest="$HOME/Applications"; mkdir -p "$dest"
fi

# Already the newest: nothing to do (and Engelbart need not quit). The app's own updater (ENGELBART_WAIT_PID) runs this
# only when there is a newer version, so it is never skipped; ENGELBART_FORCE=1 installs again anyway.
if [ -z "$WAIT_PID" ] && [ "${ENGELBART_FORCE:-}" != 1 ] && [ -f "$dest/$APP/Contents/Info.plist" ]; then
  current=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$dest/$APP/Contents/Info.plist" 2>/dev/null || true)
  if [ "$current" = "$version" ]; then
    say "Engelbart ${version} is already installed in ${dest} and up to date."
    exit 0
  fi
fi

say "Downloading Engelbart ${version} for ${kind} Macs…"
curl -fL --retry 2 --connect-timeout 20 --progress-bar -o "$work/$zip" "${DOWNLOADS}${zip}" || fail "the download did not finish; run the command again."
[ "$(openssl dgst -sha512 -binary "$work/$zip" | openssl base64 -A)" = "$sha512" ] || fail "the download does not match its checksum; run the command again."
ditto -x -k "$work/$zip" "$work/new" || fail "the download could not be unpacked."
[ -d "$work/new/$APP" ] || fail "the download holds no $APP."
codesign --verify --deep --strict "$work/new/$APP" 2>/dev/null || fail "the app in the download is not intact (its signature does not verify)."

if [ -n "$WAIT_PID" ]; then
  ready=1
  if [ -n "${ENGELBART_READY_FILE:-}" ]; then : > "$ENGELBART_READY_FILE"; fi
  say "Ready; Engelbart ${version} is installed when Engelbart quits."
  wait_for_exit
elif pgrep -xq -u "$(id -u)" Engelbart; then
  say "Engelbart is open. Quit it (Engelbart ▸ Quit Engelbart, or ⌘Q) and the install will go on."
  wait_for_exit 600 || fail "Engelbart was still open after 10 minutes. Quit it and run the command again."
fi

if [ -e "$dest/$APP" ]; then mv "$dest/$APP" "$work/previous.app" || fail "could not replace $dest/$APP."; fi
if ! mv "$work/new/$APP" "$dest/$APP"; then
  [ -e "$work/previous.app" ] && mv "$work/previous.app" "$dest/$APP"
  fail "could not write to $dest."
fi
installed=1
xattr -dr com.apple.quarantine "$dest/$APP" 2>/dev/null || true

say "Engelbart ${version} is installed in ${dest}."
if should_open; then open "$dest/$APP"; fi
