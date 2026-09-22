'use strict';

// The root library: seeds for test mode, file bytes for papers, PDF annotations, adding by address,
// and the two questions the all-projects screen asks (what a project holds, where an item is held).
// Nothing here copies user files; the seeds are the app's own fixtures (spec §2 #7, #15).

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { fileURLToPath, pathToFileURL } = require('node:url');
const { DIR_MODE } = require('./home.cjs');
const projects = require('./projects.cjs');
const { LIBRARY_TAGS } = require('./db.cjs');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_PDF_BYTES = 200 * 1024 * 1024;

function seedRows(seedDir) {
  return [
    { name: 'How to Teach Programming in the AI Era?', type: 'pdf', path: path.join(seedDir, 'hypocompass.pdf') }, // tagged paper once it is looked into
    { name: 'arXiv 2310.05292', type: 'website', tags: ['paper'], url: 'https://arxiv.org/abs/2310.05292' },
    { name: 'mqo00/hypocompass', type: 'website', tags: ['git'], url: 'https://github.com/mqo00/hypocompass', folder_path: null },
    { name: 'backend/problems', type: 'csv', path: path.join(seedDir, 'problems.csv') },
  ];
}

async function seedIfEmpty(ctx, fixturesDir) {
  const existing = await ctx.libraryDb.list();
  if (existing.length) return 0;
  const seedDir = path.join(ctx.dataRoot, 'seed');
  fs.mkdirSync(seedDir, { recursive: true, mode: DIR_MODE });
  for (const name of ['hypocompass.pdf', 'problems.csv']) {
    const source = path.join(fixturesDir, name);
    const target = path.join(seedDir, name);
    if (!fs.existsSync(target) && fs.existsSync(source)) fs.copyFileSync(source, target);
  }
  let count = 0;
  for (const row of seedRows(seedDir)) {
    if (row.path && !fs.existsSync(row.path)) continue;
    await ctx.libraryDb.insert({ id: randomUUID(), ...row });
    count += 1;
  }
  return count;
}

async function listLibrary(ctx) {
  return ctx.libraryDb.list();
}

async function readLibraryFile(ctx, id) {
  if (typeof id !== 'string' || !UUID_RE.test(id)) throw new TypeError('library id is invalid');
  const row = await ctx.libraryDb.get(id);
  if (!row || !row.path) throw new Error('This item has no local file');
  const file = path.resolve(row.path);
  if (path.extname(file).toLowerCase() !== '.pdf') throw new Error('Only downloaded pdf files open for now');
  if (!file.startsWith(ctx.homeDir + path.sep)) throw new Error('The file is outside your home directory');
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > MAX_PDF_BYTES) throw new Error('The file is not a readable pdf');
  const buffer = fs.readFileSync(file);
  return { id: row.id, name: row.name, bytes: new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength) };
}

function annotationFile(ctx, id) {
  if (typeof id !== 'string' || !UUID_RE.test(id)) throw new TypeError('library id is invalid');
  return path.join(ctx.dataRoot, 'annotations', `${id}.json`);
}

async function readAnnotations(ctx, id) {
  try {
    return JSON.parse(fs.readFileSync(annotationFile(ctx, id), 'utf8'));
  } catch {
    return null;
  }
}

async function writeAnnotations(ctx, id, value) {
  const file = annotationFile(ctx, id);
  let text;
  try {
    text = JSON.stringify(value ?? {});
  } catch {
    throw new TypeError('annotations must be JSON-serialisable');
  }
  if (text.length > 20 * 1024 * 1024) throw new TypeError('annotations are too large');
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: DIR_MODE });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, text, { mode: 0o600 });
  fs.renameSync(temporary, file);
  return true;
}

/* ------------------------------------------------------------ who holds what */

// Attachments live in each workspace's meta.json (`context`), and `library.project_id` is only
// where a row was made, so both directions are derived by scanning the workspaces. The rule is
// projects.holds, the one the catalog uses: an item belongs to a project that made it or that
// has it in a workspace's context.

