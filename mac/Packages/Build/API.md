# EngelbartBuild — public surface

Build: agents that change the code (worktrees, turns, review, accept, run step). Ported from `src/main/build/**`,
`src/shared/build-history.cjs`, the build IPC handlers and the Build panels. Ledger: `mac/parity/build.md`.

Depends on Core and UI only (Doc is allowed but not needed: mention expansion comes through `BuildHost`).

Tests: 73 XCTest cases, all passing on the cloud runner (run 40754986925).

## Entry points

| Type | What |
|---|---|
| `BuildManager` (actor) | The lifecycle. `init(BuildConfiguration)`. `targets`, `preflight`, `initRepository`, `cloneRepository`, `setDefault`, `prepareDefault`, `start(projectId, BuildStart)`, `reply(…, interrupt:, images:)`, `stop`, `resume`, `review`, `accept`, `fix`, `discard`, `promote(…, workspaceId:, picked:)`, `list`, `get`, `openIds`, `running`, `isStepping`, `showRunnable`, `stopRunning`, `stopRunnable`, `stopProject`, `removeWorktrees`, `moveWorktree`, `reconcile`, `stopAll` (quit), `sweeping`. Everything returns the public record (`JSONValue`, TaskStore.publicTask shape). |
| `BuildService` | The IPC layer: one method per channel (`buildModels`, `rememberModelChoice`, `buildTargets`, `buildSetDefault`, `buildPreflight`, `buildInit`, `buildClone`, `buildStart`, `buildList`, `buildGet`, `buildReply`, `buildStop`, `buildResume`, `buildReview`, `buildAccept`, `buildFix`, `buildDiscard`, `buildRunShow`, `buildRunStop`, `buildRunStopRunnable`, `buildPromote`) with ipc.cjs's validation; `keepOpenBuilds(projectId)` → the predicate Clear/Restore pass to archive.clearWorkspace. |
| `BuildConfiguration` | host, git (`BuildGit(gitPath:environment:)`), runner, `readModels`, `notify`, tools, `gitReady`, `runShell`, `copyTree`, `githubToken`, `libraryChanged`, `runStep`, `keepDir`, limits (3 build / 1 quick), turn times (180 / 20 min), `autoFixes` (2), `diffDelay` (0.7 s), `runLog`. |
| `BuildSetup` | `runner(environment:runDirectory:tools:)` → `FakeRunner` when `ENGELBART_BUILD_FAKE=1` (`ENGELBART_BUILD_FAKE_MS`), else `CLIRunner`; `runStep(…)` → nil when `ENGELBART_RUN_STEP=off`, fake agent when `ENGELBART_BUILD_FAKE=1` or `ENGELBART_RUN_FAKE=1`. App wiring: runDirectory = `~/Library/Application Support/Engelbart Swift/build-runs`, keepDir = `…/build-keep`. |
| `BuildMCP.server(name, arguments)` | For the app's `--mcp` entry: `--mcp engelbart <connection.json>` (Engelbart's tools for a Build turn) and `--mcp run <connection.json>` (the run step's tools, server name `engelbart-run-step`). Returns nil for other names. Call `runForever()` on it. |
| `TaskStore` | Records: `readTask`, `writeTask`, `listTasks`, `readContext`, `publicTask`, `isId`, statuses. |
| `BuildGit`, `GitGuard`, `LibraryKeep`, `BuildPolicy`, `BuildPrompt`, `BuildContext`, `CLIRunner`, `FakeRunner`, `ToolBridge`, `EngelbartTools`, `RunStep`, `RunProcesses`, `RunTools`, `Runnables`/`RunnableStore`, `LaunchDiscovery`, `LocalClaude`, `Repository` | The parts, usable alone (tests use them). |
| Models | `BuildChoices` (+ `.defaults`, `.resolve`), `EffortLabels`, `BuildDiffRows`, `BuildTarget` (+ `Storage`, `Defaults`), `BuildEvents`, `RunSteps`, `CanvasBuild`, `LocalBuild`, `BuildHistory`, `BuildCardModel`, `BuildReviewModel`. |
| Views | `BuildPanelView` + `BuildPanelModel` (`BuildActions`), `BuildReviewView`, `BuildRejectView`, `BuildCardView` (for an editor's `build> <id>` line), `RunTimelineView`, `RunLogView`, `BuildDetailsView` (Environment tab injected). |

## What the app provides

- `BuildHost` (Host.swift): data root, home, projects (find, records, workspace, setDefaultTarget, addWorkspaceBuild,
  linkToWorkspace, recordEdit, agentStarted/Finished/Stopped, readWorkspaceDoc, latestArchive, importTask, createNote,
  projectPageBlock, instructionsBlock, memoryBlock), the library (row, rows, rows(forProject), insert, updateRepo,
  addLibraryItem, addFileCopy, libraryFileType, libraryFileExtensions), the first-message expansion (expandMentions,
  expandRows, catalogJSON) and `runnables: RepoRunnablesTable`.
- `RepoRunnablesTable` (library.sqlite `repo_runnables`): `list` = `select * … where library_id = ? order by folder,
  name`; `declare` = `insert … on conflict (library_id, folder, name) do update set type = excluded.type, status = case
  when old.type = new.type then old.status else 'pending' end, install_command/run_command kept only for the same type,
  updated_at = now`; `verify` = status 'verified', commands, verified_commit, last_error null; `fail` = status 'failed',
  last_error. Foreign key to library (on delete cascade), check constraints as db.cjs. `MemoryRunnablesTable` is the
  reference semantics.
- `BuildTools` (tool lock, `ensure`, Engelbart's own Git env, `binaryFor`), `BuildRunLog` (Agent map), `notify`.
- `readModels('build' | 'quick')` → `BuildChoices` and `rememberModelChoice` (Bart's models file).
- Run step terminals: `openTerminal(cwd, command) → session JSON {id, status…}` (type the command once the shell's
  prompt is drawn: quiet 150 ms, at most 3 s, as index.cjs), `closeTerminal(id)`, `terminalSnapshot(id)`.

## Events (EventHub names = Electron channels)

`engelbart:build` (public record), `engelbart:build-progress` ({projectId, id, activity, log} | {lines}),
`engelbart:build-diff` ({projectId, id, files, patch, truncated, running}), `engelbart:build-run` ({kind: ui, url} |
{kind: terminal, session}), `engelbart:nav`. The app routes `build-run` to the asking window and a record with
`postItId` to the post-its showing it (index.cjs routeRun / postItViews.buildState); `engelbart:build-quick(-open)` are
the post-it windows' own.

## Needs from other packages

- **Bart:** the models file (`buildChoices`/`resolveBuildChoice` for 'build' and 'quick', the last pick), the run log;
  `CORE_PERSONALITY` and `bodyLines` (Build keeps a copy of the personality text, checked by SHA; the progress `lines`
  are the plain lines of the text rather than reply.cjs's flattening).
- **Store:** `BuildHost` and `RepoRunnablesTable`; trash/restore/purge call `stopProject`, `moveWorktree` (and rewrite
  the records' worktree/cwd), `removeWorktrees`.
- **Doc/Bart context:** `expandMentions`, `expandRows`, `catalogJSON` (context/expand-mentions.cjs, bart/context.cjs).
- **Tools:** `BuildTools`, git readiness, Engelbart's own Git env.
- **Terminal:** the run step's terminal sessions. Build keeps its own copy of launch.cjs's login-shell rules (LoginShell).
- **Sandbox:** `canOpenPreview`/`canOpenTerminal` and the Environment panel for `BuildDetailsView`; Build keeps its own
  copies of launch-discovery's `discoverLocal`, local-claude and the loopback bridge.
- **Editor:** draws `build> <id>` lines with `BuildCardModel`/`BuildCardView`, keeps the reply text, sends acts.
- **App:** `--mcp engelbart|run` dispatch to `BuildMCP.server`; `MCPLaunch.executable` must be the app binary.
