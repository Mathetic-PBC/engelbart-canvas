'use strict';

// <project>/.context/catalog.json: what the project holds, for anything that reads files rather
// than the database (an agent in a terminal, a script). It is a projection of the library table
// joined with the workspaces on disk, regenerable at any time, written only by the app, and
// rewritten only when its content changes. Deleting .context loses nothing.

const fs = require('node:fs');
const path = require('node:path');
const { readJson, writeJson, DIR_MODE } = require('../store/home.cjs');
const projects = require('../store/projects.cjs');

const ABOUT = 'Everything this project holds. `type` is what an item is and is never a guess: a file\'s format (md, pdf, html, csv, tsv, json, jsonl, parquet, xlsx), or folder, website, image. `tags` is what was inferred about it: `paper` (an arXiv or DOI address, or a pdf that reads like a paper), `git` (a repository: its address, or a folder with a .git), `note` (written in Engelbart). `path` is relative to `project.root` unless absolute. `summary` says why an item matters and what is in it: for a PDF with an Abstract section it is that abstract; for a page or repository added by its address it is the description the page gives of itself; otherwise it is a model-written blurb, which exists only for notes (and PDFs without an abstract) longer than 1000 characters that have been left alone for 30 minutes. `chars` is the length of a note file, and of a workspace document. When `summary` is null or `summaryStale` is true, read the file itself. `workspaces` lists the workspaces whose context includes the item.';

// A note is edited through the app (last_edited); a PDF is "edited" when its file changes.
function changedAt(row) {
  if (row.type === 'pdf' && row.path) { try { return new Date(fs.statSync(row.path).mtimeMs).toISOString(); } catch { return row.last_edited; } }
  return row.last_edited;
}

function entryFor(row, project, referencedBy) {
  const inside = row.path && row.path.startsWith(project.dir + path.sep);
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    tags: row.tags || [],
    path: row.path ? (inside ? path.relative(project.dir, row.path).split(path.sep).join('/') : row.path) : null, // with /, as workspaces' are, on Windows too
    url: row.url || null,
    folderPath: row.folder_path || null,
    githubId: row.github_id || null,
    workspaces: referencedBy.get(row.id) || [],
    chars: row.char_count ?? null,
    lastEdited: row.last_edited || null,
    summary: row.summary || null,
    summaryEdited: row.summary_edited || null,
    summaryStale: !!row.summary && (!row.summary_edited || row.summary_edited < changedAt(row)),
  };
}

function buildCatalog(project, workspaces, rows, generated) {
  const referencedBy = projects.referencedBy(workspaces);
  return {
    version: 2, // 2: `type` became the format and `tags` arrived (2026-09-21)
    about: ABOUT,
    generated,
    project: { id: project.id, name: project.name, root: project.dir, directory: project.directory || null },
    workspaces: workspaces.map((workspace) => ({ id: workspace.id, name: workspace.name, path: workspace.path, document: `${workspace.path}/workspace.md`, chars: workspace.chars ?? null })),
    entries: rows.filter((row) => projects.holds(project, referencedBy, row)).map((row) => entryFor(row, project, referencedBy)),
  };
}

/** Rewrites the catalog of every project under the data root whose content changed. Returns the files written. */
async function writeCatalogs(ctx, { now = () => new Date() } = {}) {
  const rows = await ctx.libraryDb.list();
  const written = [];
  for (const project of projects.projectRecords(ctx)) {
    const catalog = buildCatalog(project, projects.flattenWorkspaces(project.dir), rows, now().toISOString());
    const dir = path.join(project.dir, '.context');
    const file = path.join(dir, 'catalog.json');
    const previous = readJson(file);
    if (previous && JSON.stringify({ ...previous, generated: null }) === JSON.stringify({ ...catalog, generated: null })) continue;
    fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
    writeJson(file, catalog);
    written.push(file);
  }
  return written;
}

module.exports = { buildCatalog, writeCatalogs };