/** Every project that holds the item: `origin` when it was made there, `workspaces` that have it in context. */
async function projectsForLibraryItem(ctx, itemId) {
  if (typeof itemId !== 'string' || !UUID_RE.test(itemId)) throw new TypeError('library id is invalid');
  const row = await ctx.libraryDb.get(itemId);
  if (!row) throw new Error('Unknown library item');
  const out = [];
  for (const project of projects.projectRecords(ctx)) {
    const workspaces = projects.flattenWorkspaces(project.dir).filter((workspace) => workspace.context.includes(row.id));
    const origin = row.project_id === project.id;
    if (origin || workspaces.length) out.push({ id: project.id, name: project.name, origin, workspaces: workspaces.map((workspace) => ({ id: workspace.id, name: workspace.name, path: workspace.path })) });
  }
  return out;
}

/** Every library row the project holds, each with `origin` and the paths of the workspaces that have it in context. */
async function libraryForProject(ctx, projectId) {
  const project = projects.findProject(ctx, projectId);
  const refs = projects.referencedBy(projects.flattenWorkspaces(project.dir));
  return (await ctx.libraryDb.list())
    .filter((row) => projects.holds(project, refs, row))
    .map((row) => ({ ...row, origin: row.project_id === project.id, workspaces: refs.get(row.id) || [] }));
}

/* ------------------------------------------------------------- repositories */

// A repository is one row whether it arrived by its address or as a clone on disk. What it *is* is
// its GitHub id (`github_id`): a rename or a transfer changes the address and not the id, and a name
// someone else took over is the same address and a different id. `url` is where it is now,
// `folder_path` the clone. A clone says where it came from in its own .git/config, which gives the
// address to ask GitHub about. When GitHub cannot be asked (private repository, offline, not on
// GitHub at all) the address stands in for the id, and the id is taken up the first time it is
// known. "Saved locally" means `folder_path` is set and the folder is still there; deleting the
// folder removes nothing from the library.

