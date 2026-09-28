# Hudson Build integration

Integration date: 2026-09-27. Destination: `feat/e2b-implementation`.

## History and preservation

Merged Hudson's exact requested target, `f2a099d2da457e5303773d22af0774602ca6377d`, with its seven prerequisites after the common ancestor `519260997541b52b20893d2a9535bd5daea6d4a2`. No later commits were included:

1. `153b08d` — titlebar/resize edges, navigation and Copy placement.
2. `8676490` — tool discovery, setup, maintenance, defaults and locking.
3. `d7ca16e` — workspace mentions/previews and workspace-tab behavior.
4. `471e439` — middle tabs, note picker and last-terminal behavior.
5. `bfcc3bc` — worktree Build engine, Clear/Archived and post-it quick tasks.
6. `3ad5b51` — archives open in the middle panel.
7. `2e6daac` — model definitions.
8. `f2a099d` — post-it Build popup/task card, covering panels and workspace footer/panel.

Before merging, all local tracked and untracked content was backed up in `/private/tmp/engelbart-pre-hudson.BSStho/worktree.tar.gz`, alongside staged/unstaged patches. Archive SHA-256: `a128f177469556079cfe485310c634e77ae76a4153523442bd59ae62409aee3d`. Local source work was committed as `b339d82` on `backup/pre-hudson-build-20260927`. Seven existing benchmark `node_modules` symlinks remain untracked and untouched; the full backup also contains them.

Sidebar edits that arrived during integration were preserved, including its current compact spacing, Code/Writing/Literature labels, repository chooser and workspace-switcher navigation. Existing data and repositories were not moved. No user app was restarted, no existing preview process was stopped, and nothing was pushed.

## Combined behavior and conflict resolutions

| Area | Resolution |
| --- | --- |
| Build engine | Hudson's Git worktrees, per-turn checkpoints, session replies, review, conflict/check handling, Accept/Discard, quick tasks and promotion are retained. Records live under the project's `builds/`; temporary checkouts live under the data root's `worktrees/`. |
| Interface generation | `src/main/build/interfaces.cjs` adapts the existing read-only Claude planning/notification approval flow to `builds.start`. Only host-approved interface intent enters the Build. Ordinary Bart answers retain their read-only tools and sandbox. |
| Preview lifecycle | `src/main/build/previews.cjs` reuses local preview recipes, process ownership, loopback/HTML checks and browser rendering verification. Review serves the worktree. Accept switches to the accepted folder only after Git succeeds. Discard stops the review server before worktree deletion and returns to the prior accepted preview. Failed Git Accept leaves the review available. |
| Cancellation/shutdown | Setup, queued replies and explicit preview launches are coordinated with Discard and shutdown. A queued reply cannot restart after Discard. Setup failures cannot overwrite a discarded record. Owned processes are stopped before removing their worktree. |
| Existing local interfaces | The old local-preview manager remains responsible for listing, opening, restarting and stopping saved `.local-apps` interfaces. Production new-code generation no longer invokes its coding agent. No relocation or migration. |
| Shared Context | Existing project-wide Context and removal tombstones remain authoritative. Clear snapshots only the destination workspace's document/history; Restore merges still-permitted historical links instead of replacing the project collection or undoing removals. Task import creates a workspace-local archive without overwriting its current document. |
| Post-its | Hudson's model/effort popup, task card, escalation/promotion, and panel-over-card snapshot layering are integrated. Destination defaults to the open workspace, is visible and selectable before Send, and includes parent names for nested workspaces. Code still resolves from `project.directory`. |
| Sidebar/workspace | Local connector controls, library actions, conversations, resizing, note editing and workspace status are preserved. Hudson-era workspace records without a status still load; an older workspace actually named `builds` is not hidden by the new storage convention. Archived is added to that sidebar; archives open read-only in the middle. The locally removed test-mode toggle and last-viewed row remain removed. |
| Editor | Local JSON formatting, selected text/caret restoration, hidden routing flags, ordinary answers and follow-up behavior are combined with Build rows/reply fields. Incoming workspace mentions, note picker and tab primitives remain. |
| Claude/tools | Incoming discovery, selected binary paths and tool locks are combined with the local subscription wrapper, which clears proxy/API overrides after login-shell startup. The wrapper is used for Bart, Build, planning and summaries. |
| Recordings | Local recording-title `textOnly` restrictions survive the summarizer/tool-lock merge: no filesystem, browser, connector, agent or web-search tools for those requests. Recording/annotation stores and browser architecture are unchanged. |
| Application wiring | Startup, trusted IPC, preload subscriptions, Build events, archive APIs, persistence, test-data switching and shutdown are connected. Local Stage integrations, recordings, annotations and terminal fixes remain. |

No conflict was resolved by wholesale replacement with one branch's version. Project creation's directory UI is byte-identical to the pre-merge checkpoint. There are no workspace/code repositories, per-workspace repository associations, repository rows beneath titles, new repository catalogs, or `.local-apps` migrations.

