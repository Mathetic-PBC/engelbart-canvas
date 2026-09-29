# Legacy workspaces named Code

The workspace repository feature reserves `code/` for source. Older Engelbart
workspaces could have that name, including `Code`, `CODE`, and mixed-case forms.
These are now classified before the reserved-name filter is applied.

## What happens on project load

- A genuine workspace has its existing workspace ID/metadata and a regular
  `workspace.md`. The scan walks nested workspace metadata, independently of
  earlier migration-complete flags and the in-memory layout-migration cache.
- Repository records, a provisioning intent, or a `.git` boundary identify
  source content. Those directories and their descendants are never traversed
  as workspaces, even when their files imitate Engelbart metadata.
- A legacy workspace becomes `Code workspace` (or the next available numbered
  name). Existing destinations are never overwritten. Workspace IDs, documents,
  children, archives, repository IDs, and library IDs remain unchanged.
- Renames use the existing relocation journal, process/launch/worktree guards,
  and reference rewriting. This updates registered repository locations,
  library paths, Build and saved-preview paths, saved views, and the catalog.
  Even contained Git repositories not yet in the registry receive the worktree
  safety check. No existing repository is committed or connected by the rename.
- In the older goal/topic layout, a containing topic is promoted with these same
  safeguards before renaming its Code workspace. The older synchronous converter
  defers rather than moving the subtree first and invalidating its paths.

Example (IDs are illustrative):

```text
Before                              After
Project/Parent/Code/                 Project/Parent/Code workspace/
  meta.json: id=W, repoId=R            meta.json: id=W, repoId=R
  workspace.md                        workspace.md
  .archive/                           .archive/
  code/.git/                          code/.git/
  Child/meta.json: id=C                Child/meta.json: id=C

project.json repositories.R.location:
  "Parent/Code/code"                 → "Parent/Code workspace/code"
```

## Conflicts and interrupted runs

Incomplete workspace metadata, or repository ownership contradicting an earlier
workspace catalog, causes an actionable `WORKSPACE_NAME_CONFLICT` on project load.
Files remain untouched. The details persist under `workspaceNameMigration` in
`project.json`, with `version: 1`, `status: "needs-attention"`, and conflict paths.
Catalog regeneration leaves an unresolved project's previous catalog intact,
so a background sweep cannot erase evidence. Check the reported metadata and
repository records before explicitly repairing or renaming an ambiguous folder.

A busy move also stops before renaming and can be retried after the terminal,
agent, server, or Git worktree is closed. If interrupted after a move starts,
`.repository-relocation.json` resumes the path updates on the next load. Only a
successful rescan marks this compatibility migration `complete`. Repeated loads
do not rename again, duplicate repository IDs, or rewrite unchanged metadata.

The standalone structure-conversion script reports deferred Code migrations and
directs the user to open the project in Engelbart, where database references and
process-safety checks are available.

## Checks

`test/code-workspaces.test.cjs` covers root and nested names, capitalization,
already-migrated projects, absent Hudson-era status, destination collisions,
repeated runs, metadata/path/history preservation, actual repository sources,
durable ambiguity reports, busy moves, unregistered linked worktrees, interruption
before and after renaming, and the older goal/topic layout.

All tests use disposable homes. Development did not migrate the running user's
workspace files or restart Engelbart. Restart the app and open a project to apply
the compatibility pass to its saved workspaces.

Validation on 2026-09-28: the final targeted suite passed **76 tests**; the broader
run passed **804 of 807**, with only the three pre-existing frozen benchmark
snapshot failures (`../store/captured-sites.cjs` missing). The production build,
JavaScript syntax checks, and `git diff --check` passed. The final targeted run
also includes the additional unregistered-worktree guard added during the broader
run. Existing tracked and untracked work was backed up before editing under
`/private/tmp/engelbart-code-workspace-backup-Bwh41T` and was not discarded.
