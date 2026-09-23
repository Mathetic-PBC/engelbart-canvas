'use strict';

// The Stage's pure parts (Add - Mention Stage.dc.html, 2026-09-23): where an opened thing lands, what the address field
// suggests, how tables and markdown are read.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = (name) => import(pathToFileURL(path.join(__dirname, `../src/renderer/model/${name}.js`)).href);

const row = (id, name, type, tags = [], more = {}) => ({ id, name, type, tags, ...more });
const library = [
  row('n1', 'Saving and importing', 'md', ['note'], { path: '/Users/h/.engelbart/p/Saving.md' }),
  row('m1', 'README.md', 'md', [], { path: '/Users/h/code/README.md' }),
  row('p1', 'ColBERT', 'pdf', ['paper'], { path: '/Users/h/ColBERT.pdf' }),
  row('w1', 'Contextual Retrieval', 'website', [], { url: 'https://www.anthropic.com/engineering/contextual-retrieval' }),
  row('c1', 'problems.csv', 'csv', [], { path: '/Users/h/problems.csv' }),
  row('f1', 'fixtures', 'folder', [], { folder_path: '/Users/h/fixtures' }),
  row('g1', 'o/r', 'folder', ['git'], { folder_path: '/Users/h/r', url: 'https://github.com/o/r' }),
];

test('tabKey and addressKey: one page however it is spelled; the library row wins over where it is', async () => {
  const { tabKey, addressKey } = await load('stage');
  assert.equal(addressKey('https://www.Example.org/a/#x'), addressKey('http://example.org/a'));
  assert.notEqual(addressKey('https://example.org/a?id=1'), addressKey('https://example.org/a?id=2'));
  assert.equal(tabKey({ url: 'about:blank' }), '');
  assert.equal(tabKey({ item: 'p1', url: 'https://x.org' }), 'i:p1');
  assert.equal(tabKey({ url: 'about:blank', pdf: { url: 'https://x.org/a.pdf' } }), 'l:x.org/a.pdf');
  assert.equal(tabKey({ url: 'about:blank', file: { path: '/Users/h/a.md' } }), 'l:file:///Users/h/a.md');
});

test('placeTab: what is open comes forward; a blank tab in front is used; at 15 the tab in front is replaced', async () => {
  const { placeTab, MAX_TABS } = await load('stage');
  const tabs = [{ url: 'https://a.org' }, { url: 'about:blank' }, { item: 'p1' }];
  assert.deepEqual(placeTab(tabs, 0, 'i:p1'), { focus: 2 });
  assert.deepEqual(placeTab(tabs, 1, 'l:b.org'), { replace: 1 });
  assert.deepEqual(placeTab(tabs, 0, 'l:b.org'), { append: true });
  const full = Array.from({ length: MAX_TABS }, (_, i) => ({ url: `https://s${i}.org` }));
  assert.deepEqual(placeTab(full, 4, 'l:new.org'), { replace: 4 });
  assert.equal(MAX_TABS, 15);
  // a blank-looking tab that holds a pdf or a file is not free
  assert.deepEqual(placeTab([{ url: 'about:blank', pdf: { url: '' } }], 0, 'l:b.org'), { append: true });
  // nor is one something was just sent to (files picked together land in tabs of their own)
  assert.deepEqual(placeTab([{ url: 'about:blank', claimed: true }], 0, 'l:b.org'), { append: true });
});

test('afterClose: the tab to the right comes forward, else the one to the left; none left is -1', async () => {
  const { afterClose } = await load('stage');
  assert.equal(afterClose(3, 1, 1), 1);
  assert.equal(afterClose(3, 2, 2), 1);
  assert.equal(afterClose(3, 2, 0), 1);
  assert.equal(afterClose(3, 0, 2), 0);
  assert.equal(afterClose(1, 0, 0), -1);
});

test('tabPlace: a site for a page, the path for a file', async () => {
  const { tabPlace } = await load('stage');
  assert.equal(tabPlace('https://www.anthropic.com/engineering/x'), 'anthropic.com');
  assert.equal(tabPlace('file:///Users/h/a%20b.md'), '/Users/h/a b.md');
  assert.equal(tabPlace('~/x.pdf'), '~/x.pdf');
  assert.equal(tabPlace('about:blank'), '');
});

