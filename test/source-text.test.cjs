'use strict';

// What Chat reads of a source it cannot open as it is, and what it read while answering (2026-10-22,
// src/main/bart/source-text.cjs).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { sourceTexts, noteTexts, openedBy, openedKey, keepPageTexts, textDir, notesDir } = require('../src/main/bart/source-text.cjs');
const { addressKey } = require('../src/shared/address-key.cjs');

// A library db with only what the text pass keeps: id → { text, mtime }.
function fakeDb(kept = {}) {
  const texts = new Map(Object.entries(kept));
  return {
    texts,
    asked: [],
    async textStamps() { return new Map([...texts].map(([id, t]) => [id, t.mtime])); },
    async textsFor(ids) { this.asked.push(ids); return new Map(ids.filter((id) => texts.has(id) && texts.get(id).text).map((id) => [id, texts.get(id).text])); },
    async setText(id, text, mtime) { texts.set(id, { text, mtime }); return true; },
  };
}

test('openedBy: Read, Grep on a file and WebFetch from Claude Code; a Codex command naming a known file; a kept text is its source', () => {
  const pdf = '/Users/me/Downloads/Welcome map.pdf', note = '/Users/me/notes/Plan.md', text = '/data/assets/text/abc-1.txt';
  const tool = (name, input) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id: name, name, input }] } });
  const events = [
    tool('Read', { file_path: text }),
    tool('Grep', { pattern: 'x', path: '/Users/me/notes' }), // a folder: nothing read whole
    tool('Grep', { pattern: 'x', path: '/Users/me/notes/Other.md' }),
    tool('WebFetch', { url: 'https://github.com/kjfeng/cocoa-canvas', prompt: 'what is it' }),
    { type: 'item.started', item: { id: 'c1', type: 'command_execution', command: "sed -n 1,40p /Users/me/notes/Plan.md" } },
    { type: 'stream_event', event: { delta: { text: 'Read /Users/me/secret.md' } } },
  ];
  const opened = openedBy(events, { known: [pdf, note], texts: new Map([[text, pdf]]), full: ['/Users/me/notes/Mentioned.md'] });
  assert.deepEqual([...opened].sort(), [
    openedKey('/Users/me/notes/Mentioned.md'),
    openedKey('/Users/me/notes/Other.md'),
    openedKey(note),
    openedKey(pdf),
    openedKey('https://github.com/kjfeng/cocoa-canvas'),
  ].sort());
  assert.ok(opened.has(openedKey('https://www.github.com/kjfeng/cocoa-canvas/')), 'an address however it is spelled');
  const escaped = openedBy([{ type: 'item.completed', item: { id: 'c2', type: 'command_execution', command: 'cat /Users/me/Downloads/Welcome\\ map.pdf', aggregated_output: '' } }], { known: [pdf] });
  assert.ok(escaped.has(openedKey(pdf)), 'a path with its spaces escaped');
  assert.equal(openedBy([], {}).size, 0);
});

test('sourceTexts: a pdf\'s and an address-only page\'s kept text as a file, written once, replaced when read again; a scan has none', async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-source-text-'));
  const db = fakeDb({ p1: { text: 'the paper text', mtime: 100 }, w1: { text: 'the page text', mtime: 200 }, scan: { text: '', mtime: 5 }, n1: { text: 'note', mtime: 1 } });
  const rows = [
    { id: 'p1', type: 'pdf', path: '/x/paper.pdf' },
    { id: 'w1', type: 'website', url: 'https://example.org/page', path: null },
    { id: 'scan', type: 'pdf', path: '/x/scan.pdf' },
    { id: 'n1', type: 'md', path: '/x/note.md' },
    { id: 'p2', type: 'pdf', path: '/x/unread.pdf' },
  ];
  const ctx = { dataRoot, libraryDb: db };
  const first = await sourceTexts(ctx, rows);
  assert.deepEqual([...first.keys()].sort(), ['p1', 'w1']);
  assert.equal(fs.readFileSync(first.get('p1'), 'utf8'), 'the paper text');
  assert.equal(path.dirname(first.get('w1')), textDir(dataRoot));
  db.asked.length = 0;
  assert.deepEqual(await sourceTexts(ctx, rows), first);
  assert.deepEqual(db.asked, [['scan']], 'only what has no file yet is asked for again');
  await db.setText('p1', 'read again', 300);
  const again = await sourceTexts(ctx, rows);
  assert.equal(fs.readFileSync(again.get('p1'), 'utf8'), 'read again');
  assert.equal(fs.existsSync(first.get('p1')), false, 'the old file goes');
  assert.deepEqual(await sourceTexts({ dataRoot, libraryDb: {} }, rows), new Map(), 'a db without texts: none');
});

