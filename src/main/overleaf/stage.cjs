'use strict';
// What @bart is shown of the Overleaf projects open in the Stage (MATH-65, Overleaf part 1, 2026-10-07).
//
// The tab in front, when it is an Overleaf editor: <stage source="overleaf" project="…" file="…" folder="…" copied_at="…">,
// holding <open_file>, the open file's text read live from the editor (./editor.cjs; at most OPEN_FILE_MAX characters, the
// ones around the cursor, whose place is marked CURSOR), and <selection> when something is selected. `folder` is the copy
// of the whole project on disk (./copy.cjs), refreshed before the turn when it is over a minute old. A page that does not
// answer in time says live="unavailable", and the copy is all Bart has: it is told so in a <note>.
// Every other Overleaf tab is one line in <overleaf_tabs>: the project's name and its copy's folder.
// Both go in <stage>'s place in a turn (bart/context.cjs) and in a resumed turn's `now`.

const { attrOf } = require('../bart/highlights.cjs');
const { projectTitle, READ_TIMEOUT_MS } = require('./editor.cjs');

const OPEN_FILE_MAX = 60_000;
const CURSOR = '<<<cursor>>>';
const COPY_WAIT_MS = 15_000; // how long a turn waits on a download before going on with the copy it has
const MAX_SKIPPED_SHOWN = 5;

const count = (text, from, to) => { let n = 0; for (let i = from; i < to; i += 1) if (text.charCodeAt(i) === 10) n += 1; return n; };
const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : '');
const mb = (bytes) => `${Math.round((Number(bytes) || 0) / 1024 / 1024)} MB`;

/**
 * <open_file path="…" lines="N" cursor_line="L" [shown_lines="a-b"]> the text, CURSOR at the cursor </open_file>, from
 * editor.cjs's read. A file past `max` characters is shown as whole lines around the cursor, `max` at most.
 */
function openFileXml(read, { max = OPEN_FILE_MAX } = {}) {
  const text = read.text, head = read.head - read.offset;
  let start = 0, end = text.length;
  if (read.offset > 0 || text.length < read.length || text.length > max) {
    start = Math.max(0, Math.min(text.length - max, head - Math.floor(max / 2)));
    end = Math.min(text.length, start + max);
    // whole lines at each end, unless that would cut the cursor's own line (one longer than the window)
    const lineStart = head > 0 ? text.lastIndexOf('\n', head - 1) + 1 : 0;
    if (start > 0 && start < lineStart && text.charCodeAt(start - 1) !== 10) start = text.indexOf('\n', start) + 1;
    if (end < text.length) { const last = text.lastIndexOf('\n', end - 1); if (last >= head) end = last; }
  }
  const first = read.cursorLine - count(text, start, head);
  const last = first + count(text, start, end);
  const whole = start === 0 && end === text.length && read.offset === 0 && text.length === read.length;
  const attrs = `${read.file ? `path="${attrOf(read.file, 1024)}" ` : ''}lines="${read.lines}" cursor_line="${read.cursorLine}"${whole ? '' : ` shown_lines="${first}-${last}"`}`;
  return `<open_file ${attrs}>\n${text.slice(start, head)}${CURSOR}${text.slice(head, end)}\n</open_file>\n`;
}

/** <selection from_line="a" to_line="b"> what is selected in the editor </selection>, or '' with nothing selected. */
function selectionXml(read) {
  if (!read || !read.selection) return '';
  return `<selection from_line="${read.fromLine}" to_line="${read.toLine}">\n${read.selection}\n</selection>\n`;
}

/** The notes on a project's copy: not refreshed, still downloading, none at all, files left out. */
function copyNotes(copy) {
  const notes = [];
  const when = iso(copy && copy.fetchedAt);
  if (!copy || (!copy.folder && copy.error)) notes.push(`There is no copy of the project on disk: ${(copy && copy.error) || 'it could not be downloaded'}.`);
  else if (copy.pending && !copy.folder) notes.push('The project’s copy is still downloading; it is not on disk yet.');
  else if (copy.pending) notes.push(`A newer copy is still downloading; the folder holds the copy downloaded at ${when}.`);
  else if (copy.error) notes.push(`The copy could not be refreshed (${copy.error}); the folder holds the copy downloaded at ${when}.`);
  const skipped = (copy && Array.isArray(copy.skipped) ? copy.skipped : []);
  if (skipped.length) {
    const named = skipped.slice(0, MAX_SKIPPED_SHOWN).map((s) => `${s.path} (${mb(s.bytes)}, ${s.why || 'skipped'})`).join(', ');
    notes.push(`Not in the copy: ${named}${skipped.length > MAX_SKIPPED_SHOWN ? ` and ${skipped.length - MAX_SKIPPED_SHOWN} more` : ''}.`);
  }
  return notes;
}

/** Why the editor could not be read, for the <note> that says so. */
function liveNote(live, timeoutMs = READ_TIMEOUT_MS) {
  if (live && live.ok && live.read && !live.read.found) {
    return `The editor shows no text file now${live.read.file ? ` (${live.read.file} is selected in the file tree)` : ''}: an image or PDF is open, or the page is still loading. Read the project from the folder.`;
  }
  const why = live && live.why === 'timeout' ? `did not answer within ${timeoutMs} ms` : 'could not be read';
  return `The Overleaf editor ${why}, so the open file, what was typed in it in the last minute or so, and the cursor are not known. Read the project from the folder: it is the copy downloaded from Overleaf, which may be up to a minute old or older.`;
}

