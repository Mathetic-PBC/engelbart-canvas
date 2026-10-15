#!/bin/bash
# bash scripts/test-install-mac.sh (after npm run dist:mac). Real runs of scripts/install-mac.sh against the beta build served on 127.0.0.1, into scratch folders only
# (ENGELBART_INSTALL_DIR, ENGELBART_NO_OPEN=1). Never /Applications.
set -u
WT=$(cd "$(dirname "$0")/.." && pwd)
S=$(mktemp -d "${TMPDIR:-/tmp}/engelbart-install-test.XXXXXX")
rm -rf "$S"; mkdir -p "$S"
INSTALLER="$WT/scripts/install-mac.sh"
WANT=$(awk '/^version:/ {print $2; exit}' "$WT/release/upload/latest-mac.yml")
WANT=$(awk '/^version:/ {print $2; exit}' "$WT/release/upload/latest-mac.yml")
cd "$WT/release/upload" && python3 -m http.server 8799 --bind 127.0.0.1 >/dev/null 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null' EXIT
sleep 1
export ENGELBART_DOWNLOADS=http://127.0.0.1:8799/ ENGELBART_NO_OPEN=1 ENGELBART_FORCE=1 ENGELBART_HOST_PID=none
pass=0; failn=0
ok() { echo "PASS $*"; pass=$((pass+1)); }
no() { echo "FAIL $*"; failn=$((failn+1)); }
ver() { /usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$1/Engelbart.app/Contents/Info.plist" 2>/dev/null; }

# 1. fresh install
D="$S/fresh"; mkdir -p "$D"
ENGELBART_INSTALL_DIR="$D" bash "$INSTALLER" >"$S/1.log" 2>&1
[ "$(ver "$D")" = "$WANT" ] && ok "fresh install" || { no "fresh install"; tail -3 "$S/1.log"; }

# 2. replace an existing copy (a marked older one)
D="$S/replace"; mkdir -p "$D"; ENGELBART_INSTALL_DIR="$D" bash "$INSTALLER" >/dev/null 2>&1
/usr/libexec/PlistBuddy -c 'Set :CFBundleShortVersionString 0.1.0' "$D/Engelbart.app/Contents/Info.plist"
ENGELBART_INSTALL_DIR="$D" bash "$INSTALLER" >"$S/2.log" 2>&1
[ "$(ver "$D")" = "$WANT" ] && [ -z "$(ls -A "$D" | grep -v '^Engelbart.app$')" ] && ok "replace, no leftovers" || { no "replace"; ls -A "$D"; tail -3 "$S/2.log"; }

# 3. killed at random moments: there is always an Engelbart.app afterwards (old or new), never none
D="$S/kill"; mkdir -p "$D"; ENGELBART_INSTALL_DIR="$D" bash "$INSTALLER" >/dev/null 2>&1
for i in $(seq 1 12); do
  /usr/libexec/PlistBuddy -c 'Set :CFBundleShortVersionString 0.1.0' "$D/Engelbart.app/Contents/Info.plist" 2>/dev/null
  ENGELBART_INSTALL_DIR="$D" bash "$INSTALLER" >/dev/null 2>&1 &
  P=$!
  sleep "$(awk -v r=$RANDOM 'BEGIN{printf "%.2f", 0.3 + (r % 60) / 10}')"
  sig=$([ $((i % 2)) = 0 ] && echo HUP || echo TERM)
  kill -$sig $P 2>/dev/null; wait $P 2>/dev/null
  # the next run tidies what a cut-short run left
  [ -d "$D/Engelbart.app" ] || ls -A "$D" | grep -q '^\.Engelbart.app.old-' || { no "kill $i ($sig): no Engelbart.app and nothing to restore"; ls -A "$D"; continue; }
  ENGELBART_INSTALL_DIR="$D" bash "$INSTALLER" >/dev/null 2>&1
  [ "$(ver "$D")" = "$WANT" ] && [ -z "$(ls -A "$D" | grep -v '^Engelbart.app$')" ] && ok "kill $i ($sig) then rerun: installed, tidy" || { no "kill $i rerun"; ls -A "$D"; }
done

# 4. run from inside an "Engelbart" (its own terminal): hands off, installs once that Engelbart quits
D="$S/host"; mkdir -p "$D" "$S/FakeHost/Engelbart.app/Contents/MacOS"; ENGELBART_INSTALL_DIR="$D" bash "$INSTALLER" >/dev/null 2>&1
/usr/libexec/PlistBuddy -c 'Set :CFBundleShortVersionString 0.1.0' "$D/Engelbart.app/Contents/Info.plist"
/bin/bash -c "ENGELBART_HOST_PID=\$\$ ENGELBART_INSTALL_DIR='$D' bash '$INSTALLER'; sleep 3" >"$S/4.log" 2>&1 &
HOST=$!
sleep 2
[ "$(ver "$D")" = 0.1.0 ] && ok "while its Engelbart is open: old copy untouched" || no "host: replaced too early ($(ver "$D"))"
grep -q "Quit Engelbart" "$S/4.log" && ok "says to quit Engelbart" || { no "host message"; cat "$S/4.log"; }
wait $HOST; sleep 4
[ "$(ver "$D")" = "$WANT" ] && [ -z "$(ls -A "$D" | grep -v '^Engelbart.app$')" ] && ok "after its Engelbart quit: installed, tidy" || { no "host install"; ls -A "$D"; }

echo "== $pass passed, $failn failed"
