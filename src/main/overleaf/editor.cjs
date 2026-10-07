'use strict';
// The Overleaf project open in the Stage (MATH-65, Overleaf part 1, 2026-10-07). No API and no cookie import: the person
// signs in to overleaf.com in the Stage once, and its editor tabs (overleaf.com/project/<id>) are read from the page.
//
// Overleaf's editor is CodeMirror 6, which draws only the lines in view, so the page's DOM never holds the whole file.
// The file is read from the editor's state instead: READ_SCRIPT runs in the page's main world (webContents
// .executeJavaScript; the preload, page-preload.cjs, lives in an isolated world and cannot see the page's objects), finds
// the EditorView behind .cm-content and returns state.doc.toString(), the selection, the cursor's line, and the open file's
// path from the file tree's selected item. It changes nothing and keeps nothing. A page that does not answer within
// READ_TIMEOUT_MS has no live read; @bart is then given the project's copy on disk (./copy.cjs) and told so (./stage.cjs).
//
// Writing back (not yet): an edit would be applied here, through the same view, in the main world:
//   view.dispatch({ changes: { from, to, insert } })
// so Overleaf's own collaboration layer sends it to the project as if the person had typed it. Never by writing the copy
// on disk or uploading files: the copy is a read-only snapshot.

const READ_TIMEOUT_MS = 500;
const MAX_DOC = 2_000_000; // characters the page sends at most; a longer file comes as this much around the cursor
const MAX_SELECTION = 20_000; // characters of a selection kept
const MAX_NAME = 300;
const MAX_PATH = 1024;

const PROJECT_RE = /^\/project\/([0-9a-f]{24})\/?$/i;

/** The Overleaf project an editor tab shows (https://(www.)overleaf.com/project/<24 hex>) → its id, lowercased; else ''. */
function overleafProjectId(value) {
  let url;
  try { url = new URL(String(value || '')); } catch { return ''; }
  if (url.protocol !== 'https:' || !/^(?:www\.)?overleaf\.com$/i.test(url.hostname)) return '';
  const m = PROJECT_RE.exec(url.pathname);
  return m ? m[1].toLowerCase() : '';
}

