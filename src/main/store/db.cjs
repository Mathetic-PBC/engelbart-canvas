'use strict';

// Two Postgres databases, embedded (PGlite, Postgres compiled to WASM, persisted to a
// directory). The SQL is plain Postgres so the same statements run on a Supabase project
// later; this module is the swap point (spec §2 #3).
//
//   <testRoot>/library.pglite    tables `library` and `sandbox_runs` — items and their sandbox attempts
//   <project>/notes.pglite       table `notes`    — the notes created in that project

const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const { collectBuildMilestones } = require('../../shared/build-history.cjs');

// `type` is what a row is, read off the thing itself and never guessed: a file's format, or
// `folder`, `website`, `image` for the three that are not a file with an extension. What a row is
// *for* is inferred and lives in `tags`, beside the type and never instead of it: a pdf may or may
// not be a paper, and a paper may be a pdf or an address (2026-09-21).
// `docx` (2026-09-23): a Word document, read on the Stage through macOS textutil. A library that holds one cannot be
// opened by a build from before it (the type check below is re-made on every open and would refuse the row).
const LIBRARY_TYPES = Object.freeze(['md', 'pdf', 'html', 'csv', 'tsv', 'json', 'jsonl', 'parquet', 'xlsx', 'docx', 'folder', 'website', 'image']);
// `paper`: an arXiv or DOI address, or a pdf that reads like one (src/main/context/pdf-kind.cjs).
// `git`: a repository, by its address or as a folder with a `.git`. `note`: written in Engelbart;
// nothing that is added from outside can get it.
const LIBRARY_TAGS = Object.freeze(['paper', 'git', 'note']);
const typeList = LIBRARY_TYPES.map((type) => `'${type}'`).join(',');

