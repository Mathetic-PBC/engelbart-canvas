# Dependency-install diagnostics — 2026-09-23 (Pacific)

This was a diagnostic-only pass. No application/runtime code, private configuration,
active preview, or published template was changed. Existing uncommitted application
changes were preserved. All times below measure installation, **not** total time from
GitHub URL to preview. Clone, agent work, fingerprinting and startup are excluded.

The follow-up [real-agent end-to-end benchmark](sandbox-e2e-benchmark.md) includes
clone, the actual local Claude subscription, install, launch and public preview
verification. Its results are separate from the install-only measurements here.

## Required Rope comparison

Repository: `mqo00/rope` at `1ada01830031e5882f2585577720b182deac6246` from
`scripts/sandbox-cache/profile.json`; install directory: `system`.

All commands below include `--prefer-offline --timing`.

| Case | Template | npm command | Trial 1 | Trial 2 | Trial 3 | Median | Mean |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| A | engelbart-runner | install | 59.424 s | 59.526 s | 54.020 s | 59.424 s | 57.657 s |
| B | engelbart-canvas-cached | install | 47.358 s | 55.759 s | 55.677 s | 55.677 s | 52.931 s |
| C | engelbart-canvas-cached | ci | 50.958 s | 52.824 s | 58.512 s | 52.824 s | 54.098 s |
| D | engelbart-canvas-cached | ci --no-audit | 15.535 s | 16.582 s | 17.764 s | 16.582 s | 16.627 s |

All 12 commands exited **0**. No `npm ci` failure or fallback occurred. All installed
732 package records with the same location/version/integrity fingerprint:
`ab4468696a09568954c65fcec3f40a07a770b1e65bcfb1f34236b19c0bea7ee3`.
Actual installed versions matched their lock entries; input manifests/lockfiles
and tracked files were unchanged by installation.

On each case's third trial, `npm run dev` successfully served HTTP 200 HTML on port
3333. The startup checks took 9.1–14.4 seconds, **separate from install time**. No
application secrets were supplied; AI/database operations were not tested.

Measured conclusions:

- C → D isolates inline auditing: median **52.824 → 16.582 s**, a **36.242 s / 68.6%**
  reduction. All three audit-off trials were faster than every audit-on trial.
- B → C does **not** establish a useful `ci` speedup: the median improves 5.1%, but
  the mean worsens 2.2%, with overlapping trial ranges and inconsistent paired results.
  Do not switch agent-selected installs to `ci` solely for speed on this evidence.
- A → B shows a modest cache benefit while auditing is enabled, but auditing masks
  much of the potential gain. The historical roughly 54-second cached result is
  reproduced by B's 55.7-second median.

## What consumes the time

Median npm timers, in seconds. **Columns overlap; do not add them.**

| Case | idealTree | reify:unpack | reify:audit | auditReport:getReport | auditReport:init | reify:build |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| A: runner install | 0.273 | 57.826 | 47.871 | 0.762 | 47.080 | 0.043 |
| B: cached install | 0.287 | 53.688 | 49.198 | 2.216 | 45.147 | 0.044 |
| C: cached ci | 0.131 | 51.300 | 46.566 | 4.075 | 42.487 | 0.040 |
| D: cached ci, no audit | 0.149 | 15.244 | not run | not run | not run | 0.045 |

**Resolving:** lockfile/tree processing is well under a second, not the bottleneck.

**Fetching:** A records 705–709 tarball cache-miss fetches per trial, mostly from
`cdn.npmmirror.com`, as specified by this pinned lockfile. B/C record **zero tarball
fetches**, but 76 metadata/security fetch log records per trial. D records **zero
HTTP fetch log records**. These are npm log observations, not a network packet trace.
Do not sum request durations into a network wall time. npm also emits `http cache`
"cache hit" messages in cold runs before later cache-miss fetches; the summarizer
deliberately excludes those labels from its fetch evidence.

**Auditing:** npm's bulk security request is not the whole cost. Most of the audit
timer is `auditReport:init`, including advisory/metavulnerability calculation and
metadata work. For example, C trial 1 records a 21.791-second
`metavuln:load:security-advisory:@typescript-eslint/parser` timer. That is audit work,
not an install lifecycle script. These nested timers are not additive.

