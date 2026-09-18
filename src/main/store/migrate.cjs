'use strict';

// The first layout put a workspace two levels down: <project>/<Goal>/<Topic>/workspace.md.
// Goals and topics are gone; a workspace is a directory of the project (and may hold child
// workspaces). This converts a project directory in place, and never deletes anything:
//
//   1. every file of the project except its database is copied to
//      <dataRoot>/.backups/<project>-<timestamp>/;
//   2. each goal directory is moved to <project>/.legacy/<Goal>/ (its meta.json and future.md stay there);
//   3. each topic directory inside it is moved up to <project>/<Topic>/, keeping its meta.json,
//      so its id, status, context tree and the notes that point at it (notes.topic_id) still match.
//      A name already taken at the project level gets " 2", " 3", …;
//   4. context folders (+ Folder) no longer exist — a nested workspace does that job — so a
//      workspace's context becomes the flat list of what its folders held, in order.
//
// It runs by itself the first time the app touches a project (store/projects.cjs) and from
// `npm run migrate` (scripts/migrate-structure.cjs, which also has --dry-run).

const fs = require('node:fs');
const path = require('node:path');
const { uniqueName, readJson, writeJson, DIR_MODE } = require('./home.cjs');

const BOXES = ['current', 'experimental', 'past'];
const STATUSES = ['open', 'progress', 'done'];

function subdirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && !entry.name.endsWith('.pglite'))
      .map((entry) => path.join(dir, entry.name));
  } catch {
    return [];
  }
}

const isGoal = (dir) => { const meta = readJson(path.join(dir, 'meta.json')); return !!meta && typeof meta.id === 'string' && BOXES.includes(meta.box) && !STATUSES.includes(meta.status); };
const isWorkspace = (dir) => { const meta = readJson(path.join(dir, 'meta.json')); return !!meta && typeof meta.id === 'string' && STATUSES.includes(meta.status); };

const flatIds = (entries, out = []) => { for (const entry of entries || []) { if (typeof entry === 'string') { if (!out.includes(entry)) out.push(entry); } else if (entry && typeof entry === 'object') flatIds(entry.children, out); } return out; };
const hasFolders = (entries) => (entries || []).some((entry) => entry && typeof entry === 'object');

// Every workspace directory under `dir`, at any depth (also inside goal directories that are about to move).
function workspacesUnder(dir, depth = 0, out = []) {
  if (depth > 34) return out;
  for (const child of subdirs(dir)) { if (isWorkspace(child)) out.push(child); if (isWorkspace(child) || isGoal(child)) workspacesUnder(child, depth + 1, out); }
  return out;
}

/** What converting `projectDir` would do (or did): null when there is nothing to convert. */
function migrateProjectDir(projectDir, { dryRun = false, now = new Date() } = {}) {
  const goals = subdirs(projectDir).filter(isGoal);
  const foldered = workspacesUnder(projectDir).filter((dir) => hasFolders((readJson(path.join(dir, 'meta.json')) || {}).context));
  if (!goals.length && !foldered.length) return null;
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const backup = path.join(path.dirname(projectDir), '.backups', `${path.basename(projectDir)}-${stamp}`);
  const legacy = path.join(projectDir, '.legacy');
  const report = { project: projectDir, backup, goals: goals.map((dir) => path.basename(dir)), moved: [], folders: [] };
  const folderNames = (entries, out = []) => { for (const entry of entries || []) if (entry && typeof entry === 'object') { out.push(entry.name || 'folder'); folderNames(entry.children, out); } return out; };
  for (const dir of foldered) report.folders.push({ workspace: path.basename(dir), removed: folderNames(readJson(path.join(dir, 'meta.json')).context) });

  if (dryRun) {
    const taken = new Set(fs.readdirSync(projectDir).filter((name) => !goals.includes(path.join(projectDir, name))));
    for (const goal of goals) {
      for (const topic of subdirs(goal).filter(isWorkspace)) {
        let name = path.basename(topic); let n = 2;
        while (taken.has(name)) { name = `${path.basename(topic)} ${n}`; n += 1; }
        taken.add(name);
        report.moved.push({ from: path.relative(projectDir, topic), to: name });
      }
    }
    return report;
  }

  fs.mkdirSync(path.dirname(backup), { recursive: true, mode: DIR_MODE });
  fs.cpSync(projectDir, backup, { recursive: true, filter: (source) => !source.endsWith('.pglite') && !source.includes(`.pglite${path.sep}`) });
  fs.mkdirSync(legacy, { recursive: true, mode: DIR_MODE });
  for (const goal of goals) {
    const parked = path.join(legacy, uniqueName(legacy, path.basename(goal)));
    fs.renameSync(goal, parked);
    for (const topic of subdirs(parked).filter(isWorkspace)) {
      const name = uniqueName(projectDir, path.basename(topic));
      fs.renameSync(topic, path.join(projectDir, name));
      report.moved.push({ from: path.join(path.basename(goal), path.basename(topic)), to: name });
    }
  }
  // Context folders are gone (a nested workspace does that job): what a folder held stays in the
  // workspace's context, in order, as a flat list. The folder names are kept in the log below.
  for (const dir of workspacesUnder(projectDir)) {
    const file = path.join(dir, 'meta.json');
    const meta = readJson(file);
    if (meta && hasFolders(meta.context)) writeJson(file, { ...meta, context: flatIds(meta.context) });
  }
  writeJson(path.join(legacy, `migration-${stamp}.json`), { at: now.toISOString(), backup, goals: report.goals, moved: report.moved, folders: report.folders });
  return report;
}

module.exports = { migrateProjectDir };
