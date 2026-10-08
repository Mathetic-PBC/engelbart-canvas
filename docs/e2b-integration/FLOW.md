# E2B behavior flows

This is a reading copy, with JSON indentation expanded, of the actual Bart answers in [WORKSPACE.md](WORKSPACE.md). The native workspace and WORKSPACE.md retain the questions, source context and Build instruction. Later explicit corrections override earlier statements; read the final review before implementing.

Current flow: Hudson `ab0377d475ece3ca8231c11ecc6a799277417122`. New flow: Canvas `2d570caefda24e23cd5b14669b26dd1853abf706`. JSON examples are fictional, and projections explicitly omit other fields. Proposed robustness improvements are separate from source behavior.

## Bart answer 1

**Current flow — Hudson `ab0377d475ec`**

1.) Behavior: Save and optionally attach a repository. Hudson has no tracked E2B manager, sandbox IPC or `sandbox_runs` table. Adding starts no sandbox or preview; workspace Build is separate. Sources: `src/main/ipc.cjs`, `src/main/store/db.cjs`.

1.1.) Event: Add a new entry using the rules in New 1.1. DB projection: other library columns omitted; baseline lacks the three thumbnail columns shown below.

Before:
```json
{
  "library": []
}
```
After:
```json
{
  "library": [
    {
      "id": "a27b6e09-f342-4f91-8c58-64ba719312ef",
      "name": "fictional-lab/demo",
      "type": "website",
      "url": "https://github.com/fictional-lab/demo",
      "tags": [
        "git"
      ]
    }
  ]
}
```

1.2.) Decision: Reject duplicate adds; reuse through lookup/attachment. Attachment saves workspace context metadata, not `library.project_id`. Neither starts E2B. Source: `src/main/store/library.cjs`.

**New flow — Canvas `2d570caefda2`**

1.) Behavior: Add/attach, then prepare/reuse without navigating. Verified against `docs/sandbox-runs.md` and pinned source, not implemented here. Examples are fictional; unrelated DB tables are omitted.

1.1.) Event: Validate/canonicalize, then add.

1.1.1.) Decision: Invalid input?

- Reject non-string, over 4,096 characters, NUL or empty input; trim whitespace/outer quotes.
- GitHub HTTP(S), `www` and `git@github.com:` forms become HTTPS owner/repo; remove `.git`, subpaths, query and fragment, including branch selection. Other supported remotes also canonicalize. Bare `owner/repo` is rejected.
- Best-effort GitHub lookup supplies name/URL, numeric ID **as a string**, and description. Failure still permits adding; existence is not guaranteed. A known clone yields `type:"folder"` and `folder_path`.

1.1.2.) Decision: Already in the library?

- Yes: match known GitHub ID, otherwise canonical address case-insensitively; different known IDs distinguish reused URLs. Throw `EXISTS` (“Already in the library as …”); no sandbox handoff. Existing metadata may still be enriched.
- No: insert. This full actual-schema row assumes no known clone and unavailable identity metadata. Sources: `src/main/store/library.cjs`, `src/main/store/db.cjs`.

Before:
```json
{
  "library": [],
  "sandbox_runs": []
}
```
After:
```json
{
  "library": [
    {
      "id": "a27b6e09-f342-4f91-8c58-64ba719312ef",
      "name": "fictional-lab/demo",
      "type": "website",
      "path": null,
      "url": "https://github.com/fictional-lab/demo",
      "folder_path": null,
      "project_id": null,
      "created": "2026-09-22T01:00:00.000Z",
      "last_edited": "2026-09-22T01:00:00.000Z",
      "summary": null,
      "summary_edited": null,
      "char_count": null,
      "github_id": null,
      "tags": [
        "git"
      ],
      "categorized": 1,
      "thumbnail_path": null,
      "thumbnail_captured_at": null,
      "thumbnail_run_id": null
    }
  ],
  "sandbox_runs": []
}
```

1.2.) Decision: Prepare now? Sources: `src/main/ipc.cjs`, `src/renderer/ui/SandboxProgress.jsx`, `src/main/sandbox/manager.cjs`.

1.2.1.) Event: Choose the trigger.

- New add: save row, then start for raw GitHub HTTP(S)/`git@` input. Quoted/SSH input and clones can miss this gate; library-refresh ensure subsequently considers git-tagged rows.
- Existing entry: lookup, save attachment, then start newly attached GitHub IDs. Re-saving/reordering starts nothing. Handoff errors return non-DB `sandbox_error`; row/attachment survive.
- Load/refresh: ensure calls `automatic:true` for git-tagged rows, including clones. Manager accepts saved HTTPS GitHub owner/repo only (optional trailing slash; no query/subpath or `.`/`..` components); otherwise returns null.
- In-memory `prepared` Set is keyed by data root/library ID. After marking, automatic calls return latest without probing/retrying—even after preparation errors. Retry build/new attachment bypasses the gate; relaunch permits automatic preparation again.

1.2.2.) Decision: Existing run? Serialize decisions per data root/library ID.

- `starting` with tracked local worker: reuse and publish status.
- `starting` without worker: probe; recover/save missing ID through ownership metadata, clean up remaining machine, mark interrupted attempt failed. Confirmed absence also fails it. Successful reconciliation permits replacement.
- `ready`: probe even with worker, unless automatic gate returned. Reachable: reuse without navigation. Unreachable/network/auth errors: preserve, block replacement. Other confirmed states: Stop/cleanup before replacement.
- No active run, or latest `failed`/`stopped`: read environment; kill retained sandbox before insertion. Read/cleanup failure blocks rebuilding. Keep prior attempts.
- Partial unique index permits one `starting`/`ready` per library item. Conflicting insert returns active run without another worker.

