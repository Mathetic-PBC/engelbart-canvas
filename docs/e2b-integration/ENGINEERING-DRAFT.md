Read-only reference directory for this Build: /Users/divadbaroon/.engelbart/engelbart/E2B integration/reference

# E2B integration — Build request

Implement the complete E2B repository-preview integration described below in the Build worktree. Recreate the behavior of David's confirmed latest Canvas branch, with the specified robustness improvements, on the current Hudson-based code. Preserve the existing workspace Build lifecycle. This document is the settled implementation request, not a request for another plan.

Read the entire specification, implementation map and acceptance matrix below. Consult the pinned read-only reference archives and source-manifest.json in the `reference` directory beside this workspace document. The native workspace copy identifies that directory explicitly. Do not depend on uncommitted files in the person's checkout. Git source fallback: `2d570caefda24e23cd5b14669b26dd1853abf706`.

Finish all independently implementable code, tests, packaging and documentation. Use the normal Build worktree and let Engelbart manage Git checkpoints and acceptance. Report completed acceptance IDs and any exact external verification blockers. Do not merge the entire source branch, move workspace coding agents to E2B, or implement unrelated Canvas features. Do not start cloud template builds or alter private account settings merely to port this feature.

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


# Implementation handoff

## Start here

Read SPEC.md and ACCEPTANCE.md fully before editing. The new workspace embeds both plus this plan, so workspace Build receives the requirements even before these repository documentation files are committed. Its `reference/` folder is inside the Engelbart project folder granted read access by Hudson's Build policy. Reference archives are inputs, not code to run automatically.

The Canvas source is frozen at `2d570caefda24e23cd5b14669b26dd1853abf706`. It is available in the shared local Git object database and in `reference/canvas-source.tar.gz`. Use read-only inspection, for example:

```sh
git show 2d570caefda24e23cd5b14669b26dd1853abf706:src/main/sandbox/manager.cjs
git show 2d570caefda24e23cd5b14669b26dd1853abf706:src/main/sandbox/local-setup.cjs
```

If inspecting the archive, extract it to a new private reference directory within your Build worktree or permitted temporary directory. Validate against source-manifest.json. Never extract over the target code. It includes the source tree and tests to make transitive references available; this is not authorization to implement every feature in the other branch. The pinned source is preferred to any later movement of the branch name.

The agent makes changes only in its assigned Build worktree. Engelbart manages commits/branches/checkpoints and Accept; do not switch, merge, cherry-pick, push, or write into the person's checkout. Existing untracked `.env.local`, `src/main/sandbox/`, and benchmark directories in the person's checkout are not reference authority or migration inputs. Never read/copy private configuration just to find a test credential.

## Module map

Paths in this table are within the pinned reference archive unless described as target files.

