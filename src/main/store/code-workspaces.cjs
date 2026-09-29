'use strict';

// Read-only classification shared by discovery and both layout migrations. A
// reserved name alone is not evidence that an older workspace is source code.
const fs = require('node:fs');
const path = require('node:path');
const { readJson } = require('./home.cjs');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUSES = ['open', 'progress', 'done'];
const BOXES = ['current', 'experimental', 'past'];
const real = file => { try { return fs.realpathSync(file); } catch { return path.resolve(file); } };
const within = (root, file) => { const a = real(root), b = real(file); return b === a || b.startsWith(a + path.sep); };
const regular = file => { try { return fs.lstatSync(file).isFile(); } catch { return false; } };
const workspaceMeta = meta => !!meta && UUID.test(meta.id) && (meta.status == null ? !BOXES.includes(meta.box) : STATUSES.includes(meta.status));

function projectRoot(dir) {
  let at = path.resolve(dir);
  while (true) {
    if (readJson(path.join(at, 'project.json'))?.id) return at;
    const parent = path.dirname(at);
    if (parent === at) return null;
    at = parent;
  }
}

function evidence(root) {
  const project = root ? readJson(path.join(root, 'project.json')) || {} : {};
  const repositories = Object.values(project.repositories || {}).filter(repo => typeof repo.location === 'string').map(repo => path.resolve(root, repo.location));
  if (typeof project.directory === 'string' && path.isAbsolute(project.directory)) repositories.push(project.directory);
  // A project stored in Git can still contain real workspaces. Only a repository
  // boundary below (or outside) its root identifies a folder as artifact content.
  return { root, repositories: repositories.filter(dir => !root || !within(dir, root)), catalog: root ? readJson(path.join(root, '.context', 'catalog.json')) : null, conflicts: project.workspaceNameMigration?.conflicts || [] };
}

function classify(dir, known = evidence(projectRoot(path.dirname(dir)))) {
  const meta = readJson(path.join(dir, 'meta.json'));
  const document = path.join(dir, 'workspace.md');
  const valid = workspaceMeta(meta) && regular(document);
  const initialized = readJson(path.join(path.dirname(dir), '.repository-init.json'));
  const repository = known.repositories.some(root => within(root, dir))
    || initialized?.directory && real(initialized.directory) === real(dir)
    || fs.existsSync(path.join(dir, '.git'));
  // Source files may perfectly imitate metadata. Repository ownership wins
  // unless an independent, previously saved workspace association contradicts it.
  const catalogWorkspace = valid && known.root && (known.catalog?.workspaces?.some(row => row.id === meta.id && typeof row.path === 'string' && real(path.resolve(known.root, row.path)) === real(dir))
    || known.conflicts.some(row => row.code === 'WORKSPACE_NAME_CONFLICT' && row.workspaceId === meta.id && typeof row.path === 'string' && real(row.path) === real(dir)));
  if (repository && !catalogWorkspace) return { kind: 'repository' };
  if (!repository && valid) return { kind: 'workspace', id: meta.id };
  if (repository && catalogWorkspace || fs.existsSync(path.join(dir, 'meta.json')) || fs.existsSync(document)) {
    return { kind: 'conflict', id: workspaceMeta(meta) ? meta.id : null, message: `Cannot safely identify “${dir}” as a legacy workspace or repository. Its files were preserved. Check its meta.json, workspace.md and project repository records before renaming or reconnecting it.` };
  }
  return { kind: 'other' };
}

function subdirectories(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }).filter(entry => entry.isDirectory() && !entry.name.startsWith('.') && !entry.name.endsWith('.pglite')).map(entry => path.join(dir, entry.name)); }
  catch { return []; }
}

/** Raw scan, independent of migration flags and the ordinary reserved-name filter. */
function inspect(root, { onRepository = () => {} } = {}) {
  const known = evidence(root), workspaces = [], conflicts = [];
  function walk(parent, depth = 0, goal = null, goalWorkspace = null) {
    if (depth > 32) return;
    for (const dir of subdirectories(parent)) {
      if (path.basename(dir).toLowerCase() === 'code') {
        const found = classify(dir, known);
        if (found.kind === 'workspace') {
          const top = goalWorkspace || (goal ? dir : null);
          workspaces.push({ dir, id: found.id, goalWorkspace: top });
          walk(dir, depth + 1, goal, top);
        }
        else if (found.kind === 'conflict') conflicts.push({ path: dir, workspaceId: found.id, code: 'WORKSPACE_NAME_CONFLICT', message: found.message });
        else if (found.kind === 'repository') onRepository(dir);
        // Never walk a repository, even if its sources look like workspaces.
        continue;
      }
      if (known.repositories.some(root => within(root, dir)) || fs.existsSync(path.join(dir, '.git'))) { onRepository(dir); continue; }
      const meta = readJson(path.join(dir, 'meta.json'));
      if (workspaceMeta(meta)) walk(dir, depth + 1, goal, goalWorkspace || (goal ? dir : null));
      else if (meta && UUID.test(meta.id) && BOXES.includes(meta.box)) walk(dir, depth + 1, parent === root ? dir : goal, goalWorkspace);
    }
  }
  walk(root);
  return { workspaces, conflicts };
}

module.exports = { classify, inspect };
