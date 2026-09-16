'use strict';

// Two Postgres databases, embedded (PGlite, Postgres compiled to WASM, persisted to a
// directory). The SQL is plain Postgres so the same statements run on a Supabase project
// later; this module is the swap point (spec §2 #3).
//
//   <testRoot>/library.pglite    table `library`  — every mentionable thing, all projects
//   <project>/notes.pglite       table `notes`    — the notes created in that project

const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');

const LIBRARY_TYPES = Object.freeze(['note', 'paper', 'git_repo', 'dataset', 'website']);

const LIBRARY_SCHEMA = `
create table if not exists library (
  id uuid primary key,
  name text not null,
  type text not null check (type in ('note','paper','git_repo','dataset','website')),
  path text,
  url text,
  folder_path text,
  project_id uuid,
  created timestamptz not null default now(),
  last_edited timestamptz not null default now()
);
create index if not exists library_project on library (project_id);
`;

const NOTES_SCHEMA = `
create table if not exists notes (
  id uuid primary key,
  name text not null,
  path text not null,
  goal_id uuid,
  topic_id uuid,
  created timestamptz not null default now(),
  last_edited timestamptz not null default now()
);
`;

const instances = new Map();

function plain(row) {
  if (!row) return null;
  const out = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] = value instanceof Date ? value.toISOString() : value;
  }
  return out;
}

async function openRaw(dir, schema) {
  const key = path.resolve(dir);
  if (instances.has(key)) return instances.get(key);
  const opening = (async () => {
    const db = new PGlite(key);
    await db.waitReady;
    await db.exec(schema);
    return db;
  })();
  instances.set(key, opening);
  try {
    return await opening;
  } catch (error) {
    instances.delete(key);
    throw error;
  }
}

async function closeDb(dir) {
  const key = path.resolve(dir);
  const opening = instances.get(key);
  if (!opening) return false;
  instances.delete(key);
  const db = await opening;
  await db.close();
  return true;
}

async function closeAll() {
  await Promise.all([...instances.keys()].map((key) => closeDb(key)));
}

function requireText(value, name, { optional = false, max = 4096 } = {}) {
  if (value == null || value === '') {
    if (optional) return null;
    throw new TypeError(`${name} is required`);
  }
  if (typeof value !== 'string' || value.length > max) throw new TypeError(`${name} must be a string of at most ${max} characters`);
  return value;
}

async function openLibraryDb(testRoot) {
  const dir = path.join(testRoot, 'library.pglite');
  const db = await openRaw(dir, LIBRARY_SCHEMA);
  return {
    dir,
    async insert(row) {
      const type = requireText(row.type, 'type');
      if (!LIBRARY_TYPES.includes(type)) throw new TypeError(`Unknown library type: ${type}`);
      const result = await db.query(
        `insert into library (id, name, type, path, url, folder_path, project_id)
         values ($1, $2, $3, $4, $5, $6, $7) returning *`,
        [
          requireText(row.id, 'id', { max: 64 }),
          requireText(row.name, 'name', { max: 512 }),
          type,
          requireText(row.path, 'path', { optional: true }),
          requireText(row.url, 'url', { optional: true }),
          requireText(row.folder_path, 'folder_path', { optional: true }),
          requireText(row.project_id, 'project_id', { optional: true, max: 64 }),
        ],
      );
      return plain(result.rows[0]);
    },
    async list() {
      const result = await db.query('select * from library order by created, name');
      return result.rows.map(plain);
    },
    async get(id) {
      const result = await db.query('select * from library where id = $1', [requireText(id, 'id', { max: 64 })]);
      return plain(result.rows[0]);
    },
    async rename(id, name) {
      const result = await db.query(
        'update library set name = $2, last_edited = now() where id = $1 returning *',
        [requireText(id, 'id', { max: 64 }), requireText(name, 'name', { max: 512 })],
      );
      return plain(result.rows[0]);
    },
    async updatePath(id, filePath) {
      const result = await db.query(
        'update library set path = $2, last_edited = now() where id = $1 returning *',
        [requireText(id, 'id', { max: 64 }), requireText(filePath, 'path')],
      );
      return plain(result.rows[0]);
    },
    async touch(id) {
      await db.query('update library set last_edited = now() where id = $1', [requireText(id, 'id', { max: 64 })]);
      return true;
    },
    async rewritePathPrefix(oldPrefix, newPrefix) {
      const result = await db.query(
        `update library set path = $2 || substr(path, char_length($1) + 1)
         where path is not null and left(path, char_length($1)) = $1`,
        [requireText(oldPrefix, 'oldPrefix'), requireText(newPrefix, 'newPrefix')],
      );
      return result.affectedRows || 0;
    },
    async remove(id) {
      const result = await db.query('delete from library where id = $1', [requireText(id, 'id', { max: 64 })]);
      return (result.affectedRows || 0) > 0;
    },
    close: () => closeDb(dir),
  };
}

async function openNotesDb(projectDir) {
  const dir = path.join(projectDir, 'notes.pglite');
  const db = await openRaw(dir, NOTES_SCHEMA);
  return {
    dir,
    async insert(row) {
      const result = await db.query(
        `insert into notes (id, name, path, goal_id, topic_id) values ($1, $2, $3, $4, $5) returning *`,
        [
          requireText(row.id, 'id', { max: 64 }),
          requireText(row.name, 'name', { max: 512 }),
          requireText(row.path, 'path'),
          requireText(row.goal_id, 'goal_id', { optional: true, max: 64 }),
          requireText(row.topic_id, 'topic_id', { optional: true, max: 64 }),
        ],
      );
      return plain(result.rows[0]);
    },
    async list() {
      const result = await db.query('select * from notes order by created, name');
      return result.rows.map(plain);
    },
    async get(id) {
      const result = await db.query('select * from notes where id = $1', [requireText(id, 'id', { max: 64 })]);
      return plain(result.rows[0]);
    },
    async rename(id, name, relativePath) {
      const result = await db.query(
        'update notes set name = $2, path = $3, last_edited = now() where id = $1 returning *',
        [requireText(id, 'id', { max: 64 }), requireText(name, 'name', { max: 512 }), requireText(relativePath, 'path')],
      );
      return plain(result.rows[0]);
    },
    async touch(id) {
      await db.query('update notes set last_edited = now() where id = $1', [requireText(id, 'id', { max: 64 })]);
      return true;
    },
    close: () => closeDb(dir),
  };
}

module.exports = { LIBRARY_TYPES, openLibraryDb, openNotesDb, closeDb, closeAll };
