'use strict';

// Connect your library's options (2026-10-11): an option's `detail` (what it covers, kept with its line breaks by
// optionOf and asked for by the librarian's prompt), the ⓘ that shows it on the card (src/renderer/screens/
// ConnectLibrary.jsx QuestionCard), where its popover goes, and the foot button that stays quiet while it says "Skip the rest".

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const React = require('react');
const runtime = require('react/jsx-runtime');
const { renderToStaticMarkup } = require('react-dom/server');
const { buildSync } = require('esbuild');
const { optionOf, readReply } = require('../src/main/connect/session.cjs');
const { INTERVIEW_SYSTEM_PROMPT } = require('../src/main/connect/prompts.cjs');

const elements = [];
const recording = { ...runtime };
for (const name of ['jsx', 'jsxs']) recording[name] = (...args) => { const element = runtime[name](...args); elements.push(element); return element; };
const filename = path.join(__dirname, '__connect-options.cjs');
const built = buildSync({ entryPoints: [path.join(__dirname, '../src/renderer/screens/ConnectLibrary.jsx')], bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', write: false, external: ['react', 'react-dom'], loader: { '.css': 'empty', '.png': 'dataurl', '.svg': 'dataurl', '.woff2': 'empty', '.woff': 'empty' } });
const compiled = new Module(filename, module);
compiled.paths = module.paths;
compiled.require = function (id) { return id === 'react/jsx-runtime' ? recording : Module.prototype.require.call(this, id); };
const previousWindow = global.window;
global.window = { engelbartAPI: {} };
try { compiled._compile(built.outputFiles[0].text, filename); }
finally { if (previousWindow === undefined) delete global.window; else global.window = previousWindow; }
const { QuestionCard, AnsweredAsk, importFootStyle, popPlace } = compiled.exports;

test('optionOf keeps an option\'s detail with its line breaks, cut at 600 characters and 10 lines; anything else is \'\'', () => {
  const detail = 'Research Chat 1 · 2026-09-14 · Drive / Research\r\nResearch Chat 2 · 2026-09-21 · Drive / Research\n\n  Research   Chat 3 · 2026-09-28  \nand 4 more';
  assert.deepEqual(optionOf({ label: 'All the Research Chat docs', why: '7 docs', detail }), {
    label: 'All the Research Chat docs', why: '7 docs',
    detail: 'Research Chat 1 · 2026-09-14 · Drive / Research\nResearch Chat 2 · 2026-09-21 · Drive / Research\nResearch Chat 3 · 2026-09-28\nand 4 more',
  });
  const twelve = Array.from({ length: 12 }, (_, i) => `Meeting ${i + 1} · 2026-0${(i % 9) + 1}-01`).join('\n');
  assert.equal(optionOf({ label: 'Meetings', detail: twelve }).detail.split('\n').length, 10, 'at most 10 lines');
  assert.match(optionOf({ label: 'Meetings', detail: twelve }).detail, /Meeting 10 · [^\n]*$/);
  const long = optionOf({ label: 'Long', detail: 'x'.repeat(900) }).detail;
  assert.equal(long.length, 600);
  assert.ok(long.endsWith('…'), 'a cut detail says so');
  for (const value of [undefined, null, 42, ['a', 'b'], { text: 'a' }, true]) assert.equal(optionOf({ label: 'A', detail: value }).detail, '', `${JSON.stringify(value)} is ''`);
  assert.deepEqual(optionOf('Just a label'), { label: 'Just a label', why: '', detail: '' });
  // Through the librarian's reply, as the card gets it; the transcript line it is told back stays labels only.
  const reply = readReply(JSON.stringify({ say: 'Which?', ask: { source: 'notes', kind: 'multi', title: 'Which?', options: [{ label: 'Meeting transcripts', why: '4 docs', detail: '7/9/26 transcripts · 2026-07-09 · Drive\n8/12/26 · 2026-08-12 · Drive' }, { label: 'Daily', why: '' }] } }), { sources: { notes: { on: true, apps: ['Obsidian'] } } });
  assert.equal(reply.ask.options[0].detail, '7/9/26 transcripts · 2026-07-09 · Drive\n8/12/26 · 2026-08-12 · Drive');
  assert.equal(reply.ask.options[1].detail, '');
});

test('the librarian is asked for an option\'s detail, from <found> only', () => {
  assert.match(INTERVIEW_SYSTEM_PROMPT, /"options": \[\{"label": "<short>", "why": "<optional, a few words>", "detail": "<optional, from <found> only:[^"]*>"\}\]/, 'the ask format');
  const rule = INTERVIEW_SYSTEM_PROMPT.split('\n').find((text) => text.startsWith('- Fill an option\'s "detail"'));
  assert.ok(rule, 'a question rule about detail');
  assert.match(rule, /from <found> only, never invent/);
  assert.match(rule, /more than one thing/);
  assert.match(rule, /date and where it is/);
  assert.match(rule, /up to about 8, then "and N more"/);
  assert.match(rule, /For a single item: its title, its kind, its date and where it is/);
  assert.match(rule, /Leave "detail" out when the label says it all/);
});

test('the foot button: quiet while it says "Skip the rest", the page\'s main button once it says "Bring these in"', () => {
  const quiet = importFootStyle(false);
  assert.equal(quiet.background, '#fff');
  assert.equal(quiet.border, '1px solid #eaeaea');
  assert.equal(quiet.color, '#4d4d4d');
  assert.equal(quiet.cursor, 'pointer', 'still clickable');
  assert.equal(quiet.height, 36, 'the same size as the main button');
  const main = importFootStyle(true);
  assert.equal(main.background, '#171717');
  assert.equal(main.color, '#fff');
  assert.equal(main.border, '1px solid #171717');
});

const ask = { source: 'transcripts', kind: 'multi', title: 'Which meetings?', options: [
  { label: 'Meeting transcripts', why: '4 docs', detail: '7/9/26 transcripts · 2026-07-09 · Drive / Meet Recordings\n8/12/26 · 2026-08-12 · Drive / Meet Recordings' },
  { label: 'Standups', why: '12 docs', detail: '' },
] };
const render = (props) => { elements.length = 0; return renderToStaticMarkup(React.createElement(QuestionCard, props)); };
const optionButton = (label) => elements.find((element) => element.type === 'button' && element.props['data-connect-option'] === label);
const infoButton = (label) => elements.find((element) => element.type === 'button' && element.props['data-connect-option-info'] === label);
const within = (element, found) => { if (!element || typeof element !== 'object') return false; if (element === found) return true; const kids = element.props && element.props.children; return Array.isArray(kids) ? kids.some((kid) => within(kid, found)) : within(kids, found); };

test('an option with a detail gets an ⓘ, one without gets none; the why sits on the label\'s line', () => {
  const html = render({ ask, live: true, onAnswer: () => {} });
  assert.ok(infoButton('Meeting transcripts'), 'an ⓘ for the option with a detail');
  assert.equal(infoButton('Standups'), undefined, 'no ⓘ without a detail');
  assert.equal((html.match(/data-connect-option-info=/g) || []).length, 1);
  assert.match(html, /class="bs-opt cx-opt"[^>]*data-connect-option="Meeting transcripts"[^>]*data-info="1"/);
  assert.match(html, /class="bs-opt cx-opt"[^>]*data-connect-option="Standups"(?![^>]*data-info)/);
  assert.match(html, /<span class="cx-opt-text"><span class="cx-opt-label">Standups<\/span><span class="cx-opt-why" data-connect-option-why="1">12 docs<\/span><\/span>/);
  assert.doesNotMatch(html, /title="7\/9\/26/, 'not a native tooltip');
  assert.doesNotMatch(html, /data-connect-option-detail/, 'closed until hovered or focused');
  assert.match(html, /data-connect-card-actions="1" style="position:sticky;bottom:0/, 'Skip and Submit pinned to the chat\'s bottom');
});

test('clicking the ⓘ never ticks the option nor submits: it is beside the option\'s button, not in it, and stops its click', () => {
  const answers = [];
  render({ ask, live: true, onAnswer: (answer) => answers.push(answer) });
  const option = optionButton('Meeting transcripts');
  const info = infoButton('Meeting transcripts');
  assert.equal(within(option, info), false, 'the ⓘ is not inside the option\'s button');
  assert.equal(info.props.type, 'button', 'never a submit button');
  const calls = [];
  const event = { preventDefault: () => calls.push('prevent'), stopPropagation: () => calls.push('stop') };
  info.props.onClick(event);
  info.props.onDoubleClick(event);
  assert.deepEqual(calls, ['prevent', 'stop', 'prevent', 'stop']);
  assert.deepEqual(answers, [], 'nothing answered');
});

test('the ⓘ works on an answered card: its options are disabled, the ⓘ is not', () => {
  elements.length = 0;
  const card = React.createElement(QuestionCard, { ask, live: false, onAnswer: () => {} });
  renderToStaticMarkup(React.createElement(AnsweredAsk, { ask }, card));
  // Folded first; opened, the card as it was answered.
  elements.length = 0;
  const html = renderToStaticMarkup(card);
  assert.equal(optionButton('Meeting transcripts').props.disabled, true);
  assert.ok(infoButton('Meeting transcripts'));
  assert.equal(infoButton('Meeting transcripts').props.disabled, undefined);
  assert.doesNotMatch(html, /data-connect-card-actions/, 'no Skip or Submit on an answered card');
});

test('the popover opens toward the room there is and never off the window', () => {
  const viewport = { width: 800, height: 900 };
  const size = { width: 300, height: 120 };
  // Room below: under the ⓘ, right edges together.
  assert.deepEqual(popPlace({ top: 100, bottom: 122, left: 700, right: 722 }, size, viewport), { left: 422, top: 128, side: 'below' });
  // Near the bottom: above it.
  assert.deepEqual(popPlace({ top: 840, bottom: 862, left: 700, right: 722 }, size, viewport), { left: 422, top: 714, side: 'above' });
  // Near the left edge: pushed in, 8px from it.
  assert.equal(popPlace({ top: 100, bottom: 122, left: 10, right: 32 }, size, viewport).left, 8);
  // Taller than either side: kept inside the window.
  const tall = popPlace({ top: 400, bottom: 422, left: 700, right: 722 }, { width: 300, height: 1000 }, viewport);
  assert.equal(tall.top, 8);
});