| Responsibility | Reference files | Adaptation instruction |
| --- | --- | --- |
| Config, process boundary | `src/main/sandbox/config.cjs`, `transport.cjs`, `worker.cjs` | Preserve allowlists, fork semantics, ack-before-clone, provider selection, JSONL and cleanup; add schema/framing/generation hardening |
| Manager and run store | `src/main/sandbox/manager.cjs`, `runs.cjs` | Reconcile against target ctx/library interfaces; keep per-item serialization and durable uniqueness |
| Schema and upgrades | `src/main/store/db.cjs` | Port only sandbox/environment/log migration and required preview-identity pieces; do not replace the full database schema |
| Encrypted environment | `src/main/sandbox/environment.cjs`, `src/shared/environment.cjs` | Preserve mask/revision/removal contract; strengthen concurrent save transaction |
| Local subscription process | `src/main/sandbox/local-claude.cjs`, `local-mcp.cjs` | Preserve restricted CLI arguments and minimal environment; verify supported CLI version in operational tests |
| Setup prompt and tools | `src/main/sandbox/local-setup.cjs`, `local-tools.cjs` | Preserve exact prompt behavior, VM-bound bridge, early readiness and blocked mutations |
| Managed installation | `src/main/sandbox/local-install.cjs`, `install-job.py` | Port together; install job state and ownership protocol are coupled |
| Launch discovery | `src/main/sandbox/launch-discovery.cjs`, `launch-discovery.py` | Advisory bounded discovery; no execution of Railpack plan |
| App launch/restart supervisor | `src/main/sandbox/launch.py` | Preserve local recipe and hc/native/shell restart paths, PID ownership, locks, fencing, environment cleanup |
| Post-ready audit | `src/main/sandbox/npm-audit.cjs`, `npm-audit.py` | Read-only, asynchronous, bounded, never readiness authority |
| Logs and environment model | `src/shared/build-history.cjs`, `src/shared/environment.cjs` | Preserve first/latest milestones, agent retention, scan metadata, sequence ordering |
| Main wiring | `src/main/index.cjs`, `src/main/ipc.cjs`, `src/preload.cjs` | Add E2B initialization/API/events and lifecycle drains to current target code; preserve all current functionality |
| UI state and notifications | `src/renderer/ui/SandboxProgress.jsx`, `SandboxNotifications.jsx`, `sandbox-notifications.css`, `src/renderer/model/sandbox-notifications.js` | Global listener mounted before requests; E2B-only port must not require unrelated local-preview hooks |
| Inspector and environment | `src/renderer/workspace/BuildDetails.jsx`, `EnvironmentPanel.jsx`, `RunTimeline.jsx`, `repo-pane.css`, `environment-panel.css`, `run-timeline.css` | Adapt native overlays and Stage navigation; do not replace Hudson BuildPanel with this repository inspector |
| Timeline formatting | `src/renderer/model/canvas-build.js`, `run-steps.js`, `build-events.js` | Distinguish phases, runtime observations, overlapping durations, restart boundaries, empty history |
| Renderer integration | `src/renderer/App.jsx`, `screens/Workspace.jsx`, `screens/Home.jsx`, `workspace/Rail.jsx`, `workspace/Stage.jsx`, `ui/Topbar.jsx` where present | Use current target component equivalents; add bell/explicit open/error handling, not unrelated UI rewrites |
| Preview ownership map | `src/main/store/captured-sites.cjs`, relevant schema | `runs.cjs` calls rememberPreview; port minimal compatible behavior or deliberately decouple with equivalent stable identity |
| Optional thumbnail presentation | `src/main/store/repo-thumbnails.cjs` and reference consumers where present | Existing saved screenshots should not break; new screenshot capture/annotation systems are not necessary to run E2B |
| Warm templates | `scripts/build-sandbox-cache.cjs`, `scripts/sandbox-cache/*` | Keep builder dry-run, pinned seeds, isolated output and rollback |
| Operational smokes | `scripts/smoke-sandbox.cjs`, `scripts/smoke-sandbox-environment.cjs` | Disposable DB/VM only; cleanup in finally; never operate against the user's active records |
| Dependencies and distribution | reference `package.json`, `package-lock.json`; target `electron-builder.config.cjs`, `scripts/package-mac.mjs` | Add e2b 2.49.1 coherently; retain newer target Electron/React/updater/build dependencies and packaging |

The source archive contains shared files with unrelated changes. Transitive imports are a prompt to adapt an interface or copy a small required helper, not to port Google Docs, Zotero, Overleaf, recordings, annotations, workspace repository relocation, local generated-app previews, terminal session restore, or the rest of the source branch. Keep minimal stable preview identity compatible with those features if later added.

## IPC contract

Add trusted handlers/preload methods with the source names unless a target convention requires a documented equivalent:

| Renderer API | IPC | Parameters / result |
| --- | --- | --- |
| sandboxRuns | `sandbox-runs` | No arguments; latest `{run,message}` snapshots |
| ensureSandboxes | `sandbox-ensure` | No arbitrary paths; prepare eligible saved items once/session, return snapshot |
| startSandbox | `sandbox-start` | Library ID; canonical eligibility and lifecycle validated in main |
| stopSandbox | `sandbox-stop` | Run ID; scoped to current data root/library ownership |
| sandboxEnvironment | `sandbox-environment` | Library ID; revision/names/removals/report only |
| saveSandboxEnvironment | `sandbox-save-environment` | Library ID, validated changes, expected revision; names-only result |
| restartSandbox | `sandbox-restart` | Library ID; use one saved revision and existing recipe/VM |
| onSandboxProgress | `engelbart:sandbox-progress` | Subscription with disposer; scope/check event dataRoot |

Reference main IPC adds setup after library save and newly attached context persistence. Preserve that ordering across sidebar addition, browser Save, mention insertion, and workspace attachments that exist in the destination. Track pending asynchronous additions when switching mode/resetting. Do not bypass trusted-sender validation or permit renderer-supplied SDK keys/VM IDs.

## Build sequence and gates

