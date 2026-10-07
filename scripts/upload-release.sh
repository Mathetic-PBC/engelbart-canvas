#!/bin/bash
# Uploads a built release (release/upload/, from `npm run dist:mac`) to the R2 bucket behind
# https://mathetic.com/engelbart/ (2026-09-30). `npm run upload:mac`, or `bash scripts/upload-release.sh [folder]`.
#
# Built for a bad link: on 2026-09-30 uploads from this Mac to Cloudflare broke a few MB in (TLS "bad record mac"), so
# one 168 MB PUT never got through. Every file goes up in 5 MiB parts, each part retried on its own until it lands,
# through a temporary Worker with the bucket bound to it (deployed with your `wrangler login`, so no R2 keys are
# needed; a random secret guards it; it is deleted when this exits, however it exits).
#
# Safe to run again: a file of this version already there at its size is skipped. latest-mac.yml, what tells the
# install command and installed apps that the version exists, goes last, and only after both zips there match the
# sha512 it names. Until then the previous version stays live.
#
# UPLOAD_DRY_RUN=1 lists what it would do and uploads nothing.
#
# Windows (2026-10-07): scripts/upload-windows.sh runs this with UPLOAD_FEED=latest.yml on release/upload-win/; the
# feed is then latest.yml and the files it checks the installer. Without UPLOAD_FEED it is the Mac's, as before.
set -uo pipefail

BUCKET=engelbart-releases
PREFIX=engelbart
PUBLIC=${ENGELBART_R2_PUBLIC:-https://pub-a9bcd559068e4e0e9f1e04b4d9b85df7.r2.dev/engelbart} # the bucket's r2.dev URL
FEEDFILE=${UPLOAD_FEED:-latest-mac.yml} # the feed: latest-mac.yml, or the Windows one, latest.yml
FEED=https://mathetic.com/engelbart/$FEEDFILE
COMMAND=${UPLOAD_COMMAND:-curl -fsSL https://mathetic.com/engelbart | bash}
PART=5242880 # R2's smallest part: all parts but the last are this size

ROOT=$(cd "$(dirname "$0")/.." && pwd)
UPLOAD=$(cd "${1:-$ROOT/release/upload}" 2>/dev/null && pwd) || { echo "No release folder at ${1:-$ROOT/release/upload}: run \`npm run dist:mac\` first."; exit 1; }
[ -f "$UPLOAD/$FEEDFILE" ] || { echo "$UPLOAD has no $FEEDFILE: run \`npm run dist:mac\` first."; exit 1; }
VERSION=$(awk '/^version:/ {print $2; exit}' "$UPLOAD/$FEEDFILE")
DRY=${UPLOAD_DRY_RUN:-}

size_of() { stat -f %z "$1"; }
remote_size() { curl -sSI "$PUBLIC/$1?nc=$RANDOM" | awk -F': ' 'tolower($1)=="content-length"{print $2}' | tr -d '\r'; }
type_of() { case $1 in *.zip) echo application/zip ;; *.dmg) echo application/x-apple-diskimage ;; *.exe) echo application/vnd.microsoft.portable-executable ;; *.ps1) echo text/plain ;; *.yml) echo text/yaml ;; *.sh) echo text/x-shellscript ;; *.html) echo text/html ;; *.txt) echo text/plain ;; *) echo application/octet-stream ;; esac; }

