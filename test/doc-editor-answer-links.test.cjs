'use strict';

// Links in answers (src/renderer/workspace/DocEditor.jsx, src/renderer/model/doc.js; 2026-10-12): a click on or just beside
// a link (its underline, the gap between a wrapped link's lines, just past its last letter) opens it, and a click on an
// answer's line never turns a link into its `[title](url)`. Before, a click that missed the letters by a pixel made the line
// the caret's, the link showed its source, and the next click landed on plain text and opened nothing. There is no document
// here: the editor, its rows and links are stand-ins with the boxes a browser would give them. The real page is checked by
// scripts/smoke-answer-links.cjs (npm run build && npx electron scripts/smoke-answer-links.cjs).

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const { pathToFileURL } = require('node:url');
const { buildSync } = require('esbuild');
const { replyLines } = require('../src/main/bart/reply.cjs');

function load(file) {
  const filename = path.join(__dirname, `__${path.basename(file, '.jsx')}-answer-links-unit.cjs`);
  const bundled = buildSync({ entryPoints: [path.join(__dirname, '../src/renderer/workspace', file)], bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', write: false, external: ['react', 'react-dom'], loader: { '.js': 'jsx', '.css': 'empty' }, logLevel: 'silent' });
  const compiled = new Module(filename, module);
  compiled.paths = module.paths;
  compiled._compile(bundled.outputFiles[0].text, filename);
  return compiled.exports;
}

const DocEditor = load('DocEditor.jsx').default;
const docModel = () => import(pathToFileURL(path.join(__dirname, '../src/renderer/model/doc.js')).href);

const HREF = 'https://example.org/paper.pdf#find=the%20first%20words&to=the%20last%20words';
const GUIDE = [
  '**[A paper](https://example.org/paper.pdf)** · Someone et al. · 2024',
  `**Read:** [Implementation section, read up to the evaluation](${HREF})`,
  '**Why:** a method to set against the open question.',
].join('\n');
const LINES = ['Notes with [a document link](https://example.org/doc)', '@discover how do people read papers?', ...replyLines(GUIDE, { level: { name: 'Sonnet', effort: 'high' }, trail: [], ms: 3000 }, { model: false }), ''];
const READ = LINES.findIndex((line) => line.includes('**Read:**'));

/**
 * The link's boxes as a browser lays them out, padding included: the link wraps, its first part at the end of one line
 * and the rest at the start of the next (26.4px apart: 16px type, line-height 1.65).
 */
const RECTS = [{ left: 300, right: 520, top: 100, bottom: 129 }, { left: 38, right: 182, top: 126.4, bottom: 155.4 }];

/** An editor as mounted, the guide's Read line a row holding the link, what it opened recorded. */
function mounted(props = {}) {
  const opened = [];
  const p = { docKey: 'k', text: LINES.join('\n'), onChange: (next) => { p.text = next; }, onOpenLink: (href, options) => opened.push({ href, options }), ...props };
  const editor = new DocEditor(p);
  editor.props = p;
  const root = { closest: (sel) => (sel === '[data-editor]' ? root : null), matches: () => false, focus() {}, blur() {}, contains: () => true, querySelector: () => null };
  const row = { dataset: { line: String(READ) }, closest: (sel) => (sel === '[data-editor]' ? root : sel === '[data-line]' ? row : null), matches: () => false, querySelectorAll: (sel) => (sel === 'a[data-link]' ? [link] : []) };
  const link = { isConnected: true, getAttribute: (k) => (k === 'href' ? HREF : null), getClientRects: () => RECTS, closest: (sel) => (sel === '[data-editor]' ? root : sel === '[data-line]' ? row : sel === 'a[data-link]' ? link : null), matches: () => false };
  const text = { closest: (sel) => (sel === '[data-editor]' ? root : sel === '[data-line]' ? row : null), matches: () => false }; // the row's text, beside the link
  const docRow = { dataset: { line: '0' }, closest: (sel) => (sel === '[data-editor]' ? root : sel === '[data-line]' ? docRow : null), matches: () => false, querySelectorAll: () => [{ ...link, closest: () => null }] };
  editor.edRef = { current: root };
  editor.scrollRef = { current: { closest: () => null, matches: () => false } };
  editor.setState = (patch) => Object.assign(editor.state, typeof patch === 'function' ? patch(editor.state) : patch);
  editor.syncEditor = () => {};
  editor.maybeRestoreView = () => {};
  globalThis.getSelection = () => ({ isCollapsed: true, rangeCount: 0 });
  globalThis.document = { addEventListener() {}, removeEventListener() {}, hasFocus: () => true, activeElement: null };
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  editor.componentDidMount();
  const on = editor.docListeners;
  /** A press then a click at (x, y) on `target`; whether the press was taken from the browser. */
  const clickAt = (target, x, y) => {
    let prevented = false;
    on.mousedown({ target, button: 0, clientX: x, clientY: y, preventDefault() { prevented = true; } });
    on.click({ target, clientX: x, clientY: y, preventDefault() {} });
    return prevented;
  };
  return { editor, opened, row, link, text, docRow, clickAt };
}

test.afterEach(() => { delete globalThis.getSelection; delete globalThis.document; delete globalThis.window; });

test('a click on a link in an answer opens it, with the guide\'s sections, as before', () => {
  const { editor, opened, link, clickAt } = mounted();
  assert.equal(clickAt(link, 400, 115), true, 'the press does not move the caret');
  assert.equal(opened.length, 1);
  assert.equal(opened[0].href, HREF);
  assert.ok(opened[0].options && Array.isArray(opened[0].options.sections), 'an @discover passage link carries its sections for the Stage');
  assert.equal(editor.state.activeLine, null);
});

test('a click on the underline, between a wrapped link\'s lines, or just past its last letter opens the link', () => {
  for (const [where, x, y] of [
    ['on the underline, 2px below the letters\' box', 400, 129 + 2],
    ['in the gap between the link\'s two lines', 100, 127],
    ['2px past its last letter', 182 + 2, 140],
    ['4px before its first letter', 300 - 4, 115],
  ]) {
    const { editor, opened, text, clickAt } = mounted();
    assert.equal(clickAt(text, x, y), true, `${where}: the press is the link's`);
    assert.deepEqual(opened.map((o) => o.href), [HREF], `${where}: opened`);
    assert.equal(editor.state.activeLine, null, `${where}: the line does not become the caret's`);
    assert.equal(editor.held, false, `${where}: no caret is put when the button comes up`);
  }
});

test('a click further from the link places the caret, as before, and opens nothing', () => {
  const { editor, opened, text, clickAt } = mounted();
  assert.equal(clickAt(text, 182 + 10, 140), false);
  assert.equal(opened.length, 0);
  assert.equal(editor.held, true, 'the caret goes where the button comes up');
  assert.equal(editor.byMouse, true);
});

test('a press beside a link that ends somewhere else opens nothing', () => {
  const { editor, opened, text } = mounted(), on = editor.docListeners;
  on.mousedown({ target: text, button: 0, clientX: 184, clientY: 140, preventDefault() {} });
  on.click({ target: text, clientX: 400, clientY: 300, preventDefault() {} });
  assert.equal(opened.length, 0);
});

test('beside a link in the document (not an answer), a click places the caret as before', () => {
  const { editor, opened, docRow, clickAt } = mounted();
  assert.equal(clickAt(docRow, 184, 140), false);
  assert.equal(opened.length, 0);
  assert.equal(editor.held, true);
});

test('beside a link on the answer line being typed in, a click places the caret', () => {
  const { editor, opened, text, clickAt } = mounted();
  editor.state.activeLine = READ; editor.byMouse = false; // the keyboard brought the caret here
  assert.equal(clickAt(text, 184, 140), false);
  assert.equal(opened.length, 0);
});

/** The Read line drawn as the caret's line, the caret at `offset` in it. */
async function drawnRead(editor, offset) {
  const { parseLine } = await docModel();
  const ls = editor.lines(), p = parseLine(ls[READ]);
  editor.caret = { line: READ, offset: offset(p.text) };
  return editor.lineHtml(READ, ls[READ], p, true, false, editor.layout(ls).get(READ), false);
}
const linkEnd = (text) => text.indexOf(HREF) + HREF.length + 1; // just after the link's `)`

test('after a click beside a link in an answer, the link is still drawn as a link, not [text](url)', async () => {
  const { editor, text, clickAt } = mounted();
  clickAt(text, 182 + 10, 140); // beside it: the caret goes to the line, touching the link
  editor.state.activeLine = READ;
  for (const offset of [linkEnd, (t) => t.indexOf('[Implementation'), (t) => t.indexOf('Implementation') + 4]) {
    const html = await drawnRead(editor, offset);
    assert.ok(html.includes(`<a href="${HREF.replace(/&/g, '&amp;')}" data-link="1"`), 'drawn as a link');
    assert.doesNotMatch(html, /data-open="1">\[Implementation/, 'its source is not shown');
    assert.doesNotMatch(html, /data-src=/, 'no source spans: an answer is read only (2026-10-16)');
  }
});

test('an answer line reached by the keyboard still draws the link, not its source: an answer is read only (2026-10-16)', async () => {
  const { editor, text, clickAt } = mounted();
  clickAt(text, 182 + 10, 140);
  editor.state.activeLine = READ;
  editor.keyReached({ key: 'c', metaKey: true }); // ⌘C is not the keyboard reaching the caret
  assert.equal(editor.byMouse, true);
  assert.match(await drawnRead(editor, linkEnd), /<a href=/);
  editor.keyReached({ key: 'ArrowLeft' });
  assert.equal(editor.byMouse, false);
  const html = await drawnRead(editor, linkEnd);
  assert.doesNotMatch(html.replace(/ data-raw="[^"]*"/g, ''), /\[Implementation section, read up to the evaluation\]\(/, 'no source');
  assert.match(html, /<a href="https:\/\/example\.org\/paper\.pdf#find/, 'the link');
  const typing = mounted(); typing.editor.byMouse = true; typing.editor.keyReached({ key: 'x' });
  assert.equal(typing.editor.byMouse, false, 'a letter typed reaches it too');
});

test('a document line clicked by the mouse still shows a link\'s source at the caret, as before', async () => {
  const { parseLine } = await docModel();
  const { editor, docRow, clickAt } = mounted();
  clickAt(docRow, 400, 400);
  assert.equal(editor.byMouse, true);
  const ls = editor.lines(), p = parseLine(ls[0]);
  editor.state.activeLine = 0; editor.caret = { line: 0, offset: ls[0].length };
  assert.match(editor.lineHtml(0, ls[0], p, true, false, undefined, false), /data-open="1">\[a document link\]\(https:\/\/example\.org\/doc\)/);
});

test('a link\'s box is bigger than its letters, and its margin takes the padding back', async () => {
  const { inlineHtml, holdsLink } = await docModel();
  for (const html of [inlineHtml('[a section](https://example.org/x#find=a)'), inlineHtml('https://example.org/x'), inlineHtml('**[A title](https://example.org/x)**')]) {
    const style = html.match(/<a [^>]*style="([^"]*)"/)[1];
    assert.match(style, /padding:5px 2px;margin:-5px -2px;/);
    assert.match(style, /border-radius:3px/);
    assert.match(style, /cursor:pointer/);
    assert.match(style, /text-decoration:underline;text-underline-offset:3px/, 'its look as before');
  }
  assert.equal(holdsLink('[a](https://x.org)'), true);
  assert.equal(holdsLink('**[A title](https://x.org)**'), true);
  assert.equal(holdsLink('https://x.org/a'), true);
  assert.equal(holdsLink('**bold**'), false);
  assert.equal(holdsLink('@[Note]'), false);
});
