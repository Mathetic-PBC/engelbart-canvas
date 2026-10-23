'use strict';

// Chat's citations (2026-10-21). Where an answer leans on something in the person's context, Chat cites the passage it
// leans on, inline, as a link to it with the words it quotes and whose words they are:
//   [You · Oct 12](/abs/path/note.md#find=exact%20words&cite=you)
//   [TutorTrace p. 6](/abs/paper.pdf#find=…&cite=source)
// (../../shared/passage-link.cjs reads one; `&counter=1` marks one that cuts against the answer). Nothing a model wrote
// about a source is trusted: before the answer is written into the document every citation is checked against what it
// cites, and one that cannot be confirmed is taken out, its sentence kept. A citation is kept when its address is a
// library item (by path, or by url for a web page), a file inside a library folder, or a workspace document of this
// project, when that source's text can be read, and when the quoted words are in it (../../shared/passage-text.cjs, the
// fold the Stage finds them by). Whose words they are is checked where the source says: an assistant's turn in an
// imported chat, or an answer line in a workspace ("bart> "), is not the person's, so `you` there becomes `other`. A
// passage of the conversation being answered is not a source. Ordinary links are left as they are.

const fs = require('node:fs');
const path = require('node:path');
const projects = require('../store/projects.cjs');
const { splitTarget, citeHref } = require('../../shared/passage-link.cjs');
const { matchPassage, foldPassage } = require('../../shared/passage-text.cjs');
const { addressKey } = require('../../shared/address-key.cjs');
const { openedKey } = require('./source-text.cjs');

