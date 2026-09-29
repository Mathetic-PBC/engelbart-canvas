# GitHub URL to live preview

Adding a GitHub repository URL to the library starts a sandbox run automatically.
Existing GitHub repos in the library (including clones with a GitHub URL) also
prepare automatically when the app loads: a live run is reused, and a stopped,
failed, or interrupted run is rebuilt. Newly added repos also prepare automatically. Other links and local files keep their existing library behavior.
Only one `starting` or `ready` run is allowed per library item, enforced by both
the run manager and a partial unique index. Stopped and failed runs are not
restarted by background refreshes during the same app session; use **Retry build**
to try again immediately, or relaunch the app for automatic preparation.
Attaching an existing GitHub repo to a workspace also starts or reuses its build,
including retrying a previously failed or stopped attempt. Adding or attaching a
repo keeps the current document, pane and Stage tabs in place. Re-saving or
reordering existing context does not start another build. A setup handoff error
leaves the attachment saved and shows the error. Unticking a repository again during
onboarding stops its sandbox and forgets its runs before the library row goes; a
sandbox that cannot be confirmed stopped keeps the row (and says why).

The right pane has **Stage** and **Terminal**. There is no Repo tab or floating
Sandbox runs panel. Clicking a repository name always opens its GitHub page in
Stage, without starting or stopping a run. Build details and live-preview actions
are available through the notification bell.
The inspector keeps **Build**, **Logs**, and **Environment**, with **Stop sandbox**
and the existing Run / Retry controls in its footer.

The header bell shows one notification per repository, updated through
**Building…**, **Build finished**, or **Build failed**. The repo name opens GitHub
in Stage; clicking **Building…**, **Build finished**, or **Build failed** opens the inspector, never stopping or retrying
directly. A completed preview offers a separate **Open live ↗**; a failed build
shows its error, with **Retry build** available inside the inspector. A completed
run with no web preview says so and has no live-preview action.
Completion never changes panes automatically. The bell sits top-right on every
screen (workspace, all projects and onboarding; `ui/WindowControls.jsx`, beside test
mode's controls in a developer's copy). Outside a workspace, **Open live ↗** and a
repository name open in the default browser instead of Stage.

Opening the dropdown marks visible notifications read. Clearing a building entry
keeps later progress quiet while allowing its completion or failure to notify.
Read/dismissal state is saved per data root, with up to 40 latest notifications.
Repeated progress and restored snapshots do not create duplicates. Stopped or
replaced runs are excluded. Inspecting a dismissed build does not put it back into
the inbox. The underlying run records, logs, milestones and environment settings
are unchanged.

Packaged-app users must restart into a newly packaged build to receive changes;
rebuilding the checkout alone does not update an already running release.

## Configuration

Install dependencies with `npm install` and sign in to GitHub in Engelbart: the E2B
API key always comes from mathetic.com for whoever is signed in (`src/main/github/e2b-key.cjs`),
held in memory only and handed to the sandbox worker as `E2B_API_KEY`. While nobody is
signed in, automatic preparation waits instead of failing each saved repository; it
runs once you sign in. An explicit Run/Retry or a newly added repository reports that a
sign-in is needed, and records nothing. Signing out stops the running sandboxes.

An `E2B_API_KEY` in `~/.engelbart/sandbox.env`, `.env.local`, the file named by
`ENGELBART_SANDBOX_ENV_FILE`, or a packaged app's environment is ignored. Only an
unpackaged build (`npm start`) honors `E2B_API_KEY`, and only from the process
environment: it is then used instead of the sign-in, for development. The scripts in
`scripts/` (template builds, benchmarks, smoke tests) are separate and still read
`E2B_API_KEY` from `~/.engelbart/sandbox.env`.

Setup uses the signed-in local Claude subscription first, with `ANTHROPIC_API_KEY`
in `~/.engelbart/sandbox.env` as an optional fallback. This file stays on the main/worker
side; its values are never returned through renderer IPC. `.env.example` lists
the supported settings. A gitignored `.env.local` in this checkout is also read.
`ENGELBART_SANDBOX_ENV_FILE` can point at an existing private environment file.
For these settings, process environment values take precedence over file settings.
`ENGELBART_SANDBOXES=off` turns sandboxes off entirely, for scripted runs.

