# Full pipeline bundle benchmark

Status: complete. Ran 2026-09-24, 07:11–07:49 UTC. All 18 trials reached an
independently checked public HTTP 200 HTML preview; all 18 owned test sandboxes
were cleaned up. Application runtime files were not changed by this benchmark.

[Raw report](benchmarks/2026-09-24-historical-vs-optimized-e2e/report.json) ·
[Computed summary](benchmarks/2026-09-24-historical-vs-optimized-e2e/summary.json)

## Results

Seconds from worker request through verified public preview, **including the
real local Claude agent**. Trials are listed in round order, not sorted.

| Repository | Historical trials (s) | Optimized trials (s) | Historical median → optimized median |
| --- | --- | --- | --- |
| Rope | 141.077 / 144.257 / 103.807 | 63.593 / 49.995 / 54.812 | **141.077 → 54.812 s** |
| Cocoa Canvas | 256.403 / 314.472 / 373.064 | 25.368 / 42.204 / 37.127 | **314.472 → 37.127 s** |
| Hypocompass | 114.556 / 134.165 / 138.433 | 72.349 / 108.502 / 64.765 | **134.165 → 72.349 s** |

**Important: these are preview-readiness results, not proof of full application
feature parity.** In particular, optimized Hypocompass round 1 started only the
frontend, explicitly leaving its backend off. Do not interpret its three-run
median as an apples-to-apples full-application startup improvement.

### What the results support

- **Rope:** the strict source/runtime/model/package comparison passes. The
  median is **86.265 seconds lower (61.1% less time, 2.57× faster)**. All six
  installs produced the same 732-package fingerprint with no tracked changes.
  This is the cleanest measured combined-bundle speedup in this suite.
- **Cocoa:** the large observed improvement is primarily launch reliability.
  Historical runs made 3 / 4 / 4 launch attempts, including **8 failed attempts**
  in total, versus one successful attempt per optimized run. The old launcher
  probed IPv4 localhost while Vite listened on IPv6 localhost; its failures led
  to duplicate servers, port conflicts and repeated cleanup. The current
  launcher recognizes the owned listener and reaches the preview directly.
  Historical agents changed `client/vite.config.ts` in all three disposable
  copies; `npm install` also rewrote `package-lock.json` in rounds 2 and 3.
  All six still had identical 641-package fingerprints. Strict artifact equality
  therefore fails, so the automated strict-speedup fields remain null. These
  timings describe the complete recovery flow, not a controlled install-only gain.
- **Hypocompass:** all three optimized runs used the independent npm/pip
  parallel installer. Active install-job time fell from a 39.839s median to
  15.946s. All six had identical 2,097-package Node fingerprints. Of the 25
  installed Python distributions, only pip differed: historical round 1
  upgraded to 26.2.1; the other five used 23.2.1. Normalized versions of every
  other distribution matched. There were no tracked source changes.
  However, all historical runs launched both services, whereas optimized round 1
  launched only the frontend. Optimized rounds 2 and 3 launched both, taking
  **108.502s and 64.765s**; round 2 included one failed launch and recovery.
  Backend business features were not independently tested. Both the pip
  difference and service-coverage variation prevent a strict full-app claim.

### Installation and launch handoff

These are independent medians; do not add them to reconstruct total time.
“Install” is the union of worker-managed install-job intervals. For parallel
npm/pip jobs it is elapsed wall time, not the sum of the two subprocesses.
The launch gap ends at the **first attempt**, which may subsequently fail.

| Repository | Install: historical → optimized | Last install completion → first launch: historical → optimized |
| --- | --- | --- |
| Rope | 80.302 → 16.104 s | 14.156 → 0.567 s |
| Cocoa | 16.478 → 13.504 s | 1.992 → 0.523 s |
| Hypocompass | 39.839 → 15.946 s | 38.256 → 6.069 s |

The early handoff was actually exercised in **4 of 9 optimized runs**: Rope
rounds 2/3 and Cocoa rounds 1/2 submitted `start_app` while installation was
still running. The worker waited for successful installation, then began launch
within **0.495–0.567 seconds**, without another Claude turn. Merely passing
`wait_for_install` after installation has ended does not count as early handoff.

