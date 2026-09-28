'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { writeJson } = require('../store/home.cjs');
const projects = require('../store/projects.cjs');
const UUID = /^[0-9a-f-]{36}$/i;

function locations(ctx, projectId, workspaceId, create = false) {
  if (!UUID.test(projectId) || !UUID.test(workspaceId)) throw new TypeError('Invalid local app identity.');
  const { workspace } = projects.findWorkspace(ctx, projectId, workspaceId);
  // Hidden so this cannot be mistaken for another user-created project.
  const root = path.join(fs.realpathSync(ctx.dataRoot), '.local-apps', projectId, workspaceId);
  const directory = path.join(root, 'app');
  let part = fs.realpathSync(ctx.dataRoot);
  for (const name of ['.local-apps', projectId, workspaceId, 'app']) {
    part = path.join(part, name);
    if (fs.existsSync(part) && (fs.lstatSync(part).isSymbolicLink() || !fs.statSync(part).isDirectory())) throw new Error('The local app folder must not be a symlink or file.');
    if (create) fs.mkdirSync(part, { recursive: true, mode: 0o700 });
  }
  return { root, directory, file: path.join(root, 'state.json'), name: workspace.name, projectId, workspaceId, id: `${projectId}:${workspaceId}` };
}

function regular(file, maxBytes) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) throw new Error(`Invalid local app file: ${path.basename(file)}`);
  return fs.readFileSync(file, 'utf8');
}

function readState(where) {
  if (!fs.existsSync(where.file)) return null;
  const state = JSON.parse(regular(where.file, 600_000));
  if (state.id !== where.id) throw new Error('Local app identity does not match its workspace.');
  return { ...state, directory: where.directory, projectId: where.projectId, workspaceId: where.workspaceId };
}

function saveState(where, state) {
  if (fs.existsSync(where.file)) regular(where.file, 600_000);
  writeJson(where.file, state);
}

function readRecipe(directory) {
  let recipe;
  try { recipe = JSON.parse(regular(path.join(directory, 'engelbart-preview.json'), 16_000)); }
  catch (error) { throw new Error(`Missing or invalid engelbart-preview.json: ${error.message}`); }
  if (recipe.version !== 1 || recipe.kind !== 'interface') throw new Error('The output must be a browser interface, declared with kind: "interface".');
  for (const key of ['command', 'install', 'build']) {
    if ((key === 'command' || recipe[key] != null) && (typeof recipe[key] !== 'string' || !recipe[key].trim() || recipe[key].length > 2000 || /[\0\r\n]/.test(recipe[key]))) throw new Error(`Invalid ${key} command in engelbart-preview.json.`);
  }
  if (!recipe.command.includes('{port}')) throw new Error('The preview command must contain {port}, so Canvas can allocate its own port.');
  const cwd = recipe.cwd || '.';
  if (typeof cwd !== 'string' || path.isAbsolute(cwd) || cwd.split(/[\\/]/).includes('..')) throw new Error('The preview working directory must stay inside the local app.');
  const resolved = fs.realpathSync(path.join(directory, cwd));
  const realRoot = fs.realpathSync(directory);
  if (resolved !== realRoot && !resolved.startsWith(realRoot + path.sep)) throw new Error('The preview working directory escapes the local app.');
  const route = recipe.path || '/';
  if (typeof route !== 'string' || !route.startsWith('/') || route.startsWith('//') || /[\\\r\n\0]/.test(route) || route.length > 1000) throw new Error('Invalid preview path.');
  return { version: 1, kind: 'interface', buildId: typeof recipe.buildId === 'string' ? recipe.buildId.slice(0, 64) : '', name: String(recipe.name || 'Local interface').slice(0, 120), cwd, command: recipe.command, install: recipe.install || null, build: recipe.build || null, path: route };
}

function installKey(directory, recipe) {
  const hash = createHash('sha256').update(JSON.stringify([recipe.cwd, recipe.install]));
  for (const name of ['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'requirements.txt', 'pyproject.toml', 'uv.lock']) {
    const file = path.join(directory, recipe.cwd, name);
    if (fs.existsSync(file)) hash.update(name).update(regular(file, 10_000_000));
  }
  return hash.digest('hex');
}

module.exports = { locations, readState, saveState, readRecipe, installKey };