## Validation

- `npm run build` and `git diff --check` pass.
- Full sequential suite: **768 tests, 765 passed, 3 pre-existing benchmark-fixture failures, no cancellations** (`node --test --test-concurrency=1 --test-timeout=90000 test/*.test.cjs`). Log: `/private/tmp/engelbart-hudson-serial-tests.log`.
- Build tests: 26/26 pass, exercising real Git, shared Context/tombstones, Clear/Restore, task import/promotion, approval-before-code, local-server review/Accept/failed Accept/Discard, server shutdown before worktree deletion, setup cancellation and queued-reply suppression.
- Existing editor, models, launcher, tool-lock, archive/store, connector, annotation, local-preview and recording unit tests were included in the full suite. CLI command tests use stubs; no paid model call or real-account authentication was made.
- `scripts/smoke-build-integration.cjs` passes against the real app/IPC/native views/Git and local servers with scripted model output. It covers notification approval before code, task-card replies, worktree page interaction, Accept, refused Accept with an unsaved user edit, Discard, read-only archive opening, and post-it destination selection. Screenshots were inspected: `/var/folders/sq/lyvpkkvx7c112shl78lt0fdh0000gn/T/engelbart-build-integration-ywrcyM/` (`review.png`, `preview-page.png`, `post-it-build.png`). Renderer screenshots do not include native Stage contents; the page is captured separately and its DOM/actions are checked.
- The final Build Electron run also passes the accepted-server failure fallback: `/var/folders/sq/lyvpkkvx7c112shl78lt0fdh0000gn/T/engelbart-build-integration-hOMiYY/`. Final Build-only test log: `/private/tmp/engelbart-build-final.log`; subsequent workspace-compatibility/Build check: **42/42 passed**, `/private/tmp/engelbart-preservation-final.log`.
- Shared Context Electron smoke passes: A/B workspace switching, separate documents, additions from either workspace, project-wide removal, reattachment and restart. Evidence: `/var/folders/sq/lyvpkkvx7c112shl78lt0fdh0000gn/T/engelbart-shared-context-ui-uYq0At/`.
- Annotation Electron smoke passes: full-width selection, cursor/overlay cleanup, semantic labels, contextual editing/Ask Bart, persistence, markers, navigation, shadow DOM, iframe and nested-frame targeting. Evidence: `/var/folders/sq/lyvpkkvx7c112shl78lt0fdh0000gn/T/engelbart-annotations-smoke-kkRu2T/`.
- Recording Electron smoke passes: actual rrweb capture/playback, ordinary text/numeric inputs, private-input masking, reloads/frames/canvas, tab changes, site-filtered browsing and overlay dismissal. Evidence: `/var/folders/sq/lyvpkkvx7c112shl78lt0fdh0000gn/T/engelbart-recordings-smoke-DkGCdB/`.
- Connections Electron smoke passes against a loopback fake service: sign-in/cancel/reconnect, PKCE callback in Stage, existing account reuse, menus, search/workspace navigation, 220px sidebar resizing, post-it creation/drag-to-trash/restore and no unwanted imports or sandbox launches. Evidence: `/var/folders/sq/lyvpkkvx7c112shl78lt0fdh0000gn/T/engelbart-connections-ui-xVmku4/`. Its layout assertions were updated for the concurrent local sidebar edits, not used to change production styling.
- Existing **CHI Insights** remains in its original `.local-apps` directory and library record; a read-only request to its existing preview, `http://127.0.0.1:64222/`, returned HTTP 200. Its server and files were not changed.

### Test caveats and remaining limits

- Three sandbox benchmark-fixture tests fail because the frozen snapshot omits `src/main/store/captured-sites.cjs`. All three were reproduced on the pre-merge `b339d82` checkpoint in `/private/tmp/engelbart-checkpoint-benchmark.GbCTry`; the benchmark source and failing tests are unchanged by this merge.
- The concurrent full-suite run intermittently times out in `test/recordings.test.cjs`. That unchanged test file passes 17/17 independently and in the final sequential suite; actual Electron capture/playback also passes. Concurrent log: `/private/tmp/engelbart-hudson-final-tests.log`; independent recording log: `/private/tmp/engelbart-recordings-final.log`.
- The older `scripts/smoke-post-its.cjs` hidden-window smoke passes face/font/markdown/Enter, then times out on its synthetic click in a hidden native browser. Attempting to render that fully hidden browser produced Electron `UnknownVizError`; that diagnostic change was reverted. Its remaining assertions are not claimed as passing. Visible-inactive isolated tests separately pass native post-it dragging/restoration, Build popup layering/destination, and live page interaction.
- No live Claude/Codex generation was attempted. Real account subscription availability and model-generated launch recipes still depend on the installed tools/account and generated project. Invalid or unavailable recipes surface a preview error; they do not bypass review or turn a successful Git Accept into a false failure. If Git succeeds but the replacement preview cannot launch, Stage falls back to its prior accepted preview rather than retaining a stopped review URL.
