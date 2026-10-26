'use strict';

// The Stage's highlight notes look and send as the workspace's fields do (2026-10-24): every agent's token tinted exactly
// where the workspace tints it (model/doc.js agentTokens, the one rule both read), the round send's ready state
// (ui/send-button.js, shared with workspace/DocEditor.jsx), what Enter or the send does with a box's note (BoxCard.jsx
// sendBox), and that a selection's card comes with no chat icon before it (2026-10-26).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { pathToFileURL } = require('node:url');
const { buildSync } = require('esbuild');

const SEL = require('../src/shared/selection-card.cjs');

const loadDoc = () => import(pathToFileURL(path.join(__dirname, '../src/renderer/model/doc.js')).href);
const loadSend = () => import(pathToFileURL(path.join(__dirname, '../src/renderer/ui/send-button.js')).href);

function loadCard(api = {}) {
  const filename = path.join(__dirname, '__BoxCard-send.cjs');
  const bundled = buildSync({ entryPoints: [path.join(__dirname, '../src/renderer/box-card/BoxCard.jsx')], bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', write: false, external: ['react', 'react-dom', 'react-dom/client'], loader: { '.js': 'jsx', '.css': 'empty', '.woff2': 'empty', '.woff': 'empty', '.ttf': 'empty' }, logLevel: 'silent' });
  const compiled = new Module(filename, module);
  compiled.paths = module.paths;
  compiled.require = (id) => (id === 'react-dom/client' ? { createRoot: () => ({ render() {} }) } : module.require(id));
  globalThis.window = { boxCardAPI: api };
  globalThis.document = { getElementById: () => ({}) };
  try { compiled._compile(bundled.outputFiles[0].text, filename); } finally { delete globalThis.window; delete globalThis.document; }
  return compiled.exports;
}

const SAMPLES = [
  '@bart', '@Bart what is this?', 'why @bart', 'a@bart', '@barty', '@bart, @chat and @Create', 'mail me@bart.com',
  '`@bart` in code', '$@bart$', '(@bart)', '@bart.', '**@bart** bold', '**why @bart** and @chat', '*@bart* italic', '[@bart](https://x.y)', '@[bart](lib:x) a mention',
  '@[Paper](lib:p) then @bart', 'line\n@bart next', '  @bart  ', '@', '', 'no agents here', '@@bart', '@bart_x', '@bart-x',
];

test('agentTokens: the very tokens the workspace tints in a line, across code, math, links, mentions and near misses', async () => {
  const { agentTokens, inlineHtml, AGENT_LOOK } = await loadDoc();
  const tinted = new RegExp(`<span style="${AGENT_LOOK}">([^<]*)</span>`, 'g');
  for (const text of SAMPLES) {
    const fromDoc = [...inlineHtml(text).matchAll(tinted)].map((m) => m[1]);
    const ours = agentTokens(text);
    assert.deepEqual(ours.map((t) => t.token), fromDoc, JSON.stringify(text));
    for (const t of ours) assert.equal(text.slice(t.start, t.end), t.token, 'where it is in the text');
  }
});

test('the note\'s field ink labels each of those tokens, its text exactly as typed under the labels', async () => {
  const { agentTokens, agentInkHtml, noteInkHtml, esc } = await loadDoc();
  for (const text of SAMPLES) {
    const html = agentInkHtml(text);
    assert.equal((html.match(/data-agent=/g) || []).length, agentTokens(text).length, JSON.stringify(text));
    // the labels taken out, what is left is the text, escaped: so the caret over it lines up
    const bare = html.replace(/<span data-agent="[^"]*" style="[^"]*">([^<]*)<span aria-hidden="true"[^>]*>[^<]*<\/span><\/span>/g, '$1');
    assert.equal(bare, esc(text));
  }
  assert.match(agentInkHtml('@bart q'), /color:#0070f3;font:500 1em\/1 var\(--font-sans\)/, 'the sans field\'s label, at its own size');
  assert.match(noteInkHtml('@bart q'), /font:500 \.75em\/1/, 'a handwritten note\'s, smaller');
  assert.match(agentInkHtml('a <b> & @chat'), /^a &lt;b&gt; &amp; <span data-agent="chat"/);
});

test('the round send: ready once there is something but spaces, blue with a white arrow, grey and disabled before', async () => {
  const { sendReady, boxSend, sendLook, SEND_SIZE, SEND_ARROW, SEND_HOVER_CSS } = await loadSend();
  assert.equal(sendReady(''), false);
  assert.equal(sendReady('   \n'), false);
  assert.equal(sendReady(null), false);
  assert.equal(sendReady('a'), true);
  assert.equal(sendReady(' @bart '), true);
  assert.equal(boxSend(true), 'background:#0070f3;color:#fff');
  assert.equal(boxSend(false), 'background:#ececec;color:#a3a3a3');
  assert.match(sendLook(true), new RegExp(`width:${SEND_SIZE}px;height:${SEND_SIZE}px;.*border-radius:50%;background:#0070f3;color:#fff;cursor:pointer`));
  assert.match(sendLook(false), /background:#ececec;color:#a3a3a3;cursor:default/);
  assert.equal(SEND_SIZE, 28);
  assert.match(SEND_ARROW, /width="14" height="14"[^>]*stroke-width="2\.2"/);
  assert.match(SEND_HOVER_CSS, /\.bart-send:hover:not\(:disabled\)/);
  // the workspace draws its send from the same place, not a copy
  const editor = fs.readFileSync(path.join(__dirname, '../src/renderer/workspace/DocEditor.jsx'), 'utf8');
  assert.match(editor, /from '\.\.\/ui\/send-button\.js'/);
  assert.doesNotMatch(editor, /const boxSend\s*=/);
});

test('a box\'s card: Enter or the send asks a leading @bart, keeps any other note as typed, does nothing with nothing to send', () => {
  const { sendBox, SendButton } = loadCard();
  assert.equal(sendBox(''), null);
  assert.equal(sendBox('  '), null);
  assert.deepEqual(sendBox('a note'), { ask: null });
  assert.deepEqual(sendBox('why @bart'), { ask: null }, 'only a leading @bart asks');
  assert.deepEqual(sendBox('@bart what is this?'), { ask: 'what is this?' });
  assert.deepEqual(sendBox('@Bart  why'), { ask: 'why' });
  assert.equal(sendBox('@bart   '), null, 'no question yet');
  // the button: disabled and grey until ready
  const off = SendButton({ ready: false, onSend() {} }), on = SendButton({ ready: true, onSend() {} });
  assert.equal(off.props.disabled, true);
  assert.equal(off.props.style.background, '#ececec');
  assert.equal(on.props.disabled, false);
  assert.equal(on.props.style.background, '#0070f3');
  assert.equal(on.props.className, 'bart-send');
  assert.equal(on.props['aria-label'], 'Send');
  let sent = 0, pressed = false;
  on.props.onClick(); off.props.onClick();
  SendButton({ ready: true, onSend: () => { sent += 1; } }).props.onClick();
  assert.equal(sent, 1);
  on.props.onMouseDown({ preventDefault: () => { pressed = true; } });
  assert.equal(pressed, true, 'a press keeps the field\'s keyboard');
});

test('a selection\'s card has no chat icon before it (2026-10-26): none to place, none to draw, none to open', () => {
  for (const name of ['CHAT_ICON', 'ICON_GAP', 'ICON_SHADE', 'chatIconPlace', 'shadedIconPlace']) assert.equal(SEL[name], undefined, name);
  assert.equal(typeof SEL.shadedCardPlace, 'function', 'the card\'s place is still the shared one');
  const card = loadCard({});
  assert.equal(card.ChatIcon, undefined);
  assert.equal(typeof card.SelectionCard, 'function');
  assert.equal(fs.existsSync(path.join(__dirname, '../src/renderer/ui/chat-icon.js')), false);
});
