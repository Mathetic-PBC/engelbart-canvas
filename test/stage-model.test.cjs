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
  assert.deepEqual(placeTab([rope], 0, key, { newTab: false }), { focus: 0 }, 'newTab: false is the same as none');
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
  assert.deepEqual(empty.map((r) => r.key), ['p1', 'm1', 'w1', 'c1', 'f1', 'g1', 'disk']);
  assert.equal(empty[0].here, true);
  const words = stageRows({ query: 'saving', library, inRail });
  assert.deepEqual(words.map((r) => r.kind), ['search', 'disk']);
  const hit = stageRows({ query: 'colb', library, inRail });
  assert.deepEqual(hit.map((r) => r.key), ['p1', 'search:colb', 'disk']);
});

test('onStage: files, addresses and folders open on the Stage, a plain folder too; notes and workspaces do not (2026-10-02)', async () => {
  const { onStage } = await load('stage');
  const by = (id) => library.find((r) => r.id === id);
  for (const id of ['m1', 'p1', 'w1', 'c1', 'f1', 'g1']) assert.equal(onStage(by(id)), true, id);
  assert.equal(onStage(by('n1')), false, 'a note opens in the middle');
  assert.equal(onStage(row('x1', 'nowhere', 'folder')), false, 'a folder with no folder and no address');
  assert.equal(onStage(row('ws', 'Reading', 'workspace')), false);
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

// An @discover guide (main/bart/discover-system-prompt.cjs "The guide"): each entry a title, then a Read line of one or two sections.
const PAPER = 'https://arxiv.org/pdf/2312.10893';
const OTHER = 'https://dl.acm.org/doi/pdf/10.1145/3544548.3581225';
const GUIDE = [
  '## Prior work on reading support',
  `**[CiteSee](${PAPER})** · Chang et al. · 2023`,
  `**Read:** [3.2 Design Goals](${PAPER}#find=We%20set%20three%20goals&to=The%20system%20has) and [5 Evaluation](${PAPER}#find=We%20ran%20a%20study)`,
  '**Why:** it decides what to show first.',
  `**[Scim](${OTHER})** · Fok et al. · 2023`,
  `**Read:** [4 Faceted highlights](${OTHER}#find=Scim%20colours&to=Our%20study)`,
  `Then back to [3.2 Design Goals, again](${PAPER}#find=We%20set%20three%20goals&to=The%20system%20has), and \`[not a link](${PAPER}#find=in%20code)\`.`,
];

test('guideSections: an @discover reply\'s links to one paper, in order, each once; other papers and title links left out (2026-10-03)', async () => {
  const { guideSections } = await load('stage');
  assert.deepEqual(guideSections(GUIDE, PAPER), [
    { label: '3.2 Design Goals', find: 'We set three goals', to: 'The system has' },
    { label: '5 Evaluation', find: 'We ran a study', to: '' },
  ], 'two sections of the same paper; the title link (no passage), the repeat and the code span are not sections');
  assert.deepEqual(guideSections(GUIDE, OTHER), [{ label: '4 Faceted highlights', find: 'Scim colours', to: 'Our study' }], 'another paper: its own');
  assert.deepEqual(guideSections(['**Why:** nothing to read here.', `**[CiteSee](${PAPER})**`], PAPER), [], 'a reply with none');
  assert.deepEqual(guideSections([], PAPER), []);
  assert.deepEqual(guideSections(GUIDE, ''), [], 'no address, no sections');
  assert.deepEqual(guideSections([`**Read:** [Intro](/Users/h/My%20Paper.pdf#find=In%20this%20paper)`], '/Users/h/My Paper.pdf'), [{ label: 'Intro', find: 'In this paper', to: '' }], 'a path, as splitTarget spells it');
});

test('guideSections: a named paper\'s entry ("## This paper", 2026-10-04) gives all four of its sections, one Read line each, in the guide\'s order', async () => {
  const { guideSections } = await load('stage');
  const lib = '/Users/h/My Paper.pdf', at = '/Users/h/My%20Paper.pdf';
  const named = [
    '## This paper', '',
    `**[My Paper](${at})** · Ng et al. · 2024`,
    `**Read:** [5 Findings](${at}#find=Across%20four%20deployments&to=We%20discuss)`, '**Why:** a measurement.',
    `**Read:** [3.2 Pipeline](${at}#find=Each%20event%20is%20segmented&to=3.3%20Metrics%20are)`, '**Why:** a method.',
    `**Read:** [6 Limitations](${at}#find=Our%20courses%20were%20introductory&to=We%20presented)`, '**Why:** a case that cuts against it.',
    `**Read:** [4 Taxonomy](${at}#find=We%20derive%20three%20layers)`, '**Why:** a term for it.',
    '', '## Classics', '',
    `**[Older](${PAPER})** · Chang et al. · 2019`, `**Read:** [2 Method](${PAPER}#find=We%20built)`, '**Why:** a design.',
  ];
  assert.deepEqual(guideSections(named, lib), [
    { label: '5 Findings', find: 'Across four deployments', to: 'We discuss' },
    { label: '3.2 Pipeline', find: 'Each event is segmented', to: '3.3 Metrics are' },
    { label: '6 Limitations', find: 'Our courses were introductory', to: 'We presented' },
    { label: '4 Taxonomy', find: 'We derive three layers', to: '' },
  ], 'all four, best first as written, the last without an end');
  assert.deepEqual(guideSections(named, PAPER).map((s) => s.label), ['2 Method'], 'a traced paper keeps its own');
});

test('a guide\'s sections on the tab: given with the passage, the clicked one in front; a second link replaces them; landing in a pdf opens no find card', async () => {
  const { withPassage, landTab, landingFinds, sectionAt } = await load('stage');
  const sections = [{ label: '3.2 Design Goals', find: 'We set three goals', to: 'The system has' }, { label: '5 Evaluation', find: 'We ran a study', to: '' }];
  const tab = withPassage({ id: 't1', pendingFind: null, pendingTo: null }, 'We ran a study', '', sections);
  assert.deepEqual([tab.pendingFind, tab.pendingTo, tab.sections, tab.activeSection], ['We ran a study', null, sections, 1]);
  assert.equal(sectionAt(sections, 'We set three goals', 'The system has'), 0);
  assert.equal(sectionAt(sections, 'We set three goals', ''), -1, 'the same start, another end: not that section');
  const drawn = { ...tab, pdf: { seq: 1 } };
  const landed = landTab(drawn, 'We ran a study');
  assert.deepEqual([landed.pendingFind, landed.pendingTo, landed.activeSection], [null, null, 1], 'found: it waits no longer, its section in front');
  assert.equal(landingFinds(landed), false, 'a pdf with a guide\'s sections: no find card');
  assert.equal(landTab(drawn, 'Another passage'), drawn, 'a passage the tab no longer waits for changes nothing');
  const again = withPassage(landed, 'Scim colours', 'Our study', [{ label: '4 Faceted highlights', find: 'Scim colours', to: 'Our study' }]);
  assert.deepEqual([again.sections.map((s) => s.label), again.activeSection], [['4 Faceted highlights'], 0], 'a second link to the open paper: its sections replace the tab\'s');
  const plain = withPassage(landed, 'late interaction', '', undefined);
  assert.deepEqual([plain.sections, plain.activeSection], [[], -1], 'a passage from outside a guide: no sections');
  assert.equal(landingFinds(landTab({ ...plain, pdf: { seq: 1 } }, 'late interaction')), true, '…and the find card opens as before');
  assert.equal(landingFinds({ ...tab, pdf: null }), true, 'a page or a drawn file: the find card, sections or not');
  assert.equal(withPassage(landed, '', '', sections), landed, 'no passage (a title link): the tab as it was');
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

test('the section is painted under find\'s colours and stays when find stops (2026-10-03); it is never ink', async () => {
  const { paintSection, clearFind, FIND, FIND_ACTIVE, SECTION } = await load('find');
  class Fake { constructor(...ranges) { this.ranges = ranges; this.priority = 0; } }
  const registry = new Map([[FIND, new Fake('a')], [FIND_ACTIVE, new Fake('b')]]);
  paintSection(registry, ['r1', 'r2'], Fake);
  assert.deepEqual([registry.get(SECTION).ranges, registry.get(SECTION).priority < 0], [['r1', 'r2'], true]);
  paintSection(registry, [], Fake);
  assert.equal(registry.has(SECTION), false, 'nothing to tint: none left over');
  paintSection(registry, ['r1'], Fake);
  clearFind(registry);
  assert.deepEqual([...registry.keys()], [SECTION], 'find\'s matches go; the section is not find\'s');
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

test('a sandbox preview waits for its first page: Waking… from the click, then Couldn\'t load (2026-10-04)', async () => {
  const { previewWait, previewName, WAKE_MS } = await load('stage');
  const since = 1_000_000;
  const at = (ms, web = { loading: true }, preview = true) => previewWait({ preview, web, since, now: since + ms });
  assert.equal(at(0), 'waking', 'at once, before the page has answered');
  assert.equal(at(10, { loading: false, error: { code: -3 } }), 'waking', 'a failed first load is waited out at once, not shown');
  assert.equal(at(WAKE_MS - 1, { loading: false, error: { code: -105 } }), 'waking');
  assert.equal(at(WAKE_MS), 'failed', 'a minute without a page');
  assert.equal(at(WAKE_MS, { loading: true }), 'failed', 'even while a load is still on its way');
  assert.equal(at(WAKE_MS, { drawn: true, error: { code: -105 } }), null, 'a page that arrived once is a page: its failures are the usual card');
  assert.equal(at(5_000, { loading: true }, false), null, 'any other website loads as it always has');
  assert.equal(previewWait({ preview: true, web: null, since: 0, now: since }), 'waking', 'the click itself, before its wait is recorded');
  assert.equal(at(5_000, null), 'waking', 'before the page has said anything');
  assert.equal(previewName({ name: 'manifund/manifund' }), 'manifund');
  assert.equal(previewName({ name: 'engelbart-web' }), 'engelbart-web');
  assert.equal(previewName(null), '');
});

// MATH-10: the tabs kept across ⌘R and quitting, and given back.
const blank = (id) => ({ id, url: 'about:blank', web: null, item: null, file: null, pdf: null });

test('stageSnapshot: a library row, a page where it went, a pdf from the web, a file on disk; nothing a tab holds', async () => {
  const { stageSnapshot } = await load('stage');
  const tabs = [
    { ...blank('t1'), item: 'p1', row: library[2], pdf: { url: 'file:///Users/h/ColBERT.pdf', input: '/Users/h/ColBERT.pdf', name: 'ColBERT', bytes: new Uint8Array(3), marks: { a: 1 }, rowId: 'p1' }, sections: [{ label: 's', find: 'x' }], pendingFind: 'x' },
    // a page clicked through to its second page: tab.url follows it (onBrowserState)
    { ...blank('t2'), url: 'https://example.org/second', web: { id: 't2', url: 'https://example.org/second', title: 'Second page', canGoBack: true } },
    { ...blank('t3'), url: 'https://arxiv.org/abs/2312.10893', pdf: { url: 'https://arxiv.org/pdf/2312.10893', input: 'https://arxiv.org/pdf/2312.10893', name: 'Some paper', under: 'https://arxiv.org/abs/2312.10893', bytes: new Uint8Array(3), marks: {} } },
    { ...blank('t4'), file: { kind: 'md', path: '/Users/h/notes.md', name: 'notes.md', text: '# hi' } },
    { ...blank('t5'), url: 'about:blank', file: null, pdf: { url: 'file:///Users/h/a.pdf', input: '/Users/h/a.pdf', name: 'a', bytes: new Uint8Array(1) } },
    { ...blank('t6'), url: 'file:///Users/h/site/index.html', web: { title: 'Site' } },
    { ...blank('t7'), url: 'http://localhost:5173/', web: null },
  ];
  const snap = stageSnapshot(tabs, 't2');
  assert.deepEqual(snap, {
    active: 1,
    tabs: [
      { item: 'p1', title: 'ColBERT' },
      { address: 'https://example.org/second', title: 'Second page' },
      { address: 'https://arxiv.org/pdf/2312.10893', title: 'Some paper' },
      { address: '/Users/h/notes.md', title: 'notes.md' },
      { address: '/Users/h/a.pdf', title: 'a' },
      { address: 'file:///Users/h/site/index.html', title: 'Site' },
      { address: 'http://localhost:5173/', title: '' },
    ],
  });
  assert.doesNotMatch(JSON.stringify(snap), /bytes|marks|sections|pendingFind|canGoBack/);
  assert.equal(stageSnapshot(tabs, null).active, 0, 'no tab named in front: the first');
});

test('stageSnapshot: blank tabs, popups, files loading or failed and sandbox names are left; active counts what is kept', async () => {
  const { stageSnapshot } = await load('stage');
  const tabs = [
    blank('b1'),
    { ...blank('pop'), url: 'https://accounts.example.org/login', opened: true, from: 'w1' },
    { ...blank('w1'), url: 'https://example.org', web: { title: 'Example' } },
    { ...blank('l1'), file: { kind: 'loading', path: '/Users/h/big.csv', name: 'big.csv' } },
    { ...blank('e1'), file: { kind: 'error', path: '/Users/h/gone.md', name: 'gone.md', message: 'ENOENT' } },
    { ...blank('s1'), url: 'sandbox://manifund' },
    { ...blank('w2'), url: 'https://two.org', web: null },
  ];
  assert.deepEqual(stageSnapshot(tabs, 'w2'), { active: 1, tabs: [{ address: 'https://example.org', title: 'Example' }, { address: 'https://two.org', title: '' }] });
  assert.equal(stageSnapshot(tabs, 'pop').active, 0, 'the tab in front left out: 0');
  assert.equal(stageSnapshot(tabs, 'e1').active, 0);
  assert.deepEqual(stageSnapshot([blank('b1')], 'b1'), { active: 0, tabs: [] });
  // A tab given back and not opened yet is kept as it came, title and all.
  const later = [{ ...blank('r1'), restore: { item: 'p1', title: 'ColBERT' } }, { ...blank('r2'), restore: { address: '/Users/h/a.pdf', title: 'a', opening: true } }];
  assert.deepEqual(stageSnapshot(later, 'r2'), { active: 1, tabs: [{ item: 'p1', title: 'ColBERT' }, { address: '/Users/h/a.pdf', title: 'a' }] });
});

test('restoreTabs: kept tabs come back unopened in order; a row gone from the library is left; what was opened meanwhile stays in front, once', async () => {
  const { restoreTabs, tabKey, MAX_TABS } = await load('stage');
  let n = 0;
  const make = (entry) => ({ ...blank(`r${(n += 1)}`), restore: { ...entry } });
  const saved = { active: 2, tabs: [{ item: 'p1', title: 'ColBERT' }, { item: 'gone', title: 'Deleted' }, { address: 'https://example.org/second', title: 'Second page' }, { address: '/Users/h/notes.md', title: 'notes.md' }] };

  // A Stage with its lone blank tab: it gives way, and the page that was in front comes forward.
  const lone = [blank('b1')];
  let plan = restoreTabs(lone, saved, library, make);
  assert.deepEqual(plan.tabs.map((t) => t.restore), [{ item: 'p1', title: 'ColBERT' }, { address: 'https://example.org/second', title: 'Second page' }, { address: '/Users/h/notes.md', title: 'notes.md' }]);
  assert.equal(plan.front, plan.tabs[1].id);
  assert.deepEqual(plan.tabs.map(tabKey), ['i:p1', 'l:example.org/second', 'l:file:///Users/h/notes.md'], 'a tab given back is what it will show');

  // The row in front is gone: the next kept tab comes forward.
  plan = restoreTabs(lone, { active: 1, tabs: saved.tabs }, library, make);
  assert.equal(plan.tabs.find((t) => t.id === plan.front).restore.address, 'https://example.org/second');
  plan = restoreTabs(lone, { active: 9, tabs: saved.tabs }, library, make);
  assert.equal(plan.tabs.find((t) => t.id === plan.front).restore.address, '/Users/h/notes.md', 'past the end: the last');

  // Nothing kept, a failed read: the lone tab stays as it was.
  assert.deepEqual(restoreTabs(lone, { active: 0, tabs: [] }, library, make), { tabs: lone, front: null });
  assert.deepEqual(restoreTabs(lone, null, library, make), { tabs: lone, front: null });

  // A pdf opened from the all-projects screen before they came back: it stays in front, not twice, where it was kept.
  const opened = { ...blank('o1'), claimed: true, item: 'p1', row: library[2] };
  plan = restoreTabs([opened], saved, library, make);
  assert.equal(plan.front, null, 'the tab in front stays in front');
  assert.deepEqual(plan.tabs.map(tabKey), ['i:p1', 'l:example.org/second', 'l:file:///Users/h/notes.md']);
  assert.equal(plan.tabs[0], opened, 'the opened tab, not a second one');
  // Something not kept before goes after the kept ones.
  const link = { ...blank('o2'), claimed: true, url: 'https://new.org/' };
  plan = restoreTabs([link], saved, library, make);
  assert.deepEqual(plan.tabs.map(tabKey), ['i:p1', 'l:example.org/second', 'l:file:///Users/h/notes.md', 'l:new.org']);
  assert.equal(plan.tabs[3], link);
  // The page under another spelling is the same page.
  plan = restoreTabs([{ ...blank('o3'), claimed: true, url: 'http://www.example.org/second/' }], saved, library, make);
  assert.equal(plan.tabs.length, 3);

  // At most MAX_TABS: kept ones past it are left, never one opened.
  const many = { active: 0, tabs: Array.from({ length: MAX_TABS }, (_, i) => ({ address: `https://s${i}.org`, title: `s${i}` })) };
  plan = restoreTabs([link], many, library, make);
  assert.equal(plan.tabs.length, MAX_TABS);
  assert.equal(plan.tabs[MAX_TABS - 1], link);
  assert.equal(plan.tabs[MAX_TABS - 2].restore.title, `s${MAX_TABS - 2}`);
});

test('placeTab: a tab given back and not opened yet comes forward rather than a second one; it is not a blank tab to take', async () => {
  const { placeTab } = await load('stage');
  const tabs = [{ ...blank('r1'), restore: { item: 'p1', title: 'ColBERT' } }, { ...blank('r2'), restore: { address: 'https://example.org/a', title: 'A' } }];
  assert.deepEqual(placeTab(tabs, 0, 'i:p1'), { focus: 0 });
  assert.deepEqual(placeTab(tabs, 0, 'l:example.org/a'), { focus: 1 });
  assert.deepEqual(placeTab(tabs, 0, 'l:other.org'), { append: true });
});
