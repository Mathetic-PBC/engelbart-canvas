# E2B repository previews — implementation specification

Prepared 2026-09-28 for the **E2B integration** workspace in Engelbart.

## 1. Objective and authority

Bring the E2B repository-preview integration from David's latest Canvas branch into the current Hudson-based checkout. Preserve the observable behavior, subscription-first setup, performance optimizations, lifecycle guarantees, and environment management. Add the explicitly listed robustness requirements below. This is an implementation request for the coding agent that receives this document through workspace **Build**.

Reference: `feat/canvas-workspace-updates-2026-09-28`, immutable commit `2d570caefda24e23cd5b14669b26dd1853abf706`. Destination at authoring: `david-e2b`, Hudson commit `ab0377d` (see the manifest for its full hash). The user confirmed this source branch. The older `feat/e2b-implementation` branch is not the authority.

The normative requirements in this document and ACCEPTANCE.md define completion. The reference archive preserves the implementation, tests, exact setup prompt, and historical operating documentation. A requirement marked **Hardening** is a requested improvement, not a claim that the source already guarantees it. Historical tests and measurements are evidence of past behavior, not proof that the new implementation passes.

Two different operations use the word Build:

- **Workspace Build** starts a coding agent in a local Git worktree to implement this feature. Preserve Hudson's context freezing, checkpointing, Review, Accept, Discard, Stop, Resume, and post-it behavior.
- **Repository setup / preview build** creates an E2B VM, prepares a GitHub repository, and serves its web application. This is the feature being ported. Its setup agent may run locally but operates through tools bound to that VM.

Do not change workspace Build to execute remotely in E2B. That is a separate feature and was not implemented by the reference E2B integration. Do not merge the entire source branch. Read its code as a reference and adapt the E2B portions to Hudson's current interfaces.

## 2. Scope and user journeys

**E2B-01 — Repository acquisition.** Saving an eligible GitHub repository to the library persists the library row first, then starts/reuses setup. Attaching an existing eligible repository to a workspace also starts/reuses it, including an explicit retry of a previously stopped/failed run. Reordering or re-saving existing context must not start a new attempt. An asynchronous setup handoff error leaves the user's addition/attachment saved and returns an actionable error. Other websites, local files, and arbitrary folders retain their current behavior.

Eligibility is a canonical `https://github.com/<owner>/<repository>` root URL. Preserve existing library normalization and deduplication before validation. The source validator accepts a trailing slash and rejects credentials, extra path components, query/fragment ambiguity, and `.`/`..` owners/names. Test normalization of `.git`, SSH forms, and saved clones separately; the runtime must receive one canonical root URL. The source clones public repositories without a GitHub credential. Do not claim private-repository support or borrow desktop GitHub login implicitly; private access requires a separate explicit implementation.

**E2B-02 — Automatic preparation.** On application/library load, prepare saved eligible repositories once per library item and data root per app session. Reuse in-flight setup. Probe and reuse a healthy ready run. A confirmed interrupted/stopped/failed run can be rebuilt at the next app startup. Repeated library refreshes during the same session must not undo Stop or loop on failure. User Retry is an explicit new attempt. Duplicate requests converge on one active run.

**E2B-03 — Navigation.** Adding, attaching, preparing, or completing a repository must not switch the document, pane, active Stage tab, or terminal. Clicking the repository name opens its GitHub page in Stage and does not start/stop/retry it. Opening a live preview is a separate explicit action. Preserve Hudson's Stage/Terminal layout and native browser behavior; do not restore an old Repo tab or floating sandbox-run panel.

**E2B-04 — Notifications.** Provide a shared header notification bell on Workspace, Home, and project creation/onboarding surfaces. One visible entry per repository evolves through Building…, Build finished, or Build failed. Clicking that status opens the inspector. Clicking the repository name opens GitHub. A verified ready URL provides **Open live ↗**. A record lacking a URL must not expose a working-preview button. Completion alone never navigates.

