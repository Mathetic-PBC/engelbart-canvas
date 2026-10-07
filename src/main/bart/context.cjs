'use strict';

// What one @bart question carries (2026-09-19): the workspace document, the note the question
// was asked from when it was asked from a note, every mentioned note in full at the place it is
// mentioned (../context/expand-mentions.cjs), the library as Context.json with a `mentioned`
// flag per item, and where things are on disk so the agent's own file tools can open the rest.
// A follow-up carries all of that again, read again, and the earlier turns of its exchange as well.
// A question asked from a note on a pdf highlight (MATH-27) carries the passage as <highlight>, and the workspace the
// Stage was opened from as background (paperOf, highlightBlock). Since 2026-10-06 it carries the text of the highlighted
// page around the passage too (<page_text>, pdf.js's, about 4,000 characters), so Bart need not open the pdf for it.
// An @bart question also carries the person's pdf highlights (MATH-27, 2026-10-06, ./highlights.cjs): <stage>, the paper
// in front in the Stage with the page in view, and <highlights>, the pdfs the documents mention, each with its notes and
// Bart's answers there. A paper both open and mentioned is in <stage> alone.
// A web page is read the same way (MATH-54, 2026-10-06): in front in the Stage it is <stage source="web">, its title and
// address and its highlights; a saved page the documents mention is in <highlights>; a question asked from a highlight
// on one has <highlight source="web">.
// MATH-54 follow-up (2026-10-06): every @bart turn carries both as they are now, a resumed one too (`now`), and
// <stage>none</stage> when nothing is in front.
// MATH-54 build 3a (2026-10-06): a web page in front also gives what the person has selected on it as it is now
// (<selection>, read from the tab's page in front, never saved) and a picture of it (<screenshot path="…"/>, ./shots.cjs).
// `live` ({ selection(), screenshot() }, ipc.cjs from browser/views.cjs) reaches the tab; a page that does not answer in
// time has no selection, a picture that fails is left out.
// MATH-65 build 2 (2026-10-07): a mentioned Zotero item is its <zotero_item> under the line (../context/expand-mentions.cjs),
// its attachment's folder granted when it is outside the data root; and every @bart and @discover turn's <engelbart>
// names the mirror of the connected library (`zotero library: …`, ../zotero/mirror.cjs pointerLine) when there is one.
// MATH-65, Overleaf part 1 (2026-10-07): `overleaf` (../overleaf/stage.cjs forTurn) is the window's Overleaf tabs. The one
// in front is <stage source="overleaf"> in place of the web page's, with the open file read live from its editor and the
// folder of the project's copy (refreshed before the turn when over a minute old); every other is a line of
// <overleaf_tabs> after <stage>. Both are in `now`. Started first: a download runs while the documents are read.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const projects = require('../store/projects.cjs');
const { buildCatalog } = require('../context/catalog.cjs');
const { expandDoc } = require('../context/expand-mentions.cjs');
const { PENDING_RE } = require('./reply.cjs');
const { stripAgentReplies } = require('./strip.cjs');
const db = require('../store/db.cjs');
const { instructionsBlock } = require('../store/onboarding.cjs');
const library = require('../store/library.cjs');
const { attrOf, stageBlock, webStageBlock, mentionedBlock } = require('./highlights.cjs');
const { fileInRow } = require('../store/folder-files.cjs');
const { saveShot } = require('./shots.cjs');
const zoteroMirror = require('../zotero/mirror.cjs');
const { overleafStageBlock, overleafTabsBlock } = require('../overleaf/stage.cjs');

const HERE = '<<< this is the question being asked now >>>';
// @bart's <stage> with nothing in front, and a resumed turn's <highlights> when the documents mention nothing highlighted.
const NO_STAGE = '<stage>none</stage>';
const NO_HIGHLIGHTS = '<highlights>none</highlights>';
// How long a turn waits on the page in front for its selection and for its picture (MATH-54 build 3a).
const SELECTION_WAIT_MS = 300;
const SHOT_WAIT_MS = 2000;

