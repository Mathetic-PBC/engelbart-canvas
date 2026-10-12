'use strict';

// Connect your library's options (2026-10-11): an option's `detail` (what it covers, kept with its line breaks by
// optionOf and asked for by the librarian's prompt), kept in the option's data but not shown on the card (src/renderer/
// screens/ConnectLibrary.jsx QuestionCard; 2026-10-12: just the label and its why, no detail line, no ⓘ, no popover, no
// "Recommended" tag), and the foot button that stays quiet while it says "Skip the rest".

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
const { QuestionCard, AnsweredAsk, importFootStyle } = compiled.exports;

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
  assert.match(INTERVIEW_SYSTEM_PROMPT, /"options": \[\{"label": "<short>", "why": "<optional, a few words>", "detail": "<optional, from <found> only:[^"]*>", "checked": true \| false \(multi only[^)]*\)\}\]/, 'the ask format');
  const rule = INTERVIEW_SYSTEM_PROMPT.split('\n').find((text) => text.startsWith('- Fill an option\'s "detail"'));
  assert.ok(rule, 'a question rule about detail');
  assert.match(rule, /from <found> only, never invent/);
  assert.match(rule, /more than one thing/);
  assert.match(rule, /date and where it is/);
  assert.match(rule, /up to about 8, then "and N more"/);
  assert.match(rule, /For a single item: its title, its kind, its date and where it is/);
  assert.match(rule, /Leave "detail" out when the label says it all/);
});

test('optionOf keeps "checked" as a boolean on a "multi" and drops it on a "single" (MATH-122)', () => {
  assert.deepEqual(optionOf({ label: 'Research', why: '48 notes', checked: true }, true), { label: 'Research', why: '48 notes', detail: '', checked: true });
  assert.equal(optionOf({ label: 'Daily', checked: false }, true).checked, false);
  for (const value of [undefined, 'yes', 1, null]) assert.equal(optionOf({ label: 'Daily', checked: value }, true).checked, false, `${JSON.stringify(value)} is not checked`);
  assert.equal(optionOf('Just a label', true).checked, false);
  assert.equal('checked' in optionOf({ label: 'Code only', checked: true }), false, 'a single has no checked');
  assert.equal('checked' in optionOf({ label: 'Code only', checked: true }, false), false);
  const choices = { sources: { notes: { on: true, apps: ['Obsidian'] } } };
  const options = [{ label: 'Research', checked: true }, { label: 'Essays', checked: true }, { label: 'Daily', checked: false }];
  assert.deepEqual(readReply(JSON.stringify({ ask: { source: 'notes', kind: 'multi', title: 'Which folders?', options } }), choices).ask.options.map((option) => option.checked), [true, true, false]);
  assert.ok(readReply(JSON.stringify({ ask: { source: 'notes', kind: 'single', title: 'Which account?', options } }), choices).ask.options.every((option) => !('checked' in option)));
});