Opening the dropdown marks its visible entries read. Clear dismisses inbox entries, not runs. Clearing an in-progress entry silences subsequent progress but permits completion/failure to notify. Persist read/dismissed state per data root, bounded to 40 latest notifications. Ignore duplicate completion/progress, stale snapshots, stopped/replaced runs, and events from another data root. Inspecting a dismissed run must not reinsert it into the inbox. Keep any existing Hudson/local Build notifications working without importing the other branch's local-preview subsystem solely for a UI dependency.

**E2B-05 — Inspector.** The repository inspector has Build, Logs, and Environment tabs, repository identity/status, current error, time to live, and explicit Run / Retry build / Open preview / Stop sandbox actions. Active starting/ready runs can be stopped; a failed restart with a retained sandbox can also be stopped. Opening/closing an inspector never triggers a lifecycle operation. Preserve modal focus trapping/return, Escape/outside dismissal, tab-arrow/Home/End navigation, accessible names, keyboard operation, and native browser overlay coordination.

Build shows lifecycle steps with command/output details beneath their steps; Logs shows bounded redacted output. Preserve scroll position when a step opens/closes and follow output only while the user is at the bottom. Time to live is wall-clock from initial setup or latest restart to first verified readiness, not the sum of overlapping phases. Runtime observations and audits must not restart the build timer or become fake lifecycle transitions.

**E2B-06 — Environment editor.** List discovered application variable names, saved names, and drafts. Missing required values sort first. Explain required/optional/unknown, repository-supplied, sandbox-supplied, saved, and removed states. Saved values are masked and never fetched back into the renderer. Only edited fields are submitted. A blank value is an intentional empty string; removal is a distinct operation. Save changes future launches. **Save & restart app** saves, then applies the revision in the existing VM; it does not rebuild the repository.

## 3. Architecture and ownership

```text
Renderer (bell / inspector / environment / explicit Stage navigation)
    ⇅ trusted preload IPC, names and redacted run events only
Main: sandbox manager ⇄ PGlite run/environment records + OS safeStorage
    ⇅ forked worker: validated request, JSONL events, creation acknowledgement
Worker: E2B SDK / authenticated loopback tool bridge / lifecycle supervision
    ├─ local Claude CLI: subscription credentials remain on the Mac
    │      ⇄ private stdio MCP adapter → tools bound to this one E2B VM
    └─ optional API setup: hc runner inside the VM
E2B: disposable clone + managed installation + launcher + reverse proxy
    → independently checked HTTPS preview → explicit Open live
```

**E2B-07 — Boundaries.** Keep SDK credentials, decryption, lifecycle ownership, provider selection, remote process control, and database writes out of the renderer. Use a forked Node worker under Electron (`ELECTRON_RUN_AS_NODE=1`) to isolate long-running SDK/agent work from main/UI responsiveness. Attach listeners before dispatch. Agent tools cannot choose a sandbox ID. Repository code executes only in the disposable VM. The local Claude setup process has only the restricted per-run bridge tools; normal workspace Build retains its existing separate policy.

Managers are owned by the current store/data-root lifecycle. Start, Stop, restart, environment saves, reconciliation, and shutdown must coordinate. Serialize per `(dataRoot, libraryId)` and enforce uniqueness in storage as well. Different repositories may make progress independently. Mode switch/reset must drain queued additions, active work, control operations, and final database callbacks before closing the old database. Old events cannot populate the new mode.

**E2B-08 — Source integration.** Port `src/main/sandbox/*` as one coherent subsystem with its shared models, schema, IPC, UI, tests, and runtime assets. Adapt main initialization/shutdown, preload, library/workspace attachment handlers, and the current Stage/browser API. Keep Hudson's newer packaging, tool setup, onboarding, bundled Git, updates, archive, and Build behavior. IMPLEMENTATION.md identifies shared files that must be edited selectively.

## 4. Run storage and lifecycle

**E2B-09 — Records.** Add idempotent migrations to the library database without resetting existing data:

| Storage | Required contract |
| --- | --- |
| `sandbox_runs.id` | UUID attempt identity; primary key |
| `library_id` | Existing library UUID, foreign key with delete restricted while run records reference it |
| `sandbox_id` | Nullable E2B handle; retain after cleanup failures |
| `status` | Exactly `starting`, `ready`, `failed`, `stopped` |
| `preview_url`, `port` | Nullable until verified; valid port 1–65535 |
| `error` | Bounded redacted actionable failure |
| timestamps | `created_at`, `updated_at`, nullable `finished_at` |
| `build_log` | Latest 300 entries, each with identity, timestamp, ordered sequence, message, kind/data when present |
| `build_milestones` | First/latest meaningful phase/stage/outcome events, plus bounded agent activity (200 entries), independent of log tail |
| `env_revision` | UUID of the launch's saved app environment snapshot; null when none |
| `env_report` | Validated names/status metadata; no values; survives log eviction |
| `sandbox_environments` | One row per library item: UUID revision, encrypted payload, updated timestamp; delete cascades with library item |

Create an index by library item and creation time, and a partial unique index allowing at most one `starting`/`ready` attempt per library item. Log sequence assignment and retention happen atomically. Update APIs allowlist fields. Terminal records cannot be revived by late events. Explicit restart is a controlled reopen of the same run. Retry creates a new run and retains prior history.

Existing installations may already have the reference tables. Migrate absent columns/defaults/indexes, and backfill milestones/environment reports once from available legacy events. Do not invent discarded history or overwrite newer reports with stale scans. A successful empty scan legitimately clears prior names. Persist preview-origin→repository identity where needed so regenerated URLs do not destroy retained preview identity; avoid pulling in annotations/recordings as prerequisites.

**E2B-10 — State transitions.**

| Trigger | Result and required side effects |
| --- | --- |
| Valid new request | Persist `starting`, selected environment revision, then provision |
| Duplicate active request | Return current setup, or probe ready run; never create a duplicate |
| E2B created | Persist sandbox handle, acknowledge worker, only then clone/setup |
| Health verified | Save `ready`, URL, port; emit one completion notification |
| Initial setup failure | Attempt VM cleanup, persist `failed` and error; retain handle if cleanup unconfirmed |
| Explicit Stop | Cancel all stages, confirm remote release or report cleanup failure; no fallback |
| Restart ready/failed retained VM | Validate recipe first, detach old worker, reopen same run as `starting`, launch saved commands with new environment |
| Restart fails | Keep VM/files and run identity for correction; mark `failed`, allow restart or Stop |
| Retry | First resolve/clean previous ownership; create a fresh attempt |
| Confirmed VM gone/inactive | End/reconcile the run; a later explicit/new-session retry may provision |
| Timeout/auth failure/unreachable preview | Preserve ownership/status, report uncertainty; do not duplicate or assume VM is gone |

**E2B-11 — Recovery.** Every 15 seconds, reconcile registered active contexts without overlapping poll loops. Recover an unpersisted E2B handle using metadata `{canvasRunId, app: "engelbart-canvas"}`. Persist the recovered handle before cleanup. Use `canvasRunId`, never the web worker's `runId`, which belongs to a different cleanup system. Interrupted setup with no worker is failed/cleaned; healthy ready runs can be reused after renderer reload. Ready does not imply immunity to app exit or VM expiry.

Normal desktop quit or data-mode change stops active preview VMs. It does not keep a paid VM indefinitely in the background. Unexpected parent disconnect triggers bounded worker cleanup, with VM expiry as the last backstop. Retry cleanup on a previously failed attempt before replacement. Preserve actionable evidence when cleanup cannot be confirmed.

## 5. Worker and E2B runtime

**E2B-12 — Provisioning.** Require E2B_API_KEY in every setup mode. Use source SDK `e2b@2.49.1` as the reproducibility baseline; any update requires explicit compatibility verification. Base template defaults to `engelbart-runner`. Detect Compose (`compose`/`docker-compose`, YAML/YML) or `supabase/config.toml` before provisioning and choose `E2B_DOCKER_TEMPLATE`, default `<base>-docker`. The source uses a bounded public GitHub tree query. **Hardening:** a failed/truncated tree query is unknown evidence, not proof no services exist; inspect/recheck and fail actionably if the selected VM lacks required capabilities.