1.2.3.) Decision: Health limits. Every 15 seconds, poll checks latest active runs in registered contexts; starting workers are not probed, and poll never launches replacements. Ready means E2B running plus HTTPS response below 500, no redirect following, five-second timeout, first chunk capped at 1,000 characters excluding “Invalid Host header”/“not allowed”. Many 4xx pass; this is not full app health. Orphan recovery reads only the first listing-page item. Sources: `src/main/sandbox/manager.cjs`, `src/main/sandbox/worker.cjs`.

1.3.) Event: Insert a new run. Full initial DB row immediately after insertion, before initial logging; library omitted unchanged. Sources: `src/main/store/db.cjs`, `src/main/sandbox/runs.cjs`.

Before:
```json
{
  "sandbox_runs": []
}
```
After:
```json
{
  "sandbox_runs": [
    {
      "id": "7e41c6b2-580a-4bda-9d9f-82f094312abc",
      "library_id": "a27b6e09-f342-4f91-8c58-64ba719312ef",
      "sandbox_id": null,
      "status": "starting",
      "preview_url": null,
      "port": null,
      "error": null,
      "created_at": "2026-09-22T01:00:01.000Z",
      "updated_at": "2026-09-22T01:00:01.000Z",
      "finished_at": null,
      "build_log": [],
      "build_milestones": {},
      "env_revision": null,
      "env_report": null
    }
  ]
}
```

1.3.1.) Event: Save environment revision (null here), record “Starting repository setup”, publish. Logs contain `id,time,message,seq` (initially 1); milestones retain first/latest; `updated_at` changes. Insert/update/log exceptions prevent launch, but separate writes can leave an unowned starting row. Launch exceptions attempt failure persistence. Source: `src/main/sandbox/manager.cjs`.

1.4.) Event: Attach listeners, then send the complete worker request.

Before — runtime projection (DB/other runtime state omitted):
```json
{
  "start_request_sent": false,
  "worker_output_listeners_attached": false
}
```
After — same runtime projection:
```json
{
  "start_request_sent": true,
  "worker_output_listeners_attached": true
}
```

Fork local worker → attach stdout/stderr/error/close handlers → send exact request below through Node IPC. Renderer subscribes before snapshot/ensure. Credentials pass separately as private worker configuration; no saved app variables here. Sources: `src/main/sandbox/transport.cjs`, `src/main/sandbox/manager.cjs`, `src/renderer/ui/SandboxProgress.jsx`.

```json
{
  "command": "start",
  "run_id": "7e41c6b2-580a-4bda-9d9f-82f094312abc",
  "github_url": "https://github.com/fictional-lab/demo",
  "sandbox_id": null,
  "port": null,
  "environment": {
    "revision": null,
    "values": {},
    "removed": []
  }
}
```

1.5.) Event: Worker checks URL/config/provider, selects normal/Docker template, creates E2B. Default auto checks local Claude first. Ownership metadata uses `canvasRunId`, `repo`, `app:"engelbart-canvas"`; lifetime is one hour. Preflight/create can fail without an ID. Source: `src/main/sandbox/worker.cjs`.

1.5.1.) Event: Receive sandbox-created, persist, then ACK. Worker stdout carries this JSONL event:
```json
{
  "run_id": "7e41c6b2-580a-4bda-9d9f-82f094312abc",
  "event": "sandbox_created",
  "sandbox_id": "sb-fictional-demo"
}
```

Transport serializes events/checks run ID; manager validates/saves sandbox ID → records “Sandbox created” → publishes → resolves callback. These saves are separate. DB projection omits unchanged identity/creation/error/environment fields and library; also omits changing logs/milestones. Progress persists in the latest-300 log; this event adds its log and first/latest milestone.

Before:
```json
{
  "sandbox_runs": [
    {
      "id": "7e41c6b2-580a-4bda-9d9f-82f094312abc",
      "sandbox_id": null,
      "status": "starting",
      "preview_url": null,
      "port": null,
      "updated_at": "2026-09-22T01:00:04.000Z",
      "finished_at": null
    }
  ]
}
```
After:
```json
{
  "sandbox_runs": [
    {
      "id": "7e41c6b2-580a-4bda-9d9f-82f094312abc",
      "sandbox_id": "sb-fictional-demo",
      "status": "starting",
      "preview_url": null,
      "port": null,
      "updated_at": "2026-09-22T01:00:05.000Z",
      "finished_at": null
    }
  ]
}
```

After callback fulfillment, main sends IPC ACK; ACK has no DB column:
```json
{
  "command": "ack"
}
```

Worker waits up to 30 seconds, then checks cancellation before cloning. UI shows building/progress, without navigation. Persistence/handler exceptions suppress ACK and send Stop; absent ACK times out. Cleanup/failure recording are attempted, not guaranteed if DB fails. Sources: `src/main/sandbox/transport.cjs`, `src/main/sandbox/manager.cjs`, `src/main/sandbox/runs.cjs`.

1.5.2.) Decision: Material limitation. Missing/terminal rows or no-row updates can still produce ACK without a saved handle. Positive persistence confirmation is a **proposed robustness improvement**, not observed behavior. Manager/worker/runs/IPC tests were read, not run; deployment and live E2B behavior remain unverified.

