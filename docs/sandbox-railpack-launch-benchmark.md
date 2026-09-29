# Compact Railpack discovery and immediate readiness

Complete: 2026-09-24, 08:36–08:51 UTC. **18/18 trials passed** the independent
preview and required-backend checks. All 18 benchmark VMs and the separate discovery
probe VM were cleaned up. This is an **incremental comparison** against the current
optimized implementation, not the earlier historical baseline.

Evidence: [report](benchmarks/2026-09-24-railpack-early-ready-e2e/comparison/report.json)
· [strict summary](benchmarks/2026-09-24-railpack-early-ready-e2e/comparison/summary.json)
· [launch timings](benchmarks/2026-09-24-railpack-early-ready-e2e/comparison/launch-summary.json)
· [read-only Railpack probe](benchmarks/2026-09-24-railpack-early-ready-e2e/discovery-probe/probe.json).

## End-to-end results

Seconds, including the **real local Claude agent**, startup and independent checks.
Trials are listed in round order. Lower is better.

| Repository | Current optimized trials | New trials | Median, current → new | Median reduction |
| --- | --- | --- | --- | --- |
| Rope | 55.080 / 56.102 / 60.144 | 61.112 / 47.475 / 44.864 | **56.102 → 47.475** | **8.627s / 15.4%** |
| Cocoa Canvas | 39.003 / 37.495 / 27.069 | 36.917 / 26.218 / 28.620 | **37.495 → 28.620** | **8.875s / 23.7% observed*** |
| Hypocompass | 59.767 / 87.647 / 58.087 | 53.610 / 49.701 / 53.913 | **59.767 → 53.610** | **6.157s / 10.3%** |

Means, current → new: Rope **57.109 → 51.150s**, Cocoa **34.522 → 30.585s**,
Hypocompass **68.500 → 52.408s**. Three trials are a small sample: the new Rope
round 1 and Cocoa round 3 were slower than their paired baselines. These are measured
bundle results, not a promise of the same gain for every repository or run.

*Cocoa's new agent selected `npm install` in rounds 1/2 and rewrote the disposable
checkout's `package-lock.json`. Its installed 641-package fingerprint still matched
all baseline trials; round 3 used `npm ci` with no tracked changes. Strict source
equivalence therefore fails, and the automated strict-speedup fields correctly remain
null. The 23.7% is an observed median, not a controlled source-identical speedup.
The real user's checkout was not changed by any benchmark agent.

Rope and Hypocompass **pass strict source/runtime/model/package equivalence** across
both variants: no tracked source changes, matching manifests, and matching fingerprints.
Rope installed 732 Node packages; Hypocompass installed 2,097 Node packages and 25 Python
distributions, including the same pip version. All trials passed on their first app
launch; none required a launch retry or API fallback. Hypocompass's backend was present
and responsive in all six runs—unlike the frontend-only case in the earlier benchmark.

## Where the time changed

Independent medians in seconds; **do not add these columns**. Agent work overlaps
installation, and these are not paired causal estimates of each feature.

| Repository | Agent start → first install, old → new | Install job, old → new | Install end → first launch, old → new | Launch → verified tool result, old → new |
| --- | --- | --- | --- | --- |
| Rope | 9.026 → 3.753 | 18.907 → 18.988 | 9.638 → 3.226 | 12.454 → 12.147 |
| Cocoa | 11.429 → 5.341 | 13.338 → 13.737 | 0.526 → 0.516 | 2.072 → 2.207 |
| Hypocompass | 24.381 → 3.739 | 15.074 → 15.708 | 13.469 → 7.371 | 12.795 → 16.793 |

The install medians did **not** become faster. The main measured improvements are
earlier install/launch decisions and removing the final-response wait from readiness.
Hypocompass still spent a median 7.4s after installation before its first launch and
16.8s inside startup/checking; this does not eliminate agent variance or compilation.

The existing install-to-launch handoff was exercised in 5/9 baseline runs and 4/9 new
runs. All Cocoa runs queued launch during installation, with the launch beginning
about half a second after install success. No new Hypocompass run queued its launch
early; those agents prepared foreground multi-service launch scripts after installation.
All six Hypocompass runs used the managed parallel npm/Python installer. Thus the new
result is not evidence that Railpack guarantees immediate launch after every install.

Previously the median delay from a successful `start_app` result to worker ready was
**3.384s / 3.387s / 2.104s** for Rope/Cocoa/Hypocompass. Now the ready event precedes
the tool reply by approximately **9–11ms**, as intended. Claude's final response finished
**2.254–10.636s after readiness** in the new runs; those seconds no longer delay the
notification/URL. Every new run emitted exactly one ready event, made no post-ready
tool calls, and the Claude session still completed successfully. Late-error, queued
mutation and app-exit paths are covered by unit tests rather than injected into these
normal E2B timing trials.

## Discovery cost and context size

| Repository | Median discovery wall time | JSON provided to Claude | Raw Railpack plan + info |
| --- | --- | --- | --- |
| Rope | 2.505s | 895 bytes | 5,173 bytes |
| Cocoa | 2.536s | 1,544 bytes | 6,203 bytes |
| Hypocompass | 3.543s | 1,597 bytes | 9,466 bytes |