/** What `ask()` gives within `ms`, else null; null as well when it throws. */
async function inTime(ask, ms) {
  let timer;
  try {
    return await Promise.race([Promise.resolve().then(ask), new Promise((resolve) => { timer = setTimeout(() => resolve(null), ms); })]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** The pending line of this question marks its place; the pending lines of other questions are noise. */
function markPlace(text, askId) {
  return String(text || '').split('\n').flatMap((line) => {
    const pending = line.match(PENDING_RE);
    if (!pending) return [line];
    return pending[1] === askId ? [HERE] : [];
  }).join('\n');
}

/**
 * The earlier turns of the exchange a follow-up continues, as the document holds them now: the person may have edited
 * an answer or deleted a turn since, and what stands in the document is what was said.
 */
function conversationBlock(turns) {
  if (!turns.length) return '';
  const said = turns.map((turn, n) => `<turn n="${n + 1}">\n<asked>\n${turn.question}\n</asked>\n<answered>\n${turn.answer}\n</answered>\n</turn>`);
  return `<conversation>\n${said.join('\n')}\n</conversation>`;
}

const block = (tag, name, text) => `<${tag} name="${String(name).replace(/[<>"\n\r]/g, ' ').slice(0, 200)}">\n${text}\n</${tag}>`;

// The agents that read where the person is from this workspace alone (2026-09-30, round 3): its own library and none of
// the other agents' answers.
const SCOPED = new Set(['brainstorm']);

/**
 * The library's entries an agent may be shown. @brainstorm's (SCOPED): this workspace's alone, what its
 * sidebar holds (its context and the notes made in it, less what was thrown away) and whatever the document mentions.
 * Everyone else's: the whole project's. `scope` { agent, workspace, own } — `own` the ids of the notes made in it.
 */
function catalogFor(project, rows, seen, { agent = 'bart', workspace = null, own = [] } = {}) {
  if (!SCOPED.has(agent) || !workspace) return buildCatalog(project, projects.flattenWorkspaces(project.dir), rows, null).entries;
  const removed = new Set(workspace.removed || []);
  const held = new Set([...workspace.context, ...own].filter((id) => !removed.has(id)));
  for (const id of seen) held.add(id);
  const here = { id: workspace.id, name: workspace.name, path: workspace.name, context: [...held] };
  return buildCatalog(project, [here], rows.filter((row) => held.has(row.id)), null).entries;
}

/**
 * The library as the agent is shown it (Context.json): every item but pictures, `mentioned` when `seen` holds it. The
 * whole project's, or for @brainstorm this workspace's alone (catalogFor). A folder's `path` is the folder itself
 * (MATH-22, MF-06): it was null, and an agent told to open a mentioned folder had nowhere to look.
 */
function catalogEntries(project, rows, seen, scope) {
  return catalogFor(project, rows, seen, scope).filter((entry) => entry.type !== 'image').map((entry) => ({
    name: entry.name,
    type: entry.type,
    tags: entry.tags,
    path: entry.path ? path.resolve(project.dir, entry.path) : entry.folderPath ? path.resolve(entry.folderPath) : null,
    url: entry.url,
    summary: entry.summaryStale ? null : entry.summary,
    lastEdited: entry.lastEdited,
    mentioned: seen.has(entry.id),
  }));
}

/**
 * The files inside library folders the documents mention (MATH-22, MF-06), read back from `seen` (expand-mentions.cjs
 * fileKey) → [{ path, folder, exists }], `path` absolute, `folder` its folder's name. A folder no longer in the library, or
 * a path that leaves its folder, is left out.
 */
function mentionedFiles(rows, seen, homeDir = os.homedir()) {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const out = [];
  for (const key of seen) {
    const m = typeof key === 'string' ? /^file:([\w-]+):(.+)$/s.exec(key) : null;
    const row = m && byId.get(m[1]);
    if (!row || !row.folder_path) continue;
    try { const found = fileInRow(row, m[2], homeDir); out.push({ path: found.path, folder: row.name, exists: found.exists }); } catch { /* outside its folder */ }
  }
  return out;
}

/** <mentioned_files>, the list mentionedFiles gives, as JSON; '' when there are none. */
function mentionedFilesBlock(files) {
  return files.length ? `<mentioned_files>\n${JSON.stringify(files, null, 1)}\n</mentioned_files>` : '';
}

// The agents told where the Zotero mirror is (MATH-65 build 2): those that answer about the library. @brainstorm reads this
// workspace alone.
const ZOTERO_READERS = new Set(['bart', 'discover']);
/** The files of the Zotero items the documents mention, kept in `seen` by expand-mentions.cjs → [{ dir }]. */
const zoteroFiles = (seen) => [...seen].filter((key) => typeof key === 'string' && key.startsWith('zfile:')).map((key) => ({ dir: path.dirname(key.slice(6)) }));

// The agents that may open the library's own files (2026-09-30, MB-06): the folders those files are in join the
// --add-dir list, read-only like the rest. @bart too since 2026-10-02 (a paper in ~/Downloads was out of its reach).
// @brainstorm opens the paper a line mentions (2026-10-05).
const LIBRARY_READERS = new Set(['bart', 'brainstorm', 'discover']);
const MAX_LIBRARY_DIRS = 24;
const within = (dir, root) => { const inside = path.relative(root, dir); return inside === '' || (!inside.startsWith('..') && !path.isAbsolute(inside)); };

/**
 * The folders to grant so the library's files can be opened: each file's folder, and a folder item itself. Never the
 * home folder or the disk's root (a file straight in either is left out), nothing already granted or inside another
 * one, nothing that is gone.
 */
function libraryDirs(project, rows, granted, { home = os.homedir(), seen = new Set(), scope } = {}) {
  const wanted = [];
  for (const entry of catalogFor(project, rows, seen, scope)) {
    if (entry.type === 'image') continue;
    const dir = entry.folderPath ? path.resolve(entry.folderPath) : entry.path ? path.dirname(path.resolve(project.dir, entry.path)) : null;
    if (!dir || dir === path.parse(dir).root || dir === path.resolve(home) || granted.some((root) => within(dir, root))) continue;
    try { if (!fs.statSync(dir).isDirectory()) continue; } catch { continue; }
    wanted.push(dir);
  }
  const out = [];
  for (const dir of [...new Set(wanted)].sort((a, b) => a.length - b.length)) if (!out.some((root) => within(dir, root))) out.push(dir);
  return out.slice(0, MAX_LIBRARY_DIRS);
}

// A question asked from a note on a pdf highlight (MATH-27, 2026-10-06): the passage is a block of its own, the workspace it
// was opened from comes along as background. The paper is the library's row (`ref.rowId`), else the address its ink is
// kept by (`ref.url`): a file:// address is given as its path, which the agent's file tools open.

/** The paper a highlight is on → { id, name, where, dir }: `where` its absolute path or its address, `dir` a folder to grant. */
function paperOf(project, rows, ref, given = {}) {
  const row = ref.rowId ? rows.find((r) => r.id === ref.rowId) : rows.find((r) => r.url && r.url === ref.url);
  let where = row ? (row.path ? path.resolve(project.dir, row.path) : row.url || '') : String(ref.url || '');
  if (/^file:/i.test(where)) { try { where = fileURLToPath(where); } catch { /* left as it is */ } }
  const local = where && path.isAbsolute(where) ? where : null;
  const named = row ? row.name : given.paper || (local ? path.basename(local) : String(where).replace(/[?#].*$/, '').split('/').filter(Boolean).pop() || 'a pdf');
  return { id: row ? row.id : null, name: named, where, dir: local ? path.dirname(local) : null };
}

/**
 * <highlight paper="…" path="…" page="N"><quote>…</quote><note>…</note><page_text>…</page_text></highlight>; no <page_text>
 * when there is none. On a web page (`paper.source` 'web', MATH-54): <highlight source="web" title="…" address="…" path="…">,
 * no page.
 */
function highlightBlock(paper, page, { quote = '', note = '', pageText = '' } = {}) {
  const around = String(pageText || '').trim();
  const on = paper.source === 'web'
    ? `source="web" title="${attrOf(paper.name, 200)}" address="${attrOf(paper.address, 4096)}"${paper.path ? ` path="${attrOf(paper.path, 4096)}"` : ''}`
    : `paper="${attrOf(paper.name, 200)}" path="${attrOf(paper.where, 4096)}" page="${Number(page) || 1}"`;
  return `<highlight ${on}>\n<quote>\n${String(quote).trim()}\n</quote>\n<note>\n${String(note).trim()}\n</note>\n${around ? `<page_text>\n${around}\n</page_text>\n` : ''}</highlight>`;
}

/**
 * The web page a highlight or the Stage is on (MATH-54; `ref`: { rowId } or { url }) → { source: 'web', id, name,
 * address, path, dir }: the library's row when it holds the page (by the address however spelled, or a saved copy by its
 * file), named as the library names it, else `title`, else its address. `address` is where it is on the web, `path` a
 * copy on disk (a saved page's index.html, a local html file), `dir` the folder of a copy the library does not hold.
 */
async function webPageOf(ctx, project, rows, ref, title = '') {
  let row = ref.rowId ? rows.find((r) => r.id === ref.rowId) || null : null;
  if (!row && ref.url) { try { row = (await library.lookupItem(ctx, ref.url)).row; } catch { row = null; } }
  const url = row ? row.url || '' : String(ref.url || '');
  let file = row && row.path ? path.resolve(project.dir, row.path) : '';
  if (!file && /^file:/i.test(url)) { try { file = fileURLToPath(url); } catch { file = ''; } }
  const address = /^file:/i.test(url) ? '' : url;
  const named = (row && row.name) || String(title || '').trim() || address || (file ? path.basename(file) : 'a web page');
  return { source: 'web', id: row ? row.id : null, name: named, address, path: file, dir: file && !row ? path.dirname(file) : null };
}

// The ink a paper has, and the file it is read from (the annotations attribute: Bart reads it again for a follow-up). A
// library row's own, else the ink kept by the pdf's address (store/library.cjs). Ink that cannot be read is none.
// `inkRoot`, the annotations folder, is where a box's picture is found from (MATH-70, highlights.cjs).
async function inkOf(ctx, where) {
  const inkRoot = path.join(ctx.dataRoot, 'annotations');
  try {
    const ink = where.rowId ? await library.readAnnotations(ctx, where.rowId) : await library.readPageAnnotations(ctx, where.url);
    return { ink, annotations: await library.annotationsFileOf(ctx, where), inkRoot };
  } catch {
    return { ink: null, annotations: '', inkRoot };
  }
}

/** The pdf in front in the Stage (`stage` { rowId, url, page }) → paperOf's, with its ink and ink file. */
async function stagePaper(ctx, project, rows, stage) {
  const ref = { rowId: stage.rowId || null, url: stage.url || null };
  if (!ref.rowId && !ref.url) return null;
  const paper = paperOf(project, rows, ref);
  return { ...paper, ...(await inkOf(ctx, paper.id ? { rowId: paper.id } : ref.url ? { url: ref.url } : { rowId: ref.rowId })) };
}

/**
 * What `live` ({ selection(), screenshot() }) gives of the page in front for turn `askId` → { selection, screenshot }: the
 * selection ({ quote, pageText }) unless `selecting` is off, and the picture saved as the turn's (./shots.cjs), its path.
 * Each is null or '' when the page does not answer in time, has none, or the picture cannot be kept.
 */
async function livePage(ctx, live, askId, { selecting = true } = {}) {
  if (!live) return { selection: null, screenshot: '' };
  const [selection, png] = await Promise.all([
    selecting && live.selection ? inTime(() => live.selection(), SELECTION_WAIT_MS) : null,
    live.screenshot ? inTime(() => live.screenshot(), SHOT_WAIT_MS) : null,
  ]);
  const quoted = selection && selection.quote && typeof selection.quote.exact === 'string' && selection.quote.exact.trim() ? selection : null;
  return { selection: quoted, screenshot: (png && saveShot(ctx.dataRoot, askId, png)) || '' };
}

/**
 * The web page in front in the Stage (`stage` { url, title }, MATH-54) → webPageOf's, with its ink and ink file ('' for a
 * preview's), and livePage's selection and screenshot (`live`, build 3a).
 */
async function stageWebPage(ctx, project, rows, stage, { live = null, askId = '', selecting = true } = {}) {
  const [page, now] = await Promise.all([webPageOf(ctx, project, rows, { url: stage.url }, stage.title), livePage(ctx, live, askId, { selecting })]);
  if (!page.address && !page.path) page.address = stage.url;
  return { ...page, ...(await inkOf(ctx, page.id ? { rowId: page.id } : { url: stage.url })), ...now };
}

// A library row that may be a pdf: one, or an address saved before the Stage kept a copy (store/web-pdfs.cjs).
const mayBePdf = (row) => row.type === 'pdf' || (row.type === 'website' && ((row.tags || []).includes('paper') || /\.pdf(?:$|[?#])/i.test(row.url || '')));
// A library row that is a web page (MATH-54): a page saved as itself (html), or one kept by its address; not a repository.
const isWebPage = (row) => !mayBePdf(row) && !(row.tags || []).includes('git') && (row.type === 'html' || row.type === 'website');

/**
 * The mentioned library rows that are pdfs → [{ name, where, annotations, ink }], and those that are web pages →
 * [{ source: 'web', name, address, path, annotations, ink }]; mentionedBlock leaves out those without highlights.
 */
async function mentionedPapers(ctx, project, rows) {
  const out = [];
  for (const row of rows.filter((r) => mayBePdf(r) || isWebPage(r))) {
    const item = mayBePdf(row) ? paperOf(project, rows, { rowId: row.id }) : await webPageOf(ctx, project, rows, { rowId: row.id });
    out.push({ ...item, ...(await inkOf(ctx, { rowId: row.id })) });
  }
  return out;
}

/**
 * → { project, dirs, head, contextJson, mentionedFiles, files, documents, now, entries, workspaceName }. `head`,
 * `mentionedFiles` (<mentioned_files>, MATH-22; '' with none) and the documents are text; the caller adds the level and
 * the question (./ask.cjs), which differ per step. `now`: @bart's <stage> and <highlights> alone, what a resumed turn is
 * sent ('' for the other agents). `entries` (the library as Context.json
 * holds it) and `workspaceName` are for the fake agents, which name what a real one would read.
 */
async function buildContext(ctx, projectId, { ref, workspaceId, askId, agent = 'bart', highlight = null, stage = null, live = null, overleaf = null }) {
  const overleafRun = agent === 'bart' && typeof overleaf === 'function' ? Promise.resolve().then(() => overleaf(ctx)).catch(() => null) : null;
  const found = projects.findWorkspace(ctx, projectId, workspaceId);
  const { project, workspace } = found;
  const rows = await ctx.libraryDb.list();
  const seen = new Set();
  const documents = [];
  // @brainstorm reads where the person is from what they wrote: other agents' answers are taken out, its own threads
  // stay (./strip.cjs).
  const scoped = SCOPED.has(agent);
  const shown = (body) => markPlace(scoped ? stripAgentReplies(body, agent) : body, askId);
  let from = `the workspace "${workspace.name}"`;
  let paper = null, pointed = null;
  if (ref.kind === 'mark') {
    const space = await expandDoc(ctx, projectId, { kind: 'workspace', workspaceId }, { seen });
    const web = ref.source === 'web'; // a highlight on a web page (MATH-54): no page
    paper = web ? await webPageOf(ctx, project, rows, ref, (highlight && highlight.paper) || '') : paperOf(project, rows, ref, highlight || {});
    if (paper.id && !seen.has(paper.id)) { seen.add(paper.id); pointed = paper.id; } // the paper is what the person points at
    documents.push(block('workspace', space.title, shown(space.body)), highlightBlock(paper, ref.page, highlight || {}));
    from = web ? `a highlight on the web page "${attrOf(paper.name, 200)}", opened from the workspace "${workspace.name}"`
      : `a highlight on page ${Number(ref.page) || 1} of "${attrOf(paper.name, 200)}", opened from the workspace "${workspace.name}"`;
  } else if (ref.kind === 'note') {
    // The note is its own block: the workspace must not also carry it as a mention.
    seen.add(ref.id);
    const space = await expandDoc(ctx, projectId, { kind: 'workspace', workspaceId }, { seen });
    const note = await expandDoc(ctx, projectId, ref, { seen });
    documents.push(block('workspace', space.title, shown(space.body)), block('note', note.title, shown(note.body)));
    from = `the note "${note.title}", opened from the workspace "${workspace.name}"`;
  } else {
    const space = await expandDoc(ctx, projectId, ref, { seen });
    documents.push(block('workspace', space.title, shown(space.body)));
  }
  // @bart sees the person's highlights: the pdf or web page in front in the Stage (<stage>none</stage> when nothing is,
  // MATH-54 follow-up; a web page with its selection and picture, build 3a), then the ones the documents mention. `now` is the two again for a resumed session, whose own
  // copies are as they were when it started (./ask.cjs firstMessage): <highlights>none</highlights> when none has any.
  // An Overleaf editor in front (MATH-65) is its own <stage>: its picture is taken, the page's selection is the editor's.
  const projectsOpen = overleafRun ? await overleafRun : null;
  const overleafFront = projectsOpen && projectsOpen.front ? projectsOpen.front : null;
  const inFront = agent === 'bart' && stage && !overleafFront ? { pdf: stagePaper, web: stageWebPage }[stage.kind] : null;
  // A question asked from a highlight is about the highlight: the page's selection is not asked for, its picture is.
  const front = inFront ? await inFront(ctx, project, rows, stage, { live, askId, selecting: ref.kind !== 'mark' }) : null;
  let now = '';
  if (agent === 'bart') {
    let staged = overleafFront ? overleafStageBlock(overleafFront, { screenshot: (await livePage(ctx, live, askId, { selecting: false })).screenshot })
      : !front ? NO_STAGE : front.source === 'web' ? webStageBlock(front, front.ink) : stageBlock(front, stage.page, front.ink);
    const otherProjects = projectsOpen ? overleafTabsBlock(projectsOpen.background) : '';
    if (otherProjects) staged = `${staged}\n${otherProjects}`;
    const mentioned = await mentionedPapers(ctx, project, rows.filter((row) => seen.has(row.id) && row.id !== pointed && !(front && front.id === row.id)));
    const marked = mentionedBlock(mentioned);
    documents.push(staged, ...(marked ? [marked] : []));
    now = `${staged}\n\n${marked || NO_HIGHLIGHTS}`;
  }
  const own = scoped ? (await (await db.openNotesDb(project.dir)).list()).filter((note) => note.topic_id === workspace.id).map((note) => note.id) : [];
  const scope = { agent, workspace, own };
  const entries = catalogEntries(project, rows, seen, scope);
  const head = [
    '<engelbart>',
    `project: ${project.name}`,
    ...(project.description ? [`project description: ${project.description.replace(/\s+/g, ' ')}`] : []),
    `code directory: ${project.directory || 'none set'}`,
    `notes and workspaces: ${project.dir}`,
    `asked from: ${from}`,
    ...(ZOTERO_READERS.has(agent) && ctx.dataRoot ? [zoteroMirror.pointerLine(zoteroMirror.mirrorDir(ctx.dataRoot))].filter(Boolean) : []),
    '</engelbart>',
    instructionsBlock(ctx.dataRoot),
  ].filter(Boolean).join('\n');
  const granted = [project.directory, ctx.dataRoot].filter(Boolean);
  const dirs = LIBRARY_READERS.has(agent) ? [...granted, ...libraryDirs(project, rows, granted, { seen, scope })] : granted;
  // A pdf opened from disk that the library does not hold (the highlight's, the Stage's): its folder too, by the same rules
  // as the library's.
  for (const held of [paper, front && !front.id ? front : null, ...zoteroFiles(seen)]) {
    const folder = held && held.dir ? path.resolve(held.dir) : null;
    if (!folder || folder === path.parse(folder).root || folder === path.resolve(os.homedir()) || dirs.some((root) => within(folder, root))) continue;
    try { if (fs.statSync(folder).isDirectory()) dirs.push(folder); } catch { /* gone: nothing to grant */ }
  }
  // The files inside library folders the documents point at (MATH-22): their folders are granted above, as library items.
  const files = mentionedFiles(rows, seen, ctx.homeDir || os.homedir());
  return { project, dirs, head, contextJson: `<context_json>\n${JSON.stringify(entries, null, 1)}\n</context_json>`, mentionedFiles: mentionedFilesBlock(files), files, documents: documents.join('\n\n'), now, entries, workspaceName: workspace.name };
}

module.exports = { HERE, NO_STAGE, NO_HIGHLIGHTS, SELECTION_WAIT_MS, markPlace, buildContext, conversationBlock, catalogEntries, mentionedFiles, mentionedFilesBlock, libraryDirs, block, highlightBlock, paperOf, webPageOf };