*Astra · ultra · 483 s — actual Engelbart Bart response.*

## Bart answer 2

**Current flow — `ab0377d475ec`**

2.) Behavior: Hudson has no E2B worker; URL addition does not launch one. Workspace Build remains local (`src/main/ipc.cjs`).

**New flow — `2d570caefda2`**

2.) Behavior: The worker prepares and launches the repository. Select provider before provisioning; clone after Part 1’s ACK. Fictional examples show runtime/transport, **not DB columns**.

2.1.) Event: Read private configuration, lowest → highest: checkout `.env.local` → selected `ENGELBART_SANDBOX_ENV_FILE` → `~/.engelbart/sandbox.env` → process environment. Selector: process → personal → checkout. Allowlisted values stay outside renderer. Require `E2B_API_KEY` always, `ANTHROPIC_API_KEY` for API/fallback only. Source: `src/main/sandbox/config.cjs`.

2.2.) Decision: Provider.

- `ENGELBART_SANDBOX_SETUP=auto` (default): prefer local even with an API key. CLI passes → 2.3 then 2.4; missing/outdated/signed out → 2.3 then 2.9 with API key, else fail without VM.
- `claude-local`: require local; never fall back.
- `api`: skip CLI, require API key; 2.3 then 2.9.
- Invalid mode/missing E2B key: fail.

2.2.1.) Event: Resolve CLI through login shell, invoke directly; require **2.1.248+**. `claude auth status --json` must report `loggedIn:true`, `authMethod:"claude.ai"`, `apiProvider:"firstParty"`, subscription Pro/Max/Team/Enterprise. Each check ≤15 seconds; CLI retains credentials, Canvas reads no credential files/keychain. Sources: `src/main/sandbox/worker.cjs`, `src/main/sandbox/local-claude.cjs`.

2.3.) Decision: Unauthenticated GitHub HEAD-tree lookup (≤10 seconds) finds `(docker-compose|compose).yml/.yaml` or `supabase/config.toml` → `E2B_DOCKER_TEMPLATE`, default `<base>-docker`; else `E2B_TEMPLATE`, default `engelbart-runner`. **Source limitation:** Dockerfile alone is missed; failed/non-OK lookup silently selects standard. Require deployed `/opt/engelbart/hc_run.py`, hc/tools and `/opt/engelbart/proxy.mjs`; no image build here. Create timeout 60 seconds, TTL one hour; ownership metadata keys `canvasRunId`, `repo`, `app` (`engelbart-canvas`), never `runId`. Sources: `src/main/sandbox/worker.cjs`, `docs/sandbox-runs.md`.

2.3.1.) Event: After ACK, `git clone --progress --depth 1` into `/home/user/repository`, ≤5 minutes, `GIT_TERMINAL_PROMPT=0`. No GitHub token/ref/submodule workflow; **private access is not established**. Root `yarn.lock` installs missing Yarn Classic 1.22.22. Docker branch starts `dockerd`, probes 30×1 second (40-second command bound); it does not run Compose or verify services. Upload launcher/private environment file.

2.4.) Event: Local CLI uses `--restricted`, no built-ins/hooks/inherited settings/session persistence, strict per-run MCP, `dontAsk`, **32 turns**; model `ENGELBART_SANDBOX_CLAUDE_MODEL` defaults to `sonnet`. Exactly eight tools: `run_command`, `read_file`, `write_file`, `start_app`, `app_status`, `stop_app`, `list_files`, `dependency_install`.

Authenticated loopback bridge binds one VM, validates/serializes calls, accepts no sandbox-ID argument; installs run independently. Command guardrails are not shell confinement. CLI excludes API/OAuth/provider/session overrides; E2B key stays main/worker, Anthropic key only API setup. App values reach VM jobs/app privately; known values are redacted. Remove bridge capabilities; do not persist raw CLI stderr. Sources: `src/main/sandbox/local-claude.cjs`, `src/main/sandbox/local-mcp.cjs`, `src/main/sandbox/local-tools.cjs`.

2.5.) Event: **Local path only:** preflight/discovery run concurrently; Claude starts after both return, while eligible installation continues. Plan launch/services during install. Sources for 2.5: `src/main/sandbox/local-setup.cjs`, `src/main/sandbox/local-install.cjs`, `src/main/sandbox/install-job.py`, `src/main/sandbox/local-tools.cjs`.

2.5.1.) Decision: Automatic install eligible?

- One root Node manifest/exactly one recognized lockfile, available compatible runtime/manager, supported packageManager/engines/Volta/runtime declarations → `npm ci`, `pnpm install --frozen-lockfile`, Yarn 1 `yarn install --frozen-lockfile`, newer Yarn `yarn install --immutable`, or `bun install --frozen-lockfile`.
- Workspace/nested/truncated layout, custom configuration/root lifecycle scripts, missing/unsupported versions, non-Node/no lock → `needs_agent`; inspect prerequisites and start managed job. Do not guess runtime/manager or discard lockfile.
- Preflight ≤20 seconds, depth 2/100 directories. Disable inline npm audit per process; retain scripts/devDependencies. Audit follows ready.

