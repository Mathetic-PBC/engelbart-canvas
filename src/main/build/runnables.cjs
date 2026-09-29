'use strict';

// What runs in a repository (library.pglite → repo_runnables, 2026-09-29): each web UI (`ui`), desktop app (`app`) or
// terminal program (`terminal`) a Build's run step (./run-step.cjs) found in a library repository, and the commands that
// passed Engelbart's own check. A runnable is its repository's row, a folder relative to the repository's root ('.' for
// the root) and a name; its type, commands and standing are kept on it. Commands are written only when a check passed
// (`verify`); a runnable that never passed in its time keeps the commands that last worked and is `failed`, with why.

const path = require('node:path').posix;
const { randomUUID } = require('node:crypto');

const TYPES = Object.freeze(['ui', 'app', 'terminal']);
const PORT = '{port}';
const NAME_RE = /^[\w][\w .@+-]{0,63}$/;
const MAX_COMMAND = 4000;
const MAX_ERROR = 4000;

/** A folder relative to the repository's root, as it is kept: '.', or 'web', 'apps/desktop' … never outside the root. */
function runnableFolder(value) {
  const raw = value == null || value === '' ? '.' : value;
  if (typeof raw !== 'string' || raw.length > 1024 || raw.includes('\0') || raw.includes('\\') || raw.startsWith('/')) throw new TypeError('folder must be relative to the repository');
  const folder = path.normalize(raw).replace(/\/+$/, '') || '.';
  if (folder === '..' || folder.startsWith('../')) throw new TypeError('folder must be inside the repository');
  return folder;
}

function runnableName(value) {
  if (typeof value !== 'string' || !NAME_RE.test(value.trim())) throw new TypeError('name must be 1 to 64 letters, digits, spaces or ._@+-');
  return value.trim();
}

function runnableType(value) {
  if (!TYPES.includes(value)) throw new TypeError(`type must be one of ${TYPES.join(', ')}`);
  return value;
}

/** A command as it is kept: a UI's holds {port}, where Engelbart puts the port it gives it. */
function runnableCommand(value, { type = null, optional = false, name = 'command' } = {}) {
  if (value == null || (typeof value === 'string' && !value.trim())) {
    if (optional) return null;
    throw new TypeError(`${name} is required`);
  }
  if (typeof value !== 'string' || value.length > MAX_COMMAND || value.includes('\0')) throw new TypeError(`${name} must be a string of at most ${MAX_COMMAND} characters`);
  if (type === 'ui' && !value.includes(PORT)) throw new TypeError(`A web UI's run command must hold ${PORT} where its port goes (for example "npm run dev -- --port ${PORT}" or "PORT=${PORT} npm start"): Engelbart gives it a free port each time it runs.`);
  return value.trim();
}

/** The command with Engelbart's port in it. */
const withPort = (command, port) => String(command).split(PORT).join(String(port));

function runnableStore(db) {
  const one = async (sql, params) => (await db.query(sql, params))[0] || null;
  const store = {
    /** A repository's runnables, by folder and name. */
    list(libraryId) {
      return db.query('select * from repo_runnables where library_id = $1 order by folder, name', [libraryId]);
    },
    get(id) { return one('select * from repo_runnables where id = $1', [id]); },
    /**
     * A runnable the run step named: made `pending` when it is new. A known one keeps its commands; given another type,
     * its commands are for something else, so it is `pending` again. → the row
     */
    declare(libraryId, { folder, name, type }) {
      return one(`insert into repo_runnables (id, library_id, folder, name, type) values ($1, $2, $3, $4, $5)
        on conflict (library_id, folder, name) do update set
          type = excluded.type,
          status = case when repo_runnables.type = excluded.type then repo_runnables.status else 'pending' end,
          install_command = case when repo_runnables.type = excluded.type then repo_runnables.install_command end,
          run_command = case when repo_runnables.type = excluded.type then repo_runnables.run_command end,
          updated_at = now()
        returning *`, [randomUUID(), libraryId, runnableFolder(folder), runnableName(name), runnableType(type)]);
    },
    /** The check passed: these are its commands now, checked at `commit`. → the row */
    async verify(id, { install_command: install, run_command: run, commit }) {
      const row = await store.get(id);
      if (!row) throw new Error('Unknown runnable');
      return one(`update repo_runnables set status = 'verified', install_command = $2, run_command = $3, verified_commit = $4,
        last_error = null, updated_at = now() where id = $1 returning *`,
      [id, runnableCommand(install, { optional: true, name: 'install_command' }), runnableCommand(run, { type: row.type, name: 'run_command' }), typeof commit === 'string' && /^[0-9a-f]{7,64}$/.test(commit) ? commit : null]);
    },
    /** It never passed in its time: `failed`, with the last error; the commands that last worked stay. → the row */
    fail(id, error) {
      return one("update repo_runnables set status = 'failed', last_error = $2, updated_at = now() where id = $1 returning *",
        [id, String(error || 'It did not pass its check.').slice(-MAX_ERROR)]);
    },
  };
  return store;
}

module.exports = { TYPES, PORT, runnableStore, runnableFolder, runnableName, runnableType, runnableCommand, withPort };