const LINK_RE = /\[([^\]\n]+)\]\(([^)\s]+)\)/g;
// A citation whose words were left with a space or a parenthesis in them, which LINK_RE stops at: the link runs to the
// `)` after its `cite=` (and the keys after it), or its target is parenthesised one deep. Never across another link.
const LOOSE_CITE_RE = /\[([^\]\n]+)\]\(((?:(?!\]\()[^\n])*?[#&]cite=[A-Za-z]*(?:&(?:to|counter)=[^&)\n]*)*)\)/g;
const NESTED_LINK_RE = /\[([^\]\n]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)/g;
const isCite = (href) => /[#&]cite=/.test(href);

/** The citations of a line, in order, none overlapping → the matches ({ index, 0: whole, 1: label, 2: href }). */
function citeLinks(line) {
  const found = [];
  const overlaps = (m) => found.some((f) => m.index < f.index + f[0].length && f.index < m.index + m[0].length);
  for (const re of [LOOSE_CITE_RE, NESTED_LINK_RE, LINK_RE]) {
    for (const m of line.matchAll(re)) if (isCite(m[2]) && !overlaps(m)) found.push(m);
  }
  return found.sort((a, b) => a.index - b.index);
}
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;
const MAX_TEXT_BYTES = 8 * 1024 * 1024;
// Imported AI chats (../connect/tools.cjs chatNote): each turn opens with who said it.
const SPEAKER_RE = /^\*\*(You|ChatGPT|Codex|Cursor|Claude):\*\*\s/;
// A workspace's answer lines: an answer, a folded one, an old draft.
const ANSWER_LINE_RE = /^bart[+?]?> ?/;

const within = (file, dir) => { const rel = path.relative(dir, file); return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel); };

/** A file Chat must not cite: MEMORY.md, the catalogs and summaries under a `.context` folder. → a reason, or ''. */
function notCitable(file) {
  const base = path.basename(file);
  if (/^memory\.md$/i.test(base)) return 'memory';
  if (file.split(path.sep).includes('.context') || /^catalog\.json$/i.test(base)) return 'catalog';
  return '';
}

/**
 * Where a citation's address is → { kind, file, row, name, workspace } or { reason }. `kind`: 'workspace' (a workspace
 * document of this project; `workspace` its record), 'row' (a library item), 'folder-file' (a file inside a library
 * folder; `row` the folder).
 */
function resolveSource(address, { library, projectDir, workspaces, dataRoot }) {
  const where = String(address || '').trim();
  if (!where) return { reason: 'unresolved' };
  if (/^https?:\/\//i.test(where)) {
    const key = addressKey(where);
    const row = (library || []).find((r) => r.url && addressKey(r.url) === key);
    return row ? { kind: 'row', row, file: row.path || null, name: row.name } : { reason: 'unresolved' };
  }
  let file = where;
  if (/^file:\/\//i.test(file)) { try { file = decodeURIComponent(new URL(file).pathname); } catch { return { reason: 'unresolved' }; } }
  if (!path.isAbsolute(file)) return { reason: 'unresolved' };
  file = path.resolve(file);
  const banned = notCitable(file);
  if (banned) return { reason: banned };
  if (path.basename(file) === 'workspace.md') {
    const dir = path.dirname(file);
    if (projectDir && within(dir, projectDir)) {
      const parts = path.relative(projectDir, dir).split(path.sep);
      if (parts.some((part) => part === '.trash' || part === '.archive')) return { reason: 'unresolved' };
      const workspace = (workspaces || []).find((w) => path.resolve(w.dir) === dir);
      return workspace ? { kind: 'workspace', file, workspace, name: workspace.name } : { reason: 'unresolved' };
    }
    if (dataRoot && within(file, dataRoot)) return { reason: 'other-project' };
  }
  const row = (library || []).find((r) => r.path && path.resolve(r.path) === file && r.type !== 'folder');
  if (row) return { kind: 'row', row, file, name: row.name };
  const folder = (library || []).find((r) => r.type === 'folder' && r.path && within(file, path.resolve(r.path)));
  if (folder) return { kind: 'folder-file', row: folder, file, name: path.basename(file) };
  if (dataRoot && within(file, dataRoot) && /\.md$/i.test(file) && !within(file, projectDir || '\0')) return { reason: 'other-project' };
  return { reason: 'unresolved' };
}

/** The text of a source file, or null: a pdf's text layer, a saved page's readable text, any other file as text. */
async function defaultReadText(file) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return null;
    if (/\.pdf$/i.test(file)) {
      const { extractText } = require('../context/pdf-text.cjs');
      return await extractText(file);
    }
    if (stat.size > MAX_TEXT_BYTES) return null;
    const raw = fs.readFileSync(file, 'utf8');
    if (/\.html?$/i.test(file)) return require('../connect/gmail.cjs').htmlText(raw);
    return raw.includes('\u0000') ? null : raw;
  } catch {
    return null;
  }
}

// The line of `text` that offset `at` is on.
function lineAt(text, at) {
  const start = text.lastIndexOf('\n', at - 1) + 1;
  const end = text.indexOf('\n', at);
  return text.slice(start, end < 0 ? text.length : end);
}

/** In an imported chat, who said what is at `at`: the speaker of the turn it is in ('You', 'ChatGPT', …), '' when none. */
function speakerAt(text, at) {
  const lines = text.slice(0, at).split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const m = lines[i].match(SPEAKER_RE);
    if (m) return m[1];
  }
  return '';
}
const isImportedChat = (text) => text.split('\n').some((line) => SPEAKER_RE.test(line) && !line.startsWith('**You:**'));

// When the cited words were written, as far as their source says (2026-10-21, David: "You · {date}"), → a Date or null:
// an imported chat's date from its header line, the day a workspace was started (its lines are not dated one by one),
// the day a library item was added, a library folder's file's own date.
const CHAT_DATE_RE = /^\*[^*\n]*?·\s*(\d{4}-\d{2}-\d{2})\b/m;
function sourceDate(found, source) {
  const valid = (value) => { const date = value ? new Date(value) : null; return date && !Number.isNaN(date.getTime()) ? date : null; };
  const header = String(source || '').slice(0, 400).match(CHAT_DATE_RE);
  if (header) return valid(`${header[1]}T12:00:00`);
  if (found.kind === 'workspace') { try { return valid(JSON.parse(fs.readFileSync(path.join(path.dirname(found.file), 'meta.json'), 'utf8')).created); } catch { return null; } }
  if (found.kind === 'row' && found.row.created) return valid(found.row.created);
  try { const stat = fs.statSync(found.file); return valid(stat.birthtimeMs > 0 ? stat.birthtime : stat.mtime); } catch { return null; }
}
// A highlight's first words, where the paper opens for a note on it: enough to find the passage, not the whole selection.
const NOTE_FIND_WORDS = 30;
const firstWords = (value, n) => String(value || '').split(/\s+/).filter(Boolean).slice(0, n).join(' ');
// A mark's id is `m` and the time it was made (src/renderer/pdf/marks.js).
const markDate = (id) => { const m = /^m(\d{12,13})/.exec(String(id || '')); const date = m ? new Date(Number(m[1])) : null; return date && !Number.isNaN(date.getTime()) ? date : null; };

/**
 * The notes on a paper's or page's highlights, from its ink ({ "<page>": [mark] }, a web page's { web: [mark] }): [{ note,
 * text: the passage it is on ('' for a free note), page (null on a web page), at: when it was made }].
 */
function inkNotes(ink) {
  const out = [];
  if (!ink || typeof ink !== 'object' || Array.isArray(ink)) return out;
  const add = (m, page, text) => { if (m && typeof m === 'object' && typeof m.note === 'string' && m.note.trim()) out.push({ note: m.note, text: String(text || ''), page, at: markDate(m.id) }); };
  for (const [key, list] of Object.entries(ink)) {
    if (!Array.isArray(list)) continue;
    if (key === 'web') for (const m of list) add(m, null, m && m.quote && typeof m.quote === 'object' ? m.quote.exact : m && m.quote);
    else if (/^\d+$/.test(key)) for (const m of list) add(m, Number(key), m && !m.box ? m.text : '');
  }
  return out;
}

/** A library item's ink as its own file keeps it (<data root>/annotations/<id>.json), or null. */
function defaultReadInk(dataRoot, row) {
  if (!dataRoot || !row || !/^[\w-]+$/.test(String(row.id || ''))) return null;
  try { return JSON.parse(fs.readFileSync(path.join(dataRoot, 'annotations', `${row.id}.json`), 'utf8')); } catch { return null; }
}

/** "Oct 12", or "Oct 12, 2025" in another year than `today`'s. */
const dayLabel = (date, today = new Date()) => (date ? date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(date.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}) }) : '');
// Who said words cited as someone else's, where the source says: an answer line is Chat's, an imported chat's turn its
// speaker's. Elsewhere (a meeting's notes, a colleague's) the name the citation gave, when it gave a short one.
function otherOf(source, at, { workspaceDoc, chat }, label) {
  if (workspaceDoc && ANSWER_LINE_RE.test(lineAt(source, at))) return 'Chat';
  const speaker = chat ? speakerAt(source, at) : '';
  if (speaker && speaker !== 'You') return speaker;
  const named = String(label).split(' · ')[0].trim();
  return String(label).includes(' · ') && named && named.length <= 24 && !/^you$/i.test(named) ? named : 'Someone';
}

