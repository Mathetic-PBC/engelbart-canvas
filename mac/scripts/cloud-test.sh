#!/bin/bash
# Test in the cloud, never on this Mac (Hudson, 2026-10-28). Snapshots the working tree's mac/ and .github/ (other
# agents' unfinished packages included; only the target is built) into a commit made with a TEMPORARY index — the
# worktree, its index, HEAD and the branch are not touched — pushes it to a throwaway branch ci/swift/<target>/<stamp>,
# waits for the GitHub Actions macOS run, prints the result and the failures, and deletes the branch.
#
#   mac/scripts/cloud-test.sh <Package> [--filter <XCTest filter>]   e.g. cloud-test.sh Doc --filter DocTests.LineTests
#   mac/scripts/cloud-test.sh all                                    every package
#   mac/scripts/cloud-test.sh app [--filter <drive script path>]     bundle + launch with ENGELBART_SNAPSHOT
#   mac/scripts/cloud-test.sh --result <run id>                      fetch a run that was still going when the wait ended
# Options: --wait <seconds> (default 540, so one call fits a 10-minute tool timeout; 0 = do not wait).
# Exit status: 0 pass, 1 fail, 3 still running (use --result), 2 usage.
set -uo pipefail
REPO=Mathetic-PBC/engelbart-canvas
root=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
cd "$root" || exit 2

target="" filter="" wait=540 result=""
while [ $# -gt 0 ]; do
  case $1 in
    --filter) filter=$2; shift 2 ;;
    --wait) wait=$2; shift 2 ;;
    --result) result=$2; shift 2 ;;
    -h|--help) sed -n 2,13p "$0"; exit 0 ;;
    *) if [ -z "$target" ]; then target=$1; shift; else echo "unknown argument: $1"; exit 2; fi ;;
  esac
done

report() { # $1 = run id
  local id=$1 dir
  dir=$(mktemp -d -t cloudtest)
  local conclusion url
  conclusion=$(gh run view "$id" --repo $REPO --json conclusion --jq .conclusion)
  url="https://github.com/$REPO/actions/runs/$id"
  gh run download "$id" --repo $REPO -D "$dir" >/dev/null 2>&1
  local log
  log=$(find "$dir" -name ci.log | head -1)
  echo "cloud run: $url  conclusion: ${conclusion:-?}"
  if [ -n "$log" ]; then
    grep -E "^CI (RESULT|SUMMARY)" "$log"
    if [ "$conclusion" != "success" ]; then
      echo "--- failures ---"
      local found
      found=$(grep -E "error:|failed \(|XCTAssert|✘|Fatal error|unbound variable|BUILD FAILED|TIMED OUT" "$log" | grep -v "^::" | sort -u | head -120)
      if [ -n "$found" ]; then echo "$found"; else tail -40 "$log"; fi
    fi
    echo "full log and artifacts: $dir"
  else
    echo "(no log artifact; the job failed before it ran)"
    gh run view "$id" --repo $REPO --log-failed 2>/dev/null | tail -60
  fi
  [ "$conclusion" = "success" ]
}

await() { # $1 = run id, $2 = seconds
  local id=$1 limit=$2 waited=0 status
  while :; do
    status=$(gh run view "$id" --repo $REPO --json status --jq .status 2>/dev/null)
    [ "$status" = "completed" ] && return 0
    [ "$waited" -ge "$limit" ] && return 3
    sleep 20; waited=$((waited + 20))
  done
}

if [ -n "$result" ]; then
  if await "$result" "$wait"; then report "$result"; exit $?; fi
  echo "still running: https://github.com/$REPO/actions/runs/$result — fetch with: mac/scripts/cloud-test.sh --result $result"
  exit 3
fi
[ -n "$target" ] || { sed -n 2,13p "$0"; exit 2; }

stamp=$(date +%Y%m%d-%H%M%S)-$RANDOM
branch="ci/swift/$target/$stamp"
idx=$(mktemp -t cloudtest-index)
trap 'rm -f "$idx"' EXIT
export GIT_INDEX_FILE="$idx"
git read-tree HEAD
git add -A mac .github
request=$(printf '{"target":"%s","filter":"%s"}\n' "$target" "$filter" | git hash-object -w --stdin)
git update-index --add --cacheinfo "100644,$request,mac/.ci-request.json"
tree=$(git write-tree)
unset GIT_INDEX_FILE
commit=$(git commit-tree "$tree" -p HEAD -m "cloud test: $target ${filter}")
# Concurrent pushes from several agents sometimes fail with "remote unpack failed"; a retry after a pause succeeds.
pushed=0
for attempt in 1 2 3 4; do
  if git push -q origin "$commit:refs/heads/$branch" 2>/dev/null; then pushed=1; break; fi
  sleep $((attempt * 7 + RANDOM % 9))
done
[ $pushed -eq 1 ] || { echo "push failed after 4 attempts"; exit 1; }

id=""
for _ in $(seq 1 45); do
  id=$(gh run list --repo $REPO --branch "$branch" --limit 1 --json databaseId --jq '.[0].databaseId' 2>/dev/null)
  [ -n "$id" ] && break
  sleep 4
done
[ -n "$id" ] || { echo "no run started for $branch"; git push -q origin --delete "$branch" 2>/dev/null; exit 1; }
echo "cloud run started: https://github.com/$REPO/actions/runs/$id ($target)"

if await "$id" "$wait"; then
  report "$id"; status=$?
  git push -q origin --delete "$branch" 2>/dev/null || true
  exit $status
fi
echo "still running — fetch with: mac/scripts/cloud-test.sh --result $id"
exit 3