Set a one-hour VM lifetime, 60-second create request limit, and ownership metadata including the canonical repository URL. Clone shallowly into `/home/user/repository` with `GIT_TERMINAL_PROMPT=0`, a five-minute limit, and redacted progress. Do not push changes upstream. If root `yarn.lock` needs Yarn and the template lacks it, the reference supplies Yarn Classic 1.22.22; mismatched declared versions must be resolved, not silently ignored. Start Docker daemon only on the Docker image, with bounded readiness; no daemon is assumed running merely because the executable exists.

Install current adapter helpers into `/home/user/.engelbart-canvas` for each run/restart. Existing compatible templates need not be rebuilt for adapter changes. Directory permissions are 0700; sensitive JSON payloads/recipes are 0600. Apply saved application environment via a private file, not command-line arguments or globally inherited template variables.

**E2B-13 — Transport.** Request envelope contains command (`start`, `restart`, `probe`, `kill`, `can_restart`), run identity and only necessary repository/sandbox/port/environment fields. `ack`, `stop`, and `detach` are lifecycle controls. stdout is one JSON object per line with matching `run_id`; stderr is a redacted bounded tail. Serialize event handling before finishing a worker promise. Validate event names, field types, IDs, ports and URL. A persistence failure must withhold acknowledgement and cancel cleanup safely. Source limit: 256,000 characters per worker event, 30 seconds for create acknowledgement, 90 seconds to drain a stop before local force termination, 10 seconds for detach.

Events are `progress`, `sandbox_created`, `ready`, `failed`, `stopped`, and control `result`. Preserve structured progress phase/stage/status/provider/job/app metadata after validation and redaction. Main publishes `{dataRoot, run, message, notification?}` through `engelbart:sandbox-progress`; a `preview-ready` notification is generated once for each readiness cycle. Large structured output is summarized/bounded, never blindly serialized into the database.

**E2B-14 — Preview verification.** Reserve proxy port 43110 (and consecutive proxy ports for additional API-mode services). Validate service ports and local listener hosts. Start `/opt/engelbart/proxy.mjs` to forward the actual local address, including IPv6 loopback, and support dev-server/WebSocket traffic. Construct public HTTPS URLs from the assigned VM's SDK host and a validated relative route/query. Reject embedded credentials, unsafe paths, wrong hosts, and URL schemes.

The source public probe uses a five-second request timeout, manual redirects, a bounded response sample, and rejects 5xx/invalid-host text. **Hardening:** bind persisted URLs to the assigned SDK host and selected service, and make the health policy explicit. Do not mark a generic 404, unrelated service, unexpected redirect, login failure, or invalid-host page as the intended app's success. An intentional app redirect/auth screen can qualify only with positive route/application evidence. Track process alive, expected local HTTP response, and public reachability separately. HTML alone never proves that backend routes or secret-dependent features work.

## 6. Setup provider and constrained agent

**E2B-15 — Selection.** Default `ENGELBART_SANDBOX_SETUP=auto`: try the installed signed-in local Claude subscription first, optional Anthropic API fallback second. `claude-local` forbids fallback. `api` bypasses local Claude and requires ANTHROPIC_API_KEY. Invalid mode is an actionable configuration error. Missing local prerequisites with no permitted fallback fail before creating a VM.

Resolve the Claude executable through the user's login shell, then invoke the resolved file directly. Reference minimum is Claude Code 2.1.248; validate current flags/auth output for any changed version. Check `claude auth status --json` for a logged-in first-party claude.ai subscription. Do not inspect credential files/keychain payloads or publish account details. Pass only HOME, USER, LOGNAME, PATH, SHELL, TMPDIR, LANG, CLAUDE_CONFIG_DIR as needed; strip API/OAuth overrides, alternate providers, Electron/session/parent-agent state. Never send Claude subscription credentials to E2B. E2B credentials stay in the worker.