/** The answer's text with a link taken out where it stood, its sentence kept: no doubled space or space before stray punctuation. */
function tidyAround(line, start, end) {
  let before = line.slice(0, start), after = line.slice(end);
  before = before.replace(/[ \t]+$/, '');
  after = after.replace(/^[ \t]+/, '');
  // "(link)" or "[link]" around nothing left
  if (/[([]$/.test(before) && /^[)\]]/.test(after)) { before = before.slice(0, -1).replace(/[ \t]+$/, ''); after = after.slice(1); }
  const joined = !before || !after || /^[.,;:!?)\]]/.test(after) ? before + after : `${before} ${after}`;
  return joined.replace(/ {2,}/g, ' ').replace(/ ([.,;:!?])/g, '$1').replace(/^\s+/, (lead) => (line.match(/^\s*/)[0] ? lead : ''));
}

// The thread being answered, folded: its questions and answers, which no citation may quote.
const threadText = (thread) => (thread || []).map((turn) => [turn && turn.question, turn && turn.answer].filter(Boolean).join('\n')).join('\n');

/**
 * Checks each citation of `body` (Chat's answer, as replyBody gave it) → { body, kept, dropped }. `body` has every
 * citation that could not be confirmed taken out and every `you` that is someone else's made `other`; `kept`: [{ label,
 * address, source, find, cite, counter, relabeled }]; `dropped`: [{ label, address, reason }], `reason` one of
 * 'malformed', 'unresolved', 'memory', 'catalog', 'other-project', 'no-text', 'not-found', 'current-thread'.
 * `library`: the library's rows. `projectDir` and `workspaces` (each with its `dir`) are found from `dataRoot` and
 * `projectId` when not given. `currentThread`: [{ question, answer }], the exchange being answered, last question
 * included. `readText(file)`: a source file's text (defaultReadText). `readRowText(row)`: the text kept for a library
 * item that has no file (a page saved by its address, ./source-text.cjs), or null. `opened`: what Chat read while it
 * answered, as openedKey spells each (./source-text.cjs openedBy): a citation of a whole source (no `find`, 2026-10-22)
 * is kept only when its source is among them, as a summary is no reading. `readInk(row)`: a paper's or page's ink (the
 * person's highlights and notes on it, ../store/library.cjs readAnnotations): a citation of words in one of their notes
 * (2026-10-23) is theirs, dated by the note, and written with the note's words as `note` and the highlighted passage as
 * `find`, where the paper opens. `today`: for the labels' dates, whose year is
 * left off in this one.
 */
