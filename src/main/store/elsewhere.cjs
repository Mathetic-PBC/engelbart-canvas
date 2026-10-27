'use strict';

// Other projects' workspaces and Sources, found from inside this one (MATH-148, 2026-10-26): the @ menu and the Search
// panel ask with what was typed and get back only the matches, never the texts. A pdf's text is matched in the database
// (library_text, db.cjs searchText); a note's or another md's is read where it is, as search reads it (library.mdReader);
// every project's workspace documents are the one thing kept here, lowercased, each read again when its file changed
// (its size or time), and the list of them walked on every search, so a workspace saved, made, renamed, deleted or copied
// in is seen at once without a restart. This project's own things are not here: the window finds those as it always did.

const fs = require('node:fs');
const path = require('node:path');
const projects = require('./projects.cjs');
const library = require('./library.cjs');
const { stripTaskMarkers } = require('../../shared/task-marker.cjs');

const MAX_RESULTS = 50;
const AROUND = 60; // characters of a snippet either side of the words
const MAX_NEEDLE = 200;

// workspace.md → { size, mtimeMs, text, lowered }
const texts = new Map();

/** A workspace document as search reads it: no task markers, lowercased beside the text. Kept until its file changes. */
function workspaceText(file) {
  let stat;
  try { stat = fs.statSync(file); } catch { texts.delete(file); return null; }
  const held = texts.get(file);
  if (held && held.size === stat.size && held.mtimeMs === stat.mtimeMs) return held;
  const text = stripTaskMarkers(library.readBody(file));
  const next = { size: stat.size, mtimeMs: stat.mtimeMs, text, lowered: text.toLowerCase() };
  texts.set(file, next);
  return next;
}

/** A short piece of `text` around where `needle` first is in `lowered`, on one line. */
function snippetOf(text, lowered, needle) {
  const at = lowered.indexOf(needle);
  if (at < 0) return '';
  const source = text.length === lowered.length ? text : lowered; // a letter whose lowercase is longer shifts the places
  const from = Math.max(0, at - AROUND), to = Math.min(source.length, at + needle.length + AROUND);
  return `${from > 0 ? '…' : ''}${source.slice(from, to).replace(/\s+/g, ' ').trim()}${to < source.length ? '…' : ''}`;
}

const oneLine = (value) => String(value || '').replace(/\s+/g, ' ').trim();

/**
 * What the other projects hold that `query` names or says, at most `limit`: [{ id, kind: 'workspace' | 'item', name,
 * projectId, projectName, snippet, by: 'name' | 'text', type?, path? }]. Those found by their names first (workspaces, then
 * Sources), then those found by what they say. `projectId` is the project asking: nothing it holds is given. An item is
 * named by one project that holds it, the one it was made in when that is one of them.
 */
async function searchElsewhere(ctx, projectId, query, limit = 20) {
  const needle = String(query || '').trim().toLowerCase().slice(0, MAX_NEEDLE);
  const max = Math.max(1, Math.min(MAX_RESULTS, Number.isInteger(limit) ? limit : 20));
  if (!needle) return [];
  const all = projects.projectRecords(ctx);
  const here = all.find((project) => project.id === projectId) || null;
  const others = all.filter((project) => project.id !== projectId);
  const rows = await ctx.libraryDb.list();
  const heldHere = here ? projects.holder(here, projects.flattenWorkspaces(here.dir), await projects.notesMadeIn(here.dir)) : () => false;

  const named = { workspaces: [], items: [] }, said = { workspaces: [], items: [] };
  const live = new Set();
  const owner = new Map(); // library id → the other project named for it
  for (const project of others) {
    const workspaces = projects.flattenWorkspaces(project.dir);
    const holds = projects.holder(project, workspaces, await projects.notesMadeIn(project.dir, workspaces));
    for (const row of rows) {
      if (row.type === 'image' || heldHere(row) || !holds(row)) continue;
      if (!owner.has(row.id) || row.project_id === project.id) owner.set(row.id, project);
    }
    for (const workspace of workspaces) {
      const file = path.join(project.dir, workspace.path, 'workspace.md');
      live.add(file);
      const base = { id: workspace.id, kind: 'workspace', name: workspace.name, path: workspace.path, projectId: project.id, projectName: project.name };
      const held = workspaceText(file);
      if (workspace.name.toLowerCase().includes(needle)) { named.workspaces.push({ ...base, by: 'name', snippet: held ? snippetOf(held.text, held.lowered, needle) : '' }); continue; }
      if (held && held.lowered.includes(needle)) said.workspaces.push({ ...base, by: 'text', snippet: snippetOf(held.text, held.lowered, needle) });
    }
  }
  for (const file of [...texts.keys()]) if (!live.has(file)) texts.delete(file); // gone, renamed or trashed

  const item = (row, by, snippet) => { const project = owner.get(row.id); return { id: row.id, kind: 'item', type: row.type, name: row.name, projectId: project.id, projectName: project.name, by, snippet }; };
  const byId = new Map(rows.map((row) => [row.id, row]));
  const candidates = [...owner.keys()].map((id) => byId.get(id));
  const textual = [];
  for (const row of candidates) {
    if (row.name.toLowerCase().includes(needle)) named.items.push(item(row, 'name', ''));
    else if (oneLine(row.summary).toLowerCase().includes(needle)) { const summary = oneLine(row.summary); said.items.push(item(row, 'text', snippetOf(summary, summary.toLowerCase(), needle))); } else textual.push(row);
  }
  // What they say: the pdfs' in the database, as many as can still be shown; the md files' read where they are.
  const room = () => max - named.workspaces.length - named.items.length - said.workspaces.length - said.items.length;
  if (room() > 0) {
    const pdfs = textual.filter((row) => row.type === 'pdf').map((row) => row.id);
    for (const hit of await ctx.libraryDb.searchText(needle, pdfs, room(), AROUND)) {
      const row = byId.get(hit.id);
      if (row) said.items.push(item(row, 'text', `…${oneLine(hit.snippet)}…`));
    }
    const read = library.mdReader(ctx);
    for (const row of textual) {
      if (room() <= 0) break;
      if (row.type !== 'md') continue;
      const text = read(row), lowered = text.toLowerCase();
      if (lowered.includes(needle)) said.items.push(item(row, 'text', snippetOf(text, lowered, needle)));
    }
  }
  return [...named.workspaces, ...named.items, ...said.workspaces, ...said.items].slice(0, max);
}

/** Forget the kept workspace texts (tests; a data root changed). */
function forget() { texts.clear(); }

module.exports = { searchElsewhere, forget, snippetOf, MAX_RESULTS };