**E2B-16 — Local task.** Run a separate task-specific CLI with the source's restricted flags, empty built-in tools, disabled hooks/settings sources, strict per-run MCP configuration, no session persistence, 32 turns, default model `sonnet`, and 15-minute total local setup deadline. Pass prompt on stdin. Require the MCP server to connect and validate the CLI result. Keep task capability files in a private temporary directory and remove them after draining calls. Raw CLI stderr can contain account details and must not be persisted as a transcript.

The exact behavioral prompt is preserved in reference `src/main/sandbox/local-setup.cjs`. Preserve its requirements: inspect only missing facts; plan during installation; launch promptly when prerequisites are satisfied; include required backend services; never fabricate credentials; mutate only the disposable repository; use managed install/start/stop tools; diagnose the failed check before retrying; never claim success without verified start_app.

**E2B-17 — Bridge and tools.** Use a random authenticated loopback endpoint, constant-time token comparison, exact Host, POST `/tools`, no Origin, bounded requests and timeouts; stdio MCP is the only agent-facing transport. Accept no arbitrary remote host or VM selector. Validate all arguments independently of model-provided schema, reject unknown fields/type confusion/NUL/path traversal, serialize calls, and bound/redact results. File reads/listings must not execute repository code.

| Tool | Contract |
| --- | --- |
| `read_file {path}` | Bounded UTF-8 repository read; available during install |
| `list_files {path?}` | Bounded listing excluding dependency/generated trees; available during install |
| `write_file {path,content}` | Repository-only edit, max 64,000 chars; prohibited during install/after ready |
| `run_command {command,cwd?,timeout_seconds?}` | Foreground prerequisite/build command in VM, limit 180 s; not an unmanaged install/server |
| `dependency_install` | Start/status/stop/skip managed install; commands <=600 s, status wait <=180 s |
| `start_app {command,cwd?,port,path?,wait_for_install?}` | Saved foreground launch recipe, owned process supervision, health checks; port 1024–65535 excluding proxy port |
| `app_status {port?}` | Fresh owned-process/listener/local HTTP/log observation, no mutation |
| `stop_app {}` | Stop only the owned app tree, verify descendants stopped, preserve VM/files |

Every reply carries a compact observed app snapshot/changes (up to four) and current install status. No second agent polls continuously. Quoted shell arguments are constructed safely. Pattern guards against broad kills/background duplicate servers are usability guardrails; the real boundary is the disposable VM and absence of host credentials. **Hardening:** enforce realpath/symlink containment for file operations, not only lexical prefix checks; test oversized/unterminated streams before allocation and stale queued work after cancel/freeze.

**E2B-18 — Fallback.** Only auto mode may make one API attempt after local unavailability/setup failure. Log selected provider, redacted reason, and separately billed API usage. If local work already provisioned a VM, keep that VM, clone, and installed dependencies. Abort/drain local Claude and bridge/tools, confirm owned app/marked tool processes stopped, remove its saved local recipe, restore the environment snapshot, then enter the API path. Unconfirmed cleanup blocks fallback. Stop, cancel, a verified preview, final-summary failure, or a post-ready app failure can never trigger fallback. API failure terminates; no loop back to local.

**E2B-19 — API setup.** Reuse the installed hc pipeline through the uploaded `launch.py` adapter and `/opt/engelbart/hc_run.py`; no Canvas dependency on the web app server, Supabase queue/database, or web worker. Preserve JSONL phase events, saved launch recipes, dependency/repair/setup stages, and service/proxy discovery. Explicit deadline 45 minutes; VM TTL one hour covers attempts. Retain configured `HC_(BRIEF|RESOLVER|REPAIR|SETUP|SETUP_RETRY)_(MODEL|BUDGET_USD)` overrides. Runner model/budget defaults are historical runtime details in the template reference, not a new pricing guarantee. Keep setup-agent API credentials out of application processes unless the user separately saved the app's own value.

## 7. Installation and launch performance

