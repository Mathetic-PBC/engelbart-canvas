'use strict';

// A live @brainstorm card's own controls (src/renderer/workspace/DocEditor.jsx, round 6): Wrap up between Skip and Submit,
// which writes the answer given (if any) and "; (wrap up)". @discover's own cards have none. No card has the Send to
// Discover field under it (MATH-40 follow-up): an older recap does (MATH-31), which starts an @discover thread of its own
// on what the person typed, after the brainstorm thread. An older document's `@orient` line (2026-10-05) is asked, drawn
// and answered as @brainstorm's. An exchange's result (MATH-40) ends on a small line that sends their sentence on. There
// is no document here: the editor and its elements are stand-ins.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const { pathToFileURL } = require('node:url');
const { buildSync } = require('esbuild');
const card = require('../src/main/bart/card.cjs');
const { replyLines } = require('../src/main/bart/reply.cjs');

function load(file) {
  const filename = path.join(__dirname, `__${path.basename(file, '.jsx')}-cards-unit.cjs`);
  const bundled = buildSync({ entryPoints: [path.join(__dirname, '../src/renderer/workspace', file)], bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', write: false, external: ['react', 'react-dom'], loader: { '.css': 'empty' } });
  const compiled = new Module(filename, module);
  compiled.paths = module.paths;
  compiled._compile(bundled.outputFiles[0].text, filename);
  return compiled.exports;
}

const editorModule = load('DocEditor.jsx'), DocEditor = editorModule.default;
// A search an older card suggested (round 6): no longer kept, nor drawn (MATH-31).
const LOOK = 'how others have handled “it stops when the lock frees”';
const TYPED = 'how tutors notice struggle';
const FREE = { say: 'You said “it stops when the lock frees”.', card: 'questions', questions: { items: [{ id: 'next-2', type: 'free', title: 'Within “Retries”, what would change your mind?' }] }, lookFor: LOOK, ready: false };
const FOCUS = { say: '', card: 'focus', focus: { title: 'Which part do you want prior work on?', options: [{ label: 'Retries' }, { label: 'Timeouts' }] }, ready: false };
// A card as the runner writes it under its line: the fenced JSON, then the foot.
const answer = (value) => replyLines(card.cardBody(JSON.stringify(value)).body, { level: { name: 'Sonnet', effort: 'high' }, trail: [], ms: 3000 }, { model: false });

/** An editor as mounted on `lines`, with what it asks and writes kept. */
function mounted(lines) {
  const asks = [];
  const props = { docKey: 'k', text: lines.join('\n'), onChange: (next) => { props.text = next; }, onAsk: (ask) => asks.push(ask) };
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
  const entry = (q) => editor.cardsOf(editor.lines()).byQ.get(q);
  const html = (q) => editor.cardHtml('', entry(q));
  // A click on a button the card drew, as the editor's click listener gets it.
  const click = (act, turn) => editor.editorClick({ target: { closest: () => ({ dataset: { act, turn: String(turn) } }) }, preventDefault() {} });
  // Send to Discover: `text` typed into the field named `target`, then its Send clicked, or Enter pressed in it.
  const typeDiscover = (target, text) => editor.discoverInput(field(target, text));
  const sendDiscover = (target) => editor.editorClick({ target: { closest: () => ({ dataset: { act: 'senddiscover', target } }) }, preventDefault() {} });
  const enterDiscover = (target, more = {}) => { const e = { key: 'Enter', shiftKey: false, isComposing: false, target: field(target), prevented: false, preventDefault() { this.prevented = true; }, ...more }; editor.discoverKey(e); return e; };
  return { editor, props, asks, entry, html, click, typeDiscover, sendDiscover, enterDiscover, lines: () => props.text.split('\n') };
}

/** A Send to Discover field as the page holds it: its target, what it holds, and its Send. */
function field(target, value = '') {
  const send = { style: {} };
  return { dataset: { discoverInput: target }, value, style: {}, scrollHeight: 24, selectionStart: value.length, selectionEnd: value.length, setSelectionRange() {}, send, parentElement: { querySelector: (sel) => (sel.includes('senddiscover') ? send : null) } };
}

test.afterEach(() => { delete globalThis.getSelection; delete globalThis.document; delete globalThis.window; });

test('a live @brainstorm card has Skip, Wrap up and Submit, in that order, and nothing under its box: no Send to Discover, no search suggested; its "say" is drawn in the box, in regular weight above the bold question (MATH31-03, MATH-40, MATH-40 round 3)', () => {
  const { html, entry, editor, asks, typeDiscover, sendDiscover } = mounted(['Notes', '@brainstorm', ...answer(FREE), '']);
  assert.equal(entry(1).live, true);
  assert.equal(entry(1).card.lookFor, undefined, 'an older card\'s search is not kept');
  const shown = html(1);
  const at = (act) => shown.indexOf(`data-act="${act}"`);
  assert.ok(at('cardskip') > 0 && at('cardskip') < at('cardwrap') && at('cardwrap') < at('cardsend'), 'Wrap up between Skip and Submit');
  assert.match(shown, /<button type="button" class="bart-text" data-act="cardwrap" data-turn="1"[^>]*>Wrap up<\/button>/, 'styled as Skip is');
  assert.ok(shown.endsWith('Submit</button></div></div></div>'), 'the box ends the card');
  assert.ok(!shown.includes('opendiscover') && !shown.includes('data-discover-input') && !shown.includes('Send to Discover'), 'no Send to Discover under a card');
  const said = shown.indexOf('You said “it stops when the lock frees”.');
  assert.ok(shown.indexOf('data-card-box') < said && said < shown.indexOf('Within “Retries”'), 'its say, in the box, above the question');
  assert.match(shown, /<div data-card-say="1" style="[^"]*font:400 16px[^"]*">You said “it stops when the lock frees”\.<\/div><div style="font:600 16px/, 'the reply in regular weight, the question in bold');
  // A field it no longer draws sends nothing.
  typeDiscover('c1', TYPED);
  sendDiscover('c1');
  assert.deepEqual(asks, []);
  editor.editorClick({ target: { closest: () => ({ dataset: { act: 'opendiscover', target: 'c1' } }) }, preventDefault() {} });
  assert.ok(!html(1).includes('data-discover-input'), 'nor opens');
  assert.ok(!shown.includes(LOOK) && !shown.includes('cardlook') && !shown.includes('discoverlook'), 'no suggested search, no old button');
  // A card with nothing said: its question first in the box. The next card: its lead-in said, then the question; its field asks for one thing.
  const bare = mounted(['@brainstorm', ...answer({ ...FREE, say: '' }), '']).html(0);
  assert.match(bare, /^<div [^>]*data-card="0"[^>]*><div data-card-box="live"[^>]*><div style="font:600 16px/, 'nothing above the box, nor above the question');
  const NEXT = { say: 'You kept coming back to “correct”.', card: 'questions', questions: { eyebrow: 'what next', items: [{ id: 'next', type: 'open', title: card.NEXT_TITLE, placeholder: card.NEXT_PLACEHOLDER }] }, ready: false };
  const next = mounted(['@brainstorm', ...answer(NEXT), '']).html(0);
  assert.match(next, /^<div [^>]*data-card="0"[^>]*><div data-card-box="live"[^>]*><div data-card-say="1"[^>]*>You kept coming back to “correct”\.<\/div><div [^>]*>So what do you want to dig into next\?<\/div>/, 'the lead-in, then the question, in the box');
  assert.match(next, /placeholder="One thing, as specific as you can make it"/);
});

test('Wrap up with nothing given writes "(wrap up)" alone, and works on a choice card with a pick; the answered card says Wrapped up and shows no buttons', () => {
  const empty = mounted(['@brainstorm', ...answer(FREE), '']);
  empty.click('cardwrap', 0);
  assert.equal(empty.asks[0].text, '(wrap up)');
  assert.equal(empty.lines()[empty.lines().length - 3], '@brainstorm (wrap up)');

  const picked = mounted(['@brainstorm', ...answer(FOCUS), '']);
  picked.editor.cardState.set(0, { picks: ['Timeouts'], note: 'soon' });
  picked.click('cardwrap', 0);
  assert.equal(picked.asks[0].text, 'picked "Timeouts"; note: soon; (wrap up)');

  // The card as it then stands: answered, its answer read back, no controls.
  const done = mounted(['@brainstorm', ...answer(FREE), '@brainstorm I will read the logs; (wrap up)', 'bart> Where you are: x', '']);
  const entry = done.entry(0);
  assert.deepEqual([entry.live, entry.answer], [false, { skipped: false, picks: [], text: 'I will read the logs', note: '', wrap: true }]);
  const shown = done.html(0);
  assert.ok(shown.includes('I will read the logs') && shown.includes('Wrapped up'), 'the answer, then Wrapped up');
  for (const act of ['cardskip', 'cardwrap', 'cardsend', 'senddiscover', 'opendiscover']) assert.ok(!shown.includes(`data-act="${act}"`), `no ${act} on an answered card`);
  const alone = mounted(['@brainstorm', ...answer(FREE), '@brainstorm (wrap up)', 'bart> Where you are: x', '']).html(0);
  assert.ok(alone.includes('Wrapped up') && !alone.includes('Skipped'), 'Wrap up alone says Wrapped up, not Skipped');
});

test('Send to Discover after an older recap: with nothing typed it does nothing; Enter sends and Shift+Enter puts in nothing; what is typed survives a redraw and goes back into the field (MATH31-03, -05)', () => {
  const RECAP = ['@brainstorm (wrap up)', 'bart> Your question: Why do retries loop?', 'bart> *3 s*'];
  const m = mounted([...RECAP, '']);
  const before = m.lines();
  m.sendDiscover('t0');
  m.typeDiscover('t0', '   ');
  m.sendDiscover('t0');
  const enter = m.enterDiscover('t0');
  assert.deepEqual([m.asks, m.lines(), enter.prevented], [[], before, true], 'nothing typed: nothing asked, nothing written');
  const grey = field('t0', '   ');
  m.editor.discoverInput(grey);
  assert.deepEqual([grey.send.style.background, grey.send.style.color], ['#f2f2f2', '#8f8f8f'], 'spaces alone leave Send grey');

  // Typed, then the editor redrawn: the drawn field holds none of it, and restoreDiscover puts it back.
  m.typeDiscover('t0', 'how tutors\nnotice');
  assert.equal(m.editor.discoverText.get('t0'), 'how tutors notice', 'a line break becomes a space');
  m.editor.lastHtml = null;
  const page = m.editor.editorHtml();
  assert.ok(page.includes('data-discover-input="t0"') && !page.includes('how tutors notice'), 'the field is open, and what is typed is not in the HTML');
  const fresh = field('t0'), other = field('t9');
  m.editor.restoreDiscover({ querySelectorAll: (sel) => (sel === '[data-discover-input]' ? [fresh, other] : []) }, null);
  assert.deepEqual([fresh.value, fresh.send.style.background, other.value, other.send.style.background], ['how tutors notice', '#0070f3', '', '#f2f2f2'], 'back in its own field, Send blue; another field untouched');

  const shift = m.enterDiscover('t0', { shiftKey: true });
  assert.deepEqual([shift.prevented, m.asks.length], [true, 0], 'Shift+Enter: nothing put in, nothing sent');
  m.typeDiscover('t0', `${TYPED} more`);
  m.enterDiscover('t0');
  assert.deepEqual([m.asks[0].agent, m.asks[0].text, m.asks[0].turns], ['discover', `${TYPED} more`, []], 'Enter sends');
  assert.equal(m.lines()[m.lines().length - 3], `@discover ${TYPED} more`);
  assert.equal(m.editor.discoverText.get('t0'), undefined, 'and empties it');

  // A field whose thread no longer ends in the recap sends nothing.
  const done = mounted([...RECAP, '@brainstorm', 'bart~> a1', '']);
  done.typeDiscover('t0', TYPED);
  done.sendDiscover('t0');
  assert.deepEqual(done.asks, []);
});

test('@discover\'s cards have no Wrap up and no Send to Discover field, and Wrap up or Send asked of one does nothing; Skip and Submit are as they were', async () => {
  const m = mounted(['@discover', ...answer({ ...FOCUS, lookFor: LOOK }), '']);
  assert.equal(m.entry(0).live, true);
  const shown = m.html(0);
  assert.ok(shown.includes('data-act="cardskip"') && shown.includes('data-act="cardsend"'));
  assert.ok(!shown.includes('data-act="cardwrap"') && !shown.includes('data-act="senddiscover"') && !shown.includes('data-act="opendiscover"') && !shown.includes('data-discover-input') && !shown.includes('Wrap up'));
  m.click('cardwrap', 0);
  m.typeDiscover('c0', TYPED);
  m.sendDiscover('c0');
  assert.deepEqual(m.asks, [], 'nothing asked');
  m.click('cardskip', 0);
  assert.deepEqual([m.asks[0].agent, m.asks[0].text], ['discover', '(skipped)']);

  // An older recap's Look for line is a section, not a button; the field after the recap asks what was typed (A-02, A-04).
  const model = await import(pathToFileURL(path.join(__dirname, '../src/renderer/model/doc.js')).href);
  const recap = mounted(['@brainstorm (wrap up)', 'bart> Your question: Why do retries loop?', 'bart> Look for: retry loops', 'bart> *3 s*', '']);
  const ls = recap.lines(), drawn = recap.editor.lineHtml(2, ls[2], model.parseLine(ls[2]), false, false, recap.editor.layout(ls).get(2), false);
  assert.match(drawn, />Look for<\/span><span style="display:block;">retry loops<\/span>/, 'drawn as a section');
  assert.ok(!drawn.includes('<button'), 'no button');
  const page = recap.editor.editorHtml();
  assert.ok(page.indexOf('data-recap-discover="0"') > page.indexOf('data-followup="0"') && page.indexOf('data-followup="0"') > page.indexOf('data-foot="0"'), 'a row of its own, under Brainstorm again');
  recap.typeDiscover('t0', TYPED);
  recap.sendDiscover('t0');
  assert.deepEqual([recap.asks[0].text, recap.asks[0].agent, recap.asks[0].turns], [TYPED, 'discover', []]);
  assert.deepEqual(recap.lines().slice(ls.length - 1), ['', `@discover ${TYPED}`, `bart~> ${recap.asks[0].askId}`, '']);
  assert.deepEqual(model.threads(recap.lines()).map((t) => model.agentOf(model.parseLine(recap.lines()[t.from]))), ['brainstorm', 'discover']);
});

test('on a live @brainstorm versions card the field under the options reads "Or rewrite it yourself…", and the rest is as on any card; elsewhere it reads as before (round 7)', () => {
  const VERSIONS = { say: '', card: 'questions', questions: { items: [{ id: 'versions', type: 'mcq', title: 'Which one is your question?', options: [{ label: 'Why do retries loop?', why: 'as you wrote it' }, { label: 'Why specifically do retries loop?', why: 'narrower' }] }] }, lookFor: LOOK, ready: false };
  const m = mounted(['@brainstorm', ...answer(VERSIONS), '']);
  const shown = m.html(0);
  assert.match(shown, /data-card-field="note" placeholder="Or rewrite it yourself…" aria-label="Or rewrite it yourself"/);
  assert.ok(!shown.includes('Or say it in your own words'));
  for (const act of ['cardskip', 'cardwrap', 'cardsend']) assert.ok(shown.includes(`data-act="${act}"`), `it keeps ${act}`);
  assert.ok(!shown.includes('opendiscover'), 'and has no Send to Discover');
  // A rewrite typed with nothing picked is sent as their words.
  m.editor.cardState.set(0, { note: '  Why do retries   loop at all? ' });
  m.click('cardsend', 0);
  assert.equal(m.asks[0].text, 'Why do retries loop at all?');
  for (const lines of [['@brainstorm', ...answer(FOCUS), ''], ['@discover', ...answer(VERSIONS), '']]) {
    assert.match(mounted(lines).html(0), /placeholder="Or say it in your own words…"/, `${lines[0]}: as before`);
  }
  assert.equal(editorModule.BRAINSTORM_ITEM.summary, 'Think out loud about a topic, a paper or what is on your mind, then write what you want to dig into next.', 'MATH-40');
});

/* ------------------------------------------------------------- @orient folded into @brainstorm (2026-10-05) */

const lineOf = async (m, i) => {
  const model = await import(pathToFileURL(path.join(__dirname, '../src/renderer/model/doc.js')).href), ls = m.editor.lines();
  return m.editor.lineHtml(i, ls[i], model.parseLine(ls[i]), false, false, m.editor.layout(ls).get(i), m.editor.lockedAt(ls, i));
};
const KNOW = { say: '', card: 'questions', questions: { eyebrow: 'what you know', items: [{ id: 'know', type: 'open', title: 'Write what you know about “metacognition”.', subtitle: 'For a colleague.' }] }, ready: false };

test('an @orient line is asked as @brainstorm and stays as written; its live card is a brainstorm card, with Skip, Wrap up and Submit, and its answers are @brainstorm lines that go on with its thread (M-02, M-08, A-06)', async () => {
  const asked = mounted(['Notes', '@orient metacognition', '']);
  asked.editor.askInline(1);
  assert.deepEqual([asked.asks[0].agent, asked.asks[0].text, asked.asks[0].turns], ['brainstorm', 'metacognition', []]);
  assert.deepEqual(asked.lines().slice(0, 3), ['Notes', '@orient metacognition', `bart~> ${asked.asks[0].askId}`], 'the line is not rewritten');

  const m = mounted(['Notes', '@orient metacognition', ...answer(KNOW), '']);
  assert.deepEqual([m.entry(1).live, m.entry(1).agent], [true, 'brainstorm']);
  const shown = m.html(1);
  const at = (act) => shown.indexOf(`data-act="${act}"`);
  assert.ok(at('cardskip') > 0 && at('cardskip') < at('cardwrap') && at('cardwrap') < at('cardsend') && at('opendiscover') < 0, 'Skip, Wrap up, Submit, and no Send to Discover');
  assert.ok(!shown.includes('For a colleague.'), 'no subtitle');
  m.click('cardwrap', 1);
  assert.deepEqual([m.asks[0].agent, m.asks[0].text, m.asks[0].turns.length], ['brainstorm', '(wrap up)', 1]);
  assert.equal(m.lines()[m.lines().length - 3], '@brainstorm (wrap up)');
  const model = await import(pathToFileURL(path.join(__dirname, '../src/renderer/model/doc.js')).href);
  assert.deepEqual(model.threads(m.lines()).map((t) => t.turns.length), [2], 'the answer goes on with the @orient thread');

  const s = mounted(['@orient', ...answer(KNOW), '']);
  s.editor.cardState.set(0, { text: 'people overrate what they learn' });
  s.click('cardsend', 0);
  assert.deepEqual([s.asks[0].agent, s.asks[0].text, s.lines()[s.lines().length - 3]], ['brainstorm', 'people overrate what they learn', '@brainstorm people overrate what they learn']);

  // A running one shows what it is doing, never the JSON of the card arriving.
  const p = mounted(['@orient', 'bart~> run1', '']);
  p.props.asks = { run1: { agent: 'brainstorm', activity: 'Reading tutortrace.pdf', lines: ['{"say": "", "card"'] } };
  const pending = await lineOf(p, 1);
  assert.ok(pending.includes('Reading tutortrace.pdf') && !pending.includes('&quot;card&quot;') && !pending.includes('"card"'));
});

test('a recap is drawn as sections, the paper path\'s "What you took from it" and an older @orient recap\'s labels too; under it "Brainstorm again", which may be sent empty, then Send to Discover on a row of its own (M-07, M-08, A-05, A-06)', async () => {
  for (const [first, label] of [['@brainstorm @[TutorTrace]', 'What you took from it'], ['@orient metacognition', 'What you know']]) {
    const lines = [first, ...answer(KNOW), '@brainstorm (wrap up)', `bart> ${label}: learners query before trying`, 'bart> Where it thins out: not said', 'bart> What draws you: the gap', 'bart> Your question: not written yet', 'bart> ', 'bart> *3 s*', ''];
    const m = mounted(lines);
    const row = (text) => m.lines().indexOf(text);
    assert.match(await lineOf(m, row(`bart> ${label}: learners query before trying`)), new RegExp(`>${label}</span>`), `${label}: a section, its label in bold`);
    assert.match(await lineOf(m, row('bart> Where it thins out: not said')), /font-style:italic;">not said/, 'not said in grey');
    assert.match(await lineOf(m, row('bart> What draws you: the gap')), />What draws you<\/span>/, 'an older recap\'s label still draws');
    const model = await import(pathToFileURL(path.join(__dirname, '../src/renderer/model/doc.js')).href);
    const follow = m.editor.followHtml(m.lines(), model.threads(m.lines())[0]);
    assert.match(follow, /data-agent="brainstorm" data-empty="1" rows="1" placeholder="Reply…" aria-label="Brainstorm again"/, 'Brainstorm again, as it is today');
    assert.match(follow, />@brainstorm<\/span>/);
    const page = m.editor.editorHtml();
    assert.ok(page.indexOf('data-recap-discover="0"') > page.indexOf('data-followup="0"'), 'Send to Discover, a row of its own under it');
    assert.ok(!page.includes('Orient again'));
    m.editor.sendFollow(0);
    assert.deepEqual([m.asks[0].agent, m.asks[0].text, m.asks[0].turns.length], ['brainstorm', '', 2], 'sent empty: @brainstorm again on the same thread');
    assert.equal(m.lines()[lines.length - 1], '@brainstorm');
  }
});

test('an @brainstorm result is their sentence, then one small line whose @discover and @bart start a thread of their own on it; no Send to Discover row and no sections (MATH-40)', async () => {
  const SENTENCE = 'Look at how often people correct an agent mid-task.';
  const NEXT = { say: 'You came back to “correct” three times.', card: 'questions', questions: { eyebrow: 'what next', items: [{ id: 'next', type: 'open', title: card.NEXT_TITLE }] }, ready: false };
  const result = replyLines(card.resultText(SENTENCE), { level: { name: '', effort: '' }, trail: [], ms: 0 }, { model: false });
  const lines = ['@brainstorm corrigibility', ...answer(NEXT), `@brainstorm ${SENTENCE}`, ...result, ''];
  const m = mounted(lines), row = (text) => m.lines().indexOf(text), offer = row(`bart> ${card.RESULT_OFFER}`);
  const drawn = await lineOf(m, offer);
  assert.match(drawn, /font-size:13px;line-height:1\.6;color:#8f8f8f/, 'small and grey');
  assert.match(drawn, /data-act="resultask" data-agent="discover"[^>]*>@discover<\/button>, or ask about it with <button[^>]*data-act="resultask" data-agent="bart"[^>]*>@bart<\/button>/);
  const said = await lineOf(m, row(`bart> ${SENTENCE}`));
  assert.ok(said.includes(SENTENCE) && !said.includes('<button') && !said.includes('font-weight:600'), 'their sentence as written, not a section');
  assert.ok(!m.editor.editorHtml().includes('data-recap-discover'), 'no Send to Discover row: the offer line stands in for it');
  // Mid-exchange, nothing sends on: no Send to Discover under its live cards, and none once they are answered.
  const mid = mounted(['@brainstorm corrigibility', ...answer(KNOW), '@brainstorm people overrate it', ...answer(NEXT), '']).editor.editorHtml();
  assert.ok(!mid.includes('opendiscover') && !mid.includes('data-discover-input') && !mid.includes('resultask'), 'nothing under the cards in between');
  const ended = m.editor.editorHtml();
  assert.ok(!ended.includes('opendiscover') && ended.includes('resultask'), 'only the offer line under the finished result');
  // @discover, then @bart: each a thread of its own after the brainstorm thread, on their sentence, with no earlier turns.
  const press = (agent) => m.editor.editorClick({ target: { closest: () => ({ dataset: { act: 'resultask', agent, row: String(offer) } }) }, preventDefault() {} });
  press('discover');
  assert.deepEqual([m.asks[0].agent, m.asks[0].text, m.asks[0].turns], ['discover', SENTENCE, []]);
  press('bart');
  assert.deepEqual([m.asks[1].agent, m.asks[1].text, m.asks[1].turns], ['bart', SENTENCE, []]);
  const model = await import(pathToFileURL(path.join(__dirname, '../src/renderer/model/doc.js')).href);
  assert.deepEqual(model.threads(m.lines()).map((t) => m.lines()[t.from]), ['@brainstorm corrigibility', `@bart ${SENTENCE}`, `@discover ${SENTENCE}`], 'each right after the brainstorm thread, the latest first');
  press('nope');
  assert.equal(m.asks.length, 2, 'no other agent');
  // Left open: nothing to send on, and nothing drawn as an offer.
  const left = mounted(['@brainstorm corrigibility', ...answer(NEXT), '@brainstorm (skipped)', ...replyLines(card.LEFT_OPEN, { level: { name: '', effort: '' }, trail: [], ms: 0 }, { model: false }), '']);
  assert.ok(!left.editor.editorHtml().includes('resultask'));
});

test('Send to Discover is not drawn after @bart or @discover answers, under a recap still being asked again, or after an @brainstorm reply that is not a recap (MATH31-04, A-05)', () => {
  const none = (lines, why) => { const page = mounted(lines).editor.editorHtml(); assert.ok(!page.includes('data-discover-input') && !page.includes('opendiscover'), why); };
  none(['@bart why?', 'bart> because', 'bart> *Sonnet · high · 3 s*', ''], 'not after @bart');
  none(['@discover retry loops', 'bart> ## Start here', 'bart> *3 s*', ''], 'not after an @discover guide');
  none(['@orient (wrap up)', 'bart> What you know: a', 'bart> *3 s*', '@brainstorm', 'bart~> o9', ''], 'not while it is asked again');
  none(['@brainstorm', 'bart> FAKE REPLY that is not a card: {"say": "cut off', 'bart> *3 s*', ''], 'not after a reply that is not a recap');
  const bart = mounted(['@bart why?', 'bart> because', 'bart> *Sonnet · high · 3 s*', '']);
  bart.editor.discoverText.set('t0', 'x');
  bart.editor.sendDiscover('t0');
  assert.deepEqual(bart.asks, [], 'a target that is not drawn sends nothing');
  assert.match(bart.editor.editorHtml(), /aria-label="Ask a follow-up"/, '@bart\'s follow-up field is as it was');
});

test('the @ menu no longer offers Orient: the editor, the rail model and the workspace list Bart, Brainstorm and Discover; the rail names no Orient (M-01)', async () => {
  assert.equal(editorModule.ORIENT_ITEM, undefined);
  const rail = await import(pathToFileURL(path.join(__dirname, '../src/renderer/model/rail.js')).href);
  assert.equal(rail.ORIENT_VERB, undefined);
  assert.deepEqual(rail.mentionRows({ query: 'or', library: [], page: null, pageRow: null }).map((r) => r.key), [], 'nothing starts with "or"');
  assert.equal(rail.isVerbRow({ id: 'orient' }), false);
  const fs = require('node:fs');
  const workspaceSrc = fs.readFileSync(path.join(__dirname, '../src/renderer/screens/Workspace.jsx'), 'utf8');
  assert.match(workspaceSrc, /\[BART_ITEM, BRAINSTORM_ITEM, DISCOVER_ITEM, /);
  assert.ok(!/ORIENT_ITEM/.test(workspaceSrc));
  assert.ok(!/Orient asked/.test(fs.readFileSync(path.join(__dirname, '../src/renderer/workspace/Rail.jsx'), 'utf8')));
  // A row picked from an editor's own list by id: no @Orient is written.
  const m = mounted(['@or']);
  m.editor.state.mention = { i: 0, start: 0, caret: 3, query: 'or' };
  m.editor.pickMention({ id: 'brainstorm', name: 'brainstorm' });
  assert.equal(m.lines()[0], '@Brainstorm ');
});
