'use strict';

// The sidebar is a project collection. Workspace metadata still records where
// a source was attached; one durable collection keeps it visible after switches.
const fs = require('node:fs');
const path = require('node:path');
const { readJson, writeJson } = require('./home.cjs');
const UUID = /^[0-9a-f-]{36}$/i;
const ids = values => [...new Set((Array.isArray(values) ? values : []).filter(value => typeof value === 'string' && UUID.test(value)))];
const file = project => path.join(project.dir, 'project.json');

function read(project) {
  const saved = readJson(file(project), {}).sidebarContext;
  return saved?.version === 1 ? { context: ids(saved.context), removed: ids(saved.removed) } : null;
}
function write(project, collection) {
  const meta = readJson(file(project));
  const saved = { version: 1, ...collection };
  if (JSON.stringify(meta.sidebarContext) !== JSON.stringify(saved)) writeJson(file(project), { ...meta, sidebarContext: saved });
  return collection;
}
function mentions(text, library) {
  const names = new Set([...text.matchAll(/@\[([^\]\n]+)\]/g)].map(match => match[1].toLowerCase()));
  const images = new Set([...text.matchAll(/!\[[^\]\n]*\]\(img:([\w-]+)\)/g)].map(match => match[1]));
  return library.filter(row => row.type === 'image' ? images.has(row.id) : names.has(row.name.toLowerCase())).map(row => row.id);
}
function collect(project, workspaces, notes, library) {
  const current = read(project), visible = new Set(), oldRemoved = new Set();
  for (const workspace of workspaces) {
    const removed = new Set(workspace.removed || []);
    for (const id of removed) oldRemoved.add(id);
    let text = '';
    try { text = fs.readFileSync(path.join(project.dir, workspace.path, 'workspace.md'), 'utf8'); } catch { /* missing document */ }
    for (const id of [...workspace.context, ...mentions(text, library)]) if (!removed.has(id)) visible.add(id);
  }
  for (const note of notes) {
    const owner = workspaces.find(workspace => workspace.id === note.workspaceId);
    if (!owner?.removed?.includes(note.id)) visible.add(note.id);
  }
  // Preserve the old visible union once. Later removals apply to the entire
  // project and beat legacy links/mentions so a reload cannot resurrect them.
  const removed = current?.removed || [...oldRemoved].filter(id => !visible.has(id));
  const blocked = new Set(removed);
  const context = ids([...(current?.context || []), ...visible]).filter(id => !blocked.has(id));
  return write(project, { context, removed });
}
function change(project, { add = [], remove = [] }) {
  const current = read(project);
  if (!current) throw new Error('Project context has not been loaded');
  const adding = new Set(ids(add)), removing = new Set(ids(remove));
  return write(project, {
    context: ids([...current.context, ...adding]).filter(id => !removing.has(id)),
    removed: ids([...current.removed, ...removing]).filter(id => !adding.has(id)),
  });
}

module.exports = { read, collect, change };