1. **Inventory.** Compare current target with pinned source; identify existing schema additions, actual packaging layout, and current library/Stage APIs. Record scope decisions. Baseline the target's tests before introducing changes. Read the source tests as behavioral examples, including the complete local setup prompt.
2. **Persistence and protocol.** Introduce schemas, event/request validation, log retention, identity, environment storage and IPC shapes. Test migrations using temporary PGlite databases, duplicate active runs, revision conflict, stale events and redaction. No UI or live E2B prerequisite.
3. **Manager/worker lifecycle.** Wire SDK behind injectable dependencies, worker transport, creation ack, idempotent cleanup, cancellation, recovery and shutdown. Test every uncertainty/cleanup race with fakes and real local worker processes. Introduce generation fencing before implementing same-ID restarts.
4. **Runtime and providers.** Port Python adapter, subscription gating, bridge/tools, install ownership, discovery, setup prompt, API fallback, proxy and supervisor as a coherent contract. Run Python helper tests on a compatible Linux fixture/runtime; macOS alone cannot exercise Linux /proc/socket ownership faithfully.
5. **Environment restart.** Verify same-ID reuse, saved native/local/shell recipes, no installation/model calls, correct removal semantics, failed restart retention, and cleanup before replacement.
6. **Renderer and acquisition.** Integrate automatic preparation/attachments, bell, inspector, environment panel, timeline and explicit Stage navigation. Preserve focus/native overlays and data-root isolation. Test source behavior with current target UI rather than transplanting an old App/Workspace file.
7. **Packaging and isolated operation.** Include all runtime files; exercise worker/MCP/Python upload paths from a packaged build. Run credential-free regressions, then available isolated live smoke tests with cleanup evidence. Add/cache tooling without starting cloud template builds automatically.
8. **Delivery.** Record acceptance IDs passed/failed/blocked, commands and exit codes, live provider/template/commit evidence, cleanup outcomes, required settings, and any deviations. Leave a coherent implementation in the Build worktree for Review/Accept. Do not declare an untested environment or external template deployed.

All steps belong to this full workspace Build. Internal staging is for reviewability, not permission to stop after an arbitrary partial milestone. If an external requirement is unavailable, finish the independent implementation/tests and report the exact remaining operational blocker.

## External runner reference

`reference/template-runtime.tar.gz` is a separately hashed, allowlisted snapshot of the local sibling web project's runner build inputs and preserved hc source. It is not claimed to be byte-identical to a currently deployed image. The manifest identifies the sibling Git HEAD, individual source hashes, and locally modified/untracked inputs. The runtime archive has no private .env, credential files, node_modules, or application repositories.

Use its `sandbox/build-template.mjs`, `hc_run.py`, `proxy.mjs`, helper assets, and `sandbox/.hc/{pyproject.toml,README.md,src}` to understand/reproduce the prerequisite image when necessary. The builder's preserved-source validation/instrumentation patch matters; do not discard the only compatible hc snapshot. The source builder can fetch unpinned contemporary system tools, so a rebuild is not automatically reproducible: pin resolved versions/digests for a deliberate image rebuild and verify imports, helper paths, Docker capabilities and browser checks before publishing.

For ordinary Canvas implementation, use existing account templates configured privately. Account template creation/migration and live tests require runtime credentials and network access, which Hudson's coding-agent policy may not provide. Do not loosen that policy or exfiltrate settings to work around it. Finish credential-free work and provide an exact isolated smoke command for the operator if needed. No source-code change requires publishing a cloud template merely because launch.py changed.

## Source limitations to handle consciously

- Source public URL validation is generic HTTPS; positive app-health and assigned-host binding are stronger requirements in this port.
- Source GitHub Docker detection treats fetch failure as false; distinguish unknown capability.
- Source readline checks event size after receiving a whole line; enforce bounded framing before allocation.
- Source manager locks are in-memory, and terminal guards do not alone distinguish older events from a reopened same-ID run; add atomic generation/revision fencing.
- The source snapshot's documentation reports three pre-existing failures in frozen benchmark fixture tests because a captured-sites dependency is absent. Do not reproduce giant historical benchmark folders merely to hide that fixture problem. Select runnable behavioral tests, report exclusions, and repair a required test fixture coherently if carrying it forward.
- The E2B path prepares remote public repositories; it does not automatically sync uncommitted local edits, accept coding changes into Git, run Codex as the setup provider, or provide production hosting.
- A repository may have no web app, unsupported prerequisites, or missing required secrets. Report that outcome truthfully rather than fake a live preview.



# Acceptance and verification