Whole-process median user CPU drops from **51.08 s** in C to **12.84 s** in D;
system CPU is **11.58 vs 11.28 s**. This supports a substantial CPU component to
inline audit overhead, rather than treating all elapsed time as downloads. These
counters cover npm and its children; they do not isolate per-phase CPU use.

**Extracting/writing:** after removing auditing, `reify:unpack` occupies roughly
15.2 of 16.6 seconds. This includes cache reads, integrity/decompression/extraction,
filesystem creation and waiting/concurrency overhead. npm does **not** expose a
separate pure file-writing wall time. D records about 2,020,576 filesystem output
blocks and 11.3 system CPU seconds per trial, confirming substantial filesystem
work, but not proving disk bandwidth is the limit. `next`, `lucide-react`,
`@iconify/json`, and `@mui/material` are among the longest package timers; those
timers run concurrently and do not rank isolated per-package costs reliably.

**Lifecycle scripts:** scripts and devDependencies were enabled in every trial.
Rope emitted no dependency lifecycle-script events; its 29–47 ms build phase is
mostly linking/bookkeeping. Disabling scripts would not explain or safely unlock
the observed gain. `reify:save` is only about 0.1–0.2 seconds for `install`; its absence
in `ci` is not the cause of the large audit-off improvement.

The interpretation was checked against the installed npm **10.9.8** source:
[reify](https://github.com/npm/cli/blob/v10.9.8/workspaces/arborist/lib/arborist/reify.js)
starts auditing before unpacking and awaits it later; package extraction uses
`pacote.extract`.
[AuditReport](https://github.com/npm/cli/blob/v10.9.8/workspaces/arborist/lib/audit-report.js)
separates report fetching from advisory initialization.
[npm timing documentation](https://docs.npmjs.com/cli/v10/using-npm/logging/)
describes the raw millisecond timing JSON retained here.

## Prior requested audit-on/off check: Rope and Cocoa

This separate first suite used the original runner, `npm install --timing`, with
and without `--no-audit`. Two fresh trials per case, audit on/off then off/on.
`prefer-offline` was identically false here; do not combine these samples with
the required four-case suite above.

| Repository | Audit on trials | Audit off trials | Mean on → off | Interpretation |
| --- | --- | --- | --- | --- |
| Rope | 55.361, 61.096 s | 22.019, 27.122 s | 58.229 → 24.571 s | 57.8% less install time |
| Cocoa Canvas | 17.049, 15.014 s | 14.771, 17.154 s | 16.032 → 15.963 s | No meaningful observed gain |

All eight installs succeeded with identical packages within each repository.
Cocoa was pinned to `e49079a413497d4fe363af4e8a6e6fefd7539597`, with 641 installed
package records, fingerprint
`bc5942ab0e9055a93d4c49d41a991215846c275c749a14bafd52ed576666e278`.

Cocoa's `npm install` rewrote `package-lock.json` identically in every trial
(including the later startup recheck): SHA-256
`396eeca89f69f4db9b97004f4d2fe3ce8f9e2957c9c066c21bf038ddea2e9cf3` before,
`4ee058d8e423ae2cb834fb932fbc3508f83479eb4b8116e51cc9cdc905b9f08b` after.
Its package manifests and installed versions matched across cases. This is a
test-clone lockfile rewrite, not a Canvas/local repository edit. The exact lockfile
diff was not captured. The summaries compare both before and after hashes and
report `inputs_unchanged: false` for Cocoa, rather than concealing the mutation.
Every Rope install preserved its original input hashes.

Rope's audit-on and audit-off startup checks passed. Both initial Cocoa startup
checks timed out because this diagnostic initially probed only IPv4 while Vite
bound localhost on IPv6; their raw failed probe records are preserved, not erased.
The app logs showed both Vite and the backend running. The diagnostic now probes
IPv4 and IPv6; a separate fresh-sandbox audit-off recheck passed in **1.087 seconds**
at `http://[::1]:5173/`, returning HTTP 200 HTML and the same package fingerprint.
That extra sample is not included in the two-trial install averages. No application
network binding or runtime code was changed to accommodate the test.

## Supplemental cache control and recommendation

Audit deferral is **already present in this working tree**: the managed installer
sets `npm_config_audit=false`, and `worker.cjs` schedules the separate read-only
audit after preview readiness. The default template is still `engelbart-runner`;
the local configuration has neither `E2B_TEMPLATE` nor `E2B_DOCKER_TEMPLATE` set.
It would be misleading to recommend implementing audit deferral again.

To isolate the genuinely next increment, six additional fresh Rope sandboxes ran
the **identical** `npm ci --prefer-offline --no-audit --timing` command, original
versus cached template. Order: original/cached, cached/original, original/cached.
These samples are not pooled into the required four-case results.

| Template | Trial 1 | Trial 2 | Trial 3 | Median | Mean |
| --- | ---: | ---: | ---: | ---: | ---: |
| engelbart-runner | 31.378 s | 20.371 s | 21.890 s | 21.890 s | 24.546 s |
| engelbart-canvas-cached | 16.236 s | 13.955 s | 17.943 s | 16.236 s | 16.045 s |

All six exited 0 with the same 732-package fingerprint, unchanged manifests and
matching configuration/resources/runtimes. Both third-trial app checks passed.
Cold runs recorded 703–706 tarball fetches; cached runs recorded none.

**Measured cache gain after auditing is removed:** median **5.654 seconds / 25.8%**
less install time. Paired gains ranged **3.947–15.142 seconds**; the 31.378-second
cold outlier raises the mean improvement to 8.502 seconds. Use the more conservative
roughly **5–6-second** expectation for this pinned Rope case, not a guaranteed
8.5-second saving.

### ONE recommended next change — opt into the existing warm template

Use the already-published cached template for a controlled rollout starting with
new Rope sandboxes, retaining the existing audit deferral. **Not applied here.**

The only configuration file needed is
`/Users/divadbaroon/.engelbart/sandbox.env`:

```dotenv
E2B_TEMPLATE=engelbart-canvas-cached
E2B_DOCKER_TEMPLATE=engelbart-runner-docker
```

The explicit Docker value preserves the current Docker template; without it,
`src/main/sandbox/worker.cjs` derives a nonexistent `engelbart-canvas-cached-docker`
name. No edits to that worker, `src/main/sandbox/local-install.cjs`, the agent
prompts, package manifests or seed profile are needed for this opt-in. No template
rebuild is needed. Instructions live in `docs/sandbox-cache.md`.

Compatibility/rollout risks:

- The setting selects the template for **all subsequently created non-Docker
  sandboxes**, not only Rope. Start with controlled Rope runs rather than changing
  the code's global default; other repos do not yet have this post-audit cache
  comparison. The earlier Hypocompass cache benchmark regressed slightly.
- Exact performance depends on cache coverage, hardware and the agent's chosen
  command. The 5–6-second measured increment is for the pinned Rope revision and
  the tested `ci` command, not arbitrary future repositories or end-to-end previews.
- Cache misses still download normally; scripts and devDependencies remain enabled.
  Cached content is not an installed application or a replacement for its lockfile.
  Changes in required Node/native-module runtimes still require the normal setup
  logic. Existing previews are unaffected; the setting only affects new sandboxes.
- Do not infer that every repo can use `npm ci`: npm rejects mismatched manifests
  and lockfiles and requires compatible shape-affecting install flags. Rope passed;
  this pass does not justify changing the agent's command selection globally.
  [npm ci documentation](https://docs.npmjs.com/cli/v10/commands/npm-ci/)

**Hypothesis, not measured:** snapshotting installed files or reducing extraction
work could attack the remaining roughly 15 seconds in the warm audit-off case.
No benefit or compatibility has been established for that; it is not the next
recommended implementation. Do not pre-bake `node_modules` or skip scripts/dev
packages on the strength of this diagnostic.

## Controls, evidence, and limitations

- Required run order: **A B C D / D C B A / B C D A**. Every trial used a fresh
  sandbox and clean `node_modules`; no measured VM was reused. Trials were serial.
- Every VM reported **8 CPUs / 8192 MiB**, Linux x64, **Node 22.23.2, npm 10.9.8,
  Python 3.11.6**. Original template ID: `zyc96dk7q7adnb1uzy40`; cached template ID:
  `5mqfzddjuicidc1w92y5`. The published templates were not rebuilt or changed.
- The baseline npm cache started at 0 KiB; cached trials at 329,232 KiB with seed
  profile `c0f1d0ec8e7f363619160720a55334cd78e1336a2759e3d1c610902fd1b4140d`.
- Identical isolated npm user/global configuration files were used in disposable
  VMs. Inherited `npm_config_*` and `NODE_ENV` were cleared. Scripts were explicitly
  enabled, devDependencies included, audit enabled except the intended treatment,
  and cache/log paths fixed. Full effective npm configurations compare identically
  after excluding the deliberate audit variable. Persistent template/local npm
  configuration was not modified.
- The four-case suite and cache control use the same Python resource-counter
  wrapper. Outer wall time includes its small startup overhead in every case.
  CPU/IO counters were unavailable for the earlier audit suite because
  `/usr/bin/time` was absent; no counter values were invented for it.
- The scripts invoke no Claude agent and supply no application/API credentials
  to the repositories. Only the controller reads the existing E2B credential.
- Three trials are a small controlled sample, not a confidence interval or an
  end-to-end performance guarantee. Host contention, npm registry/advisory data,
  network and filesystem effects may vary. Exact network-vs-disk-vs-CPU wall-time
  attribution is unknown; npm timers overlap and resource counters are aggregate.
- Package fingerprints compare locations, lockfile versions/integrity and actual
  installed manifest versions. They are not byte-for-byte hashes of every file.

Evidence directories contain controller `report.json`, computed `summary.json`,
and per-trial `measurement.json`, full `npm-config.json`, original npm timing/debug
logs, stdout/stderr, input hashes, `packages.json`, resource counters and startup
logs/HTML where tested. Each trial also retains the exact remote collector and
specification it executed.

- [Required four-case report](benchmarks/2026-09-23-rope-install-diagnostic/report.json)
- [Required four-case summary](benchmarks/2026-09-23-rope-install-diagnostic/summary.json)
- [Audit-on/off report](benchmarks/2026-09-23-install-audit/report.json)
- [Audit-on/off summary](benchmarks/2026-09-23-install-audit/summary.json)
- [Audit-off cache control report](benchmarks/2026-09-23-rope-cache-after-audit/report.json)
- [Audit-off cache control summary](benchmarks/2026-09-23-rope-cache-after-audit/summary.json)
- [Cocoa startup recheck](benchmarks/2026-09-23-cocoa-startup-recheck/report.json)

Final verification: **27 unique test sandboxes, all 27 installations exited 0,
all 27 sandbox deletions confirmed**, and no diagnostic execution errors. The two
initial Cocoa IPv4-only probe failures are explicitly retained above. Only these
test sandboxes and their test app processes were removed; no active user previews
were stopped. The sandboxes are gone, but their captured evidence remains here.
All 15 focused diagnostic/cache tests pass, syntax checks pass, and
`git diff --check` passes. No production application behavior was edited this pass.

Diagnostic-only files added:

- `scripts/benchmark-sandbox-installs.cjs` — fresh sandbox orchestration and cleanup.
- `scripts/sandbox-diagnostics/npm.cjs` — controlled install, timers, fingerprints,
  CPU/IO counters and local app startup check.
- `scripts/sandbox-diagnostics/summarize.cjs` — comparability checks and summaries.
- `scripts/sandbox-diagnostics/verify-cocoa.cjs` — isolated IPv6-aware startup recheck.
- `test/sandbox-install-diagnostics.test.cjs` — configuration, ordering, log parsing
  and cleanup regression tests.
- `docs/benchmarks/.gitignore` — retains diagnostic `.log` evidence for review.
- This report and its linked benchmark artifacts.

`docs/sandbox-cache.md` was also updated with a link to this diagnostic; its
activation instructions remain unchanged. Changes/results are saved locally for
review, not committed.

Reproduction (each output directory must be new; these use billed E2B compute):

```sh
node scripts/benchmark-sandbox-installs.cjs --suite audit --output /tmp/engelbart-audit-new
node scripts/benchmark-sandbox-installs.cjs --suite rope --output /tmp/engelbart-rope-new
node scripts/benchmark-sandbox-installs.cjs --suite cache --output /tmp/engelbart-cache-control-new
node scripts/sandbox-diagnostics/verify-cocoa.cjs --output /tmp/engelbart-cocoa-smoke-new
node scripts/sandbox-diagnostics/summarize.cjs /tmp/engelbart-rope-new/report.json
node --test test/sandbox-install-diagnostics.test.cjs test/sandbox-cache.test.cjs
```
