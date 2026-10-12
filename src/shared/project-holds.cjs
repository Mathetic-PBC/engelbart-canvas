'use strict';
// What a project holds (2026-10-11, the Library's Phase A), one rule wherever it is asked: the catalog an agent is shown
// (main/context/catalog.cjs, main/bart/context.cjs), the all-projects cards and the project's library
// (main/store/projects.cjs, main/store/library.cjs), and the notes the @ menu and the sidebar's search leave out
// (renderer/model/rail.js letGoNotes).
//
// A project holds a row when it is not on project.json `removed` and any of: it was made there (`project_id`), project.json
// `library` lists it (an import started from the project, or an add to it), or a workspace has it in `context` and not in
// that workspace's `removed`. Removal wins over all three. A note let go of (letGo) is not held either.

/**
 * The notes let go of (MATH-58, 2026-10-06): trashed from a workspace (meta.json `removed`) and held by none of the
 * project's workspaces any more, neither in its context nor made in it, unless that one threw it away too. Only notes: a
 * paper, a link or a file in no workspace is still held, and so is a note never put in one (a post-it's +Note).
 * `workspaces` flat, each { id, context, removed }; `madeIn` Map of the project's note ids → the workspace each was made
 * in (notes.pglite `topic_id`), null for none. → Set of library ids.
 */
function letGo(workspaces, madeIn) {
  const trashed = new Set(), held = new Set();
  for (const workspace of workspaces || []) {
    const removed = new Set(workspace.removed || []);
    for (const id of removed) trashed.add(id);
    for (const id of workspace.context || []) if (!removed.has(id)) held.add(id);
    for (const [id, at] of madeIn) if (at && at === workspace.id && !removed.has(id)) held.add(id);
  }
  return new Set([...trashed].filter((id) => madeIn.has(id) && !held.has(id)));
}

/**
 * The rule for one project: `project` { id, library, removed } (project.json), its `workspaces` flat as above, `madeIn`
 * as letGo's. → (row) => boolean.
 */
function holder(project, workspaces, madeIn = new Map()) {
  const removed = new Set(project.removed || []), listed = new Set(project.library || []), inContext = new Set();
  for (const workspace of workspaces || []) {
    const thrown = new Set(workspace.removed || []);
    for (const id of workspace.context || []) if (!thrown.has(id)) inContext.add(id);
  }
  const gone = letGo(workspaces, madeIn);
  return (row) => !!row && !removed.has(row.id) && !gone.has(row.id)
    && (row.project_id === project.id || listed.has(row.id) || inContext.has(row.id));
}

module.exports = { letGo, holder };
