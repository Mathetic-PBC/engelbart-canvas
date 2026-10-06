'use strict';

// An @discover guide's sections on the Stage (2026-10-03): a paper opened from a guide's link shows the section, tinted,
// with a Sections menu where the find card sits, not the find card. PaperView (src/renderer/pdf/PaperView.jsx) keeps the
// section apart from find; the Stage (src/renderer/workspace/Stage.jsx) keeps the guide's sections on the tab. There is
// no document here: PaperView's pages are text stand-ins, and the Stage is run by a few lines that do what React's hooks do.
// A passage in a page or a drawn file (2026-10-03) is found with no find card at all: the block after. The last block: the
// tabs kept across ⌘R and quitting (MATH-10), which the same stand-ins can open.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const { buildSync } = require('esbuild');

const SECTION = 'pdf-section', FIND = 'pdf-find', FIND_ACTIVE = 'pdf-find-active';

// pdf.js and rough.js are not needed to find text in pages that are already "drawn".
const pdfjs = { GlobalWorkerOptions: {}, getDocument: () => ({ promise: new Promise(() => {}) }), TextLayer: class {} };
const rough = { svg: () => ({}) };

function load(file, stubs = {}) {
  const filename = path.join(__dirname, `__${path.basename(file, '.jsx')}-sections-unit.cjs`);
  const bundled = buildSync({ entryPoints: [path.join(__dirname, '../src/renderer', file)], bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', write: false, external: ['react', 'react-dom', 'pdfjs-dist', 'roughjs'], loader: { '.css': 'empty' } });
  const compiled = new Module(filename, module);
  compiled.paths = module.paths;
  const fixed = { 'pdfjs-dist': pdfjs, roughjs: rough, ...stubs };
  compiled.require = function (id) { return id in fixed ? fixed[id] : Module.prototype.require.call(this, id); };
  compiled._compile(bundled.outputFiles[0].text, filename);
  return compiled.exports;
}

globalThis.document = { baseURI: 'file:///app/index.html' }; // PaperView reads where its worker is when it loads
const PaperView = load('pdf/PaperView.jsx').default;

/* ------------------------------------------------------------------------------------------------ PaperView */

// A range over a page's text stand-in: where it starts and ends, and a box a page 1000px tall would give it.
class FakeRange {
  setStart(node, offset) { this.start = { node, offset }; }
  setEnd(node, offset) { this.end = { node, offset }; }
  get collapsed() { return this.start.node === this.end.node && this.start.offset === this.end.offset; }
  getBoundingClientRect() { const top = (this.start.node.page - 1) * 1000 + this.start.offset; return { top, bottom: top + 12, left: 10, right: 40 }; }
  get text() { return this.start.node.data.slice(this.start.offset, this.end.offset); }
}
class FakeHighlight { constructor(...ranges) { this.ranges = ranges; this.priority = 0; } }

const PAGES = [
  'Abstract. Readers skim. 1 Introduction. We set three goals for the reader. More words here. The system has two parts.',
  '2 Related work. Others came first. 5 Evaluation. We ran a study with twelve people.',
];

/** A viewer whose pages are drawn: their text as one stand-in node each, in a pane 600px tall. */
function drawn(props = {}) {
  const registry = new Map();
  globalThis.CSS = { highlights: registry };
  globalThis.Highlight = FakeHighlight;
  globalThis.document = { baseURI: 'file:///app/index.html', createRange: () => new FakeRange() };
  const view = new PaperView({ bytes: null, marks: {}, ...props });
  const host = { scrollTop: 0, scrollLeft: 0, clientHeight: 600, clientWidth: 400, getBoundingClientRect: () => ({ top: 0, bottom: 600, left: 0 }) };
  view.host = { current: host };
  const pages = PAGES.map((joined, n) => {
    const node = { page: n + 1, data: joined };
    return { page: n + 1, layer: null, joined, locate: (index) => (index <= joined.length ? { node, offset: index } : null) };
  });
  view.pageTexts = () => pages;
  return { view, registry, host };
}
const tinted = (registry) => (registry.has(SECTION) ? registry.get(SECTION).ranges.map((r) => r.text) : []);

test.afterEach(() => { delete globalThis.CSS; delete globalThis.Highlight; globalThis.document = { baseURI: 'file:///app/index.html' }; });

test('showSection: the section from its start words to just before the next one is tinted and scrolled to, apart from find', () => {
  const { view, registry, host } = drawn();
  assert.deepEqual(view.showSection('We ran a study', 'with twelve'), { matches: 1, active: 1 });
  assert.deepEqual(tinted(registry), ['We ran a study '], 'the start words up to the next section\'s');
  assert.equal(registry.get(SECTION).priority < 0, true, 'under find\'s colours');
  assert.ok(host.scrollTop > 0, 'page 2 is scrolled to');
  assert.deepEqual([view.findQuery, registry.has(FIND), registry.has(FIND_ACTIVE)], ['', false, false], 'find was asked nothing');
  assert.deepEqual(view.section.spot, { page: 2, from: PAGES[1].indexOf('We ran'), to: PAGES[1].indexOf('We ran') + 'We ran a study'.length }, 'its own start, not find\'s');
});

test('a later find() and stopFind() leave the section; clearSection removes it', () => {
  const { view, registry } = drawn();
  view.showSection('We set three goals', 'The system has');
  const section = tinted(registry);
  assert.deepEqual(section, ['We set three goals for the reader. More words here. ']);
  assert.deepEqual(view.find('More words', 0), { matches: 1, active: 1 });
  assert.ok(registry.has(FIND_ACTIVE), 'find paints its own match');
  assert.deepEqual(tinted(registry), section, 'a new query keeps the section');
  view.paintSection(); // as a redraw would: from the section's own start, whatever find holds
  assert.deepEqual(tinted(registry), section);
  view.find('', 0);
  view.stopFind();
  assert.deepEqual([registry.has(FIND), registry.has(FIND_ACTIVE)], [false, false], 'find\'s matches go');
  assert.deepEqual(tinted(registry), section, 'the section stays');
  view.clearSection();
  assert.deepEqual([registry.has(SECTION), view.section], [false, null], 'cleared: no tint left');
});

test('a `to` that is not found, or none, tints the start words alone; start words that are nowhere tint nothing', () => {
  const { view, registry, host } = drawn();
  view.showSection('We set three goals', 'Words that are not in the paper');
  assert.deepEqual(tinted(registry), ['We set three goals'], 'to nowhere after the start');
  view.showSection('We ran a study', '');
  assert.deepEqual(tinted(registry), ['We ran a study'], 'no to');
  const at = host.scrollTop;
  assert.deepEqual(view.showSection('Nothing like this', 'The system has'), { matches: 0, active: 0 });
  assert.deepEqual([tinted(registry), view.section, host.scrollTop], [[], null, at], 'nothing found: no tint, the scroll left alone');
});

test('a link\'s target is shown as a section and told through onTarget, not onFind; `initialSection` waits for drawing when there is no target', () => {
  const told = [], found = [];
  const { view, registry } = drawn({ onTarget: (text, result) => told.push([text, result]), onFind: (result) => found.push(result) });
  view.applyTarget('We set three goals\nThe system has');
  assert.deepEqual(told, [['We set three goals', { matches: 1, active: 1 }]]);
  assert.deepEqual(found, [], 'not through onFind');
  assert.deepEqual(tinted(registry), ['We set three goals for the reader. More words here. ']);
  assert.equal(new PaperView({ initialSection: { find: 'We ran a study', to: '' } }).gate.drawn(), 'We ran a study', 'a tab come to the front again: its section, once drawn');
  assert.equal(new PaperView({ target: 'We set three goals', targetTo: 'The system has', initialSection: { find: 'We ran a study', to: '' } }).gate.drawn(), 'We set three goals\nThe system has', 'a link\'s target comes first');
});

/* ------------------------------------------------------------------------------------------------ DocEditor */

const DocEditor = load('workspace/DocEditor.jsx').default;
const SCIM = 'https://arxiv.org/pdf/2205.04561';
const CITESEE = 'https://dl.acm.org/doi/pdf/10.1145/3544548.3580847';
const DESIGN = `${SCIM}#find=We%20introduce%20seven%20design%20goals&to=a%20tool%20that%20supports`;
const LIMITS = `${SCIM}#find=highlights%20only%20present`;
const DOC = [
  '@discover tools that help people read papers',
  `bart> **[Scim: Intelligent Skimming Support for Scientific Papers](${SCIM})** · Fok et al. · 2022`,
  `bart> **Read:** [3.2 Design Goals](${DESIGN}) and [8.4 Limitations](${LIMITS})`,
  'bart> **Why:** seven design goals to compare the reader against.',
  `bart> **[CiteSee](${CITESEE})** · Chang et al. · 2023`,
  `bart> **Read:** [4.5 Paper Cards](${CITESEE}#find=Making%20sense%20of%20inline%20citations)`,
  'bart> *Opus high · 2m 10s*',
  '',
  '@bart what should I read first?',
  `bart> **Read:** [Design Goals](${DESIGN}) and [Limitations](${LIMITS})`,
  'bart> *Sonnet high · 12s*',
  '',
  `My own note: [Design Goals](${DESIGN})`,
].join('\n');

/** A link in the document clicked: what the editor hands the Stage. */
function click(line, href, more = {}) {
  const opened = [];
  const editor = new DocEditor({ text: DOC, onAsk() {}, onChange() {}, onOpenLink: (link, options) => opened.push([link, options]) });
  const row = { dataset: { line: String(line) } };
  const anchor = { getAttribute: () => href, closest: (selector) => (selector === '[data-line]' ? row : null) };
  editor.editorClick({ target: { closest: (selector) => (selector === 'a[data-link]' ? anchor : null) }, preventDefault() {}, metaKey: false, ctrlKey: false, ...more });
  return opened;
}

test('a passage link in an @discover answer goes with that answer\'s sections for the same paper; anywhere else, none', () => {
  assert.deepEqual(click(2, LIMITS), [[LIMITS, { sections: [
    { label: '3.2 Design Goals', find: 'We introduce seven design goals', to: 'a tool that supports' },
    { label: '8.4 Limitations', find: 'highlights only present', to: '' },
  ] }]], 'the clicked one and the other, in order; CiteSee\'s left out');
  assert.deepEqual(click(2, LIMITS, { metaKey: true })[0][1].newTab, true, '⌘-click: a tab of its own, sections and all');
  assert.deepEqual(click(9, DESIGN), [[DESIGN, undefined]], 'an @bart answer: as before');
  assert.deepEqual(click(12, DESIGN), [[DESIGN, undefined]], 'the person\'s own line: as before');
  assert.deepEqual(click(1, SCIM), [[SCIM, undefined]], 'a title link (no passage): as before');
});

/* ------------------------------------------------------------------------------------------------ Stage */

// React's hooks, done in a few lines: state that persists between renders, effects run after a render when what they
// depend on changed (the last cleanup first), and a render again whenever state changed. Nothing is drawn: what Stage
// returns is read as the tree of elements it is, and `commit` (given the tree before the effects run, as React attaches
// refs) may hand an element a stand-in node.
function hookRunner(commit = () => {}) {
  const React = require('react');
  let slots = [], at = 0, dirty = false, effects = [];
  const changed = (a, b) => !a || !b || a.length !== b.length || a.some((v, i) => !Object.is(v, b[i]));
  const effect = (fn, deps) => {
    const k = at++, prev = slots[k];
    if (prev && deps && !changed(prev.deps, deps)) return;
    const slot = { deps, cleanup: null };
    slots[k] = slot;
    effects.push(() => { if (prev && prev.cleanup) prev.cleanup(); const c = fn(); slot.cleanup = typeof c === 'function' ? c : null; });
  };
  const fake = {
    ...React,
    useState(init) {
      const k = at++;
      if (!slots[k]) {
        const slot = { value: typeof init === 'function' ? init() : init };
        slot.set = (next) => { const v = typeof next === 'function' ? next(slot.value) : next; if (!Object.is(v, slot.value)) { slot.value = v; dirty = true; } };
        slots[k] = slot;
      }
      return [slots[k].value, slots[k].set];
    },
    useRef(init) { const k = at++; if (!slots[k]) slots[k] = { current: init }; return slots[k]; },
    useMemo(fn, deps) { const k = at++; if (!slots[k] || changed(slots[k].deps, deps)) slots[k] = { value: fn(), deps }; return slots[k].value; },
    useCallback(fn, deps) { return fake.useMemo(() => fn, deps); },
    useEffect: effect,
    useLayoutEffect: effect,
    useImperativeHandle(ref, make) { at++; ref.current = make(); },
    useContext() { return null; },
  };
  fake.default = fake;
  const run = (component, props, ref) => {
    let tree = null;
    for (let n = 0; n < 50; n += 1) {
      at = 0; effects = []; dirty = false;
      tree = component.render(props, ref);
      commit(tree);
      for (const go of effects) go();
      if (!dirty) return tree;
    }
    throw new Error('rendered 50 times in a row');
  };
  return { fake, run, dirty: () => dirty };
}

// Every element of a kind in what Stage returned, by its component's name, or a host element by a function of its props.
function findAll(node, name, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) { for (const child of node) findAll(child, name, out); return out; }
  if (typeof name === 'function' ? typeof node.type === 'string' && node.props && name(node.props) : node.type && typeof node.type !== 'string' && node.type.name === name) out.push(node);
  if (node.props) findAll(node.props.children, name, out);
  return out;
}

const PAPER = '/Users/h/Scim.pdf';
const SECTIONS = [
  { label: '3.2 Design Goals', find: 'We introduce seven design goals', to: 'a tool that supports' },
  { label: '8.4 Limitations', find: 'highlights only present', to: '' },
];
const link = (find, to = '') => `${PAPER}#find=${encodeURIComponent(find)}${to ? `&to=${encodeURIComponent(to)}` : ''}`;

const PDF = (place) => ({ kind: 'pdf', url: `file://${place}`, path: place, name: 'Scim.pdf', bytes: new Uint8Array([37, 80, 68, 70]) });

/**
 * The Stage with a file from disk to open (a pdf unless `file` says otherwise), and a stand-in for the viewer's ref that
 * says what it was asked. `nodes`: stand-in DOM nodes for the elements with those attributes (`data-stage-view`, …).
 * What else it asks of main is in `calls`; what it listens to main for, in `on`.
 */
function stage({ file = PDF, nodes = {}, api: own = {}, library = [], props: more = {} } = {}) {
  const hooks = hookRunner((tree) => {
    for (const [attribute, node] of Object.entries(nodes)) for (const el of findAll(tree, (p) => p[attribute] != null)) if (el.props.ref) el.props.ref.current = node;
  });
  const keydown = [], calls = [], on = {}, listeners = {};
  const api = new Proxy({
    stageFile: async (projectId, place) => file(place),
    readPageAnnotations: async () => ({}),
    windowFocused: () => true,
    ...own,
  }, { get: (own, name) => (name in own ? own[name] : String(name).startsWith('on') ? (fn) => { on[name] = fn; return () => {}; } : async (...args) => { calls.push([name, ...args]); return null; }) });
  globalThis.window = {
    engelbartAPI: api, innerWidth: 1200, innerHeight: 800, crypto: { randomUUID: () => `id-${Math.random().toString(36).slice(2)}` },
    addEventListener: (type, fn) => { if (type === 'keydown') keydown.push(fn); else (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener: (type, fn) => { const list = type === 'keydown' ? keydown : listeners[type] || []; const i = list.indexOf(fn); if (i >= 0) list.splice(i, 1); },
  };
  globalThis.document = { baseURI: 'file:///app/index.html', activeElement: null, body: {}, addEventListener() {}, removeEventListener() {}, querySelectorAll: () => [] };
  globalThis.requestAnimationFrame = () => 0;
  const Stage = load('workspace/Stage.jsx', { react: hooks.fake }).default;
  const ref = { current: null };
  const props = { projectId: 'p1', visible: true, library, inRail: () => false, ...more };
  let tree = hooks.run(Stage, props, ref);
  const asked = [];
  const paper = {
    find: (...args) => { asked.push(['find', ...args]); return { matches: 1, active: 1 }; },
    showSection: (...args) => { asked.push(['showSection', ...args]); return { matches: 1, active: 1 }; },
    stopFind: () => asked.push(['stopFind']),
    clearSection: () => asked.push(['clearSection']),
  };
  const s = {
    asked,
    calls,
    on,
    get tree() { return tree; },
    open: (href, options) => { ref.current.openInput(href, options); tree = hooks.run(Stage, props, ref); },
    settle: async () => { for (let n = 0; n < 5; n += 1) await new Promise((resolve) => setImmediate(resolve)); tree = hooks.run(Stage, props, ref); },
    rerender: () => { tree = hooks.run(Stage, props, ref); },
    front: () => ref.current.front(),
    fire: (type) => { for (const fn of [...(listeners[type] || [])]) fn({ type }); },
    paper: () => { const [view] = findAll(tree, 'PaperView'); if (view) view.props.ref.current = paper; return view; },
    one: (name) => findAll(tree, name)[0] || null,
    key: (key) => { for (const fn of [...keydown]) fn({ key, metaKey: true, altKey: false, ctrlKey: false, shiftKey: false, defaultPrevented: false, target: null, preventDefault() {}, stopPropagation() {} }); tree = hooks.run(Stage, props, ref); },
  };
  return s;
}

test.describe('the Stage', () => {
  test.afterEach(() => { delete globalThis.window; delete globalThis.requestAnimationFrame; globalThis.document = { baseURI: 'file:///app/index.html' }; });

  test('a guide\'s link landing in a pdf: no find card, its section in front in the Sections menu; ⌘F and closing it leave the section; × clears it', async () => {
    const s = stage();
    s.open(link(SECTIONS[1].find), { sections: SECTIONS });
    await s.settle();
    const view = s.paper();
    assert.ok(view, 'the pdf is drawn');
    assert.deepEqual([view.props.target, view.props.targetTo], [SECTIONS[1].find, null], 'the passage waits for drawing');
    view.props.onTarget(SECTIONS[1].find, { matches: 1, active: 1 }); // PaperView showed it, every page drawn
    s.rerender();
    assert.equal(s.one('FindCard'), null, 'finding stays false');
    assert.equal(s.paper().props.target, null, 'it waits no longer');
    const menu = s.one('SectionsMenu');
    assert.deepEqual([menu.props.sections, menu.props.active, menu.props.below], [SECTIONS, 1, false], 'the clicked one in front, where the find card sits');
    assert.deepEqual(s.asked, [], 'find was asked nothing');

    menu.props.onPick(0);
    s.rerender();
    assert.deepEqual(s.asked, [['showSection', SECTIONS[0].find, SECTIONS[0].to]], 'another section: shown in the viewer');
    assert.equal(s.one('SectionsMenu').props.active, 0);

    s.key('f');
    assert.ok(s.one('FindCard'), '⌘F opens the find card as before');
    assert.equal(s.one('SectionsMenu').props.below, true, 'the menu moves under it');
    s.asked.length = 0;
    s.one('FindCard').props.onClose();
    s.rerender();
    assert.equal(s.one('FindCard'), null);
    assert.deepEqual(s.asked, [['stopFind']], 'find stops; the section is not cleared');

    s.one('SectionsMenu').props.onClose();
    s.rerender();
    assert.equal(s.one('SectionsMenu'), null, '× takes the menu');
    assert.deepEqual(s.asked, [['stopFind'], ['clearSection']], '…and the tint');
  });

  test('a second link to the open paper replaces its sections and comes forward in the same tab', async () => {
    const s = stage();
    s.open(link(SECTIONS[0].find, SECTIONS[0].to), { sections: SECTIONS });
    await s.settle();
    s.paper().props.onTarget(SECTIONS[0].find, { matches: 1, active: 1 });
    s.rerender();
    const other = [{ label: '5 Evaluation', find: 'We ran a study', to: 'Discussion' }, { label: '3.2 Design Goals, again', find: SECTIONS[0].find, to: SECTIONS[0].to }];
    s.open(link('We ran a study', 'Discussion'), { sections: other });
    await s.settle();
    assert.equal(findAll(s.tree, 'PaperView').length, 1);
    assert.deepEqual([s.paper().props.target, s.paper().props.targetTo], ['We ran a study', 'Discussion'], 'the same viewer is given the new passage');
    assert.deepEqual([s.one('SectionsMenu').props.sections, s.one('SectionsMenu').props.active], [other, 0], 'the tab\'s sections are the new link\'s');
  });

  test('a passage link from outside a guide lands in a pdf as before: the find card with its words, and the section goes with it', async () => {
    const s = stage();
    s.open(link(SECTIONS[0].find, SECTIONS[0].to));
    await s.settle();
    s.paper().props.onTarget(SECTIONS[0].find, { matches: 1, active: 1 });
    s.rerender();
    assert.deepEqual(s.asked, [['find', SECTIONS[0].find, 0, { fromStart: true }]], 'its match in front, counted from page 1');
    const card = s.one('FindCard');
    assert.ok(card, 'the find card opens');
    assert.deepEqual([card.props.text, card.props.found], [SECTIONS[0].find, { matches: 1, active: 1 }]);
    assert.equal(s.one('SectionsMenu'), null, 'no menu');
    s.asked.length = 0;
    card.props.onClose();
    s.rerender();
    assert.deepEqual(s.asked, [['stopFind'], ['clearSection']], 'closing find takes the section, as it did');
  });
});

/* ---------------------------------------------------------------------------------- Stage: @bart on a highlight */

// MATH-27 (2026-10-06): a highlight's note asks through the Stage, which says which pdf it is (a pdf from disk or the web
// by its address, a library row by its id) and gives the viewer the answers being written for its own pdf alone. The
// finished answer goes onto its mark through the viewer showing that pdf, else straight into the ink kept for it.
test.describe('the Stage: @bart on a highlight', () => {
  test.afterEach(() => { delete globalThis.window; delete globalThis.requestAnimationFrame; globalThis.document = { baseURI: 'file:///app/index.html' }; });
  const ENTRY = { id: 'h1', question: 'why?', answer: 'Because.', meta: {}, at: 'now', pos: null, collapsed: false };
  const ASK = { markId: 'm1', page: 2, quote: 'the passage', note: '@bart why?', question: 'why?', turns: [] };

  test('the question goes up with the pdf\'s address and name; the viewer is given its own answers being written; the answer lands through it', async () => {
    const up = [];
    const pending = [{ askId: 'h1', markId: 'm1', page: 2, url: `file://${PAPER}`, rowId: null }, { askId: 'h9', markId: 'x', page: 1, url: 'https://elsewhere.org/a.pdf', rowId: null }, { askId: 'h8', markId: 'y', page: 1, rowId: 'row-1', url: null }];
    const s = stage({ props: { onAsk: async (ask) => { up.push(ask); return ENTRY; }, pendingAsks: pending, onStopAsk: () => {}, onContinueAsk: () => {} } });
    s.open(PAPER);
    await s.settle();
    const view = s.paper();
    assert.deepEqual(view.props.pendingAsks.map((p) => p.askId), ['h1'], 'its own pdf\'s alone');
    const landed = [];
    view.props.ref.current.addAsk = (...args) => { landed.push(args); return true; };
    view.props.onAsk(ASK);
    await s.settle();
    assert.deepEqual(up, [{ ...ASK, url: `file://${PAPER}`, paper: 'Scim.pdf' }]);
    assert.deepEqual(landed, [[2, 'm1', ENTRY]], 'onto its mark, through the viewer, which saves it');
    assert.ok(!s.calls.some(([name]) => name === 'writePageAnnotations'), 'nothing written behind its back');
  });

  test('with no viewer showing the mark, the answer goes into the tab that holds it; the kept ink is main\'s to write', async () => {
    const kept = { 2: [{ id: 'm1', rects: [{ x: 0.1, y: 0.2, w: 0.3, h: 0.01 }], note: '@bart why?' }] };
    const s = stage({ api: { readPageAnnotations: async () => JSON.parse(JSON.stringify(kept)) }, props: { onAsk: async () => ENTRY } });
    s.open(PAPER);
    await s.settle();
    const view = s.paper();
    view.props.ref.current.addAsk = () => false; // the viewer no longer has that mark
    view.props.onAsk(ASK);
    await s.settle();
    assert.deepEqual(s.paper().props.marks[2][0].asks, [ENTRY], 'the tab\'s ink has it');
    assert.ok(!s.calls.some(([name]) => /^write(Page)?Annotations$/.test(name)), 'main has put it in the ink kept for the pdf (library.addMarkAnswer)');
  });

  // Second pass (2026-10-06): the same pdf in two tabs. Only the tab in front has a viewer; the other must not keep ink
  // from before, or brought forward and edited it saves that over the answer.
  const twoTabs = async (props = {}) => {
    const kept = { 2: [{ id: 'm1', rects: [{ x: 0.1, y: 0.2, w: 0.3, h: 0.01 }], note: '@bart why?' }] };
    const s = stage({ api: { readPageAnnotations: async () => JSON.parse(JSON.stringify(kept)) }, props });
    s.open(PAPER);
    await s.settle();
    const first = s.paper().key;
    s.open(PAPER, { newTab: true });
    await s.settle();
    assert.notEqual(s.paper().key, first, 'a second tab, in front, with a viewer of its own');
    const landed = [];
    s.paper().props.ref.current.addAsk = (...args) => { landed.push(args); return true; };
    const back = async () => { // a press on the first tab in the strip
      const [behind] = findAll(s.tree, (p) => p.className === 'hov-tab');
      behind.props.onMouseDown({ button: 0 });
      await s.settle();
      assert.equal(s.paper().key, first, 'the first tab in front again');
    };
    return { s, landed, back, first };
  };

  test('an answer landing through the viewer in front reaches the other tab holding the pdf too', async () => {
    const { s, landed, back } = await twoTabs({ onAsk: async () => ENTRY });
    s.paper().props.onAsk(ASK);
    await s.settle();
    assert.deepEqual(landed, [[2, 'm1', ENTRY]], 'through the viewer, which saves it');
    await back();
    assert.deepEqual(s.paper().props.marks[2][0].asks, [ENTRY], 'the other tab\'s viewer opens with the answer: moving a box there saves it with it');
  });

  test('what the viewer saves, every tab holding the pdf takes: brought forward, one never saves the ink it read before', async () => {
    const { s, back } = await twoTabs();
    const moved = { 2: [{ id: 'm1', rects: [{ x: 0.1, y: 0.2, w: 0.3, h: 0.01 }], note: '@bart why?', pos: { x: 1.1, y: 0.2 }, asks: [ENTRY] }] };
    s.paper().props.onMarksChange(moved);
    await s.settle();
    assert.deepEqual(s.calls.filter(([name]) => name === 'writePageAnnotations').map((call) => call.slice(1)), [[`file://${PAPER}`, moved]]);
    await back();
    assert.deepEqual(s.paper().props.marks, moved);
  });

  test('main telling every window how an ask ended puts its answer on the mark in each tab holding the pdf, as after ⌘R; a failure or another pdf\'s changes nothing', async () => {
    const { s, landed, back } = await twoTabs();
    assert.equal(typeof s.on.onPaperAskDone, 'function', 'the Stage listens');
    const where = { markId: 'm1', page: 2, rowId: null, url: `file://${PAPER}` };
    s.on.onPaperAskDone({ askId: 'h3', ...where, failed: true, lines: ['bart> **No answer.** The CLI quit.'] });
    s.on.onPaperAskDone({ askId: 'h4', ...where, url: 'https://elsewhere.org/a.pdf', entry: { ...ENTRY, id: 'h4' } });
    s.rerender();
    assert.deepEqual(landed, []);
    s.on.onPaperAskDone({ askId: 'h1', ...where, entry: ENTRY });
    s.on.onPaperAskDone({ askId: 'h1', ...where, entry: ENTRY }); // the window that asked hears it with its answer too
    s.rerender();
    assert.deepEqual(landed, [[2, 'm1', ENTRY], [2, 'm1', ENTRY]], 'the viewer in front is given it (and keeps it once: PaperView addAsk)');
    assert.deepEqual(s.paper().props.marks[2][0].asks, [ENTRY], 'once');
    await back();
    assert.deepEqual(s.paper().props.marks[2][0].asks, [ENTRY]);
    assert.ok(!s.calls.some(([name]) => /^write(Page)?Annotations$/.test(name)), 'nothing written: main has');
  });

  test('without a workspace to ask from, a note asks nothing; Continue says which paper', async () => {
    const continued = [];
    const s = stage({ props: { onContinueAsk: (c) => continued.push(c) } });
    s.open(PAPER);
    await s.settle();
    const view = s.paper();
    assert.equal(view.props.onAsk, undefined);
    view.props.onContinueAsk({ markId: 'm1', page: 2, quote: 'q', question: 'why?', answer: 'A', foot: '' });
    assert.deepEqual(continued[0].paper, { name: 'Scim.pdf', rowId: null, url: `file://${PAPER}` });
  });
});

/* ---------------------------------------------------------------------------------- Stage: a page, a drawn file */

// A link's passage in a page or a file drawn here (2026-10-03): found, highlighted and scrolled to as ⌘F would, but with
// no find card. Chromium keeps a page's highlight until stopFindInPage, and a file's is painted until clearRanges: only
// the card's closing does either.

const ESSAY = 'https://andymatuschak.org/hmwl/';
const WORDS = 'it’s much harder to write an essay';
const NOTES = '/Users/h/notes.md';
const passage = (where, find) => `${where}#find=${encodeURIComponent(find)}`;
const finds = (s) => s.calls.filter(([name]) => name === 'browserFind' || name === 'browserStopFind');

/** A Stage with a page's view to show, and the page loaded once `loaded(s)` says so. */
function pageStage() {
  globalThis.ResizeObserver = class { observe() {} disconnect() {} };
  globalThis.MutationObserver = class { observe() {} disconnect() {} };
  const slot = { getBoundingClientRect: () => ({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 }), parentElement: null };
  return stage({ nodes: { 'data-browser-slot': slot } });
}
const loaded = (s, id, url = ESSAY) => { s.on.onBrowserState({ id, url, title: 'How might we learn?', loading: false, canGoBack: false, canGoForward: false, error: null }); s.rerender(); };
const opened = (s) => { const call = s.calls.find(([name]) => name === 'browserOpen'); return call && call[1]; };

/** A Stage with a markdown file to draw: two text nodes, in a pane 600px tall, the passage below it. */
function fileStage() {
  const registry = new Map();
  const texts = [{ page: 2, data: 'Readers skim. We set three goals for the reader.' }, { page: 2, data: 'Again: three goals.' }];
  const view = { texts, scrollTop: 0, clientHeight: 600, getBoundingClientRect: () => ({ top: 0, bottom: 600 }) };
  const s = stage({ file: (place) => ({ kind: 'md', path: place, name: 'notes.md', text: texts.map((t) => t.data).join('\n'), truncated: false }), nodes: { 'data-stage-view': view } });
  globalThis.CSS = { highlights: registry };
  globalThis.Highlight = FakeHighlight;
  globalThis.NodeFilter = { SHOW_TEXT: 4 };
  Object.assign(globalThis.document, {
    createRange: () => new FakeRange(),
    createTreeWalker: (root) => { let i = -1; return { nextNode: () => root.texts[++i] || null }; },
  });
  return { s, registry, view };
}
const painted = (registry, name) => (registry.has(name) ? registry.get(name).ranges.map((r) => `${r.text}@${r.start.offset}`) : []);

test.describe('the Stage: a passage in a page or a drawn file', () => {
  test.afterEach(() => {
    for (const name of ['window', 'requestAnimationFrame', 'ResizeObserver', 'MutationObserver', 'CSS', 'Highlight', 'NodeFilter']) delete globalThis[name];
    globalThis.document = { baseURI: 'file:///app/index.html' };
  });

  test('landing on a loaded page: browserFind with the words, no find card; nothing stops it until the card closes', async () => {
    const s = pageStage();
    s.open(passage(ESSAY, WORDS));
    await s.settle();
    const id = opened(s);
    assert.ok(id, 'the page is opened');
    assert.deepEqual(finds(s), [], 'nothing is found before the page has loaded');
    loaded(s, id);
    assert.deepEqual(finds(s), [['browserFind', id, WORDS, { backward: false }]], 'found as ⌘F would, from the first match');
    assert.equal(s.one('FindCard'), null, 'finding stays false');

    s.on.onBrowserFound({ id, matches: 2, active: 1 }); // Chromium counts the matches
    s.rerender();
    assert.equal(s.one('FindCard'), null, 'the count shows nowhere');
    s.key('t'); // another tab in front, then the page again
    s.open(ESSAY);
    await s.settle();
    assert.equal(opened(s), id, 'the same tab, never reloaded');
    assert.deepEqual(finds(s), [['browserFind', id, WORDS, { backward: false }]], 'no stopFind: the highlight stays');

    s.key('f');
    const card = s.one('FindCard');
    assert.ok(card, '⌘F opens the find card as before');
    assert.equal(card.props.text, '', 'empty: the link\'s words were never typed');
    card.props.onText('notes');
    s.rerender();
    assert.deepEqual(finds(s).slice(1), [['browserFind', id, ''], ['browserStopFind', id], ['browserFind', id, 'notes', { backward: false }]], 'a new search replaces the link\'s');
    s.one('FindCard').props.onClose();
    s.rerender();
    assert.deepEqual(finds(s).slice(-1), [['browserStopFind', id]], 'closing the card clears it');
    s.key('f');
    assert.equal(s.one('FindCard').props.text, 'notes', '⌘F again: the last query typed');
  });

  test('landing while the card is open with other words: the card takes the link\'s words, as before', async () => {
    const s = pageStage();
    s.open(ESSAY);
    await s.settle();
    const id = opened(s);
    loaded(s, id);
    s.key('f');
    s.one('FindCard').props.onText('other');
    s.rerender();
    s.calls.length = 0;
    s.open(passage(ESSAY, WORDS)); // the page is open: it comes forward with the passage
    await s.settle();
    assert.equal(s.one('FindCard').props.text, WORDS, 'the open card\'s query is the passage');
    assert.deepEqual(finds(s), [['browserStopFind', id], ['browserFind', id, WORDS, { backward: false }]], 'the old search stops and the passage is found');
    s.calls.length = 0;
    s.open(passage(ESSAY, WORDS)); // the same words again
    await s.settle();
    assert.deepEqual(finds(s), [['browserFind', id, WORDS, { backward: false }]], 'the same words: found again, the card as it was');
    assert.equal(s.one('FindCard').props.text, WORDS);
  });

  test('landing on a drawn file: its ranges painted and scrolled to, no find card; ⌘F and closing it work as before', async () => {
    const { s, registry, view } = fileStage();
    s.open(passage(NOTES, 'three goals'));
    await s.settle();
    assert.equal(s.one('FindCard'), null, 'finding stays false');
    assert.deepEqual(painted(registry, 'stage-find-cur'), [`three goals@${'Readers skim. We set '.length}`], 'the first match in front');
    assert.deepEqual(painted(registry, 'stage-find'), [`three goals@${'Again: '.length}`], 'the other painted too');
    assert.ok(view.scrollTop > 0, 'scrolled to');
    s.rerender();
    assert.equal(registry.has('stage-find-cur'), true, 'nothing clears it');

    s.key('f');
    assert.equal(s.one('FindCard').props.text, '', '⌘F opens the card empty');
    s.one('FindCard').props.onText('reader');
    s.rerender();
    assert.deepEqual([painted(registry, 'stage-find-cur'), painted(registry, 'stage-find')], [['Reader@0'], [`reader@${'Readers skim. We set three goals for the '.length}`]], 'a new search replaces the link\'s');
    s.one('FindCard').props.onClose();
    s.rerender();
    assert.deepEqual([registry.has('stage-find'), registry.has('stage-find-cur')], [false, false], 'closing the card clears it');
  });

  test('a pdf is as before: no browserFind, a guide\'s passage in the Sections menu, any other in the find card', async () => {
    const s = stage();
    s.open(link(SECTIONS[1].find), { sections: SECTIONS });
    await s.settle();
    s.paper();
    s.paper().props.onTarget(SECTIONS[1].find, { matches: 1, active: 1 });
    s.rerender();
    assert.deepEqual([s.one('FindCard'), s.one('SectionsMenu').props.active], [null, 1]);
    s.open(link(SECTIONS[0].find)); // no guide: the find card, with the words
    await s.settle();
    s.paper().props.onTarget(SECTIONS[0].find, { matches: 1, active: 1 });
    s.rerender();
    assert.equal(s.one('FindCard').props.text, SECTIONS[0].find);
    assert.deepEqual(finds(s), [], 'a pdf is found by its viewer');
  });
});

// MATH-54 (2026-10-06): what is in front for @bart's <stage>: a web page by where it is now and its title; a pdf and a
// drawn file as before.
test.describe('the Stage: what is in front for @bart', () => {
  test.afterEach(() => {
    for (const name of ['window', 'requestAnimationFrame', 'ResizeObserver', 'MutationObserver', 'CSS', 'Highlight', 'NodeFilter']) delete globalThis[name];
    globalThis.document = { baseURI: 'file:///app/index.html' };
  });

  test('a web page is { kind: "web", url, title }, the page as it is now', async () => {
    const s = pageStage();
    s.open(ESSAY);
    await s.settle();
    const id = opened(s);
    assert.deepEqual(s.front(), { kind: 'web', url: ESSAY, title: '' }, 'not loaded yet: where it is going');
    loaded(s, id);
    assert.deepEqual(s.front(), { kind: 'web', url: ESSAY, title: 'How might we learn?' });
    loaded(s, id, 'https://andymatuschak.org/hmwl/#notes');
    assert.equal(s.front().url, 'https://andymatuschak.org/hmwl/#notes', 'where the tab went (main files it without the fragment)');
  });

  test('a pdf and a drawn file are as before', async () => {
    const s = stage();
    s.open(PAPER);
    await s.settle();
    s.paper();
    assert.deepEqual(s.front(), { rowId: null, url: `file://${PAPER}`, page: 1, kind: 'pdf' });
    const { s: file } = fileStage();
    file.open(NOTES);
    await file.settle();
    assert.deepEqual(file.front(), { rowId: null, url: null, page: 1, kind: 'file' });
  });
});

// MATH-10: the tabs kept across ⌘R and quitting (main's state.json `stages`), given back when the Stage opens.
const ROW = { id: '55555555-5555-4555-8555-555555555555', name: 'ColBERT', type: 'pdf', path: '/Users/h/ColBERT.pdf', tags: [] };
const KEPT = { active: 1, tabs: [{ item: ROW.id, title: 'ColBERT' }, { address: 'https://example.org/second', title: 'Second page' }, { address: NOTES, title: 'notes.md' }] };
const textOf = (node) => (node == null || typeof node === 'boolean' ? '' : typeof node !== 'object' ? String(node) : Array.isArray(node) ? node.map(textOf).join('') : node.props ? textOf(node.props.children) : '');
const tabEls = (s) => findAll(s.tree, (p) => p['data-stage-tab'] != null);
const labels = (s) => tabEls(s).map((el) => textOf(el).replace(/×$/, ''));
const named = (s, name) => s.calls.filter(([n]) => n === name);
/** A Stage that can show pages (pageStage), with main's answer for the kept tabs and a library. */
function keptStage(options) {
  globalThis.ResizeObserver = class { observe() {} disconnect() {} };
  globalThis.MutationObserver = class { observe() {} disconnect() {} };
  const slot = { getBoundingClientRect: () => ({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 }), parentElement: null };
  return stage({ nodes: { 'data-browser-slot': slot }, ...options });
}
const choose = (s, i) => { findAll(tabEls(s)[i], (p) => typeof p.onMouseDown === 'function')[0].props.onMouseDown({ button: 0 }); s.rerender(); };

test.describe('the Stage\'s tabs kept across ⌘R and quitting (MATH-10)', () => {
  test.afterEach(() => { delete globalThis.window; delete globalThis.requestAnimationFrame; globalThis.document = { baseURI: 'file:///app/index.html' }; });

  test('they come back in order with their titles; only the one in front opens; nothing is written before they are back', async () => {
    let give;
    const s = keptStage({ api: { stage: () => new Promise((resolve) => { give = resolve; }) }, library: [ROW], file: (place) => ({ kind: 'md', path: place, name: 'notes.md', text: '# notes', truncated: false }) });
    s.fire('pagehide');
    await s.settle();
    assert.deepEqual(named(s, 'setStage'), [], 'the blank tab the Stage starts with is never written over them');
    give(KEPT);
    await s.settle();
    assert.deepEqual(labels(s), ['ColBERT', 'Second page', 'notes.md'], 'in order, each by the title it was kept with');
    assert.deepEqual(named(s, 'browserOpen').map((call) => call[2]), ['https://example.org/second'], 'the page in front opens');
    assert.deepEqual([named(s, 'readLibraryFile'), named(s, 'stageFile')], [[], []], 'nothing else does');

    choose(s, 0);
    await s.settle();
    assert.deepEqual(named(s, 'readLibraryFile').map((call) => call[1]), [ROW.id], 'a row opens the first time it comes forward');
    choose(s, 2);
    await s.settle();
    assert.equal(s.one('MarkdownView').props.text, '# notes', 'a file too');
    choose(s, 0);
    await s.settle();
    assert.equal(named(s, 'readLibraryFile').length, 1, 'and only the first time');

    s.fire('pagehide');
    const written = named(s, 'setStage');
    assert.equal(written.length, 1, 'written once, when the page went away');
    assert.deepEqual(written[0].slice(1), ['p1', { active: 0, tabs: [{ item: ROW.id, title: 'ColBERT' }, { address: 'https://example.org/second', title: '' }, { address: NOTES, title: 'notes.md' }] }]);
  });

  test('what was opened before they came back stays in front, once; a row gone from the library is not given back', async () => {
    let give;
    const s = keptStage({ api: { stage: () => new Promise((resolve) => { give = resolve; }) }, library: [] });
    s.open('https://www.example.org/second/');
    await s.settle();
    give(KEPT);
    await s.settle();
    assert.equal(tabEls(s).length, 2, 'the deleted row is gone, and the page is not there twice');
    assert.deepEqual(labels(s), ['www.example.org/second/', 'notes.md'], 'the page where it was opened, then the file kept');
    assert.deepEqual(named(s, 'browserOpen').map((call) => call[2]), ['https://www.example.org/second/'], 'the page opened, and nothing kept');
    s.fire('pagehide');
    assert.deepEqual(named(s, 'setStage')[0][2].active, 0, 'the page opened is in front');
  });

  test('a read that fails starts with nothing kept; every tab closed is kept as none', async () => {
    const s = keptStage({ api: { stage: async () => { throw new Error('unreadable'); } } });
    await s.settle();
    assert.deepEqual(labels(s), ['New tab']);
    s.open('https://example.org/a');
    await s.settle();
    s.fire('pagehide');
    assert.deepEqual(named(s, 'setStage').map((call) => call[2]), [{ active: 0, tabs: [{ address: 'https://example.org/a', title: '' }] }]);
    findAll(s.tree, (p) => p['aria-label'] === 'Close tab')[0].props.onClick({ stopPropagation() {} });
    s.rerender();
    assert.deepEqual(labels(s), ['New tab']);
    s.fire('pagehide');
    assert.deepEqual(named(s, 'setStage').map((call) => call[2]).pop(), { active: 0, tabs: [] }, 'one blank tab the next time');
  });
});
