# Project default repositories

Each project has one working repository by default. Workspaces at every nesting
depth inherit it unless they have an explicit override. Context attachments and
terminal working directories are independent of this choice.

## JSON and filesystem

Project metadata now uses `schemaVersion: 3`. Unrelated metadata is retained.

```json
{
  "id": "P",
  "schemaVersion": 3,
  "defaultRepoId": "R1",
  "repositories": {
    "R1": {
      "id": "R1",
      "name": "Demo",
      "autoName": { "kind": "project", "value": "Demo" },
      "location": "code",
      "managed": true,
      "libraryId": "L1",
      "archived": false
    },
    "R2": {
      "id": "R2",
      "name": "existing-app",
      "location": "/work/existing-app",
      "managed": false,
      "libraryId": "L2",
      "archived": false
    }
  },
  "repositoryDefaultsMigration": {
    "version": 1,
    "status": "complete",
    "issue": null
  }
}
```

IDs above are illustrative. Actual stable repository IDs are separate from library
IDs. Contained paths are project-relative; external paths are absolute. Connecting
the same physical repository, including through a symlink, reuses its registry ID.

An inheriting workspace's `meta.json` has `"repoId": null` (absence also means
inherit). An override has `"repoId": "R2"`. Newly written workspace metadata uses
schema 3; existing explicit connections do not need to be rewritten to work.
Inheritance is from the **project**, not from the containing workspace's override.

```text
demo/
  project.json                         defaultRepoId = R1
  code/.git/                           one empty initial commit
  .context/catalog.json
  Getting started/
    workspace.md
    meta.json                          repoId = null
    Child/
      workspace.md
      meta.json                        repoId = null
```

The rebuildable catalog is version 4. `project.defaultRepoId` records the default;
each workspace has `repoId` (raw override), `resolvedRepoId`, and `inherited`.
Each repository has `isProjectDefault` and workspace associations, including
inherited associations at every nesting depth. All registry repositories and
their library identities remain indexed even when detached from shared Context.
The catalog describes connections, not proof that a directory is currently
available; the resolver validates availability before work starts.

### Generated repository names

A newly provisioned project repository uses the project title exactly: project
`Demo` → repository `Demo`, with files still at `<project>/code/`. Its registry
record has additive `autoName: { kind: "project", value: "Demo" }` metadata.
The last generated value distinguishes automatic labels from subsequent custom
names. Explicitly created workspace repositories retain their existing names.

On load (including already migrated projects), a managed project-root `code/`
record with the exact legacy `<current project name> code` label is upgraded in
place. Registry and library IDs, associations, files, Git history, Build records,
saved preview history and terminal directories do not change. External,
unmanaged and workspace-owned repositories are not candidates. Older names that
cannot be identified confidently are left alone rather than guessed.

Project renames update the tracked label in the registry, library, catalog,
sidebar and both selectors. This also works when a custom project path means
only the title changes. A custom repository/library label opts out of automatic
naming (`autoName: null`); it is not replaced by the next project title. A
temporary `autoName.pending` journals registry/library updates for recovery on
the next load. Repeated loads do not rewrite unchanged names or catalog files.
Names captured in existing Bart answers and Builds remain historical snapshots.

## Creation and connection operations

| Before → request | Resulting state and UI |
| --- | --- |
| No project → create without a folder | Initialize project-root `code/` with an empty Git commit, register R1, set `defaultRepoId: R1`; first workspace inherits and shows the repository name. |
| Existing local Git repo → choose it at project creation | Register it in place as the default. No files move and nothing is committed. An unborn existing repo still requires Build's explicit Start history action. |
| Project default R1 → create any workspace or nested workspace | `meta.json.repoId: null`; no new repository folder. This also applies to children of a workspace overridden to R2. |
| Workspace inherits → choose R2 in either selector or sidebar | Only that workspace gets `repoId: R2`. R1 and all files remain unchanged. |
| Workspace has R2 → `useProjectDefault` API request | Set `repoId: null`. Future work resolves the current default. |
| Default R1, workspace override R2 → “Change project default…” to R3 | Project gets `defaultRepoId: R3`; inheritors follow R3, explicit R2 remains. No source files move. |
| Workspace inherits → explicit `createDefault` API request | Create `<workspace>/code/` and connect its new registered repository. Refuse an occupied folder without overwriting it. |

The underlying operations are `setProjectDefaultRepository(projectId, input)` and
`connectWorkspaceRepository(projectId, workspaceId, input)`. Inputs select a
registered `repoId`, existing local `directory`, or `createDefault: true`.
The workspace operation also accepts `useProjectDefault: true`.
`createWorkspace` can explicitly receive `repoId`, `directory`, or `createDefault`;
omitting those means inherit. The old `directory` project field is compatibility
metadata for migration/independent terminals, not the new Build selector.

