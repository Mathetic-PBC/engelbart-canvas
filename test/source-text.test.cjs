'use strict';

// What Chat reads of a source it cannot open as it is, and what it read while answering (2026-10-22,
// src/main/bart/source-text.cjs).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { sourceTexts, openedBy, openedKey, keepPageTexts, textDir } = require('../src/main/bart/source-text.cjs');

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