/**
 * <stage source="overleaf" …> for the Overleaf tab in front. `front`: { name, live (readEditor's), copy (copies.ensure's,
 * or { pending, …info } when the turn did not wait for it) }; `screenshot`, a picture of the page's path (optional).
 */
function overleafStageBlock(front, { screenshot = '', max = OPEN_FILE_MAX, timeoutMs = READ_TIMEOUT_MS } = {}) {
  const { live, copy } = front;
  const read = live && live.ok && live.read && live.read.found ? live.read : null;
  const file = read ? read.file : live && live.ok && live.read ? live.read.file : '';
  const attrs = [
    'source="overleaf"',
    `project="${attrOf(front.name, 200)}"`,
    ...(file ? [`file="${attrOf(file, 1024)}"`] : []),
    ...(copy && copy.folder ? [`folder="${attrOf(copy.folder, 4096)}"`] : []),
    ...(copy && copy.folder && Number.isFinite(copy.fetchedAt) ? [`copied_at="${iso(copy.fetchedAt)}"`] : []),
    ...(read ? [] : [`live="${live && live.ok ? 'none' : 'unavailable'}"`]),
  ].join(' ');
  const notes = [...(read ? [] : [liveNote(live, timeoutMs)]), ...copyNotes(copy)];
  const body = [
    read ? openFileXml(read, { max }) : '',
    read ? selectionXml(read) : '',
    ...notes.map((note) => `<note>${note}</note>\n`),
    screenshot ? `<screenshot path="${attrOf(screenshot, 4096)}"/>\n` : '',
  ].join('');
  return `<stage ${attrs}>\n${body}</stage>`;
}

/** <overleaf_tabs>, one line per Overleaf project open in another Stage tab: its name and its copy's folder; '' with none. */
function overleafTabsBlock(background) {
  if (!background || !background.length) return '';
  const lines = background.map(({ name, copy }) => (copy && copy.folder
    ? `<project name="${attrOf(name, 200)}" folder="${attrOf(copy.folder, 4096)}"/>`
    : `<project name="${attrOf(name, 200)}" copy="unavailable"/>`));
  return `<overleaf_tabs>\n${lines.join('\n')}\n</overleaf_tabs>`;
}

/** What `run()` gives within `ms`, else `late()`. */
async function within(run, ms, late) {
  let timer;
  try {
    return await Promise.race([Promise.resolve().then(run), new Promise((resolve) => { timer = setTimeout(() => resolve(late()), ms); })]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * → { forTurn }. `forTurn({ tabs, read }, stage)`, for an @bart turn: `tabs` the window's Overleaf tabs (views.cjs
 * overleafTabs: [{ id, projectId, title }]), `read(id)` reads one's editor (views.cjs readOverleaf), `stage` what the
 * renderer says is in front. → null with no Overleaf tab; else a function of the turn's ctx → { front, background },
 * `front` (null unless the tab in front is an Overleaf one) { projectId, name, live, copy }, `background` [{ projectId,
 * name, copy }], one per other project. Its `front` property says, before it runs, whether the tab in front is one.
 */
function createOverleafStage({ copies, copyWaitMs = COPY_WAIT_MS } = {}) {
  function forTurn({ tabs = [], read = async () => ({ ok: false, why: 'error' }) } = {}, stage = null) {
    const list = (Array.isArray(tabs) ? tabs : []).filter((t) => t && t.id && t.projectId);
    if (!list.length) return null;
    const frontTab = stage && stage.kind === 'web' && stage.tab ? list.find((t) => t.id === stage.tab) || null : null;
    const gather = async (ctx) => {
      const dataRoot = ctx && ctx.dataRoot;
      const ids = [...new Set(list.map((t) => t.projectId))];
      const copyOf = (id) => within(() => copies.ensure(dataRoot, id), copyWaitMs, () => ({ ...(copies.info(dataRoot, id) || { projectId: id }), pending: true }));
      const [held, live] = await Promise.all([
        Promise.all(ids.map((id) => copyOf(id).catch((error) => ({ projectId: id, error: String(error && error.message) })))),
        frontTab ? Promise.resolve().then(() => read(frontTab.id)).catch(() => ({ ok: false, why: 'error' })) : null,
      ]);
      const copyFor = new Map(ids.map((id, i) => [id, held[i]]));
      const nameOf = (tab, fromPage = '') => fromPage || projectTitle(tab.title) || `Overleaf project ${tab.projectId}`;
      const front = frontTab ? { projectId: frontTab.projectId, name: nameOf(frontTab, live && live.ok && live.read ? live.read.projectName : ''), live, copy: copyFor.get(frontTab.projectId) } : null;
      const seen = new Set(front ? [front.projectId] : []);
      const background = [];
      for (const tab of list) {
        if (seen.has(tab.projectId)) continue;
        seen.add(tab.projectId);
        background.push({ projectId: tab.projectId, name: nameOf(tab), copy: copyFor.get(tab.projectId) });
      }
      return { front, background };
    };
    gather.front = !!frontTab;
    return gather;
  }
  return { forTurn };
}

module.exports = { createOverleafStage, overleafStageBlock, overleafTabsBlock, openFileXml, selectionXml, OPEN_FILE_MAX, CURSOR, COPY_WAIT_MS };