The default template is `engelbart-runner`, built by the web project's
`sandbox/build-template.mjs`. It must contain `/opt/engelbart/hc_run.py`, the hc
package and its tools, and `/opt/engelbart/proxy.mjs`. This integration uses that
existing pipeline; it does not build a new template or require the web server,
Supabase, or the web worker. Repositories with Compose/Supabase configuration use
`E2B_DOCKER_TEMPLATE` (default: `<E2B_TEMPLATE>-docker`). The default `auto` mode
tries the desktop Claude CLI subscription before the API pipeline.
For repositories with a root `yarn.lock`, the adapter installs Yarn Classic in
the disposable sandbox if it is missing from the template.

An optional [warmed-cache template](sandbox-cache.md) inherits that runner and
seeds npm/pip caches. It leaves repository installs, setup agents, and Docker
templates unchanged.

### Local Claude subscription — default, with API fallback

No environment setting is needed to enable subscription-first setup. Quit Canvas
and start the updated checkout with:

```sh
npm start
```

Optional settings in the private `~/.engelbart/sandbox.env` file:

```dotenv
ENGELBART_SANDBOX_SETUP=auto
ENGELBART_SANDBOX_CLAUDE_MODEL=sonnet
```

`auto` is the default when unset. It checks the local CLI and subscription sign-in
before provisioning E2B. If Claude is missing, outdated or signed out, Canvas uses
the configured Anthropic API key instead. If the local setup attempt fails (including
usage limits or the setup deadline), it makes one API fallback attempt in the same
sandbox. Before handing off, it closes the local tool bridge, drains pending tools,
confirms the previous app and marked tool processes stopped, discards its local launch recipe and restores
the app environment snapshot. Cloned files and installed dependencies are retained;
the API pipeline may perform additional setup. Failed cleanup blocks the handoff.

The Build log records the provider and the fallback reason. API fallback incurs
normal API usage; it does not use subscription billing. With no API key configured,
local setup still works, but a local failure is reported without fallback. Stop/cancel
never triggers fallback, nor does an app failure after the preview became ready.
Environment-only restarts use the saved plan and invoke neither setup provider.

Explicit overrides remain available: `claude-local` requires the local subscription
and disables API fallback; `api` skips local Claude and requires `ANTHROPIC_API_KEY`.
Remove an older override or set it to `auto` to use the new default behavior.

The signed-in E2B key is needed in all modes. An old packaged release will not include these changes.
A ready sandbox is reused; use **Stop sandbox**, then **Retry build**, to test the
new setup provider on that repository.
An environment-only restart reuses the saved launch plan rather than running
either setup provider again. Existing automatic-preparation rules still apply on
app startup, so stopped/failed library repositories may build with the selected mode.

Prerequisites: the normal installed Claude Code binary, version 2.1.248 or newer,
signed in with the user's own Claude subscription through its normal terminal
login. The worker resolves the binary via the login shell, checks `claude auth
status --json`, and starts a separate task-specific process. It does not control
the user's existing terminal conversation. Raw account details are not published.
The CLI process receives a minimal user environment without API keys, OAuth token
overrides, alternate inference-provider flags, or inherited agent-session state.
In strict `claude-local` mode a signed-out/non-subscription session fails before
provisioning E2B. In default `auto` mode the worker may select the separate API path;
it never adds an API key to the local Claude process. Subscription limits and the
user's Claude billing settings still apply; E2B compute is separate.

The local CLI runs in restricted mode with built-in tools disabled, hooks disabled,
and only the per-run MCP configuration. A private stdio adapter calls a random,
authenticated loopback endpoint in the worker. Eight tools can read/write/list repository
files, control a managed dependency install, run foreground commands, or start a web
app **inside that one E2B VM**.
`app_status` reports current owned processes, listening addresses/ports, local HTTP
health and a bounded log tail; an optional `port` checks a particular conflict or
backend listener. `stop_app` stops only the managed app and confirms its descendants
are gone, preserving the VM/files. Other tool replies include the latest observed
app snapshot and up to four compact changes. These are observations delivered at
tool boundaries, not a second agent continually consuming tokens.
The bridge accepts no sandbox ID from the agent, validates every argument itself,
serializes agent tool calls, bounds returned output, and redacts saved environment
values. The managed install runs independently of that tool queue, so file reads and
directory listings can proceed while dependencies install. Arbitrary commands,
file edits and app launches are blocked while installation is active or its stop
has not been confirmed.
Claude credentials are never read by Canvas or copied to E2B. The E2B API key stays
in the worker, outside the local Claude process. Closing setup removes the temporary
bridge capability files. Stop aborts Claude and kills the owned E2B sandbox.

