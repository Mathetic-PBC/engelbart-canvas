'use strict';

// Math (2026-10-12): LaTeX in documents and agent answers, drawn with KaTeX (src/renderer/model/doc.js). `$…$` inline by
// Pandoc's rule, `$$…$$` display, `\$` a dollar, ```math blocks drawn while the caret is outside them. A drawn formula is
// one unit, as a mention is: a click after it lands after its source, and a copy gives its LaTeX.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const { pathToFileURL } = require('node:url');
const { buildSync } = require('esbuild');
const { replyLines } = require('../src/main/bart/reply.cjs');

const docJs = () => import(pathToFileURL(path.join(__dirname, '../src/renderer/model/doc.js')).href);

function load(entry, tag, stubs = {}) {
  const filename = path.join(__dirname, `__${tag}-math-unit.cjs`);
  const bundled = buildSync({ entryPoints: [path.join(__dirname, '..', entry)], bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', write: false, external: ['react', 'react-dom', 'react-dom/client'], loader: { '.js': 'jsx', '.css': 'empty', '.woff2': 'empty', '.woff': 'empty', '.ttf': 'empty' }, logLevel: 'silent' });
  const compiled = new Module(filename, module);
  compiled.paths = module.paths;
  compiled.require = (id) => (id in stubs ? stubs[id] : module.require(id));
  compiled._compile(bundled.outputFiles[0].text, filename);
  return compiled.exports;
}

test('$x^2$ is drawn as math; "$5 and $10" stays text; \\$ is a dollar; a $$…$$ line is display math', async () => {
  const { inlineHtml } = await docJs();
  const x = inlineHtml('so $x^2$ grows');
  assert.match(x, /^so <span data-math="1" contenteditable="false"><span class="katex">/);
  assert.match(x, /<\/span> grows$/);
  assert.equal(inlineHtml('$5 and $10'), '$5 and $10');
  assert.equal(inlineHtml('costs \\$5'), 'costs $5');
  assert.equal(inlineHtml('$ x$ and $y $'), '$ x$ and $y $', 'a space just inside a $ is not math');
  assert.equal(inlineHtml('$a$5'), '$a$5', 'a closing $ followed by a digit is not math');
  const display = inlineHtml('$$\\int_0^1 x\\,dx = \\tfrac12$$');
  assert.match(display, /^<span data-math="1" contenteditable="false" style="display:block[^"]*"><span class="katex-display">/);
  assert.doesNotMatch(inlineHtml('`$x$` stays code'), /katex/, 'inside backticks it is code');
});

test('LaTeX KaTeX cannot draw shows its source in the inline-code look, and nothing throws', async () => {
  const { inlineHtml, tokShown, renderMath } = await docJs();
  let html;
  assert.doesNotThrow(() => { html = inlineHtml('bad $\\frac{$ here'); });
  assert.match(html, /^bad <code data-math-error="1" style="padding:1px 4px;border-radius:4px;background:#f2f2f2;font:\.92em\/1\.6 var\(--font-mono\)">\$\\frac\{\$<\/code> here$/);
  assert.equal(renderMath('\\frac{', false), null);
  assert.deepEqual(tokShown('$\\frac{$'), { shown: '$\\frac{$', pre: 0 }, 'shown as typed: the caret counts its characters');
});

test('a math token is one unit: shown as its drawing\'s text, a click after it lands after its source', async () => {
  const { tokShown, rawOffset, renderMath } = await docJs();
  const { shown } = renderMath('x^2', false), line = 'a $x^2$ b', p = { type: 'p', text: line };
  assert.deepEqual(tokShown('$x^2$'), { shown, pre: 1, unit: true });
  assert.equal(rawOffset(p, 2, line), 2, 'just before it: its start');
  assert.equal(rawOffset(p, 2 + shown.length, line), 7, 'just after it: after its closing $');
  assert.equal(rawOffset(p, 3, line), 7, 'within the drawing: after it, never inside its source');
  assert.equal(rawOffset(p, 2 + shown.length + 2, line), 9, 'the text after it maps as before');
  assert.equal(rawOffset({ type: 'p', text: 'costs \\$5' }, 7, 'costs \\$5'), 8, 'a drawn \\$ is one character for two');
});

test('copying a selection across a math token gives its LaTeX source', async () => {
  const { selectionMarkdown, selectionHtml } = await docJs();
  const lines = ['a $x^2$ b', 'next line'];
  assert.equal(selectionMarkdown(lines, { line: 0, offset: 0 }, { line: 0, offset: 9 }), 'a $x^2$ b');
  assert.equal(selectionMarkdown(lines, { line: 0, offset: 1 }, { line: 0, offset: 8 }), ' $x^2$ ');
  assert.equal(selectionMarkdown(lines, { line: 0, offset: 4 }, { line: 1, offset: 4 }), '$x^2$ b\nnext', 'cut into it from a selection that runs on: whole');
  assert.equal(selectionMarkdown(lines, { line: 0, offset: 3 }, { line: 0, offset: 5 }), 'x^', 'within its source on the caret\'s line: as selected');
  assert.equal(selectionHtml('so $x^2$ and \\$5'), 'so $x^2$ and $5', 'other apps get the LaTeX as text');
});

test('a brainstorm card\'s text draws its math and escapes the rest', async () => {
  const { textMathHtml } = await docJs();
  const html = textMathHtml('If $p < 0.05$, is <b> real?');
  assert.match(html, /^If <span data-math="1"/);
  assert.match(html, /, is &lt;b&gt; real\?$/);
  assert.equal(textMathHtml('**not bold** and \\$3'), '**not bold** and $3');
});

// The editor, with its elements stand-ins (as in doc-editor-answer-line).
const DocEditor = load('src/renderer/workspace/DocEditor.jsx', 'DocEditor').default;
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
const drawLine = (editor, i) => { const ls = editor.lines(), ps = editor.parsedOf(ls); return editor.lineHtml(i, ls[i], ps[i], editor.state.activeLine === i, false, editor.layout(ls).get(i), false); };

test('a ```math block in a document is drawn as display math; with the caret in it, its source shows', () => {
  const editor = mounted(['Euler:', '```math', 'e^{i\\pi} + 1 = 0', '```', 'after']);
  editor.state.activeLine = 4;
  const head = drawLine(editor, 1);
  assert.match(head, /data-math-block="1"/);
  assert.match(head, /<span class="katex-display">/);
  assert.match(head, /data-act="copycode" data-row="1"/, 'Copy stays, and copies the LaTeX (the block\'s body)');
  assert.match(drawLine(editor, 2), /data-raw="e\^\{i\\pi\} \+ 1 = 0"[^>]*display:none/, 'its body is hidden, its source kept');
  assert.match(drawLine(editor, 3), /display:none/);
  editor.state.activeLine = 2;
  assert.doesNotMatch(drawLine(editor, 1), /katex/, 'the caret in the block: code, as typed');
  assert.match(drawLine(editor, 2), /e\^\{i\\pi\} \+ 1 = 0/);
  const bad = mounted(['```math', '\\frac{', '```', '']);
  bad.state.activeLine = 3;
  assert.doesNotMatch(drawLine(bad, 0), /katex/, 'LaTeX that cannot be drawn shows as code');
});

test('a ```math block in an answer is drawn on the card, and is its source with the caret in it', () => {
  const lines = ['@bart what is the variance?', ...replyLines('It is\n```math\n\\sigma^2 = \\frac{1}{n}\\sum_i (x_i - \\bar x)^2\n```\nwhere $\\bar x$ is the mean.', { level: { name: 'Sonnet', effort: 'high' }, trail: [], ms: 1000 }, { model: false }), ''];
  const editor = mounted(lines), open = lines.findIndex((l) => l.endsWith('```math')), mean = lines.findIndex((l) => l.includes('is the mean'));
  editor.state.activeLine = lines.length - 1;
  assert.match(drawLine(editor, open), /<span class="katex-display">/);
  assert.match(drawLine(editor, open + 1), /display:none/);
  assert.match(drawLine(editor, mean), /where <span data-math="1" contenteditable="false"><span class="katex">/, 'inline math in an answer line');
  editor.state.activeLine = open + 1;
  assert.doesNotMatch(drawLine(editor, open), /katex/);
});

test('the caret\'s line shows a math token\'s source when the caret touches it, and offsets map whole', () => {
  const editor = mounted(['a $x^2$ b', '']);
  editor.state.activeLine = 0;
  editor.caret = { line: 0, offset: 7 };
  assert.match(drawLine(editor, 0), /<span data-src="\$x\^2\$" data-open="1">\$x\^2\$<\/span>/, 'touched at its end: open, as typed');
  editor.caret = { line: 0, offset: 9 };
  const closed = drawLine(editor, 0);
  assert.match(closed, /<span data-src="\$x\^2\$" data-open="0"><span data-math="1" contenteditable="false">/);
  // The line as the browser holds it: text, the drawn formula, text.
  const shown = closed.match(/data-open="0">(.*?)<\/span><span data-src=" b"/)[1].replace(/<[^>]*>/g, '').replace(/&amp;/g, '&');
  const t = { childNodes: [
    { nodeName: 'SPAN', nodeType: 1, dataset: { src: 'a ', open: '1' }, textContent: 'a ' },
    { nodeName: 'SPAN', nodeType: 1, dataset: { src: '$x^2$', open: '0' }, textContent: shown },
    { nodeName: 'SPAN', nodeType: 1, dataset: { src: ' b', open: '1' }, textContent: ' b' },
  ] };
  assert.equal(editor.displayToRaw(t, 2), 2);
  assert.equal(editor.displayToRaw(t, 2 + shown.length), 7, 'a click just after it: after its source');
  assert.equal(editor.displayToRaw(t, 3), 7);
  assert.equal(editor.rawToDisplay(t, 7), 2 + shown.length);
  assert.equal(editor.rawToDisplay(t, 9), 2 + shown.length + 2);
});

test('answerHtml in the PDF box card draws inline math', () => {
  globalThis.window = { boxCardAPI: {} };
  globalThis.document = { getElementById: () => ({}) };
  const { answerHtml } = load('src/renderer/box-card/BoxCard.jsx', 'BoxCard', {
    'react-dom/client': { createRoot: () => ({ render() {} }) },
  });
  assert.match(answerHtml('Agreement was $\\kappa = 0.79$ overall (p. 6).'), /^<p>Agreement was <span data-math="1" contenteditable="false"><span class="katex">.*<\/span> overall \(p\. 6\)\.<\/p>$/s);
});

test('the system prompts tell agents to write math in LaTeX', () => {
  const rule = 'When the answer includes math (a formula, an equation, a statistic with symbols), write it in LaTeX: $…$ inline, a ```math block for a display equation. You decide when; nobody has to ask. Ordinary numbers, percentages and prices stay plain text.';
  const { BART_SYSTEM_PROMPT } = require('../src/main/bart/system-prompt.cjs');
  const { BRAINSTORM_SYSTEM_PROMPT } = require('../src/main/bart/brainstorm-system-prompt.cjs');
  const { DISCOVER_SYSTEM_PROMPT } = require('../src/main/bart/discover-system-prompt.cjs');
  for (const prompt of [BART_SYSTEM_PROMPT, DISCOVER_SYSTEM_PROMPT]) assert.ok(prompt.includes(rule));
  // A card's strings are plain text (no backticks in that prompt): display math there is $$…$$, which a card draws.
  assert.ok(BRAINSTORM_SYSTEM_PROMPT.includes(rule.replace('a ```math block', () => '$$…$$')));
  const box = BART_SYSTEM_PROMPT.slice(BART_SYSTEM_PROMPT.indexOf('# Asked from a highlight'));
  assert.match(box.slice(0, box.indexOf('\n# ', 2)), /write it in LaTeX, inline as \$…\$ \(no math blocks\)/);
});