/** A tab's title without Overleaf's " - Overleaf, Online LaTeX Editor". */
const projectTitle = (title) => String(title || '').replace(/\s+[-–—|]\s+Overleaf\b.*$/i, '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);

// Runs in the page, so it is a string and uses only what a page has. → { found, text, offset, length, lines, from, to,
// head, cursorLine, fromLine, toLine, selection, file, projectName }; found false (with file and projectName) when no
// editor is there (an image open, the page still loading).
const READ_SCRIPT = `(() => {
  const MAX_DOC = ${MAX_DOC}, MAX_SELECTION = ${MAX_SELECTION};
  const isView = (v) => !!(v && v.state && v.state.doc && typeof v.state.doc.toString === 'function' && v.state.selection && typeof v.dispatch === 'function');
  const fromTile = (t) => (t && typeof t === 'object' ? [t, t.view, t.rootView && t.rootView.view, t.root && t.root.view] : []);
  // EditorView.findFromDOM, without the module: the content element's tile (cmView, cmTile in newer versions) knows its view
  const viewOf = (el) => {
    if (!el) return null;
    for (const v of [...fromTile(el.cmView), ...fromTile(el.cmTile)]) if (isView(v)) return v;
    for (const key of Object.keys(el)) for (const v of fromTile(el[key])) if (isView(v)) return v;
    return null;
  };
  const views = [];
  for (const el of document.querySelectorAll('.cm-content')) {
    const view = viewOf(el) || viewOf(el.closest && el.closest('.cm-editor'));
    if (view && !views.includes(view)) views.push(view);
  }
  const shown = (v) => { try { return !!(v.dom && v.dom.offsetParent !== null); } catch (e) { return true; } };
  const view = views.find((v) => v.hasFocus) || views.filter(shown).sort((a, b) => b.state.doc.length - a.state.doc.length)[0] || views[0] || null;

  const label = (item) => {
    const own = item.getAttribute && item.getAttribute('aria-label');
    if (own) return own;
    const button = item.querySelector && item.querySelector('.item-name-button');
    return String((button && button.textContent) || '').trim();
  };
  let file = '';
  const selected = document.querySelector('[role="tree"] [role="treeitem"][aria-selected="true"]') || document.querySelector('.file-tree [aria-selected="true"]');
  if (selected) {
    const parts = [];
    for (let item = selected; item; item = item.parentElement && item.parentElement.closest ? item.parentElement.closest('[role="treeitem"]') : null) parts.unshift(label(item));
    file = parts.filter(Boolean).join('/');
  }
  if (!file) {
    const crumbs = document.querySelector('.ol-cm-breadcrumbs');
    if (crumbs) file = String(crumbs.textContent || '').split(/\\s*[›>\\/]\\s*/).map((s) => s.trim()).filter(Boolean).join('/');
  }
  const meta = document.querySelector('meta[name="ol-projectName"]');
  const projectName = String((meta && meta.getAttribute('content')) || '').trim() || String(document.title || '');
  if (!view) return { found: false, file, projectName };

  const state = view.state, doc = state.doc, main = state.selection.main;
  const length = doc.length;
  let offset = 0, end = length;
  if (length > MAX_DOC) { offset = Math.max(0, Math.min(length - MAX_DOC, main.head - MAX_DOC / 2)); end = offset + MAX_DOC; }
  const text = offset === 0 && end === length ? doc.toString() : doc.sliceString(offset, end);
  const from = Math.min(main.from, main.to), to = Math.max(main.from, main.to);
  return {
    found: true, text, offset, length, lines: doc.lines,
    from, to, head: main.head,
    cursorLine: doc.lineAt(main.head).number, fromLine: doc.lineAt(from).number, toLine: doc.lineAt(to).number,
    selection: to > from ? doc.sliceString(from, Math.min(to, from + MAX_SELECTION)) : '',
    file, projectName,
  };
})()`;

const int = (n, max) => Number.isInteger(n) && n >= 0 && n <= max;
const shortText = (value, max) => (typeof value === 'string' ? value.replace(/[\0\r\n]+/g, ' ').trim().slice(0, max) : '');

/**
 * What READ_SCRIPT answered, checked → { found: true, text, offset, length, lines, from, to, head, cursorLine, fromLine,
 * toLine, selection, file, projectName } or { found: false, file, projectName }; null for anything else. A file path
 * that leaves the project (.., an absolute path) is dropped.
 */
function editorInput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  let file = shortText(value.file, MAX_PATH).replace(/^\/+/, '');
  if (file.split('/').some((part) => part === '..' || part === '.')) file = '';
  const projectName = projectTitle(value.projectName);
  if (value.found !== true) return value.found === false ? { found: false, file, projectName } : null;
  const { text, offset, length, lines, from, to, head, cursorLine, fromLine, toLine } = value;
  if (typeof text !== 'string' || text.length > MAX_DOC) return null;
  if (!int(length, 1e9) || !int(offset, length) || offset + text.length > length || !int(lines, 1e8)) return null;
  if (!int(from, length) || !int(to, length) || from > to || !int(head, length) || head < offset || head > offset + text.length) return null;
  if (![cursorLine, fromLine, toLine].every((n) => int(n, lines) && n >= 1) || fromLine > toLine) return null;
  const selection = typeof value.selection === 'string' ? value.selection.slice(0, MAX_SELECTION) : '';
  return { found: true, text, offset, length, lines, from, to, head, cursorLine, fromLine, toLine, selection, file, projectName };
}

/**
 * The editor in `contents` (an Overleaf tab's webContents) read now → { ok: true, read } (editorInput's), or { ok: false,
 * why }: 'timeout' when the page did not answer within `timeoutMs`, 'unreadable' when it answered nothing usable, 'error'
 * when the script failed.
 */
async function readEditor(contents, { timeoutMs = READ_TIMEOUT_MS } = {}) {
  if (!contents || (typeof contents.isDestroyed === 'function' && contents.isDestroyed())) return { ok: false, why: 'error' };
  let timer;
  const late = Symbol('late');
  try {
    const out = await Promise.race([
      Promise.resolve().then(() => contents.executeJavaScript(READ_SCRIPT, false)),
      new Promise((resolve) => { timer = setTimeout(() => resolve(late), timeoutMs); if (typeof timer.unref === 'function') timer.unref(); }),
    ]);
    if (out === late) return { ok: false, why: 'timeout' };
    const read = editorInput(out);
    return read ? { ok: true, read } : { ok: false, why: 'unreadable' };
  } catch {
    return { ok: false, why: 'error' };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { READ_SCRIPT, READ_TIMEOUT_MS, MAX_DOC, MAX_SELECTION, overleafProjectId, projectTitle, editorInput, readEditor };