The existing hc AI pipeline is bypassed in this mode. The local Claude task performs
inspection, install/build decisions, and repairs using the sandbox tools. The worker
saves a `kind: "claude-local"` recipe with command/cwd/port/path in the VM, starts the
app under `launch.py`, and verifies the public proxy URL independently. The normal
`sandbox_runs` log/status events drive build notifications.
The local `start_app` publishes readiness immediately after its owned-process,
local HTTP and public-preview checks pass, without waiting for Claude's final message.
The tool bridge then rejects further setup mutations (including queued calls);
read-only inspection remains available. Claude has up to 30 seconds to finish its
summary, outside readiness timing. A summary error/timeout does not stop the verified
app or trigger API fallback. App supervision, user Stop, and cancellation remain active
during finalization; an application exit still stops/fails the run normally.
No new database table or Claude credential record is created. The local attempt is
bounded to 32 Claude turns and 15 minutes. The API setup deadline is 45 minutes;
the sandbox lifetime remains one hour, including both attempts when falling back.

The local launcher samples its owned processes/listeners and HTTP health about once
a second while running (checks can take longer). Only changes emit `app_status`
build events. It persists a private, bounded `app.json` inside the sandbox, with an
attempt tag and PID start times so orphaned children remain identifiable after their
supervisor exits. Starts are locked, cancelled attempts are fenced, and replacement
waits for a confirmed stop. Unknown/unowned listeners on the requested preview port
block launch; they are never killed to free a port. Health checks target the actual
owned IPv4/IPv6 loopback listener, and the preview proxy uses that same address.
Running processes, successful local HTTP, and a verified public preview are distinct
facts. A failed start returns its failed-check snapshot plus post-cleanup state, and
the original error appears in build events. Common duplicate-server and broad-kill
commands are rejected by `run_command`; this is a guardrail, not a shell security
boundary. The prompt directs diagnostics through `app_status`, not another server.
This observes multi-process launches but does not assert all backend routes or API
credentials work merely because the frontend responds. Existing API-mode/hc setup
is unchanged; saved local-Claude recipes also use this supervisor on env restart.

Before starting Claude, the worker runs a bounded read-only preflight and automatically
starts a managed install for an unambiguous root Node project with one recognized
lockfile and compatible, already available runtime/package-manager versions. Commands
are `npm ci`, `pnpm install --frozen-lockfile`, `yarn install --frozen-lockfile` (Yarn 1)
or `--immutable` (newer Yarn), and `bun install --frozen-lockfile`. It does not switch
package managers, discard lockfiles, or install a guessed runtime. Workspace/multi-package
layouts, custom package-manager configuration, root install lifecycle scripts, unsupported
version declarations, and non-Node/no-lockfile projects defer to Claude with a reason.

Claude receives the preflight facts and current job snapshot, then reads the README,
manifests and configuration and plans the launch **while dependencies install**. It uses
`dependency_install` to inspect status/logs, wait for completion, stop, or start a custom
install/retry in the chosen directory. Starting a replacement first confirms the previous
job stopped. `skip` requires an explicit reason after checking that dependencies already
exist or no install is needed. For a deferred repo, Claude resolves only the necessary
ambiguity/prerequisite before starting the same managed job; runtime-only credentials
must not delay an independent install. The tool supports agent-chosen commands for other
languages too; only automatic selection is currently limited to clear Node setups.

Before the Claude call, bounded Railpack-assisted discovery runs alongside the
deterministic install preflight. The existing template's `railpack prepare` analyzes
up to three install roots concurrently (six-second timeout per root); it does not
execute its plan, install packages, build an image, or receive app credentials.
Up to eight manifest components are discovered within three directory levels;
generated/dependency directories and symlink traversal are excluded. Workspace
children retain their scripts but are not separately analyzed as install roots.

