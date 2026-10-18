#!/bin/bash
# Uploads a Linux release to the R2 bucket behind https://mathetic.com/engelbart/, next to the Mac's and Windows' (2026-10-07,
# docs/windows-port-log.md "Linux"). `npm run upload:linux [commit]`, from the Mac, like `npm run upload:win`.
#
# The AppImage is made by CI on ubuntu-latest (scripts/package-linux.mjs), not here: this takes it and its feed,
# latest-linux.yml, from the green CI run of the commit (HEAD unless one is given; `gh run download`), checks they are
# for the version package.json gives, and writes release/upload-linux/ (scripts/release-site.mjs): those,
# install-linux.sh, SHA256SUMS-linux.txt, the download page as it is live with its Linux section, and install.sh as it
# is live with the block that hands Linux to install-linux.sh (with SHA256SUMS.txt's line for it). Then the Mac's
# uploader (scripts/upload-release.sh) sends it the same way: the same bucket and folder, 5 MiB parts each retried, the
# AppImage checked against latest-linux.yml as stored, and latest-linux.yml last.
#
# UPLOAD_DRY_RUN=1 lists what it would send and uploads nothing.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
PUBLIC=${ENGELBART_R2_PUBLIC:-https://pub-a9bcd559068e4e0e9f1e04b4d9b85df7.r2.dev/engelbart} # the bucket's r2.dev URL
DOWNLOADS="${ENGELBART_DOWNLOAD_URL:-https://mathetic.com/engelbart}"; DOWNLOADS="${DOWNLOADS%/}/"
COMMIT=$(git -C "$ROOT" rev-parse "${1:-HEAD}")
VERSION=$(node -p "require(process.argv[1]).version" "$ROOT/package.json")
FROM="$ROOT/release/linux-ci"
fail() { echo "The Linux release was not uploaded: $1"; exit 1; }

command -v gh >/dev/null || fail "gh (the GitHub CLI) is not installed."
# Green: the ubuntu-latest, windows-latest and macos-latest jobs all passed.
RUNS=$(cd "$ROOT" && gh run list --workflow ci.yml --commit "$COMMIT" --status completed --limit 10 --json databaseId --jq '.[].databaseId') || fail "could not ask GitHub for CI runs (is \`gh auth login\` done?)."
RUN=""
for id in $RUNS; do
  [ "$(cd "$ROOT" && gh run view "$id" --json jobs --jq '[.jobs[] | select(.name == "ubuntu-latest" or .name == "windows-latest" or .name == "macos-latest") | select(.conclusion == "success")] | length')" = 3 ] && { RUN=$id; break; }
done
[ -n "$RUN" ] || fail "no green CI run for ${COMMIT:0:7}; push it and wait for CI, or name another commit."
echo "Engelbart $VERSION for Linux from CI run $RUN (${COMMIT:0:7})"
rm -rf "$FROM"
(cd "$ROOT" && gh run download "$RUN" --name engelbart-linux-appimage --dir "$FROM") || fail "could not download the AppImage from CI run $RUN."
[ -f "$FROM/latest-linux.yml" ] || fail "CI run $RUN kept no latest-linux.yml."
BUILT=$(awk '/^version:/ {print $2; exit}' "$FROM/latest-linux.yml" | tr -d "'\"")
[ "$BUILT" = "$VERSION" ] || fail "CI run $RUN built $BUILT, but package.json says $VERSION."

for f in index.html install.sh SHA256SUMS.txt; do
  curl -fsSL "$PUBLIC/$f?nc=$RANDOM" -o "$FROM/live-$f" || fail "could not read the live $f, $PUBLIC/$f."
done
node "$ROOT/scripts/release-site.mjs" linux "$FROM" "$VERSION" "$DOWNLOADS" "$FROM/live-index.html" "$FROM/live-install.sh" "$FROM/live-SHA256SUMS.txt" "$ROOT/release/upload-linux" >/dev/null || fail "release/upload-linux/ could not be written."
UPLOAD_FEED=latest-linux.yml UPLOAD_COMMAND="curl -fsSL https://mathetic.com/engelbart | bash" exec bash "$ROOT/scripts/upload-release.sh" "$ROOT/release/upload-linux"