**E2B-20 — Deterministic preflight.** Before Claude starts, inspect manifests, recognized lockfiles, runtime/package-manager declarations, scripts and custom configuration. Automatically start a managed frozen install only for an unambiguous root Node project with exactly one recognized lockfile and compatible already-available runtime/manager. Commands: npm ci; pnpm install --frozen-lockfile; Yarn 1 --frozen-lockfile / newer Yarn --immutable; Bun --frozen-lockfile. Keep required devDependencies and normal install lifecycle scripts. Unsupported semver/configuration, workspaces/nested packages, root install hooks, multiple/no lockfiles, missing tools/runtime, or non-Node projects produce `needs_agent` with a reason. Do not delete lockfiles, switch managers, guess runtime compatibility, or declare failure just because automatic selection deferred.

**E2B-21 — Overlap and managed jobs.** Installation runs independently of serialized tools, permitting concurrent read/list inspection and launch planning. While installation is starting/running/stopping/blocked, prohibit commands/edits/app launches that conflict. Agent-selected commands handle ambiguous/non-Node projects through the same managed job. Start replacement only after confirmed stop of the old process tree. Distinguish succeeded, failed, stopped, timed-out, skipped, and cleanup-blocked outcomes. Skip requires evidence and a reason. Never interpret a stopped/failed job as success.

Permit one coordinated parallel job for independent npm frontend and Python requirements.txt backend: validate roots and independence, npm ci plus a new backend .venv, both must succeed. Reject overlapping/workspace roots, linked dependencies, custom prerequisite/configuration, existing Python environments, or unsupported layouts; explain and use sequential jobs. Use the backend .venv interpreter at launch. One job owns both children, cancellation, replacement, and readiness.

**E2B-22 — Discovery.** Run bounded read-only manifest/Railpack launch discovery alongside preflight. Discover <=8 components within three directory levels; omit generated trees and symlink traversal. Run `railpack prepare` for <=3 install roots concurrently with six-second per-root limits and ~12-second overall command bound. Supply <=12 KB of filtered discovery JSON, not the full plan, caches, assets, secrets or environment values. Preserve scripts/ports/proxy/backend facts. Workspace children are components, not independent install roots. Missing/truncated/unsupported analysis remains explicit and falls back to inspection. Railpack hints are advisory; never execute its plan blindly or force a production build when the appropriate dev server needs none.

**E2B-23 — Direct handoff.** Tool replies refresh compact install status, including when installation finishes/fails during a read. Once a recipe is supported and no prerequisite remains, start_app is the next mutation. `wait_for_install:true` waits up to 30 seconds for confirmed success, then launches in the same tool call. Failure, stop, closed tools, or unknown cleanup blocks launch. Timeout leaves no queued launch. A later success does not revive an expired/cancelled waiter. A known required build/configuration step runs after install and before launch. Optional runtime credentials must not block an independent install or a runnable core preview; required startup credentials must produce a named blocker, never fabricated values.

**E2B-24 — Publish early.** On successful start_app, independently verify app ownership/local health/public preview and immediately publish ready. Freeze setup mutations including queued calls. Read-only observations remain possible while Claude finishes its final summary, bounded to 30 seconds outside time-to-live. Summary timeout/failure cannot stop the app or invoke fallback. App process supervision and Stop remain active during finalization. An app exit is an app failure even if Claude was still talking.

**E2B-25 — Audit and cache.** Disable inline npm audit during install; run a separate read-only bounded npm audit after readiness, at most once per initial run, not on environment-only restart. Audit result/failure cannot change readiness, dependencies, or the lockfile. Never run audit fix. Cancel audit on Stop/detach. Preserve findings/complete/unavailable/skipped status in logs, not fake build transitions.

Keep optional warmed npm/pip cache support. Cache only pinned public dependency manifests; no app source, credentials, .env, installed application or copied local node_modules. npm seeding alone disables lifecycle scripts; actual installs retain them. Record seed commit/manifest/profile hashes, prefer-offline configuration, and validate equivalent installed packages in benchmarks. Cache misses use the network. Yarn/pnpm/Bun/uv caches are not implied. Templates may be slower for some repositories; no universal latency claim.

