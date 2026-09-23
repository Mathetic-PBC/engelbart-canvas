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
including retrying a previously failed or stopped attempt. It selects that repo
in **Repo** while setup runs, then posts a preview-ready notification without changing panes.
Re-saving or reordering existing context does not start another build. A setup
handoff error leaves the attachment saved and shows the error.

The sidebar's GitHub section shows **Add repository** beneath the list only when
empty. Hovering or keyboard-focusing the section header or a repository reveals a
**+** that opens the same add-repository form. Repository rows no longer open hover
cards; clicking their names still opens the Repo tab.

Click a repository in the workspace sidebar to open the **Repo** tab, after
**Paper**. It displays the repository's README with GitHub-flavored Markdown
(headings, lists, code blocks, tables, task lists, images, and safe HTML).
Relative links and images resolve against the README's path and default branch;
heading links scroll within the README. Other links open externally.
The README is fetched from GitHub independently of sandbox setup, cached in memory
for five minutes, and can be refreshed. This currently supports public repositories;
missing/private READMEs and network errors leave the build controls available.
No README content or new fields are written to the library or sandbox tables.

The Repo view has a compact 38px header directly below the existing pane tabs,
outside the README's scroll container so it remains available while reading.
It shows a GitHub icon and **repo / Build** breadcrumb on the
left, with run status on the right: **Preparing…**, **Live ↗**, **Needs attention**,
or **Inactive**. A ready run without a preview URL shows **Ready**, not Live.
Only **Live ↗** opens the preview; the other statuses are informational.
The README contains no injected controls or layout wrappers.
Repository selection stays in the sidebar; there is no duplicate dropdown or
permanent bottom panel. **Build** always opens the existing centered modal on its
**Build** overview tab, without starting a build. **Build** keeps the expandable
lifecycle rows; **Logs** shows the recorded output in chronological order using
the same terminal/progress normalization; **Environment** keeps its existing editor.
The compact repo/build header contains run status, View on GitHub, and an × close
control. A quiet footer holds the current sandbox state and the existing Run / Retry
and Stop actions. README utilities and retention-limit text are not shown here.
Close, Escape, or clicking
the backdrop returns to the README without losing its scroll position; unsaved
environment edits survive tab changes and closing/reopening the modal for the
same selected repository. The latest 300 events
are saved with each run and survive reloads and app restarts. Older runs begin
recording activity after this update. When a build finishes successfully, the
top-right notification bell receives an unread preview-ready notification; the
current pane and browser tabs stay unchanged. Clicking the notification or **Live ↗**
opens the verified preview on demand. The bell is also available on Home and Create
Project. Opening its dropdown marks the visible notifications read. It keeps the latest
notification per repository (up to 40); notification IDs/read state are saved locally
per data root, separately from sandbox records. Reloads/replayed events do not duplicate
notifications or mark a previously read completion unread. Stopped/replaced previews
remain identifiable but cannot be opened from an old notification.
The home screen retains the compact sandbox status panel.
Packaged-app users must restart into a newly packaged build to receive changes;
rebuilding the checkout alone does not update an already running release.

## Configuration

Install dependencies with `npm install`, then put `E2B_API_KEY` in
`~/.engelbart/sandbox.env`. Setup uses the signed-in local Claude subscription
first, with `ANTHROPIC_API_KEY` as an optional fallback. This file stays on the main/worker
side; its values are never returned through renderer IPC. `.env.example` lists
the supported settings. A gitignored `.env.local` in this checkout is also read.
`ENGELBART_SANDBOX_ENV_FILE` can point at an existing private environment file.
Process environment values take precedence over file settings.

The default template is `engelbart-runner`, built by the web project's
`sandbox/build-template.mjs`. It must contain `/opt/engelbart/hc_run.py`, the hc
package and its tools, and `/opt/engelbart/proxy.mjs`. This integration uses that
existing pipeline; it does not build a new template or require the web server,
Supabase, or the web worker. Repositories with Compose/Supabase configuration use
`E2B_DOCKER_TEMPLATE` (default: `<E2B_TEMPLATE>-docker`). The default `auto` mode
tries the desktop Claude CLI subscription before the API pipeline.
For repositories with a root `yarn.lock`, the adapter installs Yarn Classic in
the disposable sandbox if it is missing from the template.

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

Keep `E2B_API_KEY` in all modes. An old packaged release will not include these changes.
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
authenticated loopback endpoint in the worker. Six tools can read/write/list repository
files, control a managed dependency install, run foreground commands, or start a web
app **inside that one E2B VM**.
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
`sandbox_runs` log/status events drive Repo's build logs and preview-ready notifications.
No new database table or Claude credential record is created. The local attempt is
bounded to 32 Claude turns and 15 minutes. The API setup deadline is 45 minutes;
the sandbox lifetime remains one hour, including both attempts when falling back.

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

Each install is bounded to ten minutes within the existing fifteen-minute local setup
deadline. Its output streams to the existing build log, and status includes command,
directory, timestamps, exit code and a bounded redacted log tail. Status may wait up to
180 seconds, avoiding rapid polling once read-only preparation is complete. Builds,
arbitrary shell commands and writes require the active install to finish or be stopped;
app launch additionally requires success or an explicit skip. Failed/stopped jobs are
never silently treated as successful. Cleanup tags and stops only the owned job's process
tree, checks process identities to avoid PID reuse, and fences delayed starts. Setup exit
stops an unfinished install before any API handoff. No new database schema, renderer UI,
API-mode pipeline or environment-only restart behavior is introduced by this change.

First-version scope: one foreground web-server launch command, not full hc parity
for multi-service orchestration, Railpack recipes, or automatic environment-variable
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

In **Repo → Build → Environment**, add or replace masked values, mark rows
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
each run; the latest status message is also kept in memory. Deleting a library
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
