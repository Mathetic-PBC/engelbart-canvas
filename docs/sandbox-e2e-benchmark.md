# Rope end-to-end benchmark, including the real agent

2026-09-23 Pacific (2026-09-24 UTC). Diagnostic-only: no production code, agent
prompt, configuration, published template, library database or active preview
was changed during this benchmark. The warm template was still opt-in at that
point; this test did not activate it. A subsequent user-requested
[local activation and smoke check](sandbox-cache.md#local-activation-check--2026-09-23-pacific)
enabled it for new non-Docker sandboxes.

## Result

Three fresh runs per template, alternating runner/cached, cached/runner,
runner/cached. Every run invoked the real local Claude Code subscription and
reached an independently verified public HTTP 200 HTML preview.

| Template | Trial 1 | Trial 2 | Trial 3 | Median | Mean | Success |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| engelbart-runner | 71.697 s | 65.971 s | 66.078 s | **66.078 s** | 67.915 s | 3/3 |
| engelbart-canvas-cached | 50.280 s | 61.850 s | 52.759 s | **52.759 s** | 54.963 s | 3/3 |

Observed median reduction: **13.319 seconds / 20.2%**. Mean reduction: 12.952 seconds
/ 19.1%. Paired differences were **21.417, 4.121 and 13.319 seconds**. This is a
small real-agent sample, not proof that the cache alone saves 13 seconds on every
run. Agent trajectories, service latency and model prompt caching also varied.

## What is included

The clock starts when the production worker receives its setup request and stops
after `ready` plus a separate public HTTP 200 HTML check. It includes:

- Local Claude subscription sign-in check.
- Existing GitHub Docker detection, E2B creation and repository clone.
- Existing worker preparation/preflight.
- Real Claude startup, model calls, repository inspection and tool calls.
- Dependency installation, app launch, health checks and public preview proxy.
- Agent completion and the worker's final preview check.

This is **worker-request-to-preview**, not a UI automation benchmark. Library URL
insertion/GitHub metadata lookup, Electron process/IPC startup, database writes,
notification delivery and browser painting are excluded. The usual sandbox-handle
acknowledgement is represented by saving the diagnostic record, not writing the
user's database. Diagnostic `getInfo`, revision verification and event logging
overhead are included; artifact collection and cleanup occur after the timer.

The normal deferred audit starts after readiness. Its completion is not timed;
cleanup stops the test sandbox and cancels the remaining background audit. A
successful preview does not mean the dependency audit passed.

## Breakdown

Values are medians in seconds. **These rows overlap and must not be added.**

| Measurement | Runner | Cached |
| --- | ---: | ---: |
| Total worker request → verified public preview | 66.078 | 52.759 |
| Local subscription check | 0.894 | 0.848 |
| Docker detection + sandbox creation | 0.916 | 0.930 |
| Clone + pinned-revision verification | 1.394 | 1.959 |
| Agent session, including tool waits/install/startup | 61.762 | 47.114 |
| Claude CLI-reported `duration_api_ms` | 44.888 | 28.141 |
| Managed dependency-install job | 25.436 | 19.109 |
| First app start → worker ready | 17.953 | 15.405 |
| Observed tool round trips, union of overlapping intervals | 17.745 | 18.865 |

All six agents chose **`npm ci`**, with one managed install job per run. Install
job durations were **25.436 / 26.221 / 24.079 s** on the runner and
**17.255 / 24.078 / 19.109 s** cached. The median install difference was
**6.327 seconds**, consistent in direction with the prior isolated cache test.
These are worker-managed job durations including dispatch/cleanup, not the prior
benchmark's isolated npm process wall time.

The agent session spans installation and startup. CLI API duration is retained
as reported; it is **not a direct measure of pure thinking**, and it should not
be added to agent-session duration. Tool round trips include CLI/transport/queue
overhead, not just remote execution. The harness unions overlapping tool intervals
instead of adding simultaneous requests.

Why the full difference exceeds the measured install difference: Claude made
different inspection/waiting choices. For example, the second cached run reported
only 19.367 seconds of API duration but spent 36.859 seconds in observed tool round
trips, including waits. It took 61.850 seconds overall. The first cached run took
50.280 seconds, with a different inspection/wait pattern. Treat the observed 20%
full-flow improvement as encouraging, **not a cache-only causal estimate**.

## Controls and checks

- Repo: `mqo00/rope`, commit
  `1ada01830031e5882f2585577720b182deac6246`; normal `HEAD` clone, with the pinned
  revision asserted immediately afterward. No altered clone or setup prompt.
- Provider: real local Claude subscription; requested model `sonnet`, actual
  reported model **`claude-sonnet-5`** in all six runs. No mock agent or API-key
  fallback. Installed Claude Code version checked after the run: **2.1.280**.
- Same reported E2B resources in all six runs: **8 CPUs / 8192 MiB**, Linux x64,
  **Node 22.23.2 / npm 10.9.8**.
- The actual template configurations were used: the cached template has its
  existing `prefer-offline` setting and seeded cache. Both use the current worker's
  inline-audit deferral. This tests the real template opt-in, not a new command or
  prompt optimization.
- Production worker, local agent/tool/install code and launch adapter were reused
  directly. Source hashes are saved in the report and still matched after the run.
- All six installed **732 package records**, fingerprint
  `ab4468696a09568954c65fcec3f40a07a770b1e65bcfb1f34236b19c0bea7ee3`, with zero
  actual-version mismatches. Manifest hashes match across all six runs, and no
  tracked repository files were changed by the agent or installation.
- All six public previews returned HTTP 200 HTML. No app secrets were supplied;
  OpenAI/MongoDB-backed feature interactions were **not** tested.
- Six unique, fresh diagnostic sandboxes were created; all six were deleted.
  Their preview URLs in the raw report are therefore no longer live. Existing
  user previews were never connected to or stopped.
- Fresh E2B sandboxes do **not** reset Claude's server-side prompt cache. Reported
  cache read/creation token usage is saved; no attempt was made to clear or alter
  the user's authentication or shared provider caches. Alternating order reduces
  but does not eliminate order effects.
- Claude decisions are nondeterministic. Three runs per template do not establish
  a confidence interval or a guaranteed improvement for other repositories.

## Evidence and reproduction

- [Controller report and source hashes](benchmarks/2026-09-23-rope-e2e/report.json)
- [Computed summary and per-run breakdown](benchmarks/2026-09-23-rope-e2e/summary.json)
- [Final validation](benchmarks/2026-09-23-rope-e2e/validation.json)
- [Earlier dependency-only diagnostic](sandbox-install-diagnostics.md)

Each trial directory retains timestamped `events.jsonl`, `measurement.json`, and
the installed package list. Agent metrics store only selected numeric/structural
fields: model, token usage, result durations, and tool names/timing. Raw CLI
initialization/account details, MCP credentials, stderr, prompts and tool
arguments/results are not copied into these metrics.

New diagnostic files:

- `scripts/benchmark-sandbox-e2e.cjs`
- `scripts/sandbox-diagnostics/agent-metrics.cjs`
- `scripts/sandbox-diagnostics/summarize-e2e.cjs`
- `test/sandbox-e2e-benchmark.test.cjs`
- This document and `docs/benchmarks/2026-09-23-rope-e2e/`.

Reproduction uses billed E2B compute and the local Claude subscription quota:

```sh
node scripts/benchmark-sandbox-e2e.cjs --output /tmp/engelbart-rope-e2e-new --rounds 3
node scripts/sandbox-diagnostics/summarize-e2e.cjs /tmp/engelbart-rope-e2e-new/report.json
node --test test/sandbox-e2e-benchmark.test.cjs test/sandbox-install-diagnostics.test.cjs test/sandbox-cache.test.cjs
```

The output directory must be new. API-key fallback is disabled for this diagnostic
only, so a subscription problem cannot silently change the measured provider.
The harness refuses to list/reconnect to existing sandboxes and only cleans up its
newly created instance. Trials have a 17-minute controller deadline and a 20-minute
E2B TTL. No benchmark artifacts have been committed.

Verification: **21 focused tests passed**, JavaScript syntax checks passed, and
`git diff --check` passed. No runtime optimization was implemented in this pass.