It is not universal: optimized Hypocompass round 2 spent 26.653s between install
completion and its first launch, then retried after a startup-script error.
Agent preparation/launch decisions remain a substantial source of variance.
No trial exercised automatic root installation: these repositories all require
agent selection of a nested or workspace install layout.

CLI-reported median API durations were Rope 41.488 → 25.780s, Cocoa
52.149 → 19.628s, and Hypocompass 43.731 → 36.088s. These are **not pure thinking
time**, and agent wall time also contains installation/tool waits. No “percent
thinking” claim can be derived reliably from these fields.

## What is being compared

The baseline is **the exact earliest Git version with local Claude**, `d0cb837`,
as explicitly selected by the user. It already overlapped managed installation
with agent inspection and supported automatic installation for simple roots.
It is therefore a historical, partly optimized baseline—not fully unoptimized.

Baseline runtime/prompt/tool/Python helper sources are byte-identical to that
commit; the optimized sources are frozen copies of the current working tree.
The harness uses the same installed SDK dependencies and local Claude CLI for
both. Historical launch/process-handling behavior is not patched to make tests
pass. Source hashes and the full Git revision are saved in the report.
Application source, configuration and published templates are untouched.

| Feature | Historical baseline | Optimized bundle |
| --- | --- | --- |
| E2B template | `engelbart-runner` | `engelbart-canvas-cached` |
| npm inline audit | Enabled | Deferred until after preview readiness |
| Automatic managed install | Already enabled for simple roots | Enabled for eligible unambiguous roots |
| Inspection during install | Already available in parallel | Available in parallel |
| Independent npm + pip jobs | Sequential | Managed parallel option available |
| Compact install state in tool replies | Disabled | Enabled |
| Submit launch while installing | Disabled | Guarded `wait_for_install` handoff available |
| Local app supervision / health | Historical launcher and IPv4-only check | Owned-process diagnostics, cleanup and IPv4/IPv6-aware health checks |

All three pinned projects have nested or workspace layouts, so an automatic
root install is not expected to activate in either version.
Node/Python parallelism applies to Hypocompass, not Rope or Cocoa. Enabled
capability is not proof the agent used it; actual tool choices are recorded.
This compares the whole saved local-Claude implementation with the current
bundle, including launch-reliability improvements. It cannot isolate the effect
of a prompt, cache, audit policy or process-supervision change on its own. It is
not a comparison against the older API-key/Railpack worker path.

An earlier reconstructed sequential suite was stopped after the user's baseline
choice arrived. Its nine completed trials and one interrupted trial are retained
separately in [preliminary evidence](benchmarks/2026-09-23-full-pipeline-e2e/report.json).
All ten owned test instances were cleaned up. Those measurements are not part
of this historical comparison and will not be mixed into its results.

## Protocol

- Three trials per version per repository: 18 fresh sandboxes total. Alternate
  baseline/optimized order by round and rotate repository order.
- Repository commits and manifest locations come from
  [the pinned profile](../scripts/sandbox-cache/profile.json). Normal clone is
  followed by an exact revision assertion; a different HEAD stops the suite.
- Each instance must report 8 CPUs / 8192 MiB. Actual template IDs, runtime
  versions, agent model, source hashes and package fingerprints are saved.
- Verified in every trial: 8 CPUs / 8192 MiB, Linux x64, Node `v22.23.2`, npm
  `10.9.8`, Python `3.11.6`, and actual model `claude-sonnet-5`. The original
  template ID was `zyc96dk7q7adnb1uzy40`; cached was `5mqfzddjuicidc1w92y5`.
  All baseline instances had `prefer-offline=false` and no seed marker; all
  optimized instances had `prefer-offline=true` and the cache seed marker.
- Real local Claude subscription on both sides; same configured model/CLI;
  no mock agent and no API fallback. No app credentials supplied.
- Local harness: Node `v22.23.2`, Claude Code `2.1.280`, E2B SDK `2.49.1`,
  MCP SDK `1.30.0`. `package-lock.json` is unchanged from the baseline commit;
  `package.json` differs only by the two cache-script entries. The actual
  model and remote Node/npm/Python versions are checked per trial.