2.5.2.) Decision: Railpack discovery: ≤8 components, depth 3/120 directories; ≤3 install roots concurrently, workspace children grouped. `railpack prepare` ≤6 seconds/root, helper ≤12 seconds, ≤12 KB context. No app credentials or install/build/start execution. Production paths/runtime/commands are **advisory**; missing/truncated/unavailable hints require inspection. Prefer suitable existing dev scripts; preserve necessary builds. Sources: `src/main/sandbox/launch-discovery.cjs`, `src/main/sandbox/launch-discovery.py`.

2.5.3.) Decision: Managed job outcome?

- Active/`blocked`: reads/list/status allowed; edits/commands blocked. Replies include fresh install status, app observations and ≤4 changes.
- `succeeded`: required build/configuration, then launch promptly; no redundant status poll.
- `failed/stopped`: inspect, repair, retry; repairs allowed, launch blocked.
- Stop/replacement must confirm owned tree cleanup; failure → `blocked`, no replacement/edits/launch. Completion also cleans orphan children.
- `skip` requires reason; agent must verify existing/no-needed dependencies. `start_app` requires `succeeded/skipped`.
- Job default/max 600 seconds; status wait ≤180 seconds.

Before — tool-reply projection; other job/app fields, including IDs/times/logs, omitted:
```json
{
  "dependency_install": {
    "status": "running",
    "exitCode": null
  },
  "app": {
    "status": "idle",
    "running": false
  }
}
```
After — no app launched:
```json
{
  "dependency_install": {
    "status": "succeeded",
    "exitCode": 0
  },
  "app": {
    "status": "idle",
    "running": false
  }
}
```

2.5.4.) Decision: npm+pip job? Validate both first: real disjoint repo paths; no shared manifests/config/workspaces/linked dependencies/custom bootstrap; npm passes preflight; plain requirements, no existing Python environment or editable/include/local/URL dependencies. Else use sequential jobs. `npm ci --no-audit` and fresh `.venv`/pip run concurrently; **both must succeed**. Agent checks semantic independence.

Tool arguments:
```json
{
  "action": "start",
  "parallel": [
    {
      "manager": "npm",
      "cwd": "frontend"
    },
    {
      "manager": "pip",
      "cwd": "backend"
    }
  ]
}
```

2.5.5.) Decision: `start_app` with `wait_for_install:true` waits ≤30 seconds, launches on confirmed success. Failure/Stop/blocked/abort/close prevents launch. Expiry queues nothing; wait via status, explicitly retry.

2.6.) Event: Require command/known port (1024–65535 except 43110); cwd defaults to repo, path to `/`. Confirm prior app stopped; save 0600 VM recipe/environment; run `launch.py --local --attempt <uuid>`. VM recipe, not DB:
```json
{
  "kind": "claude-local",
  "command": "npm run dev -- --host 0.0.0.0 --port 5173",
  "cwd": "/home/user/repository",
  "port": 5173,
  "path": "/"
}
```

2.6.1.) Decision: Lock/fence attempts; record ownership before fork using attempt tag/PID birth times/descendants. Unknown/unowned port listener → reject, never kill it. Replacement requires confirmed stop; failed launch returns `failed_check` plus cleanup state. One foreground command may supervise children. Fix failed checks before retry; attempt failure → 2.8.

2.6.2.) Decision: Owned IPv4/IPv6 listener → local HTTP 200–399 (redirects followed), one-second checks, 75-second readiness/90-second caller bound. Proxy 43110 targets that listener; ten public tries, 500 ms gaps; recheck running/local health. **Public limitation:** five-second HTTPS check, no redirects, status <500, first chunk ≤1,000 characters excluding “Invalid Host header”/“not allowed”; many 4xx pass. Entry health proves no other services/credentials. Later HTTP degradation reports status without itself ending supervision. Sources for 2.6: `src/main/sandbox/launch.py`, `src/main/sandbox/local-setup.cjs`, `src/main/sandbox/worker.cjs`.

2.7.) Event: Freeze queued/future mutations before `onReady`; only read/list/app-status/install-status remain. Emit ready once **before final summary**; summary ≤30 seconds. Summary error/timeout leaves app supervised, without fallback; app exit/Stop still interrupts. Source: `src/main/sandbox/local-setup.cjs`.

Before — worker transport projection; omit run_id/message fields:
```json
{
  "event": "progress",
  "kind": "status",
  "data": {
    "phase": "check",
    "status": "checking"
  }
}
```
After — full worker transport event:
```json
{
  "run_id": "7e41c6b2-580a-4bda-9d9f-82f094312abc",
  "event": "ready",
  "preview_url": "https://fictional-preview.example/",
  "port": 5173
}
```

2.8.) Decision: Local attempt fails before ready → **one same-VM API fallback** only with auto+key and no Stop. Close bridge, reject/drain tools, stop install; confirm app/marked tool trees stopped via `launch.py --stop --reset-local`; discard recipe, restore environment, then 2.9. Keep clone/dependencies. Cleanup failure blocks handoff; strict-local/no-key fails; Stop/post-ready never falls back. Fallback-intent log precedes remote cleanup, not proof API began. Sources: `src/main/sandbox/local-setup.cjs`, `src/main/sandbox/worker.cjs`, `src/main/sandbox/launch.py`.

2.9.) Event: **API branch only:** invoke hc via `launch.py`; app excludes provider key. Further setup/repair may occur; failure never cycles providers. Require integer ready port; validate service ports/hosts, proxy entry-first on 43110+n; verify only entry URL (ten tries, one-second gaps), not every service. Local preflight/setup deadline 15 minutes, cleared at ready; API 45 minutes; shared original VM TTL one hour. Source: `src/main/sandbox/worker.cjs`.

