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
in **Build** while setup runs, then opens the verified interface in **Browser**.
Re-saving or reordering existing context does not start another build. A setup
handoff error leaves the attachment saved and shows the error.

Click a repository in the workspace sidebar to open the **Build** pane, whose
tab follows **Paper**. Its repository selector gives every GitHub repo its own status,
timestamped activity, errors, and Stop / Retry controls. The latest 300 events
are saved with each run and survive reloads and app restarts. Older runs begin
recording activity after this update. When a build finishes successfully, its
verified preview opens in the Browser pane automatically. **Open preview** remains
available to reopen it later. Refreshing saved runs does not switch panes again.
The home screen retains the compact sandbox status panel.
Packaged-app users must restart into a newly packaged build to receive changes;
rebuilding the checkout alone does not update an already running release.

## Configuration

Install dependencies with `npm install`, then put `E2B_API_KEY` and
`ANTHROPIC_API_KEY` in `~/.engelbart/sandbox.env`. This file stays on the main/worker
side; its values are never returned through renderer IPC. `.env.example` lists
the supported settings. A gitignored `.env.local` in this checkout is also read.
`ENGELBART_SANDBOX_ENV_FILE` can point at an existing private environment file.
Process environment values take precedence over file settings.

The default template is `engelbart-runner`, built by the web project's
`sandbox/build-template.mjs`. It must contain `/opt/engelbart/hc_run.py`, the hc
package and its tools, and `/opt/engelbart/proxy.mjs`. This integration uses that
existing pipeline; it does not build a new template or require the web server,
Supabase, or the web worker. Repositories with Compose/Supabase configuration use
`E2B_DOCKER_TEMPLATE` (default: `<E2B_TEMPLATE>-docker`). Setup uses the configured
Anthropic API key, not the desktop CLI subscription.
For repositories with a root `yarn.lock`, the adapter installs Yarn Classic in
the disposable sandbox if it is missing from the template.

## Data and events

### Application environment

In **Build → Environment variables**, add or replace masked values, mark rows
for removal, then choose **Save** or **Save & restart app**. Save affects future
launches; restarting applies the saved snapshot now and automatically reopens
the verified preview. An empty string is a value, not a removal. Names are
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
It uses sandbox time and model API calls; its deadline is eight minutes.

Verified against `render-examples/express-hello-world`: clone, setup, live public
preview, persisted `ready` row, and cleanup all completed. Repository setup still
depends on hc's capabilities: the MDN React example reached the smoke deadline
during repair, and the Heroku Node example served HTTP but hc did not recognize
its startup message. Those are setup-pipeline limitations, not proof that every
GitHub repository can produce a preview.