## 8. Application supervision and restarts

**E2B-26 — Process ownership.** Persist a private bounded app record in the VM with attempt UUID, PID/start-time identity, descendants, listeners, local health and bounded logs. Starts use a lock; cancellation fences delayed attempts; replacement waits for confirmed stop. Do not kill unknown/unowned listeners to free a port. Surviving children must remain identifiable if the supervisor exits or PIDs are reused. API-mode/hc launch records must be retired only after their owned processes are confirmed gone, otherwise hc can reject a valid replacement or falsely report it stopped.

Sample owned processes/listeners/HTTP roughly once a second (checks may take longer), emit changes only, and distinguish running from healthy. Target the actual owned IPv4/IPv6 listener. Start has a 90-second local health bound plus bounded public verification. On failure return the failed-check snapshot and post-cleanup state; preserve the original error. Use one foreground supervisor for required multi-service launches and propagate required child failure. Do not imply every backend works from frontend HTML. **Hardening:** explicitly verify required services before complete-app success and surface degraded/dead service state during supervision.

**E2B-27 — Restart semantics.** Only ready or failed runs with a retained VM can request environment restart. Before interruption, connect and verify a valid reusable recipe. If no recipe, leave the existing app untouched. Detach the old worker without killing its VM; drain it before replacement. Keep the same run and sandbox IDs, reconnect, extend TTL to one hour, confirm prior app/proxy trees stopped, reopen the run with the selected environment revision, and start saved application commands. Preserve cloned/installed files and history. Reset current-cycle milestones and start a new notification/readiness cycle.

Restart must not clone, install dependencies, invoke either setup provider or repair agent, replay preparation/build steps, reapply old patches, or provision services. Support saved local-Claude recipe `{kind,command,cwd,port,path}`, native hc plans, and the supported setup-shell fallback. A failed restart preserves the VM/files for settings correction; Stop releases it. Full Retry is a separate new VM/attempt. Frontend values compiled into assets require a deliberate rebuild; process restart cannot change already-built JavaScript.

## 9. Credentials and configuration

**E2B-28 — Configuration precedence.** Read gitignored checkout `.env.local`, then the optional selected private env file, then `<root>/sandbox.env`, then process environment (highest). The selected path comes from process, personal file, then checkout file. Allowlist E2B_API_KEY, ANTHROPIC_API_KEY, E2B_TEMPLATE, E2B_DOCKER_TEMPLATE, ENGELBART_SANDBOX_SETUP, ENGELBART_SANDBOX_CLAUDE_MODEL and the HC model/budget settings above. Preserve parse errors as actionable failures. Keep `.env.example` values empty/example-only; no secrets in docs, Git, screenshots, prompts, IPC, catalog or notifications.

Historical configured aliases were `engelbart-canvas-cached` and explicit Docker `engelbart-runner-docker`; default is still `engelbart-runner`. Do not infer the Docker alias from a warmed template when a known explicit Docker template exists. Select aliases in the user's authenticated E2B project; historical IDs do not prove availability in another account. Do not overwrite private configuration during this port.

**E2B-29 — Saved app environment.** Encrypt `{values, removed}` with Electron safeStorage backed by an OS key store. Reject unavailable/basic-text storage; no plaintext fallback. Use UUID revisions and compare-and-swap semantics to reject stale edits; a process-local lock alone is insufficient if multiple writers exist. Empty values preserve whitespace and remain values; null changes remove an override and persist a removal tombstone. Limits: <=200 changes/active values, names `[A-Za-z_][A-Za-z0-9_]{0,127}`, no prototype keys or runner-control prefixes `HC_`, `HUMAN_COMPACT_`, `ENGELBART_CANVAS_`, `ELECTRON_`; <=16,384 characters/value, no NUL, <=128 KiB saved values, <=500 removals. Keep credentials for setup separate from identically named app-owned values.

