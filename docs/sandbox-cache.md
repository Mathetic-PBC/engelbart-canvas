# Warm dependency caches

Canvas can use a derived E2B template, `engelbart-canvas-cached`, with npm and pip
download/build caches seeded from three public repositories. It inherits the
existing `engelbart-runner`; it does not replace the runner, change agent prompts,
skip repository installation, or preinstall application packages globally.

## What is cached

`scripts/sandbox-cache/profile.json` lists immutable Git commits and dependency
manifests for `mqo00/rope`, `kjfeng/cocoa-canvas`, and `mqo00/hypocompass`.
Only the listed `package.json`, `package-lock.json`, and `requirements.txt` files
are fetched during the template build. No local app files, credentials, or `.env`
files are uploaded.

Seeding runs as the sandbox's `user`:

- npm populates `/home/user/.npm` with lifecycle scripts disabled **only during
  seeding**. The temporary `node_modules` directories are discarded.
- pip downloads/builds wheels into its normal cache at `/home/user/.cache/pip`.
  Temporary wheel copies are discarded; no application Python environment is
  retained and the runner's globally installed Python packages are unchanged.
- `/home/user/.cache/engelbart/seed.json` records the profile hash, Git commits,
  manifest hashes, and seed time.

Actual sandbox runs still install the repository normally, including lifecycle
scripts, using its own manifest/lockfile and local `node_modules` or virtualenv.
npm prefers cached packages but may fetch cache misses; this is not offline mode.
The preference is saved in the template user's `.npmrc`, since E2B template
environment variables apply only during template construction.
Pip uses its normal cache semantics. Packages that differ from the seed still
download normally. npm/pip overrides in a repository or custom install command
can opt out. Yarn, pnpm, Bun, and uv caches are not seeded by this first profile.

## Build and compare

These commands read the existing private E2B configuration. Template builds and
benchmark sandboxes use billable E2B compute; no Claude/API agent is invoked.

```sh
npm run sandbox:cache:build -- --base engelbart-runner --name engelbart-canvas-cached --dry-run
npm run sandbox:cache:build -- --base engelbart-runner --name engelbart-canvas-cached
npm run sandbox:cache:bench -- --baseline engelbart-runner --candidate engelbart-canvas-cached --rounds 2
```

The builder only copies three explicitly named cache-tool files. It rejects using
the base template's name as the destination. The original runner stays available
for rollback. Use `--base` explicitly when rebuilding after changing Canvas's
configured template.

The benchmark creates fresh, 15-minute-limit sandboxes sequentially and kills
each one in `finally`, including on command failure. It never connects to,
restarts, or stops existing Canvas runs. Each round tests both templates at the
same pinned repo revisions, reversing template order on alternate rounds.

It measures **dependency installation only**, including normal npm scripts and
Python virtualenv creation. Cloning, sandbox creation, agent planning, application
startup, and preview health are not included. npm uses `npm install`, matching the
current flow; Python uses a new virtualenv and `pip install -r requirements.txt`.

The JSON report includes timing, output tails, hardware/runtime versions, and
installed-package fingerprints. Python distribution-name spelling is normalized
(`func_timeout` and `func-timeout` name the same distribution); versions and
direct-source references are not normalized away. Percentage comparisons are only produced for
successful runs with matching commits, hardware, runtimes, and packages. The
default report lives in a new temporary directory; `--output /existing/path/report.json`
chooses another location. Two rounds are a small smoke benchmark, not a guarantee
of future latency: network conditions, package changes, and install scripts vary.

### First comparison — 2026-09-23 (Pacific)

Two trials per repository/template, sequential fresh sandboxes, 8 CPUs / 8192 MiB,
Node 22.23.2, npm 10.9.8, Python 3.11.6. All 12 installs succeeded and installed
matching package versions. The Python metadata used both `func_timeout` and
`func-timeout`; observed package lists confirmed the same version (4.3.5).