const GITHUB_RE = /^(?:https?:\/\/(?:www\.)?github\.com\/|git@github\.com:)([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/?#].*)?$/i;
const MAX_GIT_CONFIG_BYTES = 1024 * 1024;

/** `git@host:o/r.git`, `ssh://git@host/o/r`, `git://…`, `https://user:token@host/o/r.git` → `https://host/o/r`. Never keeps credentials. A path or `file:` remote is null. */
function canonicalRemote(remote) {
  const value = String(remote || '').trim();
  const match = value.match(/^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i) || value.match(/^(?:[\w.-]+@)?([\w.-]+\.[\w.-]+):(?!\/)(.+)$/);
  if (!match) return null;
  const repo = match[2].replace(/[?#].*$/, '').replace(/\/+$/, '').replace(/\.git$/i, '').replace(/\/+$/, '');
  return repo ? `https://${match[1].toLowerCase().replace(/^www\./, '')}/${repo}` : null;
}

/** What two spellings of one repository share. GitHub owners and names compare without case. */
function repoKey(url) {
  const canonical = canonicalRemote(url);
  if (!canonical) return null;
  return /^https:\/\/github\.com\//.test(canonical) ? canonical.toLowerCase() : canonical;
}

// A worktree's or submodule's `.git` is a file that points at the real git directory.
function gitConfigFile(dir) {
  const dotGit = path.join(dir, '.git');
  const stat = fs.statSync(dotGit);
  if (stat.isDirectory()) return path.join(dotGit, 'config');
  const pointer = fs.readFileSync(dotGit, 'utf8').match(/^gitdir:\s*(.+)$/m);
  if (!pointer) return null;
  const gitDir = path.resolve(dir, pointer[1].trim());
  let common = gitDir;
  try { common = path.resolve(gitDir, fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim()); } catch { common = gitDir; }
  return path.join(common, 'config');
}

/** The remote a clone came from (`origin`, else the first one it has), in the one spelling; null when it has none or is not a clone. */
function readCloneRemote(dir) {
  let text;
  try {
    const file = gitConfigFile(dir);
    if (!file || fs.statSync(file).size > MAX_GIT_CONFIG_BYTES) return null;
    text = fs.readFileSync(file, 'utf8');
  } catch { return null; }
  const remotes = new Map();
  let section = null;
  for (const line of text.split('\n')) {
    const header = line.match(/^\s*\[\s*remote\s+"([^"]+)"\s*\]/);
    if (header) { section = header[1]; continue; }
    if (/^\s*\[/.test(line)) { section = null; continue; }
    const url = section && line.match(/^\s*url\s*=\s*(.+?)\s*$/);
    if (url && !remotes.has(section)) remotes.set(section, url[1]);
  }
  for (const remote of [remotes.get('origin'), ...remotes.values()]) {
    const canonical = canonicalRemote(remote);
    if (canonical) return canonical;
  }
  return null;
}

/** A project's code directory that is a clone of `url`, if one is (the clones Engelbart already knows about without looking around the disk). */
function findProjectClone(ctx, url) {
  const key = repoKey(url);
  if (!key) return null;
  const home = fs.realpathSync(ctx.homeDir);
  for (const project of projects.projectRecords(ctx)) {
    if (!project.directory) continue;
    try {
      const real = fs.realpathSync(project.directory);
      if (real.startsWith(home + path.sep) && repoKey(readCloneRemote(real)) === key) return real;
    } catch { /* not there, not a clone */ }
  }
  return null;
}

const folderThere = (folder) => { try { return !!folder && fs.statSync(folder).isDirectory(); } catch { return false; } };

/* ------------------------------------------------------------------- adding */

// One resolver behind every way of adding (the field, a dropped file): an address or a path in,
// a library row out. Files and folders are linked where they are, never copied. `type` is read off
// the thing (a file's extension, `folder`, `website`) and nothing is guessed into it; what can be
// told from the address or from a `.git` goes into `tags`. `note` is never given here: only a note
// written in Engelbart has it (projects.createNote).
const ARXIV_RE = /^(?:arxiv:\s*|https?:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf)\/)?(\d{4}\.\d{4,5})(?:v\d+)?(?:\.pdf)?\/?$/i;
const DOI_RE = /^(?:doi:\s*|https?:\/\/(?:dx\.)?doi\.org\/)?(10\.\d{4,9}\/\S+)$/i;
const FILE_TYPES = new Map([['.md', 'md'], ['.markdown', 'md'], ['.pdf', 'pdf'], ['.html', 'html'], ['.htm', 'html'], ['.csv', 'csv'], ['.tsv', 'tsv'], ['.json', 'json'], ['.jsonl', 'jsonl'], ['.ndjson', 'jsonl'], ['.parquet', 'parquet'], ['.xlsx', 'xlsx'],
  // a picture on disk is linked where it is, like any file (a pasted one is copied into the project: projects.saveImage)
  ['.png', 'image'], ['.jpg', 'image'], ['.jpeg', 'image'], ['.gif', 'image'], ['.webp', 'image'], ['.heic', 'image'], ['.svg', 'image']]);
const TEXT_TYPES = new Set(['csv', 'tsv', 'json', 'jsonl']); // what the peek can show the first lines of
const tagged = (row, tag) => Array.isArray(row.tags) && row.tags.includes(tag);

// The category rules, one set for a thing being added and for a row that is already there
// (recategorize). Bump the number when a rule changes: every installed library then goes through
// the rules once more on its next open, and nothing else about its rows is touched.
const CATEGORY_RULES = 1;

/** What an address says by itself: arXiv and DOI are papers, a GitHub repository is a repository. */
function addressTags(url) {
  const value = String(url || '');
  if (ARXIV_RE.test(value) || DOI_RE.test(value)) return ['paper'];
  return GITHUB_RE.test(value) ? ['git'] : [];
}

/** What a row is, from where it is: a file's format, else a folder, else an address. A format the rules do not name keeps the type it has. */
function typeOfRow(row) {
  if (row.path) return FILE_TYPES.get(path.extname(row.path).toLowerCase()) || row.type;
  if (row.folder_path) return 'folder';
  return row.url ? 'website' : row.type;
}

function resolveAddition(input, { homeDir }) {
  if (typeof input !== 'string' || input.length > 4096 || input.includes('\0')) throw new TypeError('Paste a link or a path');
  let value = input.trim().replace(/^["'](.*)["']$/, '$1').trim();
  if (!value) throw new TypeError('Paste a link or a path');
  let match;
  const address = (name, url) => ({ type: 'website', tags: addressTags(url), name, url });
  if ((match = value.match(ARXIV_RE))) return address(`arXiv ${match[1]}`, `https://arxiv.org/abs/${match[1]}`);
  if ((match = value.match(DOI_RE))) return address(`doi ${match[1]}`, `https://doi.org/${match[1]}`);
  if ((match = value.match(GITHUB_RE))) return address(`${match[1]}/${match[2]}`, `https://github.com/${match[1]}/${match[2]}`);
  // any other spelling of a remote (ssh://, git://, git@host:group/tool.git, https://host/tool.git)
  if (/^(?:ssh|git):\/\/|^[\w.-]+@[\w.-]+:|^https?:\/\/\S+\.git\/?$/i.test(value) && canonicalRemote(value)) {
    const url = canonicalRemote(value);
    const github = url.match(GITHUB_RE);
    return { type: 'website', tags: ['git'], name: github ? `${github[1]}/${github[2]}` : url.replace(/^https:\/\/[^/]+\//, ''), url };
  }
  if (/^https?:\/\//i.test(value)) {
    let url;
    try { url = new URL(value); } catch { throw new TypeError('That link is not a valid address'); }
    const shown = (url.host.replace(/^www\./, '') + url.pathname).replace(/\/+$/, '');
    return { type: 'website', tags: [], name: shown.slice(0, 200), url: url.href };
  }
  if (/^file:\/\//i.test(value)) value = fileURLToPath(value);
  if (value === '~' || value.startsWith('~/')) value = path.join(homeDir, value.slice(1));
  if (!path.isAbsolute(value)) throw new TypeError('Paste a link, or a path that starts with / or ~/');
  let resolved;
  try { resolved = fs.realpathSync(value); } catch { throw new Error('Nothing is at that path'); }
  const homeReal = fs.realpathSync(homeDir);
  if (!resolved.startsWith(homeReal + path.sep)) throw new Error('Only files inside your home directory can be added');
  const stat = fs.statSync(resolved);
  const base = path.basename(resolved);
  const extension = path.extname(resolved).toLowerCase();
  if (stat.isDirectory()) {
    if (!fs.existsSync(path.join(resolved, '.git'))) return { type: 'folder', tags: [], name: base, folder_path: resolved };
    // a clone is the same repository as its address: same name, and the address comes with it
    const url = readCloneRemote(resolved);
    const github = url && url.match(GITHUB_RE);
    return { type: 'folder', tags: ['git'], name: github ? `${github[1]}/${github[2]}` : base, folder_path: resolved, ...(url ? { url } : {}) };
  }
  if (!stat.isFile()) throw new Error('That is not a file or a folder');
  const type = FILE_TYPES.get(extension);
  if (type === 'pdf') return { type, tags: [], name: path.basename(resolved, path.extname(resolved)), path: resolved }; // whether it is a paper is for whoever reads it (addItem's inspectPdf)
  if (type === 'html') return { type, tags: [], name: base, path: resolved, url: pathToFileURL(resolved).href };
  if (type) return { type, tags: [], name: base, path: resolved };
  throw new Error(`Engelbart does not know what a ${extension || 'file without an extension'} is yet`);
}

/**
 * The row that already is what `found` (resolveAddition's answer) names, or null. A repository is
 * one row whatever its spelling: the same GitHub id (`who`, when GitHub was asked) is the same
 * repository; without an id on both sides the address decides (a clone added before remotes were
 * read has no url: it is read now) — but never against a row that has a *different* id: that name
 * was taken over. Anything else is the same file, the same folder, or the same address.
 */
function sameAs(rows, found, who = null) {
  if (tagged(found, 'git') && found.url) {
    const key = repoKey(found.url);
    const addressOf = (row) => repoKey(row.url || (row.folder_path ? readCloneRemote(row.folder_path) : null));
    const repo = (who && rows.find((row) => row.github_id === who.id))
      || rows.find((row) => tagged(row, 'git') && (!who || !row.github_id) && addressOf(row) === key);
    if (repo) return repo;
  }
  // A repository with an id was matched by it above; an address equal to another row's is then a different repository.
  const page = !found.path && !found.folder_path && !found.github_id && found.url ? pageKey(found.url) : null;
  return rows.find((row) => (found.path && row.path === found.path) || (found.folder_path && row.folder_path === found.folder_path) || (page && !row.path && row.url && pageKey(row.url) === page)) || null;
}

/**
 * What two spellings of one page share: `http` or `https`, with or without `www.`, a trailing slash, a #fragment. The
 * query stays — `?id=2` can be another page. Anything that is not a web address is itself.
 */
function pageKey(url) {
  let u;
  try { u = new URL(url); } catch { return String(url || ''); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return u.href;
  return `${u.host.toLowerCase().replace(/^www\./, '')}${u.pathname.replace(/\/+$/, '')}${u.search}`;
}

/**
 * A repository that is already a row can still teach the row something when its other half is
 * added: the clone of a row known by its address (or the address of a clone), the id GitHub gives
 * it, the name it has since a rename, the place a moved clone is now (spec §2 #56, #57). A name
 * given by hand is kept: only a name that was the old owner/name is brought up to date.
 */
async function learnRepo(ctx, repo, found, who) {
  const was = repo.url && repo.url.match(GITHUB_RE);
  const next = {
    name: who && was && repo.name.toLowerCase() === `${was[1]}/${was[2]}`.toLowerCase() ? who.fullName : repo.name,
    url: who ? who.url : (repo.url || found.url),
    folder_path: found.folder_path && (!folderThere(repo.folder_path) || repo.folder_path === found.folder_path) ? found.folder_path : repo.folder_path,
    github_id: repo.github_id || (who ? who.id : null),
  };
  const learned = Object.keys(next).some((field) => (next[field] || null) !== (repo[field] || null));
  return learned ? ctx.libraryDb.updateRepo(repo.id, next) : repo;
}

/** What adding something the library already holds throws. The message names the row as the library calls it. */
function alreadyThere(row) {
  const error = new Error(`Already in the library as “${row.name}”`);
  error.code = 'EXISTS';
  error.row = row;
  return error;
}

/**
 * What an address or a path would be in the library, asked without adding it and without the
 * network: `row`, the row that already is that thing, or null; `found`, what the resolver makes of
 * it; `error`, why it cannot be added (nothing at that path, a format Engelbart does not read). The
 * Browser's Save button and the sidebar's search ask this.
 */
async function lookupItem(ctx, input) {
  let found;
  try { found = resolveAddition(input, { homeDir: ctx.homeDir }); } catch (error) { return { row: null, found: null, error: error.message }; }
  return { row: sameAs(await ctx.libraryDb.list(), found), found, error: null };
}

/**
 * Adds what the address or path names as a new row. Something the library already holds is not
 * added twice: that throws (`code: 'EXISTS'`, "Already in the library as “…”", 2026-09-22). The
 * only thing such an add still does is what learnRepo says: a repository's row learns its clone,
 * its id or its new name, since that is the same row knowing more, not a second one.
 * A page is asked for its own title and description (`describe`), a GitHub repository for who it
 * is (`identifyRepo`), both best effort; the description becomes the row's summary. A pdf is read
 * for whether it is a paper (`inspectPdf`, which answers with its tags); one that cannot be read is
 * added all the same and left due for recategorize. `name`, when given, is what the row is called
 * (the Browser's Save card lets the person name the page).
 */
async function addItem(ctx, input, { describe, identifyRepo, inspectPdf, name: given = null } = {}) {
  const found = resolveAddition(input, { homeDir: ctx.homeDir });
  const rows = await ctx.libraryDb.list();
  let about = null, who = null;
  if (tagged(found, 'git') && found.url) {
    const github = found.url.match(GITHUB_RE);
    if (github && identifyRepo) { try { who = await identifyRepo(github[1], github[2]); } catch { who = null; } }
    if (who) Object.assign(found, { github_id: who.id, url: who.url, name: who.fullName });
  }
  const same = sameAs(rows, found, who);
  if (same) throw alreadyThere(tagged(found, 'git') && tagged(same, 'git') ? await learnRepo(ctx, same, found, who) : same);
  if (tagged(found, 'git') && found.url) {
    if (!found.folder_path) {
      found.folder_path = findProjectClone(ctx, found.url);
      if (found.folder_path) found.type = 'folder'; // a repository that has a folder is a folder (db.updateRepo keeps the same rule)
    }
    if (who) about = { title: '', description: who.description };
  }
  const page = found.type === 'website' && !found.tags.length; // a plain page: it names and describes itself
  if (describe && page) {
    try { about = await describe(found); } catch { about = null; }
  }
  const title = about && typeof about.title === 'string' ? about.title.replace(/\s+/g, ' ').trim().slice(0, 200) : '';
  const named = typeof given === 'string' ? given.replace(/\s+/g, ' ').trim().slice(0, 200) : '';
  // Everything but a pdf is fully categorized by the resolver; a pdf is once it has been read.
  let row = await ctx.libraryDb.insert({ id: randomUUID(), name: named || (page && title ? title : found.name), type: found.type, tags: found.tags, path: found.path || null, url: found.url || null, folder_path: found.folder_path || null, project_id: null, github_id: found.github_id || null, categorized: found.type === 'pdf' ? null : CATEGORY_RULES });
  if (inspectPdf && row.type === 'pdf') {
    try { row = await ctx.libraryDb.setCategory(row.id, { type: row.type, tags: await inspectPdf(row.path) }, CATEGORY_RULES); } catch { /* not readable now: recategorize tries again */ }
  }
  const description = about && typeof about.description === 'string' ? about.description.replace(/\s+/g, ' ').trim().slice(0, 1200) : '';
  if (description) return ctx.libraryDb.setSummary(row.id, description, new Date());
  return row;
}

/* ------------------------------------------------------------ re-categorizing */

const within = (promise, ms) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('timed out')), ms);
  Promise.resolve(promise).then(resolve, reject).finally(() => clearTimeout(timer));
});

/**
 * Brings every row that is behind CATEGORY_RULES up to them: a library from before the rules (its
 * types converted by db.cjs), a row made under older rules, a pdf that could not be read when it
 * was added. Each row is put through what + Add would tell about it today, from the thing itself —
 * its address, whether its folder has a `.git`, and for a pdf its content (`inspectPdf`) — and is
 * then marked, so this happens once per row per set of rules.
 *
 * It writes `type`, `tags` and `categorized`, and nothing else: no summary is cleared, made stale
 * or asked for again, and `last_edited` stays. A tag is only ever added: what showed that a row is
 * a repository may no longer be on it (a `git@host:…` spelling), and a folder or file that is not
 * there now says nothing either way. A pdf that is not there (a disk that is not mounted) or that
 * nobody here can read (no `inspectPdf`) stays due; one that is there and cannot be read, or whose
 * reader does not answer within `inspectTimeoutMs`, is settled without a tag, so that no file can
 * hold the library shut or be parsed at every launch.
 */
async function recategorize(ctx, { inspectPdf = null, inspectTimeoutMs = 15_000 } = {}) {
  const report = { changed: [], due: 0 };
  await ctx.libraryDb.settleUninferable(CATEGORY_RULES);
  for (const row of await ctx.libraryDb.uncategorized(CATEGORY_RULES)) {
    const type = typeOfRow(row);
    const tags = new Set([...row.tags, ...addressTags(row.url)]);
    if (row.github_id) tags.add('git');
    if (row.folder_path && fs.existsSync(path.join(row.folder_path, '.git'))) tags.add('git');
    let settled = true;
    if (type === 'pdf') {
      if (!inspectPdf || !fs.existsSync(row.path)) settled = false;
      else { try { for (const tag of await within(inspectPdf(row.path), inspectTimeoutMs)) tags.add(tag); } catch { /* not readable as a pdf */ } }
    }
    const next = LIBRARY_TAGS.filter((tag) => tags.has(tag));
    const differs = type !== row.type || next.length !== row.tags.length;
    if (differs || settled) await ctx.libraryDb.setCategory(row.id, { type, tags: next }, settled ? CATEGORY_RULES : null);
    if (differs) report.changed.push({ id: row.id, name: row.name, type, tags: next });
    if (!settled) report.due += 1;
  }
  return report;
}

/* ------------------------------------------------------------------ the peek */

const PEEK_CHARS = 6000;
const PEEK_FILES = 40;
const inside = (file, dir) => file === dir || file.startsWith(dir + path.sep);

/**
 * What hovering a library row shows beyond the row itself: an md's text, a data file's first lines,
 * a repository's top-level files (from the clone, else asked of GitHub through `listRemoteFiles`),
 * and the projects and workspaces that hold it.
 */
async function previewItem(ctx, id, { listRemoteFiles } = {}) {
  if (typeof id !== 'string' || !UUID_RE.test(id)) throw new TypeError('library id is invalid');
  const row = await ctx.libraryDb.get(id);
  if (!row) throw new Error('Unknown library item');
  const out = { id: row.id, text: null, lines: null, files: null, owner: null, folder: null, folderMissing: null, heldBy: await projectsForLibraryItem(ctx, row.id) };
  const home = fs.realpathSync(ctx.homeDir);
  const readable = (file) => { try { const real = fs.realpathSync(file); return inside(real, home) ? real : null; } catch { return null; } };
  if (row.type === 'md' && row.path) {
    const file = readable(row.path);
    if (file) { try { out.text = fs.readFileSync(file, 'utf8').slice(0, PEEK_CHARS); } catch { out.text = null; } }
  } else if (TEXT_TYPES.has(row.type) && row.path) {
    const file = readable(row.path);
    try {
      if (file && fs.statSync(file).size <= 2 * 1024 * 1024) out.lines = fs.readFileSync(file, 'utf8').slice(0, PEEK_CHARS).split('\n').slice(0, 12);
    } catch { out.lines = null; }
  }
  let folder = row.folder_path ? readable(row.folder_path) : null;
  if (!folder && tagged(row, 'git') && row.url) {
    // No clone on the row, or the one it had is gone: a project may be working in one. It is remembered.
    folder = findProjectClone(ctx, row.url);
    if (folder) await ctx.libraryDb.updateRepo(row.id, { name: row.name, url: row.url, folder_path: folder, github_id: row.github_id });
  }
  const tilde = (value) => (inside(value, home) ? `~${value.slice(home.length)}` : value);
  // The folder was deleted, moved, or is on a disk that is not mounted: the row stays and says so.
  if (!folder && row.folder_path) out.folderMissing = tilde(row.folder_path);
  if (folder) {
    out.folder = tilde(folder);
    try {
      out.files = fs.readdirSync(folder, { withFileTypes: true })
        .filter((entry) => entry.name !== '.git' && entry.name !== '.DS_Store')
        .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
        .slice(0, PEEK_FILES)
        .map((entry) => entry.name + (entry.isDirectory() ? '/' : ''));
    } catch { out.files = null; }
  }
  const github = tagged(row, 'git') && row.url ? row.url.match(GITHUB_RE) : null;
  if (github) {
    out.owner = github[1];
    if (!out.files && listRemoteFiles) { try { out.files = await listRemoteFiles(github[1], github[2]); } catch { out.files = null; } }
  }
  return out;
}

module.exports = { seedIfEmpty, listLibrary, readLibraryFile, readAnnotations, writeAnnotations, projectsForLibraryItem, libraryForProject, canonicalRemote, readCloneRemote, resolveAddition, addressTags, addItem, lookupItem, recategorize, CATEGORY_RULES, previewItem };