test('keepPageTexts: an address-only page Chat read is fetched and kept once; one not read, or already kept, is not', async () => {
  const db = fakeDb({ old: { text: 'kept before', mtime: 1 } });
  const rows = [
    { id: 'read', type: 'website', url: 'https://example.org/read', path: null },
    { id: 'unread', type: 'website', url: 'https://example.org/unread', path: null },
    { id: 'old', type: 'website', url: 'https://example.org/old', path: null },
    { id: 'saved', type: 'html', url: 'https://example.org/saved', path: '/x/index.html' },
  ];
  const fetched = [];
  const fetch = async (url) => {
    fetched.push(url);
    return { ok: true, headers: new Map([['content-type', 'text/html; charset=utf-8']]), text: async () => '<html><head><title>T</title><script>x()</script></head><body><h1>Read</h1><p>A page <b>worth</b> quoting.</p></body></html>' };
  };
  const opened = new Set(['https://example.org/read', 'https://example.org/old', 'https://example.org/saved'].map(openedKey));
  assert.equal(await keepPageTexts({ libraryDb: db }, rows, opened, { fetch }), 1);
  assert.deepEqual(fetched, ['https://example.org/read']);
  assert.equal(db.texts.get('read').text, 'Read\n\nA page worth quoting.');
  assert.equal(db.texts.get('old').text, 'kept before');
  const failing = async () => ({ ok: false, headers: new Map(), text: async () => '' });
  const db2 = fakeDb();
  assert.equal(await keepPageTexts({ libraryDb: db2 }, rows, opened, { fetch: failing }), 0);
  assert.equal(db2.texts.size, 0, 'a page that cannot be had keeps nothing');
});