Relevant tests read, not run; deployment/live behavior unverified.

*Astra · ultra · 703 s — actual Engelbart Bart response.*

## Bart answer 3

**Current flow — `ab0377d475ec`**

3.) Behavior: Hudson has no E2B progress/completion pipeline or inspector. Preserve local Build/navigation (`src/main/ipc.cjs`).

**New flow — `2d570caefda2`**

3.) Behavior: Persist evidence, derive notifications, navigate on explicit click. Fictional `fictional-lab/demo` and IDs continue Part 1.

3.1.) Event: Parse stdout JSONL ≤256,000 characters/line; match requested `run_id`, serialize callbacks. Manager handles progress/sandbox_created/ready/failed/stopped only for existing starting/ready rows. Unknown events, invalid JSON/ID/size or callback errors send Stop and reject transport completion. Sources: `src/main/sandbox/transport.cjs`, `src/main/sandbox/manager.cjs`.

Exact representative worker payload:
```json
{
  "run_id": "7e41c6b2-580a-4bda-9d9f-82f094312abc",
  "event": "progress",
  "message": "Cloning repository"
}
```

3.2.) Event: Persist before publishing. Redact known secrets; message ≤2,000 trailing characters; kind limited to status/command/stdout/stderr/error, data to non-array object. Entries have `id,time,message,seq`, optional kind/data. SQL atomically increments sequence, retains **last 300** logs, updates milestones/applicable environment report and `updated_at`. Sequence orders tied timestamps.

`build_milestones` maps keys such as `command:install`, `check:::ok`, `message:Preview ready` to full `{first,last}` entries, independent of log eviction. `agent:activity.entries` keeps latest **200** phase-agent/actor-setup-agent records. `services:observed` requires boolean app.running and array listeners. Ordinary stdout/stderr, audit/cost and generic monitoring are not lifecycle milestones. Sources: `src/main/sandbox/runs.cjs`, `src/shared/build-history.cjs`.

3.2.1.) Decision: Merge logs/milestones, deduplicate UUIDs (legacy content fallback), sort sequence or legacy time. Timeline stages are **derived UI**; absent evidence says “Not recorded”. Time-to-live uses start/restart → first recorded ready, never `updated_at`/`finished_at`; audit/process observations do not advance stages. Sources: `src/renderer/model/canvas-build.js`, `src/renderer/model/build-events.js`, `src/renderer/model/run-steps.js`.

3.3.) Event: Subscribe before snapshot/ensure. `engelbart:sandbox-progress` carries dataRoot/run/message; manager caches latest message. Reload fetches latest run per library item, using log-tail message when memory is absent. Renderer filters root, rejects older created/updated timestamps (equal accepted), merges without navigation. Runtime items/labels are not DB columns. Sources: `src/renderer/ui/SandboxProgress.jsx`, `src/renderer/model/sandbox-notifications.js`, `src/main/sandbox/manager.cjs`.

3.4.) Decision: Require saved sandbox ID/integer port 1–65535; ignore already-ready duplicates. First ready also requires HTTPS URL without credentials. Update row → separately log “Preview ready” → publish `notification:"preview-ready"`, never navigation.

Exact worker payload:
```json
{
  "run_id": "7e41c6b2-580a-4bda-9d9f-82f094312abc",
  "event": "ready",
  "preview_url": "https://fictional-preview.example/",
  "port": 5173
}
```

Before — one `sandbox_runs` DB row projection:
```json
{
  "id": "7e41c6b2-580a-4bda-9d9f-82f094312abc",
  "sandbox_id": "sb-fictional-demo",
  "status": "starting",
  "preview_url": null,
  "port": null,
  "error": null,
  "updated_at": "2026-09-22T01:01:59.000Z",
  "finished_at": null
}
```
After:
```json
{
  "id": "7e41c6b2-580a-4bda-9d9f-82f094312abc",
  "sandbox_id": "sb-fictional-demo",
  "status": "ready",
  "preview_url": "https://fictional-preview.example/",
  "port": 5173,
  "error": null,
  "updated_at": "2026-09-22T01:02:00.000Z",
  "finished_at": null
}
```
Ready/failure DB projections omit unchanged library_id/created_at/environment fields/library row, plus changing logs/milestones. Active ready keeps `finished_at:null`. Sources: `src/main/sandbox/manager.cjs`, `src/main/sandbox/runs.cjs`.

3.4.1.) Decision: Saved ready+null URL → **Build finished / No web preview**, no Open live. **UI fallback only:** new null-URL ready is rejected; API `usable` fails (“This repository has no running web preview” absent supplied reason). Sources: `src/main/sandbox/worker.cjs`, `src/renderer/ui/SandboxNotifications.jsx`.

3.5.) Decision: Failure or application exit?

- Before VM: failed/error/finished_at, null sandbox ID.
- After ACK: worker tries kill before failed; cleanup error is appended. Retain handle for cleanup—even successful kill leaves it stored.
- Unexpected worker exit while starting/ready: manager tries cleanup, then fails with worker error or “Worker exited before reporting completion”.
- Early-ready app failure aborts finalization and fails; no fallback. Harmless final-summary error/30-second timeout produces summary-unavailable activity while app stays ready.
- Normal exit/Stop → stopped after successful cleanup; cleanup uncertainty can fail.