## UI

- **Code context: …** in draft/follow-up `@bart` controls and **Build in: …** in
  the Build panel use the same connection and chooser. The redundant repository
  row beneath the workspace title is no longer shown.
- Both pickers use the heading **Repository** and show repository names, with
  the effective repository selected whether inherited or overridden. The
  “Project default” suffix and row, separate name/path tooltip, “Connect local
  repository…” and “Create separate workspace code/” actions are hidden. Existing
  inheritance and connection APIs are unchanged; paths remain in accessible
  option descriptions rather than a separate visible field.
- **Change project default…** is a separate, explicitly project-wide menu mode.
  Unmigrated projects show **Choose a project default…**. It does not convert any
  existing override to inheritance.
- Repository material rows in Context have **Use for this workspace** in their
  actions. Remote-only repositories explain that a local clone/folder is needed;
  this action does not clone or launch a sandbox implicitly.
- Opening, mentioning, attaching, or removing a context item does not reconnect
  the workspace. A single main-process repository-change event refreshes all
  selectors, Build preflight, and post-it destination information.

## Migration and recovery

Migration is queued per project and repeatable, including already migrated
projects from the previous workspace-repository design.

1. Keep every existing non-null workspace `repoId` exactly as an explicit override,
   including missing IDs/paths. Never repair one by pointing it somewhere else.
   A saved migration ambiguity is cleared once an explicit choice exists; current
   availability errors still come from the resolver, without changing that choice.
2. Consider only actual workspace-specific repositories for an inferred override:
   its saved generated app and its existing `code/` Git root. Canonical aliases of
   one repository count once. One candidate is retained in place as an override;
   zero candidates means `repoId: null`, inheriting the project default. The project
   repository is a fallback, **not** a competing workspace candidate. An occupied
   non-repository `code/` is left untouched: it is neither overwritten, initialized,
   nor treated as a repository candidate. Only an existing provisioning intent can
   resume an interrupted initialization.
3. Multiple genuine workspace repositories keep `repositoryIssue` with their
   candidate paths and require selection. They are registered with stable IDs and
   appear with names/paths in the existing repository chooser. Every source folder
   and the project fallback remain intact. Issues are recomputed from current
   evidence on every load, even for schema-3 workspaces and projects previously
   marked migrated; outdated project/Build candidates and occupied-folder errors
   do not remain as permanent blockers. An intentional schema-3 inheritance choice
   with no issue is preserved, not reconsidered because an old app still exists.
4. Reuse an unambiguous legacy project-wide target as default. Otherwise use an
   existing project-root `code/` repository, or the sole registered unarchived
   current repository. Historical Build repositories remain registered, but their
   history alone cannot select a workspace override or implicitly become the sole
   default: independent project/workspace evidence is required. Existing non-null
   default IDs are preserved. Multiple candidates or no candidate leave `defaultRepoId: null`
   and `repositoryDefaultsMigration.status: "needs-selection"` with an issue.
   An unset default is reevaluated when the available evidence changes. No
   repository is created merely by migrating an old project.
5. Regenerate the catalog. Repeated loads/reopening preserve the same IDs and
   unchanged JSON. Preview identities are saved before completing workspace
   association so an interrupted metadata write can retry safely. Already recorded
   preview repository IDs are never overwritten by current workspace selection.

| Legacy state | Migrated connection |
| --- | --- |
| Project repository P + one generated workspace app A | Project default P; workspace override A. |
| Existing valid workspace `code/` repository C | Override C, reusing its registry/library IDs and Git history. |
| Project repository P + only historical Builds in H | Inherit P; Builds keep H. |
| Only historical Builds in H, no current project/workspace target | No inferred connection; ask for a default. Builds keep H. |
| Generated app A + valid workspace `code/` C | Present A and C for explicit selection; preserve both. |
| Occupied non-Git `code/` + no workspace-specific repository | Inherit the project default; leave the folder unchanged. |
| Saved conflict caused only by project fallback, old Builds, or occupied `code/` | Reevaluate under these rules and clear the resolved issue. |
| Explicit `repoId` points to missing/archived repository | Preserve that ID and report its unavailability; never fall back. |

No repository is relocated or deleted by this defaults migration. In particular,
`.local-apps` source, Git history, launch recipes, library identity and preview
history stay where they are. Existing Code-workspace compatibility and explicit
rename/move/trash operations retain their earlier relocation safeguards.

New-project creation uses a `pending` defaults intent and `.repository-init.json`.
The same queued recovery operation resumes before/after marker creation and after
Git initialization. Its first commit is an empty tree, never staged user content.
An occupied folder without the provisioning marker is not overwritten. Catalog
readers and concurrent startup loads cannot initialize a second repository.

