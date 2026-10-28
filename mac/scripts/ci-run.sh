#!/bin/bash
# Runs on the cloud macOS runner only (.github/workflows/swift-cloud-test.yml), never on a developer's Mac.
#   ci-run.sh <Package> [filter]   build + test one package under mac/Packages (filter = swift test --filter)
#   ci-run.sh all                  every package, a summary at the end
#   ci-run.sh app                  bundle Engelbart.app, launch it with ENGELBART_SNAPSHOT, collect the PNGs
# Output lands in ./ci-out (uploaded as the run's artifact). Runs under macOS bash 3.2: an empty array is "unbound" under
# set -u, so arrays are expanded as ${a[@]+"${a[@]}"}.
set -uo pipefail
target=${1:-all}
filter=${2:-}
root=$(cd "$(dirname "$0")/../.." && pwd)
out="$root/ci-out"
mkdir -p "$out"

test_package() {
  local pkg=$1 dir="$root/mac/Packages/$1"
  [ -f "$dir/Package.swift" ] || { echo "CI: no package mac/Packages/$pkg"; return 2; }
  echo "::group::build $pkg"
  (cd "$dir" && swift build --build-tests 2>&1)
  local built=$?
  echo "::endgroup::"
  if [ $built -ne 0 ]; then
    echo "CI RESULT $pkg: BUILD FAILED"
    (cd "$dir" && swift build --build-tests 2>&1 | grep -E 'error:' | sort -u | head -60)
    return 1
  fi
  local args=()
  [ -n "$filter" ] && args=(--filter "$filter")
  (cd "$dir" && swift test --skip-build ${args[@]+"${args[@]}"} 2>&1 | tee "$out/$pkg-test.log")
  local tested=${PIPESTATUS[0]}
  if [ $tested -eq 0 ]; then echo "CI RESULT $pkg: PASS"; else
    echo "CI RESULT $pkg: TESTS FAILED"
    grep -E "error: |failed \(|XCTAssert|✘" "$out/$pkg-test.log" | head -80
  fi
  return $tested
}

run_app() {
  local bundle="$root/mac/scripts/bundle.sh"
  [ -x "$bundle" ] || [ -f "$bundle" ] || { echo "CI RESULT app: no mac/scripts/bundle.sh yet"; return 2; }
  echo "::group::bundle"
  bash "$bundle" 2>&1
  local built=$?
  echo "::endgroup::"
  [ $built -eq 0 ] || { echo "CI RESULT app: BUNDLE FAILED"; return 1; }
  local app
  app=$(find "$root/mac/build" -maxdepth 2 -name 'Engelbart.app' -type d | head -1)
  [ -n "$app" ] || { echo "CI RESULT app: no Engelbart.app under mac/build"; return 1; }
  local data
  data=$(mktemp -d)
  mkdir -p "$out/snapshots"
  local drive=()
  [ -n "$filter" ] && [ -f "$root/$filter" ] && drive=(ENGELBART_DRIVE="$root/$filter")
  env ENGELBART_ROOT_DIR="$data/root" ENGELBART_HOME_DIR="$data/home" ENGELBART_SNAPSHOT="$out/snapshots" \
    ENGELBART_TOOLS=off ${drive[@]+"${drive[@]}"} "$app/Contents/MacOS/Engelbart" > "$out/app.log" 2>&1 &
  local pid=$!
  local waited=0
  while kill -0 $pid 2>/dev/null && [ $waited -lt 180 ]; do sleep 2; waited=$((waited + 2)); done
  if kill -0 $pid 2>/dev/null; then kill -9 $pid; echo "CI RESULT app: TIMED OUT after 180 s"; tail -40 "$out/app.log"; return 1; fi
  wait $pid
  local status=$?
  ls -la "$out/snapshots"
  tail -40 "$out/app.log"
  if [ $status -eq 0 ]; then echo "CI RESULT app: PASS (exit 0)"; else echo "CI RESULT app: EXIT $status"; fi
  return $status
}

case "$target" in
  app) run_app; exit $? ;;
  all)
    failed=()
    for dir in "$root"/mac/Packages/*/; do
      pkg=$(basename "$dir")
      test_package "$pkg" || failed+=("$pkg")
    done
    echo "CI SUMMARY: ${#failed[@]} failing: ${failed[*]:-none}"
    [ ${#failed[@]} -eq 0 ] ;;
  *) test_package "$target"; exit $? ;;
esac