Exact representative post-ready failure:
```json
{
  "run_id": "7e41c6b2-580a-4bda-9d9f-82f094312abc",
  "event": "failed",
  "error": "App crashed while finalizing"
}
```

Before — same DB projection:
```json
{
  "id": "7e41c6b2-580a-4bda-9d9f-82f094312abc",
  "sandbox_id": "sb-fictional-demo",
  "status": "ready",
  "preview_url": "https://fictional-preview.example/",
  "port": 5173,
  "error": null,
  "updated_at": "2026-09-22T01:02:00.000Z",
  "finished_at": null
}
```
After:
```json
{
  "id": "7e41c6b2-580a-4bda-9d9f-82f094312abc",
  "sandbox_id": "sb-fictional-demo",
  "status": "failed",
  "preview_url": "https://fictional-preview.example/",
  "port": 5173,
  "error": "App crashed while finalizing",
  "updated_at": "2026-09-22T01:02:03.000Z",
  "finished_at": "2026-09-22T01:02:03.000Z"
}
```
Failure preserves historical URL/port; failed status blocks opening. Pre-ready failures keep null URL/port. Failed/stopped set `finished_at`; ready/progress do not. Manager ignores terminal-run messages; lifecycle updates guard status, though `record()` itself does not. Separate writes/logging/publishing can partially succeed; “Could not save worker result” is runtime feedback, not durable failure proof. Sources: `src/main/sandbox/worker.cjs`, `src/main/sandbox/local-setup.cjs`, `src/main/sandbox/manager.cjs`, `src/main/sandbox/runs.cjs`.

3.6.) Event: One alert/repository: starting → **Building…**, ready → **Build finished**, failed → **Build failed** + error. Only current run ID/status is visible; restored alerts await snapshot, stopped/replaced/stale alerts hide. Repeated progress/snapshots do not re-alert.

localStorage `engelbart:preview-notifications:<dataRoot>` saves notifications/dismissed, not DB. Rows: `id,runId,libraryId,status,at,read`; **40 notifications**, dismissal map uncapped. Dismissals are phase-specific (ready uses library ID). Read/dismiss survives reload/log trimming. Bell opening marks visible entries read. Clearing changes UI only; clearing Building permits later ready/failed alerts. Inspecting dismissed builds does not restore alerts. Source: `src/renderer/model/sandbox-notifications.js`.

Before — saved UI projection; other notifications/dismissals omitted:
```json
{
  "notifications": [
    {
      "id": "7e41c6b2-580a-4bda-9d9f-82f094312abc:starting:2026-09-22T01:00:01.000Z",
      "runId": "7e41c6b2-580a-4bda-9d9f-82f094312abc",
      "libraryId": "a27b6e09-f342-4f91-8c58-64ba719312ef",
      "status": "starting",
      "at": "2026-09-22T01:00:01.000Z",
      "read": false
    }
  ],
  "dismissed": {}
}
```
After clearing Building:
```json
{
  "notifications": [],
  "dismissed": {
    "a27b6e09-f342-4f91-8c58-64ba719312ef:starting": "2026-09-22T01:00:01.000Z"
  }
}
```

3.7.) Decision: What was clicked?

- Repository name → GitHub, without starting/stopping.
- Building/Build finished/Build failed → inspector, without retry/Stop/navigation.
- **Open live ↗** → only ready+URL; mark read and open explicit preview. In workspace use Stage; outside workspace use browser dialog. Completion never switches pane/document/tabs automatically.

Inspector has **Build / Logs / Environment**, opens on Build, and presents derived timeline versus persisted logs. No run → Run; failed/stopped → Retry build; starting/ready → Open preview (disabled unless live) and Stop sandbox. Failed with retained sandbox ID also offers Stop. Actions honor busy state. Sources: `src/renderer/ui/SandboxNotifications.jsx`, `src/renderer/ui/SandboxProgress.jsx`, `src/renderer/workspace/BuildDetails.jsx`.

3.7.1.) Event: Inspector click. Runtime React-state projection; other UI omitted, DB unchanged.

Before:
```json
{
  "preview": null,
  "buildRepoId": null
}
```
After:
```json
{
  "preview": null,
  "buildRepoId": "a27b6e09-f342-4f91-8c58-64ba719312ef"
}
```

3.8.) Event: After initial ready, asynchronously run `npm audit --json --audit=true` on installed npm-lock projects. No fix/dependency changes, readiness blocking or failure from findings. No environment-restart audit; Stop/detach/end cancels. Bounds: 200 directories/depth 5/10 roots, workspace once; 30 seconds/root, 90 overall, helper 120 seconds, report 2 MB.

Valid exit 1+vulnerabilities → `findings`; valid zero → `complete`; missing/malformed/network/timeout → `unavailable`, never clean. No npm roots → `skipped`; truncation → unavailable. Redacted Logs report severity totals/≤10 package names. Audit updates logs/time, not ready status or lifecycle milestones. Sources: `src/main/sandbox/npm-audit.cjs`, `src/main/sandbox/npm-audit.py`, `src/main/sandbox/worker.cjs`.

3.9.) Decision: Port E2B state/bell/inspector/explicit navigation into Hudson’s existing surfaces; preserve layout/local Build. Unrelated Canvas UI changes stay outside scope. Source/tests read, not run; live behavior unverified.

*Astra · ultra · 521 s — actual Engelbart Bart response.*