Each row is an observable completion condition, not merely a suggestion to copy a test filename. Port/adapt the relevant reference tests and add tests for hardening. Use fresh fixture databases and mocked SDKs by default. Real sandbox tests must create and clean only their own resources. Do not run model calls or cloud provisioning as part of the ordinary unit suite.

## Required acceptance matrix

| ID | Scenario and expected result | Spec / reference evidence |
| --- | --- | --- |
| A01 | Add public GitHub URL: one library row persists, one setup starts, current UI selection remains | 01–03; sandbox-ipc |
| A02 | Reattach existing repo retries/reuses; repeated context save/reorder produces no extra start | 01–02; sandbox-ipc |
| A03 | Malformed/credentialed/non-GitHub/nested URLs and local files do not provision; canonical forms dedupe | 01; sandbox-manager, sandbox-runs |
| A04 | Setup handoff failure retains saved library/attachment and reports cause | 01; sandbox-ipc |
| A05 | Parallel Start/ensure calls yield one active DB row and one VM; unrelated repo work proceeds | 02,07,09,37; sandbox-manager |
| A06 | Stop/failure stays stopped during same-session refresh; next app session may automatically retry | 02; sandbox-manager |
| A07 | Healthy ready run reused; timeout/auth failure/unreachable state does not authorize duplicate VM | 10–11; sandbox-manager, sandbox-worker |
| A08 | Created VM ID persists before ack/clone; DB failure or missing ack causes cleanup | 12–13; sandbox-worker |
| A09 | Crash between create and persistence recovers by owned metadata, persists handle, cleans exactly its VM | 11,34; sandbox-manager, sandbox-worker |
| A10 | Recovery paginates and rejects ambiguous/unrelated matches; not-found cleanup is idempotent | 34; new hardening tests |
| A11 | Late duplicate/terminal events cannot resurrect failed/stopped/replaced/restarted generations | 09–10,33; sandbox-manager plus new restart race |
| A12 | Mode switch/quit/reset drains pending additions/workers/callbacks before DB close; cross-root events ignored | 07,11; sandbox-ipc, sandbox-manager |
| A13 | Stop during auth/create/clone/install/health/fallback/finalization cancels and never starts fallback/replacement | 10,18,24; sandbox-provider, sandbox-install |
| A14 | Cleanup failure retains handle and clear action; Retry first resolves it, never silently duplicates | 10–11,34; sandbox-manager, sandbox-provider |
| A15 | Automatic mode selects local subscription even when optional API key exists | 15; sandbox-provider |
| A16 | Missing/outdated/signed-out CLI selects allowed fallback before VM create; no-key strict mode fails pre-create | 15–16; sandbox-provider, sandbox-local |
| A17 | Explicit api skips subscription; strict claude-local never invokes API | 15; sandbox-provider |
| A18 | Local failure permits exactly one same-VM API handoff after tool/app drain, recipe reset and env restore | 18; sandbox-provider |
| A19 | Failed cleanup, Stop or post-ready app error cannot trigger API fallback; API failure terminates | 18; sandbox-provider |
| A20 | CLI has no built-in host tools/hooks/inherited provider keys; subscription credentials never enter VM | 07,16; sandbox-local |
| A21 | MCP adapter connects over stdio; wrong token/Host/Origin/method/args are rejected; no VM selector | 17; sandbox-local |
| A22 | File tool path escape, symlink escape, unknown properties, type confusion and unsafe preview routes rejected | 17; sandbox-local plus new symlink tests |
| A23 | Tool requests/results, stdout/stderr, unterminated JSON and queue growth stay bounded; orderly cancellation works | 13,17,35; sandbox-worker/local plus new stream stress |
| A24 | Compatible single-lockfile Node repo starts frozen install before agent; managers/runtime pins honored | 20; sandbox-install |
| A25 | Ambiguous workspaces/custom scripts/configuration/missing runtimes defer with cause, never guess/delete lockfiles | 20; sandbox-install |
| A26 | Read/list planning proceeds during install; mutations/duplicate installs cannot race it | 21; sandbox-install, sandbox-local |
| A27 | Failed/timed-out/stopped/unconfirmed install never unlocks launch; confirmed replacement owns one job | 21; sandbox-install |
| A28 | Independent npm+pip pair runs concurrently, uses new .venv, succeeds only if both children succeed | 21; sandbox-install + Python install checks |
| A29 | Shared/overlapping/linked/custom/unsupported parallel roots rejected with specific reason | 21; sandbox-install |
| A30 | Bounded Railpack discovery finishes before prompt; failure/truncation falls back; no plan execution or secret payload | 22; sandbox-discovery |
| A31 | Read reply can report install completion; prepared start waits then launches without another agent turn | 23; sandbox-install |
| A32 | Expired/cancelled install wait leaves no delayed launch even if installation later succeeds | 23; sandbox-install |
| A33 | Ready arrives before slow/failing final summary, once only; post-ready/queued mutations rejected | 24; sandbox-local, sandbox-provider |
| A34 | Required app exit interrupts summary and changes lifecycle; summary failure alone leaves preview up | 24,26; sandbox-provider |
| A35 | Owned process/PID-start-time records, orphan descendants and actual IPv4/IPv6 listeners are reported | 26; sandbox-launch + sandbox_app_check.py |
| A36 | Unknown port owner never killed; replacement waits for confirmed stop; stale attempt cannot start | 26; sandbox-launch |
| A37 | App-local health and expected assigned-host HTTPS route verified; wrong host/5xx/false 404/redirect rejected | 14; sandbox-worker/local plus new health tests |
| A38 | Required frontend/backend both live; required child failure is propagated; credentials-dependent behavior is not claimed from HTML | 14,26; multi-service fixture |
| A39 | Environment save is encrypted, renderer reads names only, unavailable keychain fails without plaintext fallback | 06,29; sandbox-environment |
| A40 | Add/update/remove/empty/whitespace values, bounds, reserved names and conflicting revisions behave correctly | 29; sandbox-environment + concurrent save |
| A41 | Structured/escaped/split secrets absent from output, DB/logs/prompts/IPC; short values do not corrupt protocol IDs | 30; sandbox-environment/local + stream redaction |
| A42 | Detected variable names survive 300-event eviction/reopen/new failed scan; untouched fields not saved as empty | 06,09,29; environment-report, sandbox-environment |
| A43 | Restart validates recipe before interrupting; same run/VM IDs and installed sentinel survive | 27; sandbox-worker and live environment smoke |
| A44 | Restart makes zero clone/install/setup/repair calls; new env applied to local/native/shell paths and every component | 27,29; sandbox-launch, sandbox-environment smoke |
| A45 | Removed override never resurrects from merge cache; user-app credentials separated from setup credentials | 29; sandbox-launch, environment smoke |
| A46 | Failed restart retains VM/files for correction; Stop releases it; Retry creates distinct attempt | 10,27; sandbox-worker/manager |
| A47 | Log tail 300, agent activity 200, lifecycle first/latest survives eviction; tied timestamps keep order | 09; sandbox-runs, run-timeline |
| A48 | Legacy DB migration twice preserves library/workspaces/old attempts and backfills only available evidence | 09; sandbox-runs, sandbox-environment |
| A49 | Bell matches progress/completion/failure, no auto-navigation, explicit Open live and separate GitHub action | 03–05; sandbox-notifications + UI smoke |
| A50 | Read/clear persisted per mode; dismissed progress quiet but completion alerts; stale/duplicate/stopped rows excluded | 04; sandbox-notifications |
| A51 | Inspector tabs/actions/focus/Escape/keyboard/native-overlay work; time-to-live handles overlap/restart correctly | 05; run-timeline, build-steps + UI smoke |
| A52 | Audit runs only after initial ready; unavailable/findings do not fail app or change dependencies | 25; sandbox-audit |
| A53 | Cache seeds contain pinned public manifests only; actual installs retain scripts and package parity; rollback works | 25; sandbox-cache |
| A54 | Docker query unavailable/truncated is not false confidence; compatible template/daemon checked or clear blocker | 12,36; new capability tests |
| A55 | Packaged app includes/reads worker, MCP and Python helpers; packaged worker starts and reports validated events | 32; isolated packaged smoke |
| A56 | Existing Hudson Build context, worktree isolation, reply/Stop/Resume, checkpoint, Review, Accept, Discard and post-it flows pass | 01,08; target build/build-git/post-it tests |
| A57 | Existing library, Stage browser, tools/onboarding, test-mode switching and application data preserved | 08; target regressions |
| A58 | Fresh local-provider E2B smoke persists verified ready URL and independent expected HTTP result, then confirms owned VM cleanup | 12–26; smoke-sandbox |
| A59 | Fresh API-provider smoke exercises API runner/proxy, persists verified ready and cleanup; fallback exercised separately | 18–19; smoke-sandbox plus provider tests |
| A60 | Report distinguishes historical/source tests, new mock/helper tests, actual live/provider/package evidence and blocked checks | 36; implementation delivery |