test('noteTexts: every item with ink gets its highlights and notes as a file, word for word, rewritten when the ink changes', async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-note-text-'));
  const inkDir = path.join(dataRoot, 'annotations');
  fs.mkdirSync(path.join(inkDir, 'pages'), { recursive: true });
  const paper = { id: '11111111-1111-4111-8111-111111111111', type: 'pdf', name: 'Augmenting "Human" Intellect', path: '/x/augment.pdf' };
  const page = { id: '22222222-2222-4222-8222-222222222222', type: 'website', name: 'Cocoa', url: 'https://github.com/kjfeng/cocoa-canvas', path: null };
  const bare = { id: '33333333-3333-4333-8333-333333333333', type: 'pdf', name: 'Unmarked', path: '/x/unmarked.pdf' };
  const emptied = { id: '44444444-4444-4444-8444-444444444444', type: 'pdf', name: 'Wiped', path: '/x/wiped.pdf' };
  const note = 'What does operating by association\nmean in practice?';
  fs.writeFileSync(path.join(inkDir, `${paper.id}.json`), JSON.stringify({
    15: [{ id: 'm2', y: 0.1, text: 'all his books, records', note: null }],
    14: [{ id: 'm1', y: 0.7, text: 't operates by association', note }, { id: 'm0', y: 0.2, text: '', note: null }],
  }));
  // A page's ink from before the library held it, kept by its address
  const pageInk = path.join(inkDir, 'pages', `${createHash('sha256').update(addressKey(page.url)).digest('hex')}.json`);
  fs.writeFileSync(pageInk, JSON.stringify({ web: [{ id: 'm3', quote: { exact: 'a canvas for co-planning' }, note: 'like our Stage' }] }));
  fs.writeFileSync(path.join(inkDir, `${emptied.id}.json`), JSON.stringify({ 1: [{ id: 'm4', y: 0, text: 'gone soon', note: 'x' }] }));
  const ctx = { dataRoot };
  const rows = [paper, page, bare, emptied, { id: 'not-a-row', type: 'pdf' }];

  const first = await noteTexts(ctx, rows);
  assert.deepEqual([...first.keys()].sort(), [paper.id, page.id, emptied.id].sort());
  assert.equal(path.dirname(first.get(paper.id)), notesDir(dataRoot));
  const paperText = fs.readFileSync(first.get(paper.id), 'utf8');
  assert.ok(paperText.startsWith('<paper name="Augmenting  Human  Intellect" path="/x/augment.pdf">\n'), paperText);
  assert.ok(paperText.includes(`<note>\n${note}\n</note>`), 'the note word for word');
  assert.ok(paperText.indexOf('page="14"') < paperText.indexOf('page="15"'), 'in page order');
  assert.ok(!paperText.includes('m0'), 'a mark with nothing in it is left out');
  assert.match(fs.readFileSync(first.get(page.id), 'utf8'), /^<page source="web" title="Cocoa" address="https:\/\/github.com\/kjfeng\/cocoa-canvas">\n<highlight>\n<quote>\na canvas for co-planning\n<\/quote>\n<note>\nlike our Stage\n<\/note>\n<\/highlight>\n<\/page>\n$/);

  const written = fs.statSync(first.get(paper.id)).mtimeMs;
  assert.deepEqual(await noteTexts(ctx, rows), first, 'the same files, not written again');
  assert.equal(fs.statSync(first.get(paper.id)).mtimeMs, written);

  const later = new Date(Date.now() + 5000);
  fs.writeFileSync(path.join(inkDir, `${paper.id}.json`), JSON.stringify({ 2: [{ id: 'm5', y: 0, text: 'new words', note: 'a new note' }] }));
  fs.utimesSync(path.join(inkDir, `${paper.id}.json`), later, later);
  fs.writeFileSync(path.join(inkDir, `${emptied.id}.json`), JSON.stringify({ 1: [] }));
  fs.utimesSync(path.join(inkDir, `${emptied.id}.json`), later, later);
  const again = await noteTexts(ctx, rows);
  assert.notEqual(again.get(paper.id), first.get(paper.id));
  assert.match(fs.readFileSync(again.get(paper.id), 'utf8'), /a new note/);
  assert.equal(fs.existsSync(first.get(paper.id)), false, 'the old file goes');
  assert.equal(again.has(emptied.id), false, 'ink with no highlight left: no notes');
  assert.equal(fs.existsSync(first.get(emptied.id)), false);
  assert.deepEqual(await noteTexts({}, rows), new Map(), 'no data root: none');
});

test('catalogEntries: an item with notes names its notes file; the others have no notes', () => {
  const { catalogEntries } = require('../src/main/bart/context.cjs');
  const project = { dir: '/p' };
  const rows = [{ id: 'a', name: 'A', type: 'pdf', path: '/x/a.pdf' }, { id: 'b', name: 'B', type: 'pdf', path: '/x/b.pdf' }];
  const entries = catalogEntries(project, rows, new Set(), { agent: 'bart', madeIn: new Map() }, new Map([['a', '/d/assets/text/a-1.txt']]), new Map([['a', '/d/assets/notes/a-2.txt']]));
  assert.equal(entries[0].text, '/d/assets/text/a-1.txt');
  assert.equal(entries[0].notes, '/d/assets/notes/a-2.txt');
  assert.equal('notes' in entries[1], false);
  assert.equal('notes' in catalogEntries(project, rows, new Set(), { agent: 'bart', madeIn: new Map() })[0], false);
});
