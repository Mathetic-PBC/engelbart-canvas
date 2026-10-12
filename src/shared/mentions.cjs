'use strict';
// Which library rows a document mentions, one grammar for the renderer (model/rail.js, the rail and the @ menu's links,
// MATH-57) and main (store/projects.cjs projectItemMentions, the Library's "Still mentioned in N workspaces").

// Every mention a document holds: `@[Name]`, `@[Name](lib:<id>)`, `@[Name](ws:<id>)`, and a file in a library folder,
// `@[Name](lib:<folderId>:<path>)` (MATH-22), and a Zotero item, `@[Title](zotero:<key>)`, which is no row.
const MENTION_TOKEN_RE = /@\[([^\]\n]+)\](?:\((ws|lib|zotero):([\w-]+)(?::[\w.~%/-]+)?\))?/g;

/**
 * The library rows a document mentions, by id (MATH-57): a library mention its item, a plain one every row of its name
 * (as the rail reads them, Workspace.jsx `mentioned`). A workspace is no row. A file in a folder (MATH-22) is a mention of
 * its folder, so the folder stays linked while any mention of it or of a file in it is left.
 */
function mentionedIds(text, library = []) {
  const ids = new Set(), names = new Set(), body = String(text || '');
  if (!body.includes('@[')) return ids;
  for (const [, name, kind, id] of body.matchAll(MENTION_TOKEN_RE)) {
    if (kind === 'lib') ids.add(id);
    else if (!kind) names.add(name.toLowerCase());
  }
  if (names.size) for (const row of library) if (row && row.name && names.has(row.name.toLowerCase())) ids.add(row.id);
  return ids;
}

module.exports = { mentionedIds };