async function checkCitations(body, { library = [], dataRoot = null, projectId = null, workspaceId = null, projectDir = null, workspaces = null, currentThread = [], readText = defaultReadText, readRowText = () => null, readInk = (row) => defaultReadInk(dataRoot, row), opened = null, today = new Date() } = {}) {
  const text = String(body == null ? '' : body);
  const kept = [], dropped = [];
  if (!/[#&]cite=|#find=/.test(text)) return { body: text, kept, dropped };
  let dir = projectDir, spaces = workspaces;
  if ((!dir || !spaces) && dataRoot && projectId) {
    try {
      const project = projects.findProject({ dataRoot }, projectId);
      dir = dir || project.dir;
      spaces = spaces || projects.flattenWorkspaces(project.dir).map((w) => ({ ...w, dir: path.join(project.dir, w.path) }));
    } catch { /* an unknown project: no workspace is citable */ }
  }
  const current = (spaces || []).find((w) => w.id === workspaceId) || null;
  const thread = foldPassage(threadText(currentThread), { prefixes: true, markdown: true }).text;
  const reads = new Map();
  const read = (file) => {
    if (!reads.has(file)) reads.set(file, Promise.resolve().then(() => readText(file)).catch(() => null));
    return reads.get(file);
  };
  const rowText = (row) => {
    const key = `row:${row.id}`;
    if (!reads.has(key)) reads.set(key, Promise.resolve().then(() => readRowText(row)).catch(() => null));
    return reads.get(key);
  };

  // The person's notes on a library item's highlights, as its ink keeps them (`readInk`), read once each.
  const notes = new Map();
  const notesOf = (row) => {
    if (!notes.has(row.id)) notes.set(row.id, Promise.resolve().then(() => readInk(row)).then(inkNotes).catch(() => []));
    return notes.get(row.id);
  };
  const noteHolding = async (row, words) => (words ? (await notesOf(row)).find((n) => matchPassage(n.note, words, { markdown: true }).length) || null : null);
  // A note cited: the person's words, dated by when the note was made, opening the paper at the passage it is on.
  const noteCite = (target, found, n) => {
    const quote = target.note || target.find, find = firstWords(n.text, NOTE_FIND_WORDS);
    const shown = ['You', dayLabel(n.at || sourceDate(found, null), today)].filter(Boolean).join(' · ');
    const address = found.row.url && /^https?:\/\//i.test(target.address) ? found.row.url : found.file || target.address;
    kept.push({ label: shown, address, source: found.name, find, note: quote, page: n.page, cite: 'you', counter: !!target.counter, relabeled: target.cite !== 'you' });
    return `[${shown}](${citeHref({ address: target.address, find, note: quote, cite: 'you', counter: target.counter })})`;
  };

  // A whole source: a library item (not a workspace's document, whose passages are what it holds), read while answering.
  // Whose it is goes by what was said, its label by when the source is from, as a passage's.
  const whole = async (label, target, found, cut) => {
    if (found.kind === 'workspace') return cut('malformed');
    const keys = [found.file && openedKey(found.file), found.row && found.row.url && openedKey(found.row.url)].filter(Boolean);
    if (!opened || !keys.some((key) => opened.has(key))) return cut('not-read');
    const address = found.row && found.row.url && /^https?:\/\//i.test(target.address) ? found.row.url : found.file || target.address;
    const source = found.file ? await read(found.file) : null;
    const by = target.cite === 'you' ? 'You' : target.cite === 'other' ? otherOf('', 0, {}, label) : '';
    const shown = by ? [by, dayLabel(sourceDate(found, source), today)].filter(Boolean).join(' · ') : label;
    kept.push({ label: shown, address, source: found.name || path.basename(found.file || ''), find: '', cite: target.cite, counter: !!target.counter, relabeled: false });
    return `[${shown}](${citeHref({ address: target.address, find: '', cite: target.cite, counter: target.counter })})`;
  };

  const check = async (label, href) => {
    const target = splitTarget(href);
    const cut = (reason) => { dropped.push({ label, address: target.address || href, reason }); return null; };
    if (!target.cite) return cut('malformed');
    const found = resolveSource(target.address, { library, projectDir: dir, workspaces: spaces, dataRoot });
    if (found.reason) return cut(found.reason);
    if (!target.find && !target.note) return whole(label, target, found, cut);
    const source = found.file ? await read(found.file) : found.row ? await rowText(found.row) : null;
    const workspaceDoc = found.kind === 'workspace';
    const markdown = found.file ? /\.(?:md|markdown|txt|html?)$/i.test(found.file) : true; // a saved page's text has its links as markdown
    const hits = typeof source === 'string' && target.find && !target.note ? matchPassage(source, target.find, { prefixes: workspaceDoc, markdown }) : [];
    // The person's note on a highlight of a paper or page (2026-10-23): their words, wherever the model said they were.
    if (found.kind === 'row' && (target.note || target.cite === 'you' || !hits.length)) {
      const noted = await noteHolding(found.row, target.note || target.find);
      if (noted) return noteCite(target, found, noted);
    }
    if (typeof source !== 'string' || !source.trim()) return cut('no-text');
    if (!hits.length) return cut('not-found');
    if (workspaceDoc && current && found.workspace.id === current.id && thread && thread.includes(foldPassage(target.find, { markdown: true }).text)) return cut('current-thread');
    // The same words can be in more than one place (the person's question repeating Chat's suggestion): they are
    // someone else's only when every place they are is.
    let cite = target.cite, who = '';
    if (cite === 'you') {
      if (workspaceDoc && hits.every((h) => ANSWER_LINE_RE.test(lineAt(source, h.start)))) who = 'Chat';
      else if (!workspaceDoc && markdown && isImportedChat(source)) {
        const speakers = hits.map((h) => speakerAt(source, h.start));
        if (speakers.every((speaker) => speaker && speaker !== 'You')) who = speakers[0];
      }
      if (who) cite = 'other';
    }
    const address = found.row && found.row.url && /^https?:\/\//i.test(target.address) ? found.row.url : found.file;
    // Whose words and when is the code's to say, not the model's: "You · Oct 12", "Chat · Oct 12", "ChatGPT · Sep 2". A
    // paper's or page's label is the model's (its short title and page).
    const by = cite === 'you' ? 'You' : cite === 'other' ? who || otherOf(source, hits[0].start, { workspaceDoc, chat: !workspaceDoc && markdown && isImportedChat(source) }, label) : '';
    const shown = by ? [by, dayLabel(sourceDate(found, source), today)].filter(Boolean).join(' · ') : label;
    kept.push({ label: shown, address, source: found.name || path.basename(found.file || ''), find: target.find, cite, counter: !!target.counter, relabeled: !!who });
    // written again when its label or words changed, or when a space or parenthesis in it would end the link early
    return who || shown !== label || /[()\s]/.test(href) ? `[${shown}](${citeHref({ address: target.address, find: target.find, to: target.to, cite, counter: target.counter })})` : `[${label}](${href})`;
  };

  // A passage of a source in the person's context linked with no `cite=` (2026-10-22: a whole answer's were) is a citation
  // that left out whose words they are: given the kind its label or source says, it is checked as any other, not let
  // through unchecked. A passage of anything else (a paper on the web) stays a link.
  const withKinds = (line) => {
    const cites = citeLinks(line);
    return line.replace(LINK_RE, (whole, label, href, at) => {
    if (isCite(href) || !/#find=/.test(href) || /`/.test(label) || cites.some((m) => at < m.index + m[0].length && m.index < at + whole.length)) return whole;
    const target = splitTarget(href);
    if (!target.find) return whole;
    const found = resolveSource(target.address, { library, projectDir: dir, workspaces: spaces, dataRoot });
    if (found.reason) return whole;
    const who = String(label).split(' · ')[0].trim();
    const kind = /^you$/i.test(who) ? 'you' : String(label).includes(' · ') && who.length <= 24 ? 'other'
      : found.kind === 'workspace' || /\.(?:md|markdown|txt)$/i.test(found.file || '') ? 'you' : 'source';
    return `[${label}](${href}&cite=${kind})`;
    });
  };

  const out = [];
  let fence = null;
  for (let line of text.split('\n')) {
    if (fence) { out.push(line); if (new RegExp(`^ {0,3}${fence[0]}{${fence.length},}\\s*$`).test(line)) fence = null; continue; }
    const open = line.match(FENCE_RE);
    if (open) { fence = open[1]; out.push(line); continue; }
    line = withKinds(line);
    // inline code is no link: its spans are kept out of the search, and put back as they were
    const masked = line.replace(/`[^`\n]*`/g, (code) => '\u0000'.repeat(code.length));
    const links = citeLinks(masked);
    if (!links.length) { out.push(line); continue; }
    const results = [];
    for (const m of links) results.push(await check(m[1], m[2])); // in order, so kept and dropped are the answer's
    let now = line;
    for (let i = links.length - 1; i >= 0; i -= 1) {
      const m = links[i], replaced = results[i];
      now = replaced == null ? tidyAround(now, m.index, m.index + m[0].length) : now.slice(0, m.index) + replaced + now.slice(m.index + m[0].length);
    }
    out.push(now);
  }
  return { body: out.join('\n'), kept, dropped };
}

module.exports = { checkCitations, resolveSource, notCitable, defaultReadText, speakerAt, tidyAround, inkNotes };