test('the librarian asks "multi" by default, with its recommendation checked (kept, not shown) and no "Everything" beside the parts', () => {
  const rule = INTERVIEW_SYSTEM_PROMPT.split('\n').find((text) => text.startsWith('- Prefer options'));
  assert.match(rule, /"multi" \(pick any\) is the default/);
  assert.match(rule, /"single" \(pick one\) only when the answers exclude each other/);
  assert.match(rule, /is always "multi"/);
  const checked = INTERVIEW_SYSTEM_PROMPT.split('\n').find((text) => text.startsWith('- In a "multi", set "checked": true'));
  assert.ok(checked, 'a rule about checked');
  assert.match(checked, /No "Everything" or "Everything but…" option next to the parts/);
  assert.match(checked, /the card starts with nothing ticked/);
  assert.doesNotMatch(checked, /"Recommended" tag/, 'the card no longer shows a tag (2026-10-12)');
  assert.doesNotMatch(checked, /one Submit takes your recommendation/);
  assert.doesNotMatch(INTERVIEW_SYSTEM_PROMPT, /make it the first option \("Everything but/);
  assert.doesNotMatch(INTERVIEW_SYSTEM_PROMPT, /multiple choice/);
});

const pickedOn = (html) => [...html.matchAll(/data-connect-option="([^"]*)"[^>]*aria-checked="true"/g)].map((match) => match[1]);

test('a "multi" starts with nothing ticked, its recommended options not marked out: no "Recommended" tag, no ⓘ; Submit waits for a tick (2026-10-12)', () => {
  const recommended = { source: 'notes', kind: 'multi', title: 'Which folders?', options: [
    { label: 'Research', why: '48 notes', detail: 'Research/Thesis · 31 notes\nResearch/Lab · 17 notes', checked: true },
    { label: 'Daily', why: '180 notes', detail: '', checked: false },
    { label: 'Essays', why: '12 notes', detail: '', checked: true },
  ] };
  const html = render({ ask: recommended, live: true, onAnswer: () => {} });
  assert.deepEqual(pickedOn(html), [], 'nothing ticked');
  assert.doesNotMatch(html, /Recommended|data-connect-option-recommended/, 'no tag');
  assert.doesNotMatch(html, /data-connect-option-info|cx-info|ⓘ|aria-label="What /, 'no ⓘ');
  assert.equal(elements.some((element) => element.props && element.props.role === 'tooltip'), false, 'no popover');
  const submit = elements.find((element) => element.type === 'button' && element.props['data-connect-submit'] === '1');
  assert.equal(submit.props.disabled, true, 'Submit waits for a tick');
  assert.ok(elements.some((element) => element.type === 'button' && element.props['data-connect-skip'] === '1'), 'Skip is always there');
  assert.equal(recommended.options[0].checked, true, 'checked is still in the data');
});

test('a "single"\'s options and an answered card\'s options never come checked', () => {
  const single = { source: 'email', kind: 'single', title: 'Which account?', options: [{ label: 'a@x.edu', why: '', detail: '', checked: true }, { label: 'b@y.com', why: '', detail: '' }] };
  const html = render({ ask: single, live: true, onAnswer: () => {} });
  assert.deepEqual(pickedOn(html), []);
  assert.equal(elements.find((element) => element.type === 'button' && element.props['data-connect-submit'] === '1').props.disabled, true);
  const answered = { source: 'notes', kind: 'multi', title: 'Which folders?', options: [{ label: 'Research', why: '', detail: '', checked: true }] };
  assert.deepEqual(pickedOn(render({ ask: answered, live: false, onAnswer: () => {} })), []);
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

test('an option shows its label and its why after it, wrapping instead of cut off; its detail is not shown', () => {
  const html = render({ ask, live: true, onAnswer: () => {} });
  assert.match(html, /<span class="cx-opt-text"><span class="cx-opt-line"><span class="cx-opt-label">Standups<\/span><span class="cx-opt-why" data-connect-option-why="1">12 docs<\/span><\/span><\/span>/);
  assert.match(html, /<span class="cx-opt-text"><span class="cx-opt-line"><span class="cx-opt-label">Meeting transcripts<\/span><span class="cx-opt-why" data-connect-option-why="1">4 docs<\/span><\/span><\/span>/, 'no detail line, even with a detail');
  assert.doesNotMatch(html, /data-connect-option-detail|cx-opt-detail/, 'no detail element');
  assert.doesNotMatch(html, /7\/9\/26|Meet Recordings/, 'the detail\'s text is nowhere on the card');
  assert.doesNotMatch(html, /data-connect-option-info|data-info=/, 'no ⓘ');
  const css = require('node:fs').readFileSync(path.join(__dirname, '../src/renderer/screens/ConnectLibrary.jsx'), 'utf8');
  for (const name of ['cx-opt-label', 'cx-opt-why']) {
    const rule = css.match(new RegExp(`\\.${name}\\{([^}]*)\\}`))[1];
    assert.doesNotMatch(rule, /ellipsis|nowrap/, `${name} is never cut`);
  }
  assert.doesNotMatch(css, /\.cx-opt-detail\{/, 'no style left for a detail line');
  assert.match(html, /data-connect-card-actions="1" style="position:sticky;bottom:0/, 'Skip and Submit pinned to the chat\'s bottom');
  assert.ok(optionButton('Meeting transcripts'));
});

test('an answered card shows its options disabled, still without their details', () => {
  elements.length = 0;
  const card = React.createElement(QuestionCard, { ask, live: false, onAnswer: () => {} });
  renderToStaticMarkup(React.createElement(AnsweredAsk, { ask }, card));
  elements.length = 0;
  const html = renderToStaticMarkup(card);
  assert.equal(optionButton('Meeting transcripts').props.disabled, true);
  assert.match(html, /<span class="cx-opt-label">Meeting transcripts<\/span>/);
  assert.doesNotMatch(html, /data-connect-option-detail|7\/9\/26/);
  assert.doesNotMatch(html, /data-connect-card-actions/, 'no Skip or Submit on an answered card');
});
