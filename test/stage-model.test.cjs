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

test('placeTab with newTab (a ⌘-click): a tab of its own though one shows it; still the blank tab in front; still 15 at most', async () => {
  const { placeTab, linkPlan, MAX_TABS } = await load('stage');
  const key = linkPlan('https://github.com/mqo00/rope', library).key;
  const rope = { url: 'https://github.com/mqo00/rope' };
  assert.deepEqual(placeTab([rope], 0, key), { focus: 0 }, 'a plain click: the tab that has it comes forward');
  assert.deepEqual(placeTab([rope], 0, key, { newTab: true }), { append: true }, 'a ⌘-click: a second tab');
  assert.deepEqual(placeTab([{ item: 'p1' }], 0, 'i:p1', { newTab: true }), { append: true }, 'a library row too');
  assert.deepEqual(placeTab([rope, { url: 'about:blank' }], 1, key, { newTab: true }), { replace: 1 }, 'the blank tab in front takes it');
  assert.deepEqual(placeTab([{ url: 'about:blank', claimed: true }], 0, key, { newTab: true }), { append: true }, 'not one something is on its way into');
  const full = Array.from({ length: MAX_TABS }, (_, i) => (i === 2 ? rope : { url: `https://s${i}.org` }));
  assert.deepEqual(placeTab(full, 4, key, { newTab: true }), { replace: 4 }, 'at 15 the tab in front is replaced, as a plain click on a new link does');
  assert.deepEqual(placeTab(full, 4, key), { focus: 2 }, 'a plain click still brings the open one forward');
  assert.deepEqual(placeTab([rope], 0, key, {}), { focus: 0 }, 'without newTab, as before');
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

/* ------------------------------------------------- a link's passage (2026-09-30, @discover's guide: #find=) */

test('splitTarget: #find= is the passage, percent-decoded; any other fragment stays on the address', async () => {
  const { splitTarget } = await load('stage');
  assert.deepEqual(splitTarget('https://arxiv.org/pdf/2312.10893#find=We%20argue%20that%20GenAI'), { address: 'https://arxiv.org/pdf/2312.10893', find: 'We argue that GenAI', to: '' });
  assert.deepEqual(splitTarget('https://arxiv.org/pdf/2312.10893'), { address: 'https://arxiv.org/pdf/2312.10893', find: '', to: '' }, 'no fragment');
  assert.deepEqual(splitTarget('https://x.org/a.pdf#page=3'), { address: 'https://x.org/a.pdf#page=3', find: '', to: '' }, 'another fragment is the address\'s');
  assert.deepEqual(splitTarget('https://x.org/guide#section-2'), { address: 'https://x.org/guide#section-2', find: '', to: '' });
  assert.deepEqual(splitTarget('/Users/h/Downloads/My%20Paper.pdf#find=the%20%20first%0Asentence%20'), { address: '/Users/h/Downloads/My Paper.pdf', find: 'the first sentence', to: '' }, 'a path: decoded, so it is the file; the words: spaces run together');
  assert.deepEqual(splitTarget('/Users/h/ColBERT.pdf#find=late%20interaction'), { address: '/Users/h/ColBERT.pdf', find: 'late interaction', to: '' });
  assert.deepEqual(splitTarget('https://x.org/a#find=100%'), { address: 'https://x.org/a', find: '100%', to: '' }, 'a stray % is kept as written');
  assert.deepEqual(splitTarget('https://x.org/a#find='), { address: 'https://x.org/a', find: '', to: '' });
  assert.deepEqual(splitTarget(null), { address: '', find: '', to: '' });
});

test('splitTarget: &to= is where the section ends, each value decoded after the split (@discover round 2)', async () => {
  const { splitTarget } = await load('stage');
  assert.deepEqual(splitTarget('https://arxiv.org/pdf/2312.10893#find=We%20argue%20that'), { address: 'https://arxiv.org/pdf/2312.10893', find: 'We argue that', to: '' }, 'find only: as before');
  assert.deepEqual(splitTarget('https://arxiv.org/pdf/2312.10893#find=We%20argue%20that&to=In%20this%20section%20we'), { address: 'https://arxiv.org/pdf/2312.10893', find: 'We argue that', to: 'In this section we' });
  assert.deepEqual(splitTarget('/Users/h/My%20Paper.pdf#find=search%20%26%20rank&to=Q%26A%20systems'), { address: '/Users/h/My Paper.pdf', find: 'search & rank', to: 'Q&A systems' }, 'an encoded & stays in the words');
  assert.deepEqual(splitTarget('https://x.org/a.pdf#page=3&to=x'), { address: 'https://x.org/a.pdf#page=3&to=x', find: '', to: '' }, 'another fragment is still the address\'s');
  assert.deepEqual(splitTarget('https://x.org/a#find=a%20b&to='), { address: 'https://x.org/a', find: 'a b', to: '' }, 'an empty to is none');
});

test('linkPlan: a passage to a library paper opens its row; other links open their address in the tab that has it, or a new one', async () => {
  const { linkPlan, placeTab, tabKey } = await load('stage');
  assert.deepEqual(linkPlan('/Users/h/ColBERT.pdf#find=late%20interaction', library), { address: '/Users/h/ColBERT.pdf', find: 'late interaction', to: '', row: library[2], key: 'i:p1' }, 'by its path');
  assert.equal(linkPlan('file:///Users/h/ColBERT.pdf#find=x', library).row, library[2], 'by its file: address');
  assert.equal(linkPlan('https://anthropic.com/engineering/contextual-retrieval#find=x', library).row, library[3], 'by its url, however spelled');
  assert.equal(linkPlan('/Users/h/.engelbart/p/Saving.md#find=x', library).row, null, 'never a note: notes open in the middle');
  assert.equal(linkPlan('/Users/h/ColBERT.pdf', library).row, null, 'no passage: the link opens as it always did');
  assert.deepEqual(linkPlan('https://arxiv.org/pdf/2312.10893#find=We%20argue', library), { address: 'https://arxiv.org/pdf/2312.10893', find: 'We argue', to: '', row: null, key: 'l:arxiv.org/pdf/2312.10893' });
  assert.equal(linkPlan('/Users/h/ColBERT.pdf#find=late%20interaction&to=Next%20we', library).to, 'Next we', 'the section\'s end goes with the passage');
  assert.equal(linkPlan('/Users/h/elsewhere.pdf', library).key, '', 'a path without a passage: a tab of its own, as before');
  assert.equal(linkPlan('/Users/h/My Paper.pdf#find=x', library).key, tabKey({ url: 'about:blank', pdf: { url: 'file:///Users/h/My%20Paper.pdf' } }), 'with one, the tab that has the file (as main spells it) comes forward');

  // openInput: a new tab for a paper not open, the same tab for a second passage in it.
  const fresh = linkPlan('https://arxiv.org/pdf/2312.10893#find=We%20argue', library);
  const blank = { url: 'about:blank' };
  const page = { url: 'https://example.org' };
  assert.deepEqual(placeTab([page], 0, fresh.key), { append: true }, 'not open: a new tab');
  const open = { url: 'about:blank', pdf: { url: 'https://arxiv.org/pdf/2312.10893' } };
  assert.deepEqual(placeTab([page, open], 0, linkPlan('https://arxiv.org/pdf/2312.10893#find=In%20Section%205', library).key), { focus: 1 }, 'open already: that tab comes forward (and takes the new passage)');
  assert.deepEqual(placeTab([blank], 0, fresh.key), { replace: 0 }, 'a blank tab in front is used');
  assert.deepEqual(placeTab([{ item: 'p1', url: 'about:blank' }], 0, linkPlan('/Users/h/ColBERT.pdf#find=x', library).key), { focus: 0 }, 'a library paper open already: its tab');
});

test('nextFind: a passage counts from page 1; nothing matching scrolls nowhere; searches and steps as before', async () => {
  const { nextFind } = await import(pathToFileURL(path.join(__dirname, '../src/renderer/model/find.js')).href);
  const inView = () => 4;
  assert.deepEqual(nextFind({ fresh: true, count: 9, at: -1, fromStart: true, firstInView: inView }), { at: 0, scroll: true }, 'a link\'s passage: the first match in the paper, scrolled to');
  assert.deepEqual(nextFind({ fresh: false, count: 9, at: 6, fromStart: true, firstInView: inView }), { at: 0, scroll: true }, 'the same words again from a link: from page 1 again');
  assert.deepEqual(nextFind({ fresh: true, count: 0, at: -1, fromStart: true }), { at: -1, scroll: false }, 'no match: nothing in front, the scroll left alone');
  assert.deepEqual(nextFind({ fresh: true, count: 9, at: -1, firstInView: inView }), { at: 4, scroll: true }, '⌘F: the first match in view');
  assert.deepEqual(nextFind({ fresh: true, step: -1, count: 9, at: -1 }), { at: 8, scroll: true });
  assert.deepEqual(nextFind({ fresh: false, step: 1, count: 9, at: 8 }), { at: 0, scroll: true }, 'wraps');
  assert.deepEqual(nextFind({ fresh: false, step: 0, count: 3, at: 7 }), { at: 2, scroll: false }, 'a re-layout keeps its place, unscrolled');
});

test('the target gate: a passage is found once, after drawing; a re-layout does not find it again; given again, it is', async () => {
  const { createTargetGate } = await import(pathToFileURL(path.join(__dirname, '../src/renderer/model/find.js')).href);
  const gate = createTargetGate();
  assert.equal(gate.set('We argue that'), null, 'not drawn yet: it waits');
  gate.drawing();
  assert.equal(gate.drawn(), 'We argue that', 'every page drawn: found now');
  gate.drawing();
  assert.equal(gate.drawn(), null, 'a zoom redraws: not found again');
  assert.equal(gate.set('In Section 5 we'), 'In Section 5 we', 'a second link to the drawn paper: found at once');
  assert.equal(gate.set(null), null, 'the Stage clears it once found');
  assert.equal(gate.set('In Section 5 we'), 'In Section 5 we', 'the same link clicked again: found again');
  gate.drawing();
  assert.equal(gate.set('Mid-draw words'), null, 'given while drawing: waits for the end');
  assert.equal(gate.drawn(), 'Mid-draw words');
  assert.equal(createTargetGate().drawn(), null, 'no target: nothing to find');
});

test('sectionSpans: a link\'s section, one stretch a page, from the start words to just before the next section (@discover round 2)', async () => {
  const { sectionSpans, SECTION_PAGES } = await load('find');
  const start = { page: 2, from: 100, to: 140 };
  assert.deepEqual(sectionSpans(start, [{ page: 2, from: 900 }]), [{ page: 2, from: 100, to: 900 }], 'on one page');
  assert.deepEqual(sectionSpans(start, [{ page: 1, from: 50 }, { page: 2, from: 20 }, { page: 4, from: 300 }]), [{ page: 2, from: 100, to: null }, { page: 3, from: 0, to: null }, { page: 4, from: 0, to: 300 }], 'across three pages, from the first match after the start; the end words left out');
  assert.equal(sectionSpans(start, []), null, 'to missing: the start words alone');
  assert.equal(sectionSpans(start, [{ page: 1, from: 10 }, { page: 2, from: 120 }]), null, 'to only before the start (or inside it): missing too');
  assert.equal(SECTION_PAGES, 6);
  assert.equal(sectionSpans(start, [{ page: 2 + SECTION_PAGES + 1, from: 0 }]), null, 'more than six pages on: too far');
  assert.equal(sectionSpans(start, [{ page: 2 + SECTION_PAGES, from: 40 }]).length, SECTION_PAGES + 1, 'six pages on is still a section');
  assert.equal(sectionSpans(null, [{ page: 2, from: 900 }]), null, 'no start, no section');
});

test('the section is painted under find\'s colours and goes when find stops; it is never ink', async () => {
  const { paintSection, clearFind, FIND, FIND_ACTIVE, SECTION } = await load('find');
  class Fake { constructor(...ranges) { this.ranges = ranges; this.priority = 0; } }
  const registry = new Map([[FIND, new Fake('a')], [FIND_ACTIVE, new Fake('b')]]);
  paintSection(registry, ['r1', 'r2'], Fake);
  assert.deepEqual([registry.get(SECTION).ranges, registry.get(SECTION).priority < 0], [['r1', 'r2'], true]);
  paintSection(registry, [], Fake);
  assert.equal(registry.has(SECTION), false, 'nothing to tint: none left over');
  paintSection(registry, ['r1'], Fake);
  clearFind(registry);
  assert.deepEqual([...registry.keys()], [], 'cleared with find');
  assert.doesNotThrow(() => { clearFind(null); paintSection(null, ['r'], Fake); }, 'no Highlight API: nothing painted, nothing thrown');
});

test('wheelZooms: a pinch (ctrlKey), ⌃ scroll and ⌘ scroll zoom the paper; plain, ⇧ and ⌥ scroll do not', async () => {
  const { wheelZooms } = await load('paper-zoom');
  assert.equal(wheelZooms({ ctrlKey: true, deltaY: -3 }), true, 'a trackpad pinch arrives with ctrlKey');
  assert.equal(wheelZooms({ metaKey: true, deltaY: -100 }), true, '⌘ scroll');
  assert.equal(wheelZooms({ ctrlKey: true, metaKey: true, deltaY: 4 }), true);
  assert.equal(wheelZooms({ deltaY: 40 }), false, 'plain scroll scrolls');
  assert.equal(wheelZooms({ shiftKey: true, deltaY: 40 }), false);
  assert.equal(wheelZooms({ altKey: true, deltaY: 40 }), false);
  assert.equal(wheelZooms(null), false);
});

test('wheelZoom: one mouse-wheel notch is a modest step around ×1.65, a pinch moves a little, both stay within the ends', async () => {
  const { wheelZoom } = await load('paper-zoom');
  const near = (a, b) => Math.abs(a - b) < 1e-9;
  assert.ok(near(wheelZoom(1, { deltaY: -100, deltaMode: 0 }, 0.15, 2), Math.exp(0.5)), 'a ⌘ notch up: ×1.65, not ×2.7');
  assert.ok(near(wheelZoom(1, { deltaY: 100, deltaMode: 0 }, 0.15, 2), Math.exp(-0.5)), 'a notch down: ÷1.65');
  assert.ok(near(wheelZoom(1, { deltaY: -3, deltaMode: 1 }, 0.15, 2), Math.exp(0.48)), 'three lines (deltaMode 1) count as 48px');
  assert.ok(near(wheelZoom(1, { deltaY: -4, deltaMode: 0 }, 0.15, 2), Math.exp(0.04)), 'a pinch event: a few percent');
  assert.equal(wheelZoom(1.9, { deltaY: -100, deltaMode: 0 }, 0.15, 2), 2, 'not past the largest zoom');
  assert.equal(wheelZoom(0.2, { deltaY: 100, deltaMode: 0 }, 0.15, 2), 0.15, 'nor the smallest');
  assert.equal(wheelZoom(1.3, { deltaY: 0, deltaMode: 0 }, 0.15, 2), 1.3, 'sideways only: no change');
});

test('createPageCache: each page\'s text is asked for once a document, shared while pending, asked again after a failure', async () => {
  const { createPageCache } = await load('paper-zoom');
  const asked = [];
  let fail = true;
  const cache = createPageCache(async (n) => { asked.push(n); if (n === 3 && fail) throw new Error('worker gone'); return { items: [n] }; });
  const [a, b] = [cache.get(1), cache.get(1)];
  assert.equal(a, b, 'two layouts asking at once share one request');
  assert.deepEqual(await a, { items: [1] });
  assert.equal(await cache.get(1), await a, 'a later zoom reuses it');
  await assert.rejects(cache.get(3), /worker gone/);
  fail = false;
  assert.deepEqual(await cache.get(3), { items: [3] }, 'a failed page is asked for again');
  assert.deepEqual(asked, [1, 3, 3]);
  assert.notEqual(createPageCache(async () => ({})).get(1), a, 'a new document starts empty');
});
