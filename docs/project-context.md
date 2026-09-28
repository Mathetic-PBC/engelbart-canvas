# Shared sidebar context

Sidebar sources are shared across all workspaces in one project. Workspace
documents, open tabs, scroll positions, and child-workspace navigation remain
independent. Other projects keep their own context collections.

The collection is stored locally in `project.json`:

```json
{
  "sidebarContext": {
    "version": 1,
    "context": ["library-item-uuid"],
    "removed": ["hidden-library-item-uuid"]
  }
}
```

On first load, existing workspace attachments, project notes, saved mentions,
and pasted images are collected without duplicating library entries or changing
the original workspace metadata. Previously removed items remain hidden unless
they were still visible in another workspace. The collection survives app
restarts, project renames, and deletion of a workspace that attached a source.

Adding a source in any workspace includes it in the shared collection. Removing
it from the sidebar hides it throughout the project; the library entry and
underlying file remain. Shared removals take precedence over old attachments and
document mentions, so reloading cannot bring an item back unintentionally.
Explicitly attaching the item again restores it. Workspace attachment metadata
continues to record provenance; `setWorkspaceContext` adds its entries to the
project collection, while `unlinkFromWorkspace` removes shared sidebar entries.

`test/project-context.test.cjs` covers migration, persistence, concurrent adds,
removal/restoration, project isolation, and saved document references.
`scripts/smoke-project-context.cjs` exercises real sidebar interactions and
workspace switching in Electron with a disposable local library.
