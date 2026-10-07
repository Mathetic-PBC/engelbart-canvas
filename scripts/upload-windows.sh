#!/bin/bash
# Uploads a Windows release to the R2 bucket behind https://mathetic.com/engelbart/, next to the Mac's (2026-10-07,
# docs/windows-port-log.md "One-command install"). `npm run upload:win [commit]`, from the Mac, like `npm run upload:mac`.
#
# The installer is made by CI on windows-latest (scripts/package-windows.mjs), not here: this takes it and its feed,
# latest.yml, from the green CI run of the commit (HEAD unless one is given; `gh run download`), checks they are for the
# version package.json gives, and writes release/upload-win/ (scripts/release-site.mjs): those, the install command
# (install.ps1), SHA256SUMS-windows.txt and the download page as it is live with its Windows section. Then the Mac's
# uploader (scripts/upload-release.sh) sends it the same way: the same bucket and folder, 5 MiB parts each retried, the
# installer checked against latest.yml as stored, and latest.yml last.
#
# UPLOAD_DRY_RUN=1 lists what it would send and uploads nothing.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
PUBLIC=${ENGELBART_R2_PUBLIC:-https://pub-a9bcd559068e4e0e9f1e04b4d9b85df7.r2.dev/engelbart} # the bucket's r2.dev URL
DOWNLOADS="${ENGELBART_DOWNLOAD_URL:-https://mathetic.com/engelbart}"; DOWNLOADS="${DOWNLOADS%/}/"
COMMIT=$(git -C "$ROOT" rev-parse "${1:-HEAD}")
VERSION=$(node -p "require(process.argv[1]).version" "$ROOT/package.json")
FROM="$ROOT/release/win-ci"
fail() { echo "The Windows release was not uploaded: $1"; exit 1; }

command -v gh >/dev/null || fail "gh (the GitHub CLI) is not installed."
RUN=$(cd "$ROOT" && gh run list --workflow ci.yml --commit "$COMMIT" --status success --limit 1 --json databaseId --jq '.[0].databaseId // empty') || fail "could not ask GitHub for CI runs (is \`gh auth login\` done?)."
[ -n "$RUN" ] || fail "no green CI run for ${COMMIT:0:7}; push it and wait for CI, or name another commit."
echo "Engelbart $VERSION for Windows from CI run $RUN (${COMMIT:0:7})"
rm -rf "$FROM"
(cd "$ROOT" && gh run download "$RUN" --name engelbart-windows-installer --dir "$FROM") || fail "could not download the installer from CI run $RUN."
[ -f "$FROM/latest.yml" ] || fail "CI run $RUN kept no latest.yml (it predates \`npm run dist:win\` in CI)."
BUILT=$(awk '/^version:/ {print $2; exit}' "$FROM/latest.yml" | tr -d "'\"")
[ "$BUILT" = "$VERSION" ] || fail "CI run $RUN built $BUILT, but package.json says $VERSION."

curl -fsSL "$PUBLIC/index.html?nc=$RANDOM" -o "$FROM/live-index.html" || fail "could not read the live download page, $PUBLIC/index.html."
node "$ROOT/scripts/release-site.mjs" windows "$FROM" "$VERSION" "$DOWNLOADS" "$FROM/live-index.html" "$ROOT/release/upload-win" >/dev/null || fail "release/upload-win/ could not be written."
UPLOAD_FEED=latest.yml UPLOAD_COMMAND="irm ${DOWNLOADS}install.ps1 | iex" exec bash "$ROOT/scripts/upload-release.sh" "$ROOT/release/upload-win"