## Bart answer 4

4.) **Behavior: save app environment variables and restart only the app.** Current: `ab0377d475ec`; New: `2d570caefda24`. Part 3’s ready run continues; IDs/ciphertext fictional, secrets redacted. Projections omit unchanged fields except stated updates. Bare filenames mean `src/main/sandbox/<filename>`.

4.1.) **Current flow — Event:** configure an E2B app. **Decision:** Hudson lacks this store/IPC/panel/restart flow; preserve its local Build. Evidence: baseline `src/main/ipc.cjs`, `src/main/store/db.cjs`, no tracked `src/main/sandbox/`.

4.2.) **New flow — Event:** receive `phase:"environment"` with `variables` array. **Decision:** persist `sandbox_runs.env_report` outside the log tail: variable `name,status,requirement,group,source,public`; report `missing,local,scannedAt,runId`. No values/defaults; ≤500 variables/names, source ≤256 characters, normalized enums, duplicate missing wins.

Restart retains it. Attempts look up the newest-created report/legacy scan without copying it. No scan/warnings preserve it; valid empty scan replaces it. Local injection’s `requirements_scan:"not_run"` leaves possibly stale metadata. Sources: `src/shared/environment.cjs`, `runs.cjs`.

4.3.) **Event:** add values; leave detected `DATABASE_URL` untouched; **Save**. **Decision:** submit edited drafts only. Blank saved inputs mean unchanged; explicitly edited `""` saves empty. Untouched detection creates no override. Sources: `src/renderer/workspace/EnvironmentPanel.jsx`, `src/preload.cjs`, `src/main/ipc.cjs`.

**Before — renderer save arguments (library ID omitted); no DB row:**
```json
{
  "revision": null,
  "changes": [
    {
      "name": "APP_SECRET",
      "value": "[redacted:first]"
    },
    {
      "name": "EMPTY",
      "value": ""
    },
    {
      "name": "OLD_FLAG",
      "value": "on"
    }
  ]
}
```
**After — full new `sandbox_environments` DB row:**
```json
{
  "library_id": "a27b6e09-f342-4f91-8c58-64ba719312ef",
  "revision": "6be35591-2c1d-4762-a33d-d8dcb5f1ceae",
  "encrypted": "RklDVElUSU9OQUxfQ0lQSEVSVEVYVF8x",
  "updated_at": "2026-09-22T01:03:00.000Z"
}
```
Drafts clear; app/run unchanged. Renderer gets revision/sorted names/removals/report, never saved values; typed values exist in drafts.

4.4.) **Event:** replace secret/remove `OLD_FLAG`. **Decision:** merge strings; `null` removes and records the name. `EMPTY` stays empty; `DATABASE_URL` stays unsaved. Source: `environment.cjs`.

**Before — renderer save arguments:**
```json
{
  "revision": "6be35591-2c1d-4762-a33d-d8dcb5f1ceae",
  "changes": [
    {
      "name": "APP_SECRET",
      "value": "[redacted:replacement]"
    },
    {
      "name": "OLD_FLAG",
      "value": null
    }
  ]
}
```
**After — DB projection; library ID unchanged:**
```json
{
  "revision": "f315c29b-176d-432b-b119-470174ae4d58",
  "encrypted": "RklDVElUSU9OQUxfQ0lQSEVSVEVYVF8y",
  "updated_at": "2026-09-22T01:04:00.000Z"
}
```
**After — renderer projection; report unchanged:**
```json
{
  "revision": "f315c29b-176d-432b-b119-470174ae4d58",
  "names": [
    "APP_SECRET",
    "EMPTY"
  ],
  "removed": [
    "OLD_FLAG"
  ]
}
```

4.5.) **Event:** validate/save. **Decision:** names must be unique and match `^[A-Za-z_][A-Za-z0-9_]{0,127}$`. Reserve case-sensitive prefixes `HC_`, `HUMAN_COMPACT_`, `ENGELBART_CANVAS_`, `ELECTRON_` and exact `__proto__`, `constructor`, `prototype`; not `E2B_API_KEY`, `ANTHROPIC_API_KEY` or `PATH`. Limits: 200 changes/values, 500 removals; strings ≤16,384 JS characters, no NUL; changed-value bytes/merged values JSON each ≤128 KiB. Whitespace stays.

Reject stale revision. Encrypt values **and removals** with Electron safeStorage; save base64 and new UUID revision. No plaintext fallback; unavailable keychain/`basic_text` rejects access. Existing rows need decryption even for names. Empty changes keep revision. Validation/encryption failure preserves settings/app; response failure cannot undo commit. Unlock/reload; conflict reload retains drafts. Sources: `environment.cjs`, `src/shared/environment.cjs`, `src/main/index.cjs`, `src/main/store/db.cjs`.

4.6.) **Event:** **Save & restart app**. **Decision:** save, then separately call `sandbox-restart(libraryId)` without expected revision. Read latest snapshot; require latest run ready/failed with VM handle, otherwise wait for next build. **Save** is future-only; restart permits unchanged settings.

Before detaching, `can_restart` connects (10s), uploads adapter, runs `launch.py --check` (20s). Local `kind:"claude-local"` validates command/cwd/port/path without hc/models. API uses `recipe.json`, eligible hc record capture, or existing `setup/start.sh` plus known port. Failed preflight does not detach/reopen; settings stay saved. Passing does not prove health. Then detach/await old worker without VM kill; detach failure aborts. Sources: `manager.cjs`, `worker.cjs`, `transport.cjs`, `launch.py`.