## Work already in progress

`store/workspace-repositories.cjs::resolve` is the selector for new Bart requests,
Builds, and repository displays. Missing explicit overrides fail with a
reconnect/restore instruction; there is no default fallback. A missing default
fails for inheritors but leaves valid overrides usable.

At request start, Bart captures the resolved repository and holds a relocation
lease through the answer or proposed-build planning. Its resume cache is scoped
by repository. A durable `.bart/questions/<askId>.json` records `workspaceId`,
document `ref`, a question hash, original repository ID/name/library ID/directory,
inheritance/default at start, timestamps and status. Answer attribution includes
the repository name; it is not rewritten when the selection changes. These are
provenance records, not duplicate answer bodies. Existing answers are unchanged.

New Builds record `repoId`, `repositoryName`, `repo`, `sourceDirectory`, `worktree`
and `cwd`. Their replies, continuation, review and Accept/Discard continue using
those captured targets. Changing a connection does not transplant worktrees.
Preflight/approval carries the expected repository ID; a stale proposal asks for
a fresh plan rather than building in a newly selected repository accidentally.
Bart's ordinary answers remain read-only and proposed builds still require approval.

Hudson's checkpoint/review/Accept/Discard lifecycle and review-preview behavior
are retained. Successful Accept switches to accepted code; Discard restores the
accepted preview; failed Accept retains review. Servers stop before worktree
removal. Temporary worktrees are not registered as workspace repositories.
Post-it Builds still show their chosen workspace and resolved code destination.
Shell/Claude/Codex terminal cwd selection remains completely independent.

See [repository runtime ownership and relocation](repository-runtime-fixes.md)
for exact preview-server ownership, location-checked Bart session resumption,
absolute Context repository paths, and dependency-scoped move/rename guards.

## Validation

- `test/project-repository-names.test.cjs`: exact project labels on creation,
  completed-project naming migration, repeatability/reopening, interrupted
  library writes and project renames, custom labels, external repositories,
  unmanaged/symlink exclusions, unchanged overrides, IDs, Git and Build/preview
  history, plus registry/library/catalog/Bart name agreement.
- `test/project-default-repositories.test.cjs`: root/default initialization,
  nested inheritance, external dirty-file preservation, explicit creation,
  override/default changes, context independence, missing targets, conflict and
  no-candidate migration, repeatability, interrupted/concurrent provisioning,
  catalog rebuilding, captured Bart context and durable history.
- `test/build.test.cjs`: ongoing Build reply/Accept after a default change, plus
  the existing override, approval, transfer and review/Accept/Discard checks.
- Existing workspace relocation/trash, legacy Code compatibility, shared context,
  editor, connector, annotation, recording and terminal tests remain in scope.
- `test/workspace-repositories.test.cjs`: legacy project-plus-app inheritance,
  existing `code/` reuse, occupied non-Git preservation, real candidate ambiguity,
  clearing stale issues in already-migrated projects, unavailable explicit IDs,
  historical-only targets, repeatability and reopening the persisted library.
- `scripts/smoke-workspace-repositories.cjs`: isolated real Electron/IPC, synchronized
  selectors, separate default action, sidebar action, nested inheritance, path
  display, narrow-window placement, independent terminal sessions and busy rename;
  generated-name migration, live project rename and custom label updates across
  sidebar, Code context and Build in without reloading the renderer.

Development uses disposable homes and fake coding-agent responses (with real Git
and local preview servers). The user's running app and repositories are not
restarted or migrated by these tests. Current validation totals are reported with
the change, not inferred from the historical report linked above.

Validation on 2026-09-28:

- Full suite after the legacy-inheritance correction: **825 passed, 3 failed**
  (828 tests). The three existing failures in
  `sandbox-pipeline-benchmark.test.cjs` are frozen snapshots missing
  `src/main/store/captured-sites.cjs`; those snapshots were not changed.
- Legacy correction: **100 targeted tests passed** across workspace repositories,
  defaults, Code compatibility, Builds, and local previews. A final repository
  pass had **30 passing tests**; the final stale-issue/history edge-case pass had
  **5 passing tests**, including historical references to a missing project `code/`.
- These migration checks used disposable homes and reopened the persisted test
  library. No real user repositories or project metadata were migrated.
- Additional final editor/session regression pass: **21 passed**, including a
  new check that repository controls never enter editable document/question text.
- Repository/selector, Build/Stage, and post-it startup Electron checks: passed.
  Build checks include accepting into the original repository after a project
  default change and keeping review available when Accept fails.
- Production renderer build, main-process syntax checks, and `git diff --check`:
  passed. Normal/narrow repository UI screenshots were inspected.
