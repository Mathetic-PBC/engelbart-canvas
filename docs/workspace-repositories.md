# Workspace-connected repositories

The current project-default model is documented in
[Project default repositories](project-default-repositories.md). It supersedes
the per-workspace automatic provisioning and `.local-apps` relocation described
in this original implementation report. Existing connections remain explicit;
new workspaces inherit the project default. The relocation, trash, and Build
lifecycle safeguards described below remain in place.

Implemented on top of the Hudson Build merge at `47dc5bf` (Hudson through `f2a099d`).
The pre-change snapshot is `backup/pre-workspace-repositories-20260927`. No user
repositories, existing `.local-apps` files, credentials, or live profiles were
migrated during development; migration tests use disposable homes.

## Model and execution boundary

`store/workspace-repositories.cjs` owns registration, connection, resolution,
provisioning, migration, and relocation. A connection is not a context attachment.
Removing a repository from shared Context does not change `meta.json.repoId`.

Project and workspace metadata use `schemaVersion: 2`; unrelated keys are retained.
The rebuildable catalog uses `version: 3`. IDs below are illustrative; real IDs are
UUIDs, and a repository's ID is distinct from its library row's ID.

```json
{
  "id": "P",
  "schemaVersion": 2,
  "repositories": {
    "R1": {
      "id": "R1",
      "name": "Workspace code",
      "location": "Workspace/code",
      "managed": true,
      "libraryId": "L1",
      "archived": false
    },
    "R2": {
      "id": "R2",
      "name": "existing-app",
      "location": "/absolute/external/existing-app",
      "managed": false,
      "libraryId": "L2",
      "archived": false
    }
  },
  "repositoryMigration": { "version": 1, "status": "complete" }
}
```

Workspace metadata contains one `repoId`. Catalog repositories include their
workspace IDs and nested paths, independently of context membership. Symlink
aliases of the same physical repository reuse its registry entry. Existing
library folder rows (or matching remote-only rows) retain their library IDs.

`resolve(ctx, projectId, workspaceId)` is the sole selector for new Builds, Bart's
code context, the repository row, and relative Stage files. Interactive shell,
Claude, and Codex terminals keep independent working directories: their current
session, explicit choice, project default, or remembered terminal folder. Changing
the workspace connection never retargets them or overrides a new terminal's cwd.
New interface proposals resolve here before planning and capture
the approved repository ID; changing it while approval is pending requires a new
proposal. Missing repositories fail with a reconnection instruction, not a fallback.

Build previews use the Build's frozen repository/worktree, not the current
workspace connection. The old project-wide `directory` field remains readable
for migration, legacy file APIs, and the independent terminal default, but no
longer selects new Build targets.
Bart's ordinary answers remain read-only. Tool discovery, Claude subscription
routing, agent locking, model flags and text-only recording naming are retained.

## Before → request → after → UI

### Project without a repository

- Before: no project directory.
- Request: `createProjectWithWelcome({name: "Demo"})`; Code directory is optional.
- After:

```text
demo/
  project.json                 repositories.R1.location = "Getting started/code"
  .context/catalog.json        repositories: [{ id: R1, workspaces: [{ id: W1, ... }] }]
  Getting started/
    meta.json                  { schemaVersion: 2, id: W1, repoId: R1, ... }
    workspace.md
    code/.git/                 main, one empty initial commit
```

- UI: no directory-gate modal. Beneath the title: a compact repository icon/name
  row matching the sidebar. Its dropdown lists registered repositories and folder
  actions; the full path is on hover. A first Build can create its worktree immediately.
- Provisioning never stages user files. Even interruption followed by user edits
  or staged files produces an empty initial commit, preserving those edits/index.

### Project with an existing repository

- Before: `/work/existing-app/.git`, commits and uncommitted files.
- Request: `createProjectWithWelcome({name: "Demo", directory: "/work/existing-app"})`.
- After: registry `R1.location = "/work/existing-app"`, `managed = false`;
  initial workspace `repoId = R1`. No `code/` copy is made. HEAD and dirty files
  are unchanged. The temporary initial-workspace selection is consumed.
- UI: the existing repository name; its menu includes Open on GitHub when its
  remote is on GitHub. The link uses Stage. An unborn existing Git repository is not auto-committed: Hudson's
  explicit **Start history** action remains available.

### Nested workspace

- Before: `Workspace/meta.json.repoId = R1`.
- Request: `createWorkspace(P, {name: "Child", parentId: W1})`.
- After: `Workspace/Child/meta.json.repoId = R2`;
  `repositories.R2.location = "Workspace/Child/code"`, with its own first commit.