- Time starts at the worker request and ends after `ready` plus an independent
  public HTTP 200 HTML check. It includes sign-in verification, clone, worker
  preparation, model/tool calls, installs, app startup and preview checks.
- This is not renderer/UI timing: GitHub metadata/library insertion, Electron
  IPC/database writes, notifications and browser painting are excluded.
- Package evidence collection and cleanup happen after the timer. The normal
  optimized background audit starts after readiness; cleanup can cancel it.
- Public homepage readiness does not establish database/LLM-backed feature
  correctness or confirm that every dependency vulnerability has been audited.
- The harness cannot reconnect to/list existing sandboxes. It only stops its
  own fresh instances. Each has a 20-minute TTL and a 17-minute controller limit.

## Interpretation limits

Three runs per case are a small sample, not a universal guarantee. Agent choices,
network conditions and service latency vary. Fresh VMs do not reset Claude's
provider-side prompt cache; reported cache token usage is retained.

Agent wall time contains tool waits and overlaps install/startup; CLI-reported
API duration is not pure thinking time. These intervals must not be added.
The install-to-launch gap includes any remaining inspection/model turns plus
launcher preparation. An early submitted launch is measured separately.

Success counts and failures are retained. A quick failure is not a faster preview.
Headline reductions are only computed when successful artifacts have matching
commits, hardware, runtimes, models, manifests and installed packages without
unexplained tracked-source modifications. Any exception will be called out.

### What this can and cannot attribute

- The historical version already supports overlapping inspection and install.
  This experiment does not measure the original benefit of introducing that
  overlap or the automatic installer.
- Installation-job durations are worker-observed wall intervals, not CPU time.
  The parallel npm/pip job is counted once. Without npm `--timing` on these
  agent-selected commands, this suite cannot split fetching, audit requests,
  resolution, file writes and scripts. See the separate controlled install
  diagnostics for that evidence; do not transplant their exact savings here.
- Launch recovery is part of end-to-end time. In Cocoa, old health-check
  failures and duplicate processes consume much more time than installation.
  The current launcher handles owned IPv4/IPv6 listeners; that is a runtime
  reliability improvement, not a cache effect.
- Identical input commits do not force identical agent behavior. In Hypocompass,
  one optimized run starts only the frontend, while the other five also start
  the Flask backend.
  Every timing uses the same public frontend check; backend feature parity is
  not asserted. Generated untracked launch scripts are not included in the
  tracked-source-change check.

## Reproduction

These commands use billed E2B compute and the local Claude subscription quota:

```sh
node scripts/benchmark-sandbox-pipeline.cjs --baseline historical --rounds 3 --output /tmp/canvas-full-pipeline-new
node scripts/sandbox-diagnostics/summarize-pipeline.cjs /tmp/canvas-full-pipeline-new/report.json
```

Use `--prepare-only` to create and inspect both implementation snapshots without
creating sandboxes. `--repo owner/name` restricts to one pinned repository.
The optional reconstructed sequential ablation is a different experiment, not
the user's selected historical baseline.

Diagnostic files:

- `scripts/benchmark-sandbox-pipeline.cjs`
- `scripts/sandbox-diagnostics/implementations.cjs`
- `scripts/sandbox-diagnostics/pipeline-artifacts.cjs`
- `scripts/sandbox-diagnostics/summarize-pipeline.cjs`
- Reused/generalized `scripts/benchmark-sandbox-e2e.cjs` and allowlisted metrics.
- `test/sandbox-pipeline-benchmark.test.cjs`

Validation: 134 sandbox tests and `git diff --check` passed, including a historical
snapshot test that verifies every copied file against `git show` and loads the
historical runtime, setup and Claude modules without source changes.
Final evidence checks passed: 18 unique owned sandbox IDs, exact pinned commits,
public checks, cleanup, runtime/hardware/model equality, package evidence, and
unchanged optimized application-source hashes. There are no missing artifact
collections or final run failures. Earlier failed launch attempts are retained.