4.7.) **Event:** handoff succeeds. **Decision:** reopen same run/VM; preserve port/created time/report/logs, remember old preview, select revision. Sources: `runs.cjs`, `manager.cjs`.

**Before — DB run projection:**
```json
{
  "id": "7e41c6b2-580a-4bda-9d9f-82f094312abc",
  "sandbox_id": "sb-fictional-demo",
  "status": "ready",
  "preview_url": "https://fictional-preview.example/",
  "port": 5173,
  "env_revision": null,
  "error": null,
  "finished_at": null
}
```
**After — DB immediately after reopen, before log; IDs unchanged:**
```json
{
  "status": "starting",
  "preview_url": null,
  "port": 5173,
  "env_revision": "f315c29b-176d-432b-b119-470174ae4d58",
  "error": null,
  "finished_at": null,
  "build_milestones": {}
}
```

`updated_at` advances. Append “Restarting app with saved environment (same sandbox)”, data `{"phase":"setup","status":"reusing","lifecycle":"restart"}`. Sequence continues (≤300 logs). Published milestones contain its new `lifecycle:restart` first/last boundary.

**After — worker request, full decrypted snapshot:**
```json
{
  "command": "restart",
  "run_id": "7e41c6b2-580a-4bda-9d9f-82f094312abc",
  "github_url": "https://github.com/fictional-lab/demo",
  "sandbox_id": "sb-fictional-demo",
  "port": 5173,
  "environment": {
    "revision": "f315c29b-176d-432b-b119-470174ae4d58",
    "values": {
      "APP_SECRET": "[redacted:replacement]",
      "EMPTY": ""
    },
    "removed": [
      "OLD_FLAG"
    ]
  }
}
```

4.8.) **Event:** reconnect. **Decision:** same-VM `sandbox_created` → persisted ACK → adapter → `--stop`. Confirm owned app/launcher/hc/proxy trees stopped using process identities; **then** retire repository hc records as stopped/unhealthy, pid/url null, preserving plans/history. Unconfirmed stop blocks replacement; unrelated Docker/database services remain. Extend VM one hour, write snapshot outside repo (directory/file 0700/0600), invoke `--restart`. E2B access required; no Claude check/Anthropic setup key. Known values are redacted before log persistence. Sources: `worker.cjs`, `launch.py`.

Clear previously managed names ∪ current overrides ∪ removals from **every component’s** hc cache; retain unrelated generated values. Each component receives removals/full overrides, including empty strings. Shell fallback strips inherited provider credentials/removals before applying values. Local recipes bypass hc/models, filter inherited credentials/control variables, apply removals/values and consume the payload.

**Before — runtime app-env projection: managed keys absent; other keys omitted:**
```json
{}
```
**After — runtime projection; OLD_FLAG absent, other keys omitted:**
```json
{
  "APP_SECRET": "[redacted:replacement]",
  "EMPTY": ""
}
```

Repo dotenv/code may supply removed-name defaults. Replay skips clone/install/setup/repair/provisioning/audit; API clears preparation/patch steps and disables repair. Saved scripts can themselves do extra work. Compiled `NEXT_PUBLIC_`/`VITE_` assets need rebuilding, not just restart; public variables must contain no secrets. New port needs a new recipe. Sources: `launch.py`, `docs/sandbox-runs.md`.

4.9.) **Event:** restart succeeds/fails. **Decision:** Part 3’s preview events/notifications; no automatic navigation.

**Before — DB projection:**
```json
{
  "status": "starting",
  "preview_url": null,
  "error": null,
  "finished_at": null
}
```
**After — success:**
```json
{
  "status": "ready",
  "preview_url": "https://fictional-preview.example/",
  "error": null,
  "finished_at": null
}
```
**After — alternative failure before ready:**
```json
{
  "status": "failed",
  "preview_url": null,
  "error": "Application did not become healthy",
  "finished_at": "2026-09-22T01:05:00.000Z"
}
```

IDs/revision stay; logs/milestones/time advance. Non-cancel failure attempts cleanup, retains VM/files; uncertainty appends “Application cleanup could not be confirmed.” Partial stop has no rollback guarantee. Correct/save/restart again. **Stop sandbox** kills it; **Retry build** cleans up then creates new run/VM/full setup. Saved settings survive. Sources: `manager.cjs`, `worker.cjs`.

4.10.) **Source limitations:** same-manager per-root/repo locking and revision read/compare exist; UPSERT is **not DB compare-and-swap**. Save/restart can interleave and select newer settings. UI compares saved/run revisions: assigned before launch, equality means selected, not proven applied.

Detach suppresses callbacks and drains transport/worker completion. Messages lack restart generation/revision. If ready→stopped during preflight, `reopen` returns null; restart dereferences it unchecked. Reopen/log/publish/handoff are not transactional. Sources: `manager.cjs`, `transport.cjs`, `runs.cjs`, `environment.cjs`.

Inspected tests (not run): `test/sandbox-environment.test.cjs`, `test/environment-report.test.cjs`, `test/sandbox-manager.test.cjs`, `test/sandbox-worker.test.cjs`, `test/sandbox_launch_check.py`. No live/package checks; recipe compatibility remains unproven.

*Astra · ultra · 804 s — actual Engelbart Bart response.*
