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

