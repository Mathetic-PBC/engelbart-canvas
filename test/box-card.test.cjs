'use strict';

// A web box's card (src/renderer/box-card/BoxCard.jsx, 2026-10-17): its note's field as tall as its lines on every
// keystroke, never a line too tall after one that widens the card; what Bart is doing while he answers waves as the
// document's text at work does (.eb-wave, src/renderer/wave.css), with no spinner; its placeholder.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { buildSync } = require('esbuild');

function load() {
  const filename = path.join(__dirname, '__BoxCard-unit.cjs');
  const bundled = buildSync({ entryPoints: [path.join(__dirname, '../src/renderer/box-card/BoxCard.jsx')], bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', write: false, external: ['react', 'react-dom', 'react-dom/client'], loader: { '.js': 'jsx', '.css': 'empty', '.woff2': 'empty', '.woff': 'empty', '.ttf': 'empty' }, logLevel: 'silent' });
  const compiled = new Module(filename, module);
  compiled.paths = module.paths;
  compiled.require = (id) => (id === 'react-dom/client' ? { createRoot: () => ({ render() {} }) } : module.require(id));
  globalThis.window = { boxCardAPI: {} };
  globalThis.document = { getElementById: () => ({}) };
  try { compiled._compile(bundled.outputFiles[0].text, filename); } finally { delete globalThis.window; delete globalThis.document; }
  return compiled.exports;
}
const card = load();
const source = fs.readFileSync(path.join(__dirname, '../src/renderer/box-card/BoxCard.jsx'), 'utf8');

test('the placeholder: "Write a note or ask @bart", no comma', () => {
  assert.equal(card.PLACEHOLDER, 'Write a note or ask @bart');
});

test('the card is as wide as the note\'s longest line and the field\'s room, MIN_W..ASK_W; ASK_W once answered', () => {
  assert.equal(card.noteWidth(0, false), card.MIN_W);
  assert.equal(card.noteWidth(200.2, false), 201 + 20, 'the line, rounded up, and its room');
  assert.equal(card.noteWidth(5000, false), card.ASK_W);
  assert.equal(card.noteWidth(50, true), card.ASK_W);
  // Caveat at 24px is under 11px a letter: the placeholder's 25 fit in ASK_W on one line
  assert.ok(card.noteWidth(card.PLACEHOLDER.length * 11, false) < card.ASK_W);
});

// A textarea as the browser lays it out: 6px padding each side, 28.8px lines (24px × 1.2), its words wrapped at its width,
// and a scrollHeight never less than the height it is given (what holds a field up when it is measured before letting go).
function field(text, width, letter = 10) {
  const ta = {
    value: text, width, style: { height: '' },
    get scrollHeight() {
      const inner = this.width - 12;
      let lines = 0;
      for (const para of this.value.split('\n')) {
        let line = 0; lines += 1;
        for (const word of para.split(' ')) {
          const w = word.length * letter, space = line ? letter : 0;
          if (line && line + space + w > inner) { lines += 1; line = w; } else line += space + w;
        }
      }
      return Math.max(parseFloat(this.style.height) || 0, Math.round(lines * 28.8));
    },
  };
  return ta;
}

test('fitField: as tall as the field\'s lines at its width, after letting go of the height it had', () => {
  const ta = field('what am i high', 160);
  card.fitField(ta);
  assert.equal(ta.style.height, '29px', 'one line');
  ta.width = 100; card.fitField(ta);
  assert.equal(ta.style.height, '58px', 'narrower: its last word wraps');
  ta.width = 300; card.fitField(ta);
  assert.equal(ta.style.height, '29px', 'wider again: back to one line, not held at two');
  ta.value = 'a\nb\nc'; card.fitField(ta);
  assert.equal(ta.style.height, '86px', 'a line each');
  ta.value = ''; card.fitField(ta);
  assert.equal(ta.style.height, '29px', 'emptied: one line');
  card.fitField(null); // no field yet: nothing
});

test('a keystroke that widens the card: the field fitted at the new width, never a line too tall', () => {
  // As the card does it: the field is fitted to the text first (the Note's layout effect), then the card's width is
  // measured from the text (BoxCard's) and the field fitted again at it, both before the card is painted.
  let text = 'what am i hig', width = card.noteWidth(text.length * 10, false);
  const ta = field(text, width);
  card.fitField(ta);
  assert.equal(ta.style.height, '29px');
  text += 'h'; ta.value = text; card.fitField(ta); // at the old width, the new letter has no room
  assert.equal(ta.style.height, '58px', 'the first pass alone would leave it a line too tall');
  width = card.noteWidth(text.length * 10, false);
  ta.width = width; card.fitField(ta);
  assert.equal(ta.style.height, '29px', 'fitted again at the new width');
  // and the field is fitted again whenever the width changes, not only the text
  assert.match(source, /function Note\(\{[^}]*\bwidth\b[^}]*\}\)/);
  assert.match(source, /React\.useLayoutEffect\(\(\) => fitField\(fieldRef\.current\), \[value, width, refit, fieldRef\]\)/);
  assert.match(source, /<Note [^>]*width=\{width\}/);
});

test('while Bart answers: what he is doing in the document\'s grey wave (.eb-wave), no spinner; Stop beside it', () => {
  const html = renderToStaticMarkup(React.createElement(card.Running, { run: { askId: 'a1', question: 'why?', activity: 'Reading' }, note: '@bart why?' }));
  assert.match(html, /<span class="eb-wave" style="display:inline-block;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:top">[^<]+<\/span>/);
  assert.doesNotMatch(html, /card-spin|border-radius:50%/, 'no spinner');
  assert.match(html, />Stop<\/button>/);
  const failed = renderToStaticMarkup(React.createElement(card.Running, { run: { askId: 'a1', question: 'why?', error: 'No model' }, note: '' }));
  assert.doesNotMatch(failed, /eb-wave/, 'a failure is not at work');
  // the wave's rules are loaded on the card's own page, from the one file styles.css imports too
  assert.match(source, /^import '\.\.\/wave\.css';/m);
  assert.match(fs.readFileSync(path.join(__dirname, '../src/renderer/styles.css'), 'utf8'), /^@import "\.\/wave\.css";$/m);
  assert.match(fs.readFileSync(path.join(__dirname, '../src/renderer/wave.css'), 'utf8'), /^\.eb-wave\{color:transparent!important;/m);
  assert.match(source, /keepWaves\(root\.current\)/, 'on the page\'s clock, as the document\'s waves are');
});
