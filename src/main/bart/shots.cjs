'use strict';
// The pictures of the web page in front that @bart turns are given (MATH-54 build 3a, 2026-10-06): one PNG per turn,
// <dataRoot>/bart-shots/<turn id>.png, inside the data folder the agent's file tools may already read. Bart is given the
// path alone (<screenshot path="…"/>, ./context.cjs) and opens it only when the answer depends on how the page looks.
// The last MAX_SHOTS are kept; each new one deletes those older than that.

const fs = require('node:fs');
const path = require('node:path');

const SHOTS_DIR = 'bart-shots';
const MAX_SHOTS = 20;

/** The folder the pictures are kept in. */
const shotsDir = (dataRoot) => path.join(dataRoot, SHOTS_DIR);

/**
 * Deletes all but the newest `keep` pictures in `dir`, by when each was written, `newest` (a file name) among them
 * whatever its time says; nothing else there is touched. → the names deleted.
 */
function pruneShots(dir, keep = MAX_SHOTS, newest = '') {
  let names;
  try { names = fs.readdirSync(dir).filter((name) => name.endsWith('.png')); } catch { return []; }
  const dated = [];
  for (const name of names) { try { dated.push({ name, at: fs.statSync(path.join(dir, name)).mtimeMs }); } catch { /* gone meanwhile */ } }
  dated.sort((a, b) => (b.name === newest) - (a.name === newest) || b.at - a.at || (a.name < b.name ? 1 : -1));
  const gone = [];
  for (const { name } of dated.slice(Math.max(0, keep))) { try { fs.unlinkSync(path.join(dir, name)); gone.push(name); } catch { /* gone meanwhile */ } }
  return gone;
}

/**
 * `png` (bytes) kept as turn `id`'s picture, then the older ones pruned. → its absolute path, or null: no bytes, an id that
 * is no file name, or a write that failed.
 */
function saveShot(dataRoot, id, png, { keep = MAX_SHOTS } = {}) {
  if (!png || !png.length || typeof id !== 'string' || !/^[\w-]{1,64}$/.test(id)) return null;
  const dir = shotsDir(dataRoot), file = path.join(dir, `${id}.png`);
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, png, { mode: 0o600 });
  } catch {
    return null;
  }
  pruneShots(dir, keep, path.basename(file));
  return file;
}

module.exports = { SHOTS_DIR, MAX_SHOTS, shotsDir, saveShot, pruneShots };