- UI: Child shows its own repository; the parent connection is unchanged. An explicit
  `repoId` or local `directory` in the create request connects that repository instead.
- Discovery and the older layout converter skip `code/`, even when source files
  inside it contain `meta.json`, `workspace.md`, or workspace-looking directories.

### Change connection

- Before: `W1.repoId = R1`; Build B and terminal T were started against R1.
- Request: click the repository row → registered R2, or **Connect local repository…**.
- After: only W1's connection becomes R2. R1 remains registered and its files stay
  in place. B retains `repoId: R1`, `repo`, `sourceDirectory`, `worktree`, and `cwd`;
  T retains its launch snapshot. New Builds resolve R2; new terminals continue to
  use their own chosen directory.
- UI: the row updates and its menu closes. Existing terminal sessions are never
  automatically sent `cd`, and unavailable Build repositories do not block terminals.
- **Create code/** refuses an occupied directory; select the preserved repository
  from the list instead. Connecting a repository in trash requires restoring it.

### Rename and move

- Before: R1 at `Workspace/code`, R2 at `Workspace/Child/code`; R1 may no longer be
  connected to Workspace. Both remain registry records.
- Request: `renameWorkspace(P, W1, "Renamed")`, then
  `moveWorkspace(P, W1, destinationParentId)` (null means project root).
- After: IDs unchanged; both contained locations follow the physical move,
  including disconnected repositories and every descendant. Library paths,
  historical Build path fields, saved-interface state paths, saved view path
  fields, and catalog projections are rewritten. Existing conversation text is
  historical content and is not rewritten.
- Connections and historical Builds in another project that reference the same
  physical repository are updated too; cross-project consumers also prevent
  deletion and contribute to the busy check.
- UI: the title and repository path reflect the new location. Project renaming
  also updates contained paths when its normal name-derived directory moves;
  custom project slugs retain the existing naming behavior.
- Before any filesystem move: refuse active project terminals/agents, starting
  Builds, relevant previews, unfinished Builds, or linked Git worktrees. On macOS
  `lsof` also detects processes with a working directory inside the affected tree.
  Close terminals, stop previews, and finish/discard worktrees first. **Stop preview**
  is available on Build cards. External repositories themselves are not moved.

### Delete and recover

- Before: W1 owns a subtree with contained repositories; external R3 is elsewhere.
- Request: delete W1.
- After: the complete subtree moves to `.trash/<workspace-id>-<name>/`; contained
  registry entries are archived and keep recovery locations. A
  `.workspace-recovery.json` preserves the original path and descendant IDs.
  External R3 remains untouched. Shared notes and library identity remain intact.
- UI: W1 leaves navigation; the next workspace is selected. Deletion refuses if
  another workspace is connected to a repository inside W1 or an unfinished Build
  would be orphaned. Errors occur before moving the subtree.
- `restoreWorkspace(P, W1)` restores from trash with the same IDs and references;
  a conflicting destination is never overwritten. Restore the parent first if it
  has also been removed. There is no new trash-browser UI in this change; the
  existing filesystem trash is recoverable through this store/preload operation.

## Migration and recovery

Migration runs on project load or before starting new work, under a per-project
queue. It does not edit user source files, commit existing repositories, or pick
between competing candidates.

| Before | Request | After / UI |
| --- | --- | --- |
| Legacy `project.json.directory` only | Load project | Register in place as the project default; workspaces without an override inherit it. |
| No legacy target or workspace repository | Load project | Inherit a known project default or request selection; do not create a repository during migration. |
| One workspace-owned `.local-apps/P/W/app`, with or without a project default | Load project | Register the app in place as the workspace override; retain Git history, recipe, library ID, logs, run/build IDs, and preview record. The project default does not compete. |
| Valid existing workspace `code/` | Load project | Reuse it as an override without creating a conflict or committing files. |
| Occupied non-repository `code/` | Load project | Preserve it untouched; it neither competes with an app nor prevents inheriting the project default. |
| Local app plus a distinct valid workspace `code/` repository | Load project | Preserve/register both candidates; `repositoryIssue` presents their paths for explicit selection. |
| Saved migration issue, even in an already-migrated project | Load project | Reevaluate actual workspace candidates; clear resolved issues. Keep any explicit `repoId`, even when unavailable. |
| Existing Build without `repoId` | Load project | Register its recorded `repo`; preserve worktree, branch, commits, replies, and original source directory. History alone never chooses the workspace's current connection or project default. |
| Unavailable selected directory | Resolve | Actionable unavailable error; no default repo is silently created. |

Default creation uses `.repository-init.json`. Relocations write
`.repository-relocation.json` before renaming; subsequent loads finish interrupted
reference updates. A relocation journal includes Git HEADs, verified again after
moving along with library paths, as well as the requested project title and trash
recovery metadata when applicable. Interruption midway through reference updates
does not lose the title or the ability to restore a trashed workspace. The journal is removed only after updates and
catalog regeneration succeed. Both/neither source and destination existing is a
recovery conflict, never permission to overwrite. A failed migration remains
pending/needs-selection, and repeated loads reuse IDs instead of duplicating repos.
If the initial filesystem rename itself is refused without moving anything, its
intent is cleared and the original folder remains usable. Recovery also holds the
same launch/move locks as a normal relocation.

Saved local interfaces retain their own `repoId` in the existing state file under
`.local-apps/P/W/state.json`. Restarting one after a connection change resolves its
original registered repository, not today's workspace connection. Unmoved legacy
interfaces continue using their original app path.

## Build and preview lifecycle

New tasks persist `schemaVersion: 2`, `repoId`, `sourceDirectory`, `repo`, `worktree`,
and `cwd`. Temporary worktrees are never registry or catalog repository entries.
Replies, resume, review, checks, Accept, and Discard use those recorded values.

Post-it popups default to the open workspace, allow another workspace, and display
the destination repository before Send. Same-repository promotion retains the
Build/session. Cross-repository promotion creates a new Build with `sourceBuildId`,
imports the task into the destination archive, and preserves the original Build,
worktree and edits. It does not copy or transplant changes.

Review serves the worktree. Successful Git Accept serves accepted code; Discard
restores the prior accepted preview. Refused Accept keeps the review server and
worktree. Preview servers stop before worktree removal. An accepted-server startup
failure is reported as a preview failure, not an unsuccessful Git Accept.

## Validation

- `test/workspace-repositories.test.cjs`: creation, nested discovery, canonical
  deduplication, external dirty-file preservation, registry/library separation,
  catalog regeneration, missing targets, migration conflicts/repeatability,
  local-app history/recipe preservation, disconnected/nested path rewrites, trash
  restore, cross-project consumers, unfinished-worktree/launch guards, busy
  migration retries, and interrupted provisioning/partial reference updates.
- `test/build.test.cjs`: recorded-target replies and Accept after reconnection,
  approval invalidation, cross-repository promotion, shared Context/Clear/Restore,
  real Git checkpoints, and actual review/Accept/Discard localhost transitions.
- `scripts/smoke-workspace-repositories.cjs`: real Electron renderer, IPC, Git and
  PTYs; compact title row/menu, keyboard dismissal, narrow layouts, default/nested
  repos, independent old/new shell/Claude/Codex directories, missing Build targets,
  busy refusal, rename paths, and screenshots. Agent CLIs are replaced with idle
  shells after their real launch configuration is checked.
- `scripts/smoke-build-integration.cjs`: approval, editor input, archive, post-it
  destination, browser interaction and preview transitions. Models are scripted;
  Git, processes, IPC and native browser views are real.
- Existing editor, connector/authentication, annotations, recordings, tools and
  shared-context tests remain in the full suite. The frozen benchmark-snapshot
  tests have three known pre-existing missing-source failures, unrelated to this work.

The repository smoke also verified a disposable copy of the existing **CHI Insights**
interface through the real preview manager and browser verifier (`ready`, HTTP 200,
9,294-byte HTML). Original source and state were not changed. No actual Claude/Codex
subscription request was made by these tests.

Final check results (2026-09-28):

- Production renderer build and `git diff --check`: passed.
- Targeted repository/Build/project/Bart/library suite: **100 passed**.
- Build suite rerun after the final external-preview deletion guard: **28 passed**.
- Full suite: **784 passed, 3 failed** (787 tests total). All three failures are in
  `test/sandbox-pipeline-benchmark.test.cjs`; its frozen snapshots lack
  `src/main/store/captured-sites.cjs`. Those snapshots were not altered.
- Both isolated Electron smoke scripts: passed. Repository-row and chooser
  screenshots were inspected; Build checks exercised real Git, servers and Stage.

## Boundaries

Moves use same-filesystem rename and refuse unsafe relocation instead of repairing
live worktrees or moving active processes. Arbitrary external filesystem moves
while Engelbart is running are not coordinated by the app; use its rename/move
operations. Migration conflicts intentionally require user selection. This change
does not introduce a repository-catalog browser, relocate external repositories,
or change shared Context, archive semantics, connector plumbing, or authentication.