## Reference test inventory

Core `test/sandbox-{runs,manager,worker,ipc,environment,local,provider,install,discovery,launch,audit,notifications,cache}.test.cjs`, `test/environment-report.test.cjs`, `test/run-timeline.test.cjs`, `test/build-events.test.cjs`, `test/build-steps.test.cjs`, and corresponding Python `sandbox_*_check.py` files establish the source's intended contracts. Inspect their assertions before porting; source-shape-only UI assertions need behavior-level coverage in the destination.

The runtime ownership helpers use Linux process metadata. Run their relevant checks in a compatible isolated Linux environment; do not weaken production checks so a macOS-only test happens to pass. Unit tests should dependency-inject SDK operations, process spawn, clock/deadlines and probe responses. Include real subprocess tests for JSON framing/stdio bridge and deterministic temporary Git/PGlite fixtures for target integration.

Do not copy frozen `docs/benchmarks/**/implementations` folders or run billed benchmark scripts in the default test suite. The reference history reports missing-module failures in frozen benchmark fixtures, which are not evidence of a runtime regression in this port. Preserve meaningful performance regression checks for overlap, readiness ordering, bounded discovery and package parity.

## Execution guidance for the implementation

After dependencies and tests are ported, run the project's full test/build commands plus focused failing tests as needed. Typical commands are:

```sh
npm ci
node --test test/sandbox-runs.test.cjs test/sandbox-manager.test.cjs test/sandbox-worker.test.cjs test/sandbox-ipc.test.cjs test/sandbox-environment.test.cjs test/sandbox-local.test.cjs test/sandbox-provider.test.cjs test/sandbox-install.test.cjs test/sandbox-discovery.test.cjs test/sandbox-launch.test.cjs test/sandbox-audit.test.cjs test/sandbox-notifications.test.cjs test/sandbox-cache.test.cjs
npm test
npm run build
git diff --check
```

These are commands for the future implementation, not a claim that those files exist on Hudson's current branch or were run while authoring this spec. If the target changes filenames, record the mapping. Missing dependencies/network require an explicit blocked verification result, not a fabricated pass. Use project-appropriate Electron smoke tooling with an isolated profile/data root for IPC/UI/package checks.

For live tests, ensure private credentials/templates and ordinary CLI sign-in are configured through the normal runtime outside the spec. Do not print environment secrets or copy them into a Build prompt. The source smoke commands are:

```sh
# Local subscription only, deliberately no API fallback:
ENGELBART_SANDBOX_SETUP=claude-local ANTHROPIC_API_KEY= node scripts/smoke-sandbox.cjs https://github.com/render-examples/express-hello-world
# Separate API path; requires its private key:
ENGELBART_SANDBOX_SETUP=api node scripts/smoke-sandbox.cjs https://github.com/render-examples/express-hello-world
# Saved recipe, same-VM environment restart; --local does not need model calls:
node scripts/smoke-sandbox-environment.cjs --local
node scripts/smoke-sandbox-environment.cjs
```

Live tests use E2B time and, for setup, the configured provider's subscription/API usage. They must retain cleanup evidence even when the app/probe fails and use only their own disposable DB/VM. Where a fixed public repo HEAD is used, record the resolved commit; for comparable benchmarks pin it. A single smoke latency is not a performance guarantee.

Include a simple Node app, independent frontend+Python backend, a workspace/monorepo needing agent inspection, an intentionally missing startup secret, a port conflict, and failed cleanup in the combined fixture matrix. Docker-backed live verification is required before claiming Docker/Supabase application compatibility; the existence of Docker binaries or a past hello-world container is insufficient.

## Completion report format

Record target/source hashes, changed modules, any explicit behavior deviations, test commands/exit codes, acceptance IDs with pass/fail/blocked status, provider/template and resolved repository commit for each live run, local/public health evidence, environment revision/restart identity evidence, packaged resource checks, and cleanup confirmation. Never include secret values. If blocked, provide the exact remaining operator step and its expected result. Workspace Build success means a reviewable implementation and honest verification report; production deployment and cloud-template publishing are not implied.


## Build now

Implement E2B-01 through E2B-37 and verify A01 through A60 as specified. Preserve the baseline behavior and all listed lifecycle/credential guarantees. Keep the current Hudson application coherent. End with a concise implementation/validation report, including anything blocked or uncertain; do not substitute a new high-level proposal for implementation.