# What goes up: this version's files (skipped when already there at their size), then the ones every version shares a
# name for (always sent: SHA256SUMS.txt can change without changing size), the feed last.
VERSIONED=(); SHARED=()
for path in "$UPLOAD"/*; do
  f=$(basename "$path")
  case $f in "$FEEDFILE") ;; *"$VERSION"*) VERSIONED+=("$f") ;; *) SHARED+=("$f") ;; esac
done
echo "Engelbart $VERSION from $UPLOAD → r2://$BUCKET/$PREFIX/ (${#VERSIONED[@]} files of this version, ${#SHARED[@]} shared, then $FEEDFILE)"
if [ -n "$DRY" ]; then
  for f in "${VERSIONED[@]}"; do [ "$(remote_size "$f")" = "$(size_of "$UPLOAD/$f")" ] && echo "  there  $f" || echo "  send   $f ($(size_of "$UPLOAD/$f") bytes)"; done
  for f in "${SHARED[@]}" "$FEEDFILE"; do echo "  send   $f"; done
  echo "Live now: $(curl -sSL "$FEED?nc=$RANDOM" | head -1)"
  exit 0
fi

# The temporary Worker.
W=$(mktemp -d)
cleanup() { [ -f "$W/deployed" ] && (cd "$W" && for i in 1 2 3 4 5; do npx -y wrangler@latest delete --force >/dev/null 2>&1 && { echo "Temporary Worker deleted."; break; }; sleep 2; done); rm -rf "$W"; }
trap cleanup EXIT
cat > "$W/worker.js" <<'EOF'
// Temporary (scripts/upload-release.sh): multipart uploads into the release bucket. Deleted after use.
export default {
  async fetch(request, env) {
    if (request.headers.get('x-upload-secret') !== env.SECRET) return new Response('no', { status: 403 });
    const url = new URL(request.url);
    const key = url.searchParams.get('key');
    if (!key || !key.startsWith(`${env.PREFIX}/`)) return new Response('bad key', { status: 400 });
    const action = url.pathname.slice(1);
    if (action === 'create') {
      const upload = await env.BUCKET.createMultipartUpload(key, { httpMetadata: { contentType: url.searchParams.get('type') || 'application/octet-stream' } });
      return Response.json({ uploadId: upload.uploadId });
    }
    const upload = env.BUCKET.resumeMultipartUpload(key, url.searchParams.get('uploadId'));
    if (action === 'part') return Response.json(await upload.uploadPart(Number(url.searchParams.get('part')), request.body));
    if (action === 'complete') { const object = await upload.complete(await request.json()); return Response.json({ size: object.size }); }
    if (action === 'abort') { await upload.abort(); return new Response('aborted'); }
    return new Response('?', { status: 404 });
  },
};
EOF
printf 'name = "engelbart-r2-upload-tmp"\nmain = "worker.js"\ncompatibility_date = "2026-09-01"\nworkers_dev = true\n[vars]\nPREFIX = "%s"\n[[r2_buckets]]\nbinding = "BUCKET"\nbucket_name = "%s"\n' "$PREFIX" "$BUCKET" > "$W/wrangler.toml"
openssl rand -hex 24 > "$W/secret"; SECRET=$(cat "$W/secret")
cd "$W" || exit 1
retry() { local n=$1; shift; for i in $(seq 1 "$n"); do "$@" && return 0; sleep $((i * 2)); done; return 1; }
echo "Deploying the temporary upload Worker…"
retry 8 sh -c 'npx -y wrangler@latest deploy > deploy.out 2>&1 && grep -q "workers\.dev" deploy.out' || { echo "Could not deploy it (is \`npx wrangler login\` done?):"; tail -5 deploy.out; exit 1; }
touch deployed
retry 8 sh -c 'npx -y wrangler@latest secret put SECRET < secret 2>&1 | grep -qi success' || { echo "Could not set its secret."; exit 1; }
BASE=$(grep -o 'https://[^ ]*workers\.dev' deploy.out | head -1)
for i in $(seq 1 30); do [ "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/")" = 403 ] && break; sleep 2; done # up, and guarded

call() { curl -sS --http1.1 --max-time 120 -H "x-upload-secret: $SECRET" "$@"; }
field() { python3 -c "import sys,json;print(json.load(sys.stdin)['$1'])" 2>/dev/null; }

# put FILE: FILE to PREFIX/FILE in parts, each retried until it lands (60 tries).
put() {
  local f=$1 key="$PREFIX/$1" parts id="" list="[" n=0 etag try total got
  parts=$(mktemp -d)
  if [ "$(size_of "$UPLOAD/$f")" -gt 0 ]; then split -b $PART "$UPLOAD/$f" "$parts/p."; else : > "$parts/p.aa"; fi
  total=$(ls "$parts" | wc -l | tr -d ' ')
  for i in $(seq 1 30); do id=$(call -X POST "$BASE/create?key=$key&type=$(type_of "$f")" | field uploadId); [ -n "$id" ] && break; sleep 2; done
  [ -n "$id" ] || { echo "$f: could not start its upload"; rm -rf "$parts"; return 1; }
  for p in "$parts"/p.*; do
    n=$((n + 1)); etag=""
    for try in $(seq 1 60); do
      etag=$(call -X PUT --data-binary @"$p" "$BASE/part?key=$key&uploadId=$id&part=$n" | field etag)
      [ -n "$etag" ] && break; sleep 1
    done
    [ -n "$etag" ] || { call -X POST "$BASE/abort?key=$key&uploadId=$id" >/dev/null; echo; echo "$f: part $n failed 60 times"; rm -rf "$parts"; return 1; }
    [ "$total" -gt 1 ] && printf '\r  %s: part %d/%d   ' "$f" "$n" "$total"
    list="$list{\"partNumber\":$n,\"etag\":\"$etag\"},"
  done
  rm -rf "$parts"; [ "$total" -gt 1 ] && echo
  for i in $(seq 1 30); do got=$(call -X POST --data "${list%,}]" "$BASE/complete?key=$key&uploadId=$id" | field size); [ -n "$got" ] && break; sleep 2; done
  [ "$got" = "$(size_of "$UPLOAD/$f")" ] || { echo "$f: stored at $got bytes, not $(size_of "$UPLOAD/$f")"; return 1; }
  echo "  ok     $f"
}

for f in "${VERSIONED[@]}"; do
  if [ "$(remote_size "$f")" = "$(size_of "$UPLOAD/$f")" ]; then echo "  there  $f"; continue; fi
  put "$f" || { echo "Stopped at $f. $FEEDFILE was not uploaded, so the previous version stays live; run this again to continue."; exit 1; }
done
for f in "${SHARED[@]}"; do put "$f" || { echo "Stopped at $f; the previous version stays live. Run this again to continue."; exit 1; }; done

# Every zip (or installer) the feed names, as stored, against the sha512 it gives (what the install command checks).
for zip in $(awk '/^ *- url: / {print $3}' "$UPLOAD/$FEEDFILE"); do
  want=$(awk -v z="$zip" '$0 ~ "url: "z {getline; sub(/.*sha512: /, ""); print; exit}' "$UPLOAD/$FEEDFILE")
  for attempt in 1 2 3; do
    got=$(curl -fsSL "$PUBLIC/$zip?nc=$RANDOM" | openssl dgst -sha512 -binary | base64)
    [ -n "$want" ] && [ "$want" = "$got" ] && break
    [ "$attempt" = 3 ] && { echo "$zip as stored still does not match $FEEDFILE; NOT going live."; exit 1; }
    echo "  $zip as stored does not match $FEEDFILE: sending it again"; put "$zip" || exit 1
  done
  echo "  sha512 $zip"
done
put "$FEEDFILE" || { echo "$FEEDFILE did not go up; run this again."; exit 1; }
echo "Live: $(curl -sSL "$FEED?nc=$RANDOM" | head -1)  ·  $COMMAND"