Discovery wall time includes helper upload, transport, bounded manifest scanning and
cold Railpack preparation; it overlaps the deterministic preflight. The earlier probe's
individual Railpack invocations were about 0.1–1.3s, so CLI time alone understates the
actual added pipeline cost. The raw JSON is formatted, while the supplied JSON is
compact and also includes selected manifest facts; these byte figures are **not token
counts**. Complete prompt sizes were 10,512 / 11,585 / 11,214 bytes, versus baseline
8,238 / 8,662 / 8,238 bytes. No full plan entered Claude's context.

This two-bundle comparison cannot isolate the gain caused by Railpack from the prompt
changes or early publication. The smaller pre-install decision times are consistent
with the discovery hints helping, but an isolated causal claim would require an ablation.

## Changes under test

- Emit the existing ready event as soon as `start_app` verifies the app and public
  preview. Do not wait for the final Claude response/recheck. Fence agent mutations
  after publication, retain process supervision/cancellation, and prohibit late API
  fallback. Finalization is bounded to 30 seconds and is not a readiness prerequisite.
- Prepare launch decisions earlier using compact discovery facts. Prefer an existing
  development launch when supported, read only missing launch facts, prepare required
  backend services too, and retain the guarded install-to-launch handoff.
- Run the installed Railpack CLI before Claude, concurrently with the existing install
  preflight. This is plan discovery only, not `railpack build` or another model call.

## Context budget

An allowlist retains component paths, selected manifest scripts, lockfiles, workspace/
runtime declarations, local proxy routing, evidence paths, Railpack providers/runtime/
package-manager hints, install/build/start hints, and warnings. Excluded: build assets,
layer/copy graphs, caches, environment values, secret lists and resolved default runtime
versions. Railpack's defaults do not change the sandbox runtime. Production commands
are explicitly advisory; the agent must choose a valid preview recipe.

Maximum 12 KB JSON, eight manifest components, three analyzed install roots, three
directory levels, 120 visited directories, six seconds per Railpack process in parallel.
Failures/timeouts/incomplete scans are explicit and hand missing facts back to Claude.
No repo scripts are executed during discovery. The plan/info files are temporary and
outside the repository. The retained read-only probe uses public fixture repositories.

## Controlled protocol

- Three trials per variant per pinned repository (18 fresh E2B VMs); alternating
  variant order and rotating repository order.
- Byte-identical frozen pre-change baseline, verified against hashes before copying.
  The new implementation is separately frozen. No edits to either during testing.
- Both variants use `engelbart-canvas-cached`, required 8 CPU / 8192 MiB, same local
  Claude CLI/model/subscription. API fallback disabled. No app secrets supplied.
- Verified actual values in every trial: template `5mqfzddjuicidc1w92y5`, 8 CPU /
  8192 MiB, Node `v22.23.2`, npm `10.9.8`, Python `3.11.6`, model `claude-sonnet-5`,
  warm seed present and `prefer-offline=true`. Local CLI: Claude Code `2.1.280`;
  E2B SDK `2.49.1`; MCP SDK `1.30.0`. The installed Railpack version was `0.39.0`.
- Timer: worker request through independent public HTTP 200 HTML plus required local
  backend checks. The preview-only timestamp is also retained. Agent final-message
  draining, package evidence collection and owned-VM cleanup are outside timing.
- Cocoa: owned backend port 3001, `/api/health`, HTTP 200 with expected JSON.
  Hypocompass: owned Flask port 8090, `/`, HTTP 200 with expected login content.
  These expectations come from the pinned repository source; no services are started
  or repaired by the benchmark. A frontend-only result is partial, not successful.
- These checks do not prove all UI interactions, proxy routing, database/LLM features,
  authentication or required credentials work. Renderer/IPC/notification paint excluded.
- Capture installed-package fingerprints, manifest hashes, tracked source changes,
  actual runtimes/model, tool timings, install/launch handoff, discovery overhead and
  context bytes. Failed/partial trials are retained, not silently retried.
- Existing user previews, configuration and published templates remain untouched.

Reproduce:

```sh
node scripts/benchmark-sandbox-pipeline.cjs \
  --baseline current \
  --baseline-snapshot docs/benchmarks/2026-09-24-railpack-early-ready-e2e/baseline-implementation.json \
  --output NEW_DIRECTORY --rounds 3
```

## Local verification

**142 sandbox tests pass**, as do the production build and `git diff --check`.
The application runtime hashes still match the frozen new implementation after testing.
The complete test suite also runs, but two
untouched `test/launch.test.cjs` terminal-provider discovery tests fail in this shell:
the installed Claude path wins over the alias fixture, and the sign-in fixture returns
false instead of true. Neither that test file nor `src/main/terminal/launch.cjs` was
modified in this work. No unrelated terminal/authentication changes were made.

## Application files changed in this pass

- `src/main/sandbox/launch-discovery.{cjs,py}`: bounded remote discovery and allowlisted
  context, with graceful fallback when Railpack is unavailable or unsupported.
- `src/main/sandbox/local-setup.cjs`: run discovery before Claude, prepare launch earlier,
  publish after successful checks, and bound final-message completion separately.
- `src/main/sandbox/local-tools.cjs`: freeze queued/future setup mutations after readiness.
- `src/main/sandbox/worker.cjs`: emit ready once immediately, keep supervision active,
  and prevent a late final-message failure from starting API fallback.

Tests, diagnostic harness/snapshot/service-check/summary scripts, and documentation were
also added/updated. No library schema, runtime template, worker authentication, README,
Repo UI, navigation, environment restart recipe format or published configuration changed.