Claude receives at most 12 KB of discovery JSON: component paths, selected launch/
build scripts, lockfiles, declared runtimes/workspaces, local proxy evidence, relevant
file paths, providers/package managers/frameworks, Railpack install/build/start hints,
and bounded warnings. Build layers, assets, caches, environment values and the full
Railpack plan are excluded. Missing/truncated/unsupported discovery stays explicit
and falls back to agent inspection. Railpack production defaults are advisory, not
authority to change runtimes or force a production build. The prompt prefers an
existing development server when appropriate and plans required backend services
during installation rather than claiming a frontend-only launch is a complete app.
Railpack's output contract is documented in its
[production integration guide](https://railpack.com/platforms/running-railpack-in-production).

Each tool reply also includes a compact `dependency_install` snapshot sampled after
that operation, so a file read can report that installation has just finished without
an extra status request. Full install output stays in the explicit status tool.
Claude is instructed to prepare the launch command, directory, port and required
prelaunch steps during installation, then stop general exploration. Once installation
succeeds and no known startup prerequisite remains, its next tool call should be
`start_app` (or a specific required build/configuration step first), not another broad
README, source or optional-feature review. Readiness is based on repository evidence,
not a numerical confidence score. If the recipe is ready while installation is still
running, Claude can call `start_app` with `wait_for_install: true`: the same tool call
waits up to 30 seconds for confirmed install success, then launches without another
agent round trip. If that wait expires, no launch is queued; Claude must wait for the
install result and retry. Failure, stop, cancellation and incomplete cleanup still
block launch. All existing health checks, credential rules and targeted-retry
safeguards remain in place. The prompt guides when Claude submits a recipe; it does
not guarantee a fixed model-response latency before submission.

Validation on 2026-09-23 (Pacific): **128 sandbox tests passed**, including an
install completing during a file read, same-call launch after success, and no launch
after install failure, incomplete cleanup, stop, cancellation, close or wait timeout.
Two fresh cached-template Rope checks with real local Claude both reached public
HTTP 200 HTML and were cleaned up:

- [Prompt/status-only attempt](benchmarks/2026-09-23-prompt-launch-smoke/measurement.json):
  17.157 s install, then 14.676 s until the launch stage; 60.534 s total.
- [Prepared-launch-capable attempt](benchmarks/2026-09-23-install-launch-handoff-smoke/measurement.json):
  19.461 s install, then 9.187 s until the launch stage; 57.841 s total.

These are development smoke checks, not a controlled speedup estimate. The agent
chose `npm install` in the first and `npm ci` in the second; both installed the same
732-package fingerprint without tracked source changes. In the second check Claude
still inspected startup imports after install and submitted its launch **after**
completion, so the pre-completion handoff was verified by automated tests, not
exercised by that real-agent run. It does not establish a zero-delay guarantee or
prove secret-dependent features work. Existing user previews/configuration were
untouched by these checks.

For independent npm frontend + Python `requirements.txt` backend directories, Claude
can request one managed parallel job:

```json
{
  "action": "start",
  "parallel": [
    { "manager": "npm", "cwd": "system/frontend" },
    { "manager": "pip", "cwd": "system/backend" }
  ]
}
```

The worker validates both targets before starting either: disjoint real repository
paths, no shared parent manifests/configuration or linked dependencies, a compatible
npm lockfile/runtime without custom install scripts, and plain Python requirements
without local/editable/include directives or custom bootstrap configuration. npm uses
`npm ci --no-audit`; Python creates a directory-local `.venv` then installs its
requirements. Existing Python environments and ambiguous layouts defer to sequential
agent-chosen commands. In particular, an npm workspace is still installed once at its
workspace root, never split into competing jobs. Output identifies each target. Both
must succeed; stop/replacement cleans up the entire owned process tree. Claude can
continue read-only inspection while both installs run.

npm's inline audit is disabled through process-scoped `npm_config_audit=false` in
managed installs and setup commands (including API fallback). No global npm config,
dependency versions, install scripts, or devDependency selection is changed. After a
new build's preview is verified, a separate read-only `npm audit --json --audit=true`
checks installed npm lockfile roots and reports severity counts and affected-package
summaries to the existing Build **Logs** view. Findings are not hidden: npm's normal
nonzero exit with vulnerabilities is a report, not a setup failure. The audit never
runs `fix`, blocks preview readiness, or changes the run's ready status. Missing/
unavailable reports are labelled as such, not treated as clean. Scanning is bounded to
200 directories/depth 5/10 npm roots; audits have a 30-second per-root and 90-second
overall time budget. Workspaces are audited once. Non-npm projects are not audited by
this npm-specific task. Environment-only restarts do not repeat installation or audit.

Validation (2026-09-23): fresh `engelbart-runner` sandboxes, Hypocompass commit
`7bc855e7316aeb17e9919013a26aa0427138d480`, 8 CPU / 8192 MiB, Node 22.23.2 /
npm 10.9.8. Two alternating-order runs each measured sequential Python + `npm ci
--audit=true` at 42.738s / 39.972s, versus the managed parallel pair with inline audit
disabled at 16.793s / 21.338s (means 41.355s vs 19.066s, about 54% less install time).
This isolates the combined install optimizations, not total preview time or the prior
`npm install` cache benchmark. All four cases had identical installed-package
fingerprints (2097 npm entries, 25 Python distributions) and no tracked file changes.
A separate end-to-end managed-install smoke took 25.216s including validation/transport
and confirmed deferred audit findings were emitted. Timings vary; no warmed-cache
template was enabled. All five disposable verification sandboxes were removed.

Each install is bounded to ten minutes within the existing fifteen-minute local setup
deadline. Its output streams to the existing build log, and status includes command,
directory, timestamps, exit code and a bounded redacted log tail. Status may wait up to
180 seconds, avoiding rapid polling once read-only preparation is complete. Builds,
arbitrary shell commands and writes require the active install to finish or be stopped;
app launch additionally requires success or an explicit skip. Failed/stopped jobs are
never silently treated as successful. Cleanup tags and stops only the owned job's process
tree, checks process identities to avoid PID reuse, and fences delayed starts. Setup exit
stops an unfinished install before any API handoff. No new database schema or renderer
UI is introduced; the API pipeline is otherwise unchanged, and environment-only
restarts still reuse installed dependencies and the saved launch recipe.

Scope: one foreground launch command (which may supervise required child services),
not full hc parity for multi-service orchestration, execution of Railpack recipes, or automatic environment-variable
discovery. Saved manual environment overrides are supported, including same-sandbox
add/update/remove restarts with no model call, clone, or dependency reinstall. Changing
the application's listening port requires a new launch plan. Production frontend
environment values can still require an asset rebuild.

Authentication remains in the unmodified official CLI, following its documented
[credential boundary](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use).
See [programmatic Claude Code](https://code.claude.com/docs/en/headless) and the
[CLI tool restrictions](https://code.claude.com/docs/en/cli-reference).

## Data and events

### Application environment

In **Build → Environment**, add or replace masked values, mark rows
for removal, then choose **Save** or **Save & restart app**. Save affects future
launches; restarting applies the saved snapshot now and notifies when the verified
preview is ready again, without switching panes. An empty string is a value, not a removal. Names are
validated and runner-control variables are reserved. Values are not trimmed.
The setup scan automatically lists the variables the repository uses, with
missing required values first and statuses for saved, optional, repository-supplied,
and sandbox-supplied values. Detected names do not create saved empty overrides;
only fields the user edits are submitted. Scan reports contain metadata only and
are retained separately from the bounded log, so the latest detected list remains
available after reopening Canvas or starting a new attempt. Existing run logs
also supply this list when they still contain an environment scan.

The separate `sandbox_environments` table references `library.id` and holds
`revision`, `encrypted`, and `updated_at`. The payload (values and removed names)
uses Electron safeStorage encryption backed by the OS key store. No plaintext
fallback is allowed; unlock the keychain if unavailable. Renderer read responses
contain names/revision/removals only, never saved values. It is not exported into
the library catalog. `sandbox_runs.env_revision` records the launch snapshot.
See [Electron's storage contract](https://www.electronjs.org/docs/latest/api/safe-storage);
unsigned development builds may prompt again for keychain access after updates.

Restart reuses the **same run and sandbox IDs**. After preflight confirms a saved
launch plan, the existing local worker detaches without killing the machine.
A new worker connects, confirms the previous app/proxy process trees have stopped,
marks that repository's old hc launch records as stopped, and restarts only the
saved application commands. The ownership records must be updated too: leaving
them marked running makes hc reject the replacement even after the processes exit.
If stopping cannot be confirmed, the replacement is blocked rather than clearing
the ownership records. The original launch plans and logs are preserved.
No clone, dependency installation, setup
agent, or repair agent is run. The timeline displays the current restart while
keeping the bounded earlier events in the database. A failed restart retains the
sandbox and files, so settings can be corrected and **Save & restart app** tried
again. **Stop sandbox** releases the retained machine. **Retry build** remains
the separate full-rebuild action.

`launch.py` is uploaded into the sandbox, so existing compatible runner templates
do not need rebuilding. It clears Canvas-managed names from hc's merge-only env
cache for every component and applies the complete current override set to each
new app process, including the shell fallback. Removed overrides are not injected
again. Code or dotenv files owned by the repository may still supply their own
defaults. Initial runs also receive saved variables. App values are isolated from
the setup agent's credentials and redacted from worker output before persistence.

Environment values compiled into frontend assets (e.g. production `NEXT_PUBLIC_`
or `VITE_` variables) need an asset rebuild; restarting processes does not rewrite
already-built JavaScript. Such public variables must not contain secrets.

### Run lifecycle records

`library.pglite` contains `library` and `sandbox_runs`. A run references the
repository through `sandbox_runs.library_id → library.id`; run updates do not
change the library row. Run records survive restarts. The `build_log` JSONB
column stores the latest 300 timestamped progress and lifecycle messages for
each run. `build_milestones` retains the first/latest redacted record per lifecycle
phase, stage, and outcome independently of that tail, plus the latest 200 setup
agent activity records and first/latest valid process observations. Runtime
snapshots and audit reports are not build transitions. Event sequences preserve order
when timestamps tie; UI merging deduplicates records. Application restarts clear
the milestone set and preserve their new restart boundary, without changing the
run or sandbox identity. The latest status message is also kept in memory. Deleting a library
entry with run records is restricted.

1. Save or reuse the library entry and check its GitHub URL.
2. Reuse active setup, or verify an existing ready preview before opening it.
   Unknown remote state does not authorize a duplicate run.
3. Insert a `starting` run, with a null sandbox ID and preview URL.
4. Attach output listeners and send the local worker a request:

```json
{"command":"start","run_id":"<uuid>","github_url":"https://github.com/owner/repository"}
```

5. The worker creates a sandbox, clones the repository, and launches the hc
   pipeline. It emits one JSON object per line on stdout:

```jsonl
{"run_id":"<uuid>","event":"progress","message":"Creating sandbox"}
{"run_id":"<uuid>","event":"sandbox_created","sandbox_id":"<e2b-id>"}
{"run_id":"<uuid>","event":"progress","message":"Installing dependencies"}
{"run_id":"<uuid>","event":"ready","preview_url":"https://<preview-host>/","port":3000}
```

Canvas persists `sandbox_id` and acknowledges it before the worker begins
cloning. `ready` is emitted after the pipeline reports a healthy application and
the public proxy responds. The manager saves URL/port/status, updates
`updated_at`, and publishes through `engelbart:sandbox-progress`. The renderer
subscribes before requests can be submitted and loads a snapshot after reloads.
Opening a ready preview uses the workspace browser or a browser dialog on Home.

### Private repositories (2026-09-29)

Signing in to GitHub in Engelbart is what lets a sandbox read a private
repository, but the sign-in itself never leaves the app's main process: not to
the worker, the sandbox, a command line, a log, or a stored remote address.

- Before the sandbox is made, the manager asks GitHub's API with the sign-in
  whether the repository is private, its default branch, and whether it wants
  Docker (compose or Supabase files), so a private one gets the right template
  (`src/main/github/repo-access.cjs`). A repository GitHub will not show fails
  the run at once with what to do: install the Engelbart App where it lives
  (signed in), or sign in.
- A public repository is cloned in the sandbox as before, without credentials.
- For a private one, the manager asks `/repos/{owner}/{repo}/tarball` without
  following its redirect when the worker reports `sandbox_created`, and sends
  the `codeload.github.com` address GitHub answers with in the ack. That link
  carries a token of its own for that one archive, for about five minutes; it
  cannot read another repository or write anything. The worker accepts only an
  https codeload address, puts it in one command's environment
  (`ENGELBART_ARCHIVE_URL`, never the command line), redacts its token from
  what the sandbox prints, downloads and unpacks it into
  `/home/user/repository`, and commits it as one snapshot on the default
  branch with `origin` set to the plain address, as a shallow clone would be.
  The timeline shows it as the clone.
- A Build's clone of a library repository (Build panel, "Clone into
  repos/<name>") uses the sign-in the same way on this Mac: a credential helper
  for that one git command answers github.com alone from its environment, the
  person's own helpers are left out of it (so their keychain never stores the
  token), and the clone keeps the plain address. If GitHub refuses the
  sign-in, the person's own Git credentials are tried.

The Engelbart App needs only **Contents: Read-only** for this
(`docs/github-app-setup.md`).

On an initial setup failure, the worker attempts sandbox cleanup and emits `failed` with an error.
Canvas records the error and `finished_at`. Cleanup errors retain the sandbox ID;
a retry attempts cleanup before starting again. Retries append a run and keep
earlier attempts. Late events cannot revive terminal records.

## Lifecycle

Stop kills the sandbox and updates the run. Normal app quit and data-mode changes
stop workers before closing their databases. A disconnected worker also attempts
cleanup. Sandboxes have a one-hour lifetime, and setup has a 45-minute deadline.
Every 15 seconds, Canvas checks saved active runs: a confirmed lost sandbox ends
the run; network/authentication failures leave its status intact. Interrupted
setup without its local worker is cleaned up and marked failed; startup
preparation rebuilds it automatically. Ready runs can be checked and reused after a renderer reload.

Canvas tags sandboxes with `canvasRunId`, deliberately not `runId`: the web
worker's cleanup job treats the latter as ownership and removes sandboxes whose
runs are not in Supabase.

## Verification

`node --test test/sandbox-*.test.cjs` covers schema constraints, lifecycle,
concurrency, stale runs, worker events, cleanup, and the process boundary.
`npm run build` checks the renderer bundle.

`node scripts/smoke-sandbox-environment.cjs` verifies real add/update/remove
restarts against a disposable E2B sandbox with an isolated test database. It
checks that the sandbox ID and installed-file sentinel survive, values reach
both supported launch paths, and the setup agent's API key does not reach the
test application. It uses sandbox time and cleans up after itself.

`node scripts/smoke-sandbox.cjs https://github.com/owner/repository` runs a real
E2B/agent setup using an isolated temporary database. It verifies the saved
preview, stops the test sandbox afterward, and prints the test database path.
It uses sandbox time and the selected provider's subscription/API usage; its
deadline is eight minutes. Set `ENGELBART_SANDBOX_SETUP=api` to test only the API path.

The API path was verified against `render-examples/express-hello-world`: clone, setup, live public
preview, persisted `ready` row, and cleanup all completed. Repository setup still
depends on hc's capabilities: the MDN React example reached the smoke deadline
during repair, and the Heroku Node example served HTTP but hc did not recognize
its startup message. Those are setup-pipeline limitations, not proof that every
GitHub repository can produce a preview.

The local subscription proof can be repeated in strict mode, without API fallback:

```sh
ENGELBART_SANDBOX_SETUP=claude-local ANTHROPIC_API_KEY= node scripts/smoke-sandbox.cjs https://github.com/render-examples/express-hello-world
node scripts/smoke-sandbox-environment.cjs --local
```

The first test uses subscription model calls and E2B compute, with an isolated local
database and automatic sandbox cleanup. The second uses a disposable saved local
launch recipe and E2B compute only, verifying environment restarts without any model
or Anthropic API key. Do not run these as routine unit tests.

Verified locally: the Express example reached a persisted `ready` row through the
local Claude/MCP path with `ANTHROPIC_API_KEY` explicitly empty, then cleanup stopped
the test sandbox. The local-recipe environment smoke also verified two launches
in the same VM with add/update/remove/empty values and no model call. Unit tests
additionally cover atomic JSON framing for concurrent app logs and readiness,
the real stdio MCP transport, subscription gating, tool restrictions, request
validation, redaction and cancellation. Provider tests cover subscription-first
selection, missing/failed local Claude, explicit overrides, no-key behavior,
same-VM API handoff, cleanup failures, and preventing fallback after Stop or readiness.
