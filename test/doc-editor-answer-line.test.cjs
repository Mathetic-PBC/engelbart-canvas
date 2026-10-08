'use strict';

// The line of an @bart answer the caret is on (src/renderer/workspace/DocEditor.jsx, 2026-10-05): it shows its source, as
// any line being edited does, but keeps its look. A heading keeps its size with its `## ` faint before it; a bullet keeps
// its place with its `- ` faint where the dot stood. The characters are the line's own, in order, so the caret's offsets
// are what they were. There is no document here: the editor and its elements are stand-ins, as in doc-editor-cards.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const { pathToFileURL } = require('node:url');
const { buildSync } = require('esbuild');
const { replyLines } = require('../src/main/bart/reply.cjs');

function load(file) {
  const filename = path.join(__dirname, `__${path.basename(file, '.jsx')}-answer-line-unit.cjs`);
  const bundled = buildSync({ entryPoints: [path.join(__dirname, '../src/renderer/workspace', file)], bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', write: false, external: ['react', 'react-dom'], loader: { '.js': 'jsx' }, logLevel: 'silent' });
  const compiled = new Module(filename, module);
  compiled.paths = module.paths;
  compiled._compile(bundled.outputFiles[0].text, filename);
  return compiled.exports;
}

const DocEditor = load('DocEditor.jsx').default;
const LINES = ['@bart how does reading work?', ...replyLines('## Reading a PDF\n- The highlight keeps its **zigzag** ink.\nThen a plain line.', { level: { name: 'Sonnet', effort: 'high' }, trail: [], ms: 3000 }, { model: false }), ''];

function mounted(lines) {
  const props = { docKey: 'k', text: lines.join('\n'), onChange: (next) => { props.text = next; } };
  const editor = new DocEditor(props);
  const root = { closest: (sel) => (sel === '[data-editor]' ? root : null), matches: () => false, focus() {}, blur() {}, contains: () => false, querySelector: () => null };
  editor.props = props;
  editor.edRef = { current: root };
  editor.scrollRef = { current: { closest: () => null } };
  editor.setState = (patch) => Object.assign(editor.state, typeof patch === 'function' ? patch(editor.state) : patch);
  editor.syncEditor = () => {};
  editor.maybeRestoreView = () => {};
  globalThis.getSelection = () => ({ isCollapsed: true, rangeCount: 0 });
  globalThis.document = { addEventListener() {}, removeEventListener() {}, hasFocus: () => true, activeElement: null };
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  editor.componentDidMount();
  return editor;
}

/** Line `i` drawn, the caret on it (`active`) or not; with the text its spans stand for, in order. */
async function drawn(editor, i, active) {
  const { parseLine } = await import(pathToFileURL(path.join(__dirname, '../src/renderer/model/doc.js')).href);
  const ls = editor.lines(), p = parseLine(ls[i]);
  const html = editor.lineHtml(i, ls[i], p, active, false, editor.layout(ls).get(i), false);
  const spans = [...html.matchAll(/<span data-src="([^"]*)" data-open="\d" style="([^"]*)"|<span data-src="([^"]*)"/g)].map((m) => ({ src: m[1] ?? m[3], style: m[2] || '' }));
  return { html, p, spans };
}

// The mark's column (MATH-69): the drawn mark's and the edited one's.
const MARK_DRAWN = 'flex:none;min-width:1.75em;padding-right:0.25em;box-sizing:border-box';
const MARK_EDITED = 'display:inline-block;min-width:1.75em;margin-left:-1.75em;box-sizing:border-box;white-space:pre';

const at = (editor, start) => editor.lines().findIndex((line) => line.includes(start));

test('a heading in an answer keeps its size while the caret is on it, its `## ` faint before it', async () => {
  const editor = mounted(LINES), i = at(editor, '## Reading');
  const { html, p, spans } = await drawn(editor, i, true);
  assert.match(html, /font:600 17px/, 'the heading\'s size, as when it is not being edited');
  assert.deepEqual(spans[0], { src: '## ', style: 'color:#b5b5b5;' });
  assert.equal(spans.map((s) => s.src).join(''), p.text, 'the line\'s own characters, in order');
  assert.doesNotMatch((await drawn(editor, i, false)).html, />## </, 'not being edited: no mark');
});

test('a bullet in an answer keeps its place while the caret is on it, its `- ` faint where the dot stood', async () => {
  const editor = mounted(LINES), i = at(editor, '- The highlight');
  const { html, p, spans } = await drawn(editor, i, true);
  assert.deepEqual(spans[0], { src: '- ', style: `color:#b5b5b5;${MARK_EDITED};` });
  assert.equal(spans.map((s) => s.src).join(''), p.text);
  assert.match(html, /padding-left:calc\(0px \+ 1\.75em\);/, 'its depth\'s indent, and the mark\'s column');
  assert.match(html, /background:#f5f5f5/, 'the light focus tint');
});

test('a plain line of an answer is edited as before: no faint mark', async () => {
  const editor = mounted(LINES), i = at(editor, 'Then a plain');
  const { p, spans, html } = await drawn(editor, i, true);
  assert.ok(spans.every((s) => !s.style.includes('#b5b5b5')));
  assert.equal(spans.map((s) => s.src).join(''), p.text);
  assert.doesNotMatch(html, /padding-left:\d+px;padding/, 'no bullet indent');
});

// MATH-69: the mark has one column, drawn or edited, so clicking a bullet does not move its text sideways, and a wrapped
// line hangs under the text either way.
const LIST = ['@bart lists?', ...replyLines('- A bullet that is long enough to wrap onto a second line of the card.\n  - A nested one.\n10. The tenth step.\n- [ ] A todo in an answer.\n- **Bold** then @[bart] and more.', { level: { name: 'Sonnet', effort: 'high' }, trail: [], ms: 3000 }, { model: false }), ''];

/** Where a line's text starts, read from its style: the indent before the mark's column, and the column. */
function startsAt(html, active) {
  if (active) { const m = html.match(/padding-left:calc\((\d+)px \+ ([\d.]+em)\);/); return m && { depth: Number(m[1]), col: m[2] }; }
  const m = html.match(/<span style="display:flex;padding-left:(\d+)px"><span contenteditable="false" style="flex:none;min-width:([\d.]+em);/); return m && { depth: Number(m[1]), col: m[2] };
}

test('an answer\'s bullet, number or todo puts its text at the same place drawn and edited', async () => {
  const editor = mounted(LIST);
  for (const [start, depth] of [['- A bullet', 0], ['  - A nested', 18], ['10. The tenth', 0], ['- [ ] A todo', 0]]) {
    const i = at(editor, start), shown = await drawn(editor, i, false), edited = await drawn(editor, i, true);
    assert.deepEqual(startsAt(shown.html, false), { depth, col: '1.75em' }, `${start}: drawn`);
    assert.deepEqual(startsAt(edited.html, true), { depth, col: '1.75em' }, `${start}: edited`);
    assert.ok(shown.html.includes(`style="${MARK_DRAWN};color:#8f8f8f;user-select:none"`), `${start}: the drawn mark in its column`);
    assert.deepEqual(edited.spans[0].style, `color:#b5b5b5;${MARK_EDITED};`, `${start}: the edited mark in the same column`);
    assert.doesNotMatch(shown.html, /gap:10px/, 'no gap beside the column: the column is the gap');
  }
  assert.equal((await drawn(editor, at(editor, '10. The tenth'), false)).html.match(/user-select:none">([^<]*)</)[1], '10.', 'the number drawn as before');
});

test('a wrapped bullet being edited hangs under its text: the line indented by the column, its mark pulled back into it', async () => {
  const editor = mounted(LIST), i = at(editor, '  - A nested');
  const { html, spans } = await drawn(editor, i, true);
  const pad = html.match(/padding-left:calc\(18px \+ (1\.75em)\);/), pull = spans[0].style.match(/margin-left:-(1\.75em)/), wide = spans[0].style.match(/min-width:(1\.75em)/);
  assert.ok(pad && pull && wide, 'the line\'s padding, the mark\'s pull and its width');
  assert.equal(pull[1], pad[1], 'the mark is pulled back by the column the line is indented by');
  assert.equal(wide[1], pad[1], 'and fills it, so the first line\'s text starts where the wrapped lines do');
  assert.doesNotMatch(html, /text-indent/, 'no indent the line\'s inline pieces would inherit');
});

test('caret offsets on an edited bullet are its own characters, as before', async () => {
  const { parseLine, replyRawOffset, tokShown } = await import(pathToFileURL(path.join(__dirname, '../src/renderer/model/doc.js')).href);
  const editor = mounted(LIST), i = at(editor, '- **Bold**'), p = parseLine(editor.lines()[i]);
  editor.caret = { line: i, offset: 0 }; // the caret at the line's start: the bold and the mention after it stay drawn
  const { spans } = await drawn(editor, i, true);
  const nodes = spans.map(({ src }, k) => { const open = k === 0 || !tokShown(src).pre; return { nodeType: 1, nodeName: 'SPAN', dataset: { src, open: open ? '1' : '0' }, textContent: open ? src : tokShown(src).shown }; });
  const t = { childNodes: nodes };
  assert.equal(editor.activeRaw(t), p.text, 'the line\'s text, its `- ` first');
  assert.equal(editor.displayToRaw(t, 0), 0, 'before the mark');
  assert.equal(editor.displayToRaw(t, 2), 2, 'after `- `: where the text starts');
  const shown = nodes.map((n) => n.textContent).join('');
  for (let d = 0; d <= shown.length; d++) assert.equal(editor.rawToDisplay(t, editor.displayToRaw(t, d)), d, `display ${d} round-trips`);
  assert.equal(replyRawOffset(p, 1), 2, 'the drawn line: just after its `•` is just after its `- `');
  assert.equal(replyRawOffset(parseLine(editor.lines()[at(editor, '10. The tenth')]), 3), 4, 'and after its `10.` after its `10. `');
});

test('a bullet in the document is drawn as it was', async () => {
  const editor = mounted(['- A document bullet', '  1. A numbered one', '']);
  for (const k of [0, 1]) for (const active of [false, true]) {
    const { html } = await drawn(editor, k, active);
    assert.match(html, /style="display:flex;align-items:flex-start;gap:10px;padding:4px 0 4px \d+px;min-height:35px"/);
    assert.match(html, /user-select:none;flex:none;(width|min-width):14px;text-align:(center|right)/);
    assert.doesNotMatch(html, /1\.75em/);
  }
});
