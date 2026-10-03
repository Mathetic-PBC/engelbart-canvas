'use strict';

// An @discover guide's sections on the Stage (2026-10-03): a paper opened from a guide's link shows the section, tinted,
// with a Sections menu where the find card sits, not the find card. PaperView (src/renderer/pdf/PaperView.jsx) keeps the
// section apart from find; the Stage (src/renderer/workspace/Stage.jsx) keeps the guide's sections on the tab. There is
// no document here: PaperView's pages are text stand-ins, and the Stage is run by a few lines that do what React's hooks do.

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
// returns is read as the tree of elements it is.
function hookRunner() {
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
      for (const go of effects) go();
      if (!dirty) return tree;
    }
    throw new Error('rendered 50 times in a row');
  };
  return { fake, run, dirty: () => dirty };
}

// Every element of a kind in what Stage returned, by its component's name.
function findAll(node, name, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) { for (const child of node) findAll(child, name, out); return out; }
  if (node.type && typeof node.type !== 'string' && node.type.name === name) out.push(node);
  if (node.props) findAll(node.props.children, name, out);
  return out;
}

const PAPER = '/Users/h/Scim.pdf';
const SECTIONS = [
  { label: '3.2 Design Goals', find: 'We introduce seven design goals', to: 'a tool that supports' },
  { label: '8.4 Limitations', find: 'highlights only present', to: '' },
];
const link = (find, to = '') => `${PAPER}#find=${encodeURIComponent(find)}${to ? `&to=${encodeURIComponent(to)}` : ''}`;

/** The Stage with a pdf from disk to open, and a stand-in for the viewer's ref that says what it was asked. */
function stage() {
  const hooks = hookRunner();
  const keydown = [];
  const api = new Proxy({
    stageFile: async (projectId, place) => ({ kind: 'pdf', url: `file://${place}`, path: place, name: 'Scim.pdf', bytes: new Uint8Array([37, 80, 68, 70]) }),
    readPageAnnotations: async () => ({}),
    windowFocused: () => true,
  }, { get: (own, name) => (name in own ? own[name] : String(name).startsWith('on') ? () => () => {} : async () => null) });
  globalThis.window = {
    engelbartAPI: api, innerWidth: 1200, innerHeight: 800, crypto: { randomUUID: () => `id-${Math.random().toString(36).slice(2)}` },
    addEventListener: (type, fn) => { if (type === 'keydown') keydown.push(fn); }, removeEventListener: (type, fn) => { const i = keydown.indexOf(fn); if (type === 'keydown' && i >= 0) keydown.splice(i, 1); },
  };
  globalThis.document = { baseURI: 'file:///app/index.html', activeElement: null, body: {}, addEventListener() {}, removeEventListener() {}, querySelectorAll: () => [] };
  globalThis.requestAnimationFrame = () => 0;
  const Stage = load('workspace/Stage.jsx', { react: hooks.fake }).default;
  const ref = { current: null };
  const props = { projectId: 'p1', visible: true, library: [], inRail: () => false };
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
    get tree() { return tree; },
    open: (href, options) => { ref.current.openInput(href, options); tree = hooks.run(Stage, props, ref); },
    settle: async () => { for (let n = 0; n < 5; n += 1) await new Promise((resolve) => setImmediate(resolve)); tree = hooks.run(Stage, props, ref); },
    rerender: () => { tree = hooks.run(Stage, props, ref); },
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