test('looksLikePlace: addresses, bare hosts, ports and paths go; words are searched', async () => {
  const { looksLikePlace } = await load('stage');
  for (const yes of ['https://a.org', 'example.com', 'example.com/a/b', 'localhost:3000', ':5173', '3000', '~/x.pdf', '/Users/h/a.csv', 'report.html', 'docs/a.md', 'file:///Users/h/a.md', '2310.05292']) assert.equal(looksLikePlace(yes), true, yes);
  for (const no of ['', 'colbert', 'contextual retrieval', 'what is rag']) assert.equal(looksLikePlace(no), false, no);
});

test('stageRows: never notes; here first, then the library; a web search for words; a file from the computer last', async () => {
  const { stageRows } = await load('stage');
  const inRail = (id) => ['n1', 'p1'].includes(id);
  const empty = stageRows({ query: '', library, inRail });
  assert.deepEqual(empty.map((r) => r.key), ['p1', 'm1', 'w1', 'c1', 'g1', 'disk']);
  assert.equal(empty[0].here, true);
  const words = stageRows({ query: 'saving', library, inRail });
  assert.deepEqual(words.map((r) => r.kind), ['search', 'disk']);
  const hit = stageRows({ query: 'colb', library, inRail });
  assert.deepEqual(hit.map((r) => r.key), ['p1', 'search:colb', 'disk']);
});

test('stageRows: a typed place is one row — the library row for it when the library has one', async () => {
  const { stageRows } = await load('stage');
  const inRail = () => false;
  assert.deepEqual(stageRows({ query: 'https://x.org/a.pdf', library, inRail }).map((r) => r.kind), ['place', 'disk']);
  const known = stageRows({ query: 'https://www.anthropic.com/engineering/contextual-retrieval', library, inRail, found: { row: library[3] } });
  assert.equal(known[0].kind, 'item');
  assert.equal(known[0].row.id, 'w1');
  // a note found by its path still opens in the middle, so it is not offered here
  assert.equal(stageRows({ query: '/Users/h/.engelbart/p/Saving.md', library, inRail, found: { row: library[0] } })[0].kind, 'place');
});

test('parseTable: quotes, doubled quotes, delimiters and line breaks inside quotes, tabs, CRLF, a limit', async () => {
  const { parseTable } = await load('stage');
  assert.deepEqual(parseTable('a,b\n1,"x, y"\n2,"say ""hi"""\n'), [['a', 'b'], ['1', 'x, y'], ['2', 'say "hi"']]);
  assert.deepEqual(parseTable('a\tb\r\n1\t2', '\t'), [['a', 'b'], ['1', '2']]);
  assert.deepEqual(parseTable('a\n"line\nbreak"'), [['a'], ['line\nbreak']]);
  assert.equal(parseTable('1\n2\n3\n4', ',', 2).length, 2);
});

test('markdownBlocks: headings, paragraphs joined, nested items with boxes, quotes, fenced code, rules', async () => {
  const { markdownBlocks } = await load('markdown');
  const blocks = markdownBlocks('# Title\n\nOne\ntwo\n\n- a\n  - [x] b\n1. c\n> q1\n> q2\n```js\nx # not a heading\n```\n---\n');
  assert.deepEqual(blocks, [
    { type: 'h', level: 1, text: 'Title' },
    { type: 'p', text: 'One two' },
    { type: 'li', ordered: false, marker: '-', depth: 0, checked: null, text: 'a' },
    { type: 'li', ordered: false, marker: '-', depth: 1, checked: true, text: 'b' },
    { type: 'li', ordered: true, marker: '1.', depth: 0, checked: null, text: 'c' },
    { type: 'quote', text: 'q1 q2' },
    { type: 'code', lang: 'js', text: 'x # not a heading' },
    { type: 'hr' },
  ]);
});

test('inlineRuns: bold, italic, code, links and bare addresses; html stays text', async () => {
  const { inlineRuns } = await load('markdown');
  assert.deepEqual(inlineRuns('a **b** *c* `d` [e](https://e.org) https://f.org/x. <b>g</b>'), [
    { text: 'a ' }, { text: 'b', bold: true }, { text: ' ' }, { text: 'c', italic: true }, { text: ' ' }, { text: 'd', code: true }, { text: ' ' },
    { text: 'e', href: 'https://e.org' }, { text: ' ' }, { text: 'https://f.org/x', href: 'https://f.org/x' }, { text: '. <b>g</b>' },
  ]);
});