const LIBRARY_SCHEMA = `
create table if not exists library (
  id uuid primary key,
  name text not null,
  type text not null check (type in (${typeList})),
  path text,
  url text,
  folder_path text,
  project_id uuid,
  created timestamptz not null default now(),
  last_edited timestamptz not null default now()
);
create index if not exists library_project on library (project_id);
-- the catalog blurb (src/main/context): written by the summary sweep, null for images and for notes that are short or not yet settled
alter table library add column if not exists summary text;
alter table library add column if not exists summary_edited timestamptz;
-- characters in a note's file, kept current on every save; null for every other type
alter table library add column if not exists char_count integer;
-- a GitHub repository's numeric id: what the repository is, whatever it is called this year. Digits,
-- kept as text (it crosses IPC and JSON). Null for everything else and for a repository GitHub could
-- not be asked about (private, offline), which is then known by its url. One row per id.
alter table library add column if not exists github_id text;
create unique index if not exists library_github_id on library (github_id) where github_id is not null;
-- what was inferred about the row (LIBRARY_TAGS), and the version of the category rules that was
-- applied to it (library.cjs CATEGORY_RULES; null: none yet). A row behind the current version is
-- re-categorized the next time its library opens, which is how an installed library follows a
-- change of rules without anyone adding its items again.
alter table library add column if not exists tags text[] not null default '{}';
alter table library add column if not exists categorized integer;
-- Last captured live-preview viewport. The image path is relative to the data root,
-- not the repository's path. Source run is provenance, not a second ownership link.
alter table library add column if not exists thumbnail_path text;
alter table library add column if not exists thumbnail_captured_at timestamptz;
alter table library add column if not exists thumbnail_run_id uuid;
-- Databases from before 2026-09-21 typed a row by what it was for (note, paper, git_repo, dataset;
-- website also meant an html file). Each becomes its format plus the tag that says the rest. This
-- is only what SQL can tell from the old type: categorized stays null, so library.recategorize
-- then applies the rules to every row before the library is handed to anyone (a pdf was always
-- called a paper, so whether one is comes from reading it; an address that was typed website may be
-- an arXiv one). Nothing a row knew is lost, and no summary, summary_edited or last_edited changes. The two fallbacks (a paper or dataset whose file has some other extension) match
-- nothing the app ever wrote; they exist so that no row can fail the check below.
alter table library drop constraint if exists library_type_check;
update library set type = 'md', tags = array['note'] where type = 'note';
update library set type = 'website', tags = array['paper'] where type = 'paper' and path is null;
update library set type = 'pdf' where type = 'paper';
update library set type = case when folder_path is null then 'website' else 'folder' end, tags = array['git'] where type = 'git_repo';
update library set type = 'folder' where type = 'dataset' and path is null;
update library set type = case lower(substring(path from '\\.([^./]+)$')) when 'tsv' then 'tsv' when 'json' then 'json' when 'jsonl' then 'jsonl' when 'ndjson' then 'jsonl' when 'parquet' then 'parquet' when 'xlsx' then 'xlsx' else 'csv' end where type = 'dataset';
update library set type = 'html' where type = 'website' and path is not null;
alter table library add constraint library_type_check check (type in (${typeList}));
alter table library drop constraint if exists library_note_is_md;
alter table library add constraint library_note_is_md check (type = 'md' or not ('note' = any(tags)));

-- Each attempt belongs to a library item; retrying creates another run. Keep the run's
-- sandbox handle when a library deletion is attempted: cleanup must be explicit first.
create table if not exists sandbox_runs (
  id uuid primary key,
  library_id uuid not null references library (id) on delete restrict,
  sandbox_id text,
  status text not null default 'starting' check (status in ('starting', 'ready', 'failed', 'stopped')),
  preview_url text,
  port integer check (port between 1 and 65535),
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz
);
create index if not exists sandbox_runs_library_created on sandbox_runs (library_id, created_at desc);
alter table sandbox_runs add column if not exists build_log jsonb not null default '[]';
-- Null marks pre-upgrade runs for a one-time backfill from whatever history remains.
alter table sandbox_runs add column if not exists build_milestones jsonb;
alter table sandbox_runs alter column build_milestones set default '{}';
alter table sandbox_runs add column if not exists env_revision uuid;
-- Keep discovered names after their event rolls out of the bounded build log.
alter table sandbox_runs add column if not exists env_report jsonb;
create table if not exists sandbox_environments (
  library_id uuid primary key references library (id) on delete cascade,
  revision uuid not null,
  encrypted text not null,
  updated_at timestamptz not null default now()
);
create unique index if not exists sandbox_runs_one_active on sandbox_runs (library_id)
  where status in ('starting', 'ready');
-- Captured pages retain their owner even when a resumed run replaces its URL.
create table if not exists captured_sites (
  site text primary key,
  library_id uuid not null references library (id) on delete cascade
);
alter table captured_sites add column if not exists kind text not null default 'site' check (kind in ('site','repo'));
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
create table if not exists post_its (
  id uuid primary key,
  text text not null default '',
  nx double precision not null check (nx between 0 and 1),
  ny double precision not null check (ny between 0 and 1),
  width double precision not null check (width between 180 and 2400),
  height double precision not null check (height between 140 and 2400),
  z double precision not null default 0,
  created timestamptz not null default now(),
  last_edited timestamptz not null default now()
);
-- In the trash since (2026-09-22): hidden, restorable, and purged a week later (main/post-its/views.cjs).
alter table post_its add column if not exists deleted timestamptz;
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

function optionalGithubId(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || !/^[1-9]\d{0,18}$/.test(value)) throw new TypeError('github id must be a string of digits');
  return value;
}

function requireTags(value, type) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new TypeError('tags must be a list');
  const tags = [...new Set(value)];
  for (const tag of tags) if (!LIBRARY_TAGS.includes(tag)) throw new TypeError(`Unknown library tag: ${tag}`);
  if (tags.includes('note') && type !== 'md') throw new TypeError('Only a note written in Engelbart (an md) can be tagged note');
  return tags;
}

function requireCount(value) {
  if (!Number.isInteger(value) || value < 0 || value > 2_000_000_000) throw new TypeError('count must be a non-negative integer');
  return value;
}

// A library typed the old way is about to be rewritten row by row (LIBRARY_SCHEMA): the directory
// is copied first, closed, to <root>/.backups/library-<when>.pglite. It happens once, because the
// converted table has the column this looks for.
async function typedTheOldWay(db) {
  const columns = (await db.query("select column_name from information_schema.columns where table_name = 'library'")).rows.map((row) => row.column_name);
  return columns.length > 0 && !columns.includes('tags');
}

async function openRaw(dir, schema, { setAsideIf } = {}) {
  const key = path.resolve(dir);
  if (instances.has(key)) return instances.get(key);
  const opening = (async () => {
    let db = new PGlite(key);
    await db.waitReady;
    if (setAsideIf && await setAsideIf(db)) {
      await db.close();
      const backups = path.join(path.dirname(key), '.backups');
      fs.mkdirSync(backups, { recursive: true, mode: 0o700 });
      fs.cpSync(key, path.join(backups, `${path.basename(key, '.pglite')}-${new Date().toISOString().replace(/[:.]/g, '-')}.pglite`), { recursive: true });
      db = new PGlite(key);
      await db.waitReady;
    }
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
  const db = await openRaw(dir, LIBRARY_SCHEMA, { setAsideIf: typedTheOldWay });
  for (const run of (await db.query('select id, build_log from sandbox_runs where build_milestones is null')).rows) {
    await db.query('update sandbox_runs set build_milestones = $2::jsonb where id = $1 and build_milestones is null',
      [run.id, JSON.stringify(collectBuildMilestones(run.build_log))]);
  }
  return {
    dir,
    async insert(row) {
      const type = requireText(row.type, 'type');
      if (!LIBRARY_TYPES.includes(type)) throw new TypeError(`Unknown library type: ${type}`);
      const result = await db.query(
        `insert into library (id, name, type, path, url, folder_path, project_id, github_id, tags, categorized)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning *`,
        [
          requireText(row.id, 'id', { max: 64 }),
          requireText(row.name, 'name', { max: 512 }),
          type,
          requireText(row.path, 'path', { optional: true }),
          requireText(row.url, 'url', { optional: true }),
          requireText(row.folder_path, 'folder_path', { optional: true }),
          requireText(row.project_id, 'project_id', { optional: true, max: 64 }),
          optionalGithubId(row.github_id),
          requireTags(row.tags, type),
          row.categorized == null ? null : requireCount(row.categorized),
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
    // A note was saved with different text: it counts as edited now, and its length is recorded with it.
    async recordEdit(id, charCount) {
      await db.query('update library set last_edited = now(), char_count = $2 where id = $1', [requireText(id, 'id', { max: 64 }), requireCount(charCount)]);
      return true;
    },
    // Length only (a new note, or a backfill): does not count as an edit.
    async setCharCount(id, charCount) {
      await db.query('update library set char_count = $2 where id = $1', [requireText(id, 'id', { max: 64 }), requireCount(charCount)]);
      return true;
    },
    // `at` is when the text that was summarized was read, so an edit made while the summary was
    // being written still leaves summary_edited < last_edited. Never touches last_edited.
    async setSummary(id, summary, at) {
      const text = summary == null ? null : requireText(summary, 'summary', { max: 4000 });
      const result = await db.query(
        'update library set summary = $2, summary_edited = $3 where id = $1 returning *',
        [requireText(id, 'id', { max: 64 }), text, text == null ? null : new Date(at).toISOString()],
      );
      return plain(result.rows[0]);
    },
    // What the category rules make of a row: its type and tags, and `rules`, the version that was
    // applied (null when the row could not be settled, a pdf that is not there to read: the mark
    // stays where it was). Not an edit, and nothing to do with the summary: it writes these three columns only.
    async setCategory(id, { type, tags }, rules) {
      if (!LIBRARY_TYPES.includes(type)) throw new TypeError(`Unknown library type: ${type}`);
      const result = await db.query(
        'update library set type = $2, tags = $3, categorized = coalesce($4, categorized) where id = $1 returning *',
        [requireText(id, 'id', { max: 64 }), type, requireTags(tags, type), rules == null ? null : requireCount(rules)],
      );
      if (!result.rows.length) throw new Error('Unknown library item');
      return plain(result.rows[0]);
    },
    // Rows behind `rules`: converted from a database typed the old way, made before the rules
    // changed, or a pdf that could not be read when it was added.
    async uncategorized(rules) {
      const result = await db.query('select * from library where categorized is null or categorized < $1 order by created, name', [requireCount(rules)]);
      return result.rows.map(plain);
    },
    // A note and a pasted image are what Engelbart made them; no rule has anything to infer. Returns how many were marked.
    async settleUninferable(rules) {
      const result = await db.query("update library set categorized = $1 where (categorized is null or categorized < $1) and (type = 'image' or 'note' = any(tags))", [requireCount(rules)]);
      return result.affectedRows || 0;
    },
    // What is known about a repository, all on its one row: its GitHub id, its address, its clone on
    // disk, the name GitHub gives it. Every value is the one to store. Learning one is not an edit:
    // last_edited stays. A repository that has a folder is a folder; one that has only its address
    // is a website.
    async updateRepo(id, { name, url, folder_path: folderPath, github_id: githubId }) {
      const result = await db.query(
        "update library set name = $2, url = $3, folder_path = $4, github_id = $5, type = case when $4::text is null then 'website' else 'folder' end where id = $1 returning *",
        [requireText(id, 'id', { max: 64 }), requireText(name, 'name', { max: 512 }), requireText(url, 'url', { optional: true }), requireText(folderPath, 'folder_path', { optional: true }), optionalGithubId(githubId)],
      );
      return plain(result.rows[0]);
    },
    // A page that was a pdf all along becomes its saved copy (library web-pdfs, 2026-09-23): the same row — its id,
    // name, address, tags, summary — now a pdf with a file. Only a row that is still a page without a file changes;
    // null when it is not (gone, or given a file meanwhile). Not an edit: last_edited stays. The category rules run again.
    async adoptPdf(id, file) {
      const result = await db.query(
        "update library set type = 'pdf', path = $2, categorized = null where id = $1 and type = 'website' and path is null and folder_path is null returning *",
        [requireText(id, 'id', { max: 64 }), requireText(file, 'path', { max: 4096 })],
      );
      return result.rows.length ? plain(result.rows[0]) : null;
    },
    // Notes whose length has never been recorded (created before the column existed).
    async uncountedNotes() {
      const result = await db.query("select id, path from library where 'note' = any(tags) and path is not null and char_count is null");
      return result.rows.map(plain);
    },
    // Notes the summary sweep has to look at: untouched since `quietBefore`, and either never
    // summarized (and not known to be short) or summarized before their last edit.
    async summaryCandidates(quietBefore, minChars) {
      const result = await db.query(
        `select * from library
          where 'note' = any(tags) and path is not null and last_edited <= $1
            and ((summary is null and (char_count is null or char_count > $2))
              or (summary is not null and (summary_edited is null or summary_edited < last_edited)))
          order by last_edited`,
        [new Date(quietBefore).toISOString(), requireCount(minChars)],
      );
      return result.rows.map(plain);
    },
    // Every pdf on disk, paper or not: a PDF's abstract is its summary.
    async papersWithFiles() {
      const result = await db.query("select * from library where type = 'pdf' and path is not null order by created");
      return result.rows.map(plain);
    },
    // Escape hatch for tests and repairs.
    async query(sql, params = []) {
      const result = await db.query(sql, params);
      return result.rows.map(plain);
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
    postIts: {
      // The cards on screen; the trash holds the rest (trashed / restore / purge).
      async list() {
        return (await db.query('select * from post_its where deleted is null order by z, created, id')).rows.map(plain);
      },
      async create(row) {
        const values = postItValues(row);
        const result = await db.query('insert into post_its (id, text, nx, ny, width, height, z) values ($1,$2,$3,$4,$5,$6,$7) returning *', [requireText(row.id, 'id', { max: 64 }), ...values]);
        return plain(result.rows[0]);
      },
      async update(id, row) {
        // UPDATE, never UPSERT: a save already in flight must not resurrect a purged card. It leaves `deleted` alone.
        const result = await db.query('update post_its set text=$2, nx=$3, ny=$4, width=$5, height=$6, z=$7, last_edited=now() where id=$1 returning *', [requireText(id, 'id', { max: 64 }), ...postItValues(row)]);
        return plain(result.rows[0]);
      },
      async trash(id) {
        const result = await db.query('update post_its set deleted=now() where id=$1 and deleted is null returning *', [requireText(id, 'id', { max: 64 })]);
        return plain(result.rows[0]);
      },
      async restore(id) {
        const result = await db.query('update post_its set deleted=null where id=$1 and deleted is not null returning *', [requireText(id, 'id', { max: 64 })]);
        return plain(result.rows[0]);
      },
      async trashed() {
        return (await db.query('select * from post_its where deleted is not null order by deleted desc, id')).rows.map(plain);
      },
      // Gone for good: cards in the trash since before `before`.
      async purge(before) {
        const when = new Date(before);
        if (Number.isNaN(when.getTime())) throw new TypeError('purge needs a date');
        const result = await db.query('delete from post_its where deleted is not null and deleted < $1', [when.toISOString()]);
        return result.affectedRows || 0;
      },
      async remove(id) {
        const result = await db.query('delete from post_its where id=$1', [requireText(id, 'id', { max: 64 })]);
        return (result.affectedRows || 0) > 0;
      },
    },
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

function postItValues(row) {
  if (!row || typeof row.text !== 'string' || row.text.length > 400000) throw new TypeError('Post-it text must be at most 400000 characters');
  const values = [row.text];
  for (const [key, min, max] of [['nx', 0, 1], ['ny', 0, 1], ['width', 180, 2400], ['height', 140, 2400], ['z', 0, Number.MAX_SAFE_INTEGER]]) {
    if (!Number.isFinite(row[key]) || row[key] < min || row[key] > max) throw new TypeError(`Post-it ${key} is out of range`);
    values.push(row[key]);
  }
  return values;
}

module.exports = { LIBRARY_TYPES, LIBRARY_TAGS, openLibraryDb, openNotesDb, closeDb, closeAll };