Read IPC returns `{revision,names,removed,report}` only. Launch privately decrypts one snapshot and records its revision. Clear prior Canvas-managed names from hc's merge-only caches for all components and apply the complete new overrides to each new app process, including fallback shells; removals cannot resurrect old saved overrides. Repository dotenv/defaults may still supply repository-owned values and must be explained accurately. Scans persist at most 500 validated name/status entries, source metadata <=256 chars, public flags, missing/local lists, scan time/run ID; no values. Source enum values are in `src/shared/environment.cjs` in the archive.

**E2B-30 — Redaction.** Redact E2B/setup keys and app values recursively before persistence or publishing, including structured errors, escaped strings and stream-boundary fragments. Bound output after safe handling. Preserve protocol IDs/discriminants without destructive substring substitution. **Hardening:** independently validate identity/URL fields before storing them, use streaming redaction with bounded carry, and ensure attacker-controlled nested structures cannot bypass redaction or memory limits. Do not claim literal-secret filtering proves arbitrary encoded/exfiltrated secrets are safe. Do not expose host/home credentials to remote commands or model prompts.

## 10. Template prerequisites and packaging

**E2B-31 — Template contract.** A working account-accessible image contains Python, Git, compatible Node/package managers, hc's `human_compact.trajectory` modules, `/opt/engelbart/hc_run.py`, and `/opt/engelbart/proxy.mjs`. API runner capability includes saved recipes, structured events, environment scanning, and required helpers. Docker image adds Docker/Compose/Supabase CLI. Existing runner recipe includes browser health tooling and instrumentation; their presence is not a requirement to implement model tracing/recording in Canvas.

Source template builder lives in sibling `engelbart-web/sandbox/build-template.mjs`; it is not part of the Canvas Git commit. The local reference artifacts and hashes are recorded separately. Historical preserved hc was 0.20.4. Never substitute a similarly named package without compatibility checks. The migration document records the earlier 8 vCPU/8192 MiB setup and default disk allocation, not a current quota promise. Cache/base/Docker builds must validate their source and fail before publishing if incompatible. Existing account templates are sufficient for the Canvas port; rebuilding/publishing templates is a separate operational action when needed.

**E2B-32 — Distribution.** Add the e2b dependency and lockfile entries without reverting Hudson's package changes. Ensure the forked worker, local MCP adapter, Python helpers, shared modules and launch resources are available in the packaged ASAR/resource layout. Test Electron's process.execPath/fork semantics and file reads in development and packaged mode; explicitly unpack helpers only where execution requires real files. Keep credentials outside the bundle. Reference tests against the source branch do not establish packaged compatibility; this is a mandatory port check.

## 11. Robustness requirements and completion

In addition to the marked improvements, implement these failure controls:

- **E2B-33:** Persistent lifecycle generation/attempt fencing across restart/stop/retry so an old worker's event cannot mutate a reopened same-ID run. Use atomic state/revision checks and test the race.
- **E2B-34:** Idempotent remote release (confirmed not-found counts as released), bounded control requests, durable cleanup-needed evidence, and ownership-checked orphan recovery across all relevant SDK listing pages. Never kill a VM by unverified unrelated ID or create a replacement during uncertain ownership.
- **E2B-35:** Bounded protocol framing before newline and bounded queued output/backpressure; an oversized/no-newline stream cannot grow memory indefinitely or deadlock shutdown. Validate schemas before database updates.
- **E2B-36:** Diagnose absent credentials/templates/CLI/runtime and required backend failures with the failed stage, retryability, and whether a VM still exists. Avoid silent success, empty spinners and unbounded retry loops.
- **E2B-37:** Preserve startup auto-prepare behavior while bounding concurrent provisioning/resource pressure; no global lock that unnecessarily serializes all repository work. Cancellation reaches queued as well as running requests.

Completion requires the test/evidence matrix in ACCEPTANCE.md, including Hudson regressions, secret-boundary tests, same-VM restart, early-ready/fallback races, packaged execution and isolated live verification when credentials/runtime access permit. Report deterministic tests separately from real E2B checks. If live access is unavailable, finish all implementable local work, identify exactly what remains unverified, and do not claim full end-to-end success. Do not run model calls or create paid VMs just to author this specification.