| Repository | Original median | Cached median | Change |
| --- | ---: | ---: | ---: |
| mqo00/rope | 62.5 s | 53.6 s | 14.2% faster |
| kjfeng/cocoa-canvas | 18.6 s | 16.4 s | 11.7% faster |
| mqo00/hypocompass | 32.1 s | 35.5 s | 10.5% slower |

The candidate was published but **left opt-in at this stage** because the small
benchmark did not show a consistent improvement. The later local activation is
recorded below.
The roughly 322 MiB npm cache and 7 MiB pip cache were present in a fresh sandbox;
persistent npm configuration, pip cache hits, inherited runner imports/files,
and absence of a baked-in application repository were checked. Benchmark and
smoke-test sandboxes were cleaned up; existing Canvas runs were not touched.

Published template: `5mqfzddjuicidc1w92y5`, build
`f5d40843-ef72-4ba8-a326-530456c22e35`.
Seed profile: `c0f1d0ec8e7f363619160720a55334cd78e1336a2759e3d1c610902fd1b4140d`.

The follow-up [install diagnostic](sandbox-install-diagnostics.md) compares the
same Rope commit across `install`, `ci`, and inline-audit settings with full npm
timing logs. It separates audit overhead from cache benefit; the diagnostic does
not activate the template or change application behavior.

## Local activation check — 2026-09-23 (Pacific)

After the controlled install and agent-inclusive comparisons, the user requested
trying the warm-template configuration. The local `~/.engelbart/sandbox.env` now
selects `engelbart-canvas-cached`, with Docker explicitly pinned to
`engelbart-runner-docker`. Other settings and the file's `0600` permissions were
preserved. No runtime code, agent prompts, published templates, or existing
previews were changed by this activation.

A fresh Rope smoke check used the normal sandbox manager, forked worker, local
Claude subscription, and an isolated library database. It confirmed:

- Actual E2B template `5mqfzddjuicidc1w92y5`, 8 CPUs / 8192 MiB.
- Successful dependency installation; managed install job **18.368 s**.
- Manager start to saved `ready` run: **63.675 s**, including the agent.
- Saved preview URL returned public **HTTP 200 HTML** in an independent check.
- The one test sandbox was stopped afterward; existing user previews were not
  touched. Its recorded preview URL is no longer live.

[Smoke-check evidence](benchmarks/2026-09-23-warm-template-rollout/report.json)
contains the saved run, actual template, structured build events, and cleanup
result. This is a single configuration/preview validation against the normal
HEAD clone, **not another controlled performance comparison**. The timer starts
at the manager request, unlike the earlier worker-only benchmark; it stops at
`ready`, before the independent public-page check. Secret-dependent app features
were not tested.

The prior controlled install comparison measured **21.890 s → 16.236 s**, a
**5.654 s** median cache benefit for Rope after deferring inline audit. This
activation applies that same cache benefit; it is **not an additional 5–6 seconds
on top of the cached benchmark**. The setting affects all new non-Docker
sandboxes, so Rope's result is not a universal gain. In particular, the first
small Hypocompass sample was slower with the cache.

The smoke script accepts an optional new report filename:

```sh
node scripts/smoke-sandbox.cjs https://github.com/mqo00/rope /tmp/rope-warm-smoke-new.json
```

## Enable or roll back

After testing a published template, set these in `~/.engelbart/sandbox.env`:

```dotenv
E2B_TEMPLATE=engelbart-canvas-cached
E2B_DOCKER_TEMPLATE=engelbart-runner-docker
```

Keep the explicit Docker template setting: without it, Canvas derives a Docker
name from `E2B_TEMPLATE`. This first cache variant does not change Docker runs.
Process environment values take precedence over the file.

The selected template applies to **new sandboxes only**. Existing builds/previews
are not rebuilt or restarted. To roll back, restore `E2B_TEMPLATE=engelbart-runner`.
No database migration, runtime change, or app rebuild is required for this setting.

To refresh the seed, review and update the pinned commits/manifests in the profile,
build a new candidate, and benchmark it again. Updating a cache does not change
which dependency versions a repository declares.
