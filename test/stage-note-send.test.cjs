'use strict';

// The Stage's highlight notes look and send as the workspace's fields do (2026-10-24): every agent's token tinted exactly
// where the workspace tints it (model/doc.js agentTokens, the one rule both read), the round send's ready state
// (ui/send-button.js, shared with workspace/DocEditor.jsx), what Enter or the send does with a box's note (BoxCard.jsx
// sendBox), and where the chat icon at a selection's end shows and when it does not (shared/selection-card.cjs).

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

test('chatIconPlace: right of the selection\'s end, level with its line; under its end with no room right, above with none under', () => {
  const pane = { x: 0, y: 0, width: 800, height: 600 }, line = { x: 100, y: 200, width: 300, height: 20 };
  assert.deepEqual(SEL.chatIconPlace(line, pane), { x: 400 + SEL.ICON_GAP, y: 210 - SEL.CHAT_ICON / 2, width: SEL.CHAT_ICON, height: SEL.CHAT_ICON });
  const right = { x: 500, y: 200, width: 290, height: 20 };
  assert.deepEqual(SEL.chatIconPlace(right, pane), { x: 790 - SEL.CHAT_ICON, y: 220 + SEL.ICON_GAP, width: SEL.CHAT_ICON, height: SEL.CHAT_ICON }, 'under its end');
  const corner = { x: 500, y: 575, width: 290, height: 20 };
  assert.equal(SEL.chatIconPlace(corner, pane).y, 575 - SEL.ICON_GAP - SEL.CHAT_ICON, 'above it');
  const at = SEL.chatIconPlace({ x: 790, y: 2, width: 8, height: 8 }, pane);
  assert.ok(at.x >= 0 && at.x + at.width <= 800 && at.y >= 0 && at.y + at.height <= 600, 'always inside the pane');
});

test('chatIconPlace: none once the selection\'s line is scrolled out of the pane, or there is no selection', () => {
  const pane = { x: 0, y: 40, width: 800, height: 600 };
  assert.equal(SEL.chatIconPlace({ x: 100, y: 900, width: 300, height: 20 }, pane), null, 'below');
  assert.equal(SEL.chatIconPlace({ x: 100, y: 0, width: 300, height: 20 }, pane), null, 'scrolled past, above');
  assert.equal(SEL.chatIconPlace({ x: -400, y: 100, width: 300, height: 20 }, pane), null, 'its end left of the pane');
  assert.equal(SEL.chatIconPlace(null, pane), null, 'cleared');
  assert.equal(SEL.chatIconPlace({ x: 1, y: 1, width: NaN, height: 1 }, pane), null);
  assert.ok(SEL.chatIconPlace({ x: 100, y: 30, width: 300, height: 20 }, pane), 'partly in it');
});

test('shadedIconPlace: the icon placed in the pane less its shadow\'s room, the view that room bigger; none when the icon is', () => {
  const pane = { x: 0, y: 40, width: 800, height: 600 }, line = { x: 100, y: 90, width: 300, height: 20 };
  const s = SEL.ICON_SHADE, at = SEL.shadedIconPlace(line, pane);
  assert.deepEqual(at, { x: 400 + SEL.ICON_GAP - s, y: 100 - SEL.CHAT_ICON / 2 - s, width: SEL.CHAT_ICON + 2 * s, height: SEL.CHAT_ICON + 2 * s });
  assert.equal(SEL.shadedIconPlace({ x: 100, y: 900, width: 300, height: 20 }, pane), null);
  const edge = SEL.shadedIconPlace({ x: 700, y: 620, width: 99, height: 18 }, pane);
  assert.ok(edge.x >= 0 && edge.x + edge.width <= 800 && edge.y >= 40 && edge.y + edge.height <= 640, JSON.stringify(edge));
});

test('the chat icon\'s look: 28px round, white, a shade darker under the pointer, its tooltip', async () => {
  const { CHAT_TIP, CHAT_SVG, CHAT_ICON_CSS, chatIconLook } = await import(pathToFileURL(path.join(__dirname, '../src/renderer/ui/chat-icon.js')).href);
  assert.equal(CHAT_TIP, 'Ask or add a note');
  assert.match(chatIconLook(), /width:28px;height:28px;.*border-radius:50%;background:#fff/);
  assert.match(CHAT_ICON_CSS, /\[data-chat-icon\]:hover\{background:#f2f2f2/);
  assert.match(CHAT_SVG, /^<svg/);
});

test('a web page\'s chat icon, in the card\'s own view: its tooltip, a press keeping the page\'s selection, a click asking for the card', () => {
  let opened = 0, pressed = false;
  const { ChatIcon } = loadCard({ open: () => { opened += 1; } });
  const shell = ChatIcon();
  assert.equal(shell.props.style.padding, SEL.ICON_SHADE, 'room for its shadow');
  const button = shell.props.children;
  assert.equal(button.props.title, 'Ask or add a note');
  assert.equal(button.props['data-chat-icon'], '1');
  button.props.onMouseDown({ preventDefault: () => { pressed = true; } });
  assert.equal(pressed, true);
  assert.equal(opened, 0, 'nothing until clicked');
  button.props.onClick();
  assert.equal(opened, 1, 'main asked for its card');
});
